import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  API_URL,
  ConfigurationError,
  DomainInputError,
  SpaceshipAPIError,
  SpaceshipClient,
  main,
  normalizeDomain,
  normalizeDomains,
  postJson,
} from "../scripts/check_domains.mjs";

function captureOutput() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
      },
    },
    read() {
      return value;
    },
  };
}

test("normalizes case and trailing dot", () => {
  assert.equal(normalizeDomain("Example.COM."), "example.com");
});

test("rejects IDNs instead of applying implicit conversion", () => {
  for (const value of ["faß.de", "Kitty.com", "\u00a0example.com", "xn--mnich-kva.de", "xn--a.com"]) {
    assert.throws(() => normalizeDomain(value), DomainInputError);
  }
});

test("rejects multiple trailing dots", () => {
  assert.throws(() => normalizeDomain("example.com..."), DomainInputError);
});

test("deduplicates without reordering", () => {
  assert.deepEqual(normalizeDomains(["Example.com", "example.com.", "other.dev"]), [
    "example.com",
    "other.dev",
  ]);
});

test("rejects invalid domains and IP addresses", () => {
  for (const value of ["localhost", "bad_label.dev", "-bad.dev", "127.0.0.1"]) {
    assert.throws(() => normalizeDomain(value), DomainInputError);
  }
});

test("batches twenty domains and preserves order", async () => {
  const calls = [];
  const transport = async (url, headers, payload) => {
    assert.equal(url, API_URL);
    assert.equal(headers["X-API-Key"], "key");
    assert.equal(headers["X-API-Secret"], "secret");
    calls.push(payload.domains);
    return {
      domains: payload.domains.map((domain) => ({
        domain,
        result: "available",
        premiumPricing: [],
      })),
    };
  };
  const domains = Array.from({ length: 21 }, (_, index) => `candidate-${index}.dev`);
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains(domains);

  assert.deepEqual(calls.map((call) => call.length), [20, 1]);
  assert.deepEqual(report.results.map((item) => item.domain), domains);
  assert.equal(report.complete, true);
  assert.deepEqual(report.errors, []);
});

test("normalizes availability and premium pricing", async () => {
  const transport = async () => ({
    domains: [
      {
        domain: "premium.dev",
        result: "available",
        premiumPricing: [{ operation: "register", price: 120.5, currency: "usd" }],
      },
      { domain: "taken.dev", result: "taken" },
      { domain: "odd.dev", result: "reserved" },
    ],
  });
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains([
    "premium.dev",
    "taken.dev",
    "odd.dev",
  ]);

  assert.deepEqual(
    report.results.map((item) => item.availability),
    ["available", "unavailable", "unknown"],
  );
  assert.deepEqual(report.results[0].premiumPricing, [
    { operation: "register", price: 120.5, currency: "USD" },
  ]);
  assert.equal(report.results[1].providerResult, "taken");
});

test("rejects negative and unsafe premium prices", async () => {
  const transport = async () => ({
    domains: [
      {
        domain: "negative.dev",
        result: "available",
        premiumPricing: [{ operation: "register", price: -1, currency: "USD" }],
      },
      {
        domain: "unsafe.dev",
        result: "available",
        premiumPricing: [
          { operation: "register", price: 9_007_199_254_740_992, currency: "USD" },
        ],
      },
    ],
  });
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains([
    "negative.dev",
    "unsafe.dev",
  ]);

  assert.equal(report.complete, false);
  assert.equal(report.results.every((item) => item.availability === "unknown"), true);
  assert.equal(report.errors[0].code, "invalid_results");
});

test("live response fixture maps taken to unavailable", async () => {
  const transport = async () => ({
    domains: [
      { domain: "example.com", result: "taken", premiumPricing: [] },
      { domain: "dotmole-smoke-260725.dev", result: "available", premiumPricing: [] },
    ],
  });
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains([
    "example.com",
    "dotmole-smoke-260725.dev",
  ]);

  assert.equal(report.complete, true);
  assert.deepEqual(
    report.results.map((item) => item.availability),
    ["unavailable", "available"],
  );
  assert.equal(report.results[0].providerResult, "taken");
});

test("expected provider error statuses remain unknown", async () => {
  const statuses = ["invalidDomainName", "tldNotSupported", "unexpectedError"];
  const domains = ["invalid.dev", "unsupported.dev", "failed.dev"];
  const transport = async (_url, _headers, payload) => ({
    domains: payload.domains.map((domain, index) => ({
      domain,
      result: statuses[index],
      premiumPricing: [],
    })),
  });
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains(domains);

  assert.equal(report.complete, false);
  assert.equal(report.results.every((item) => item.availability === "unknown"), true);
  assert.deepEqual(
    report.errors.map((error) => error.code),
    ["provider_invalid_domain", "tld_not_supported", "availability_check_failed"],
  );
});

test("duplicate and malformed results are unknown", async () => {
  const transport = async () => ({
    domains: [
      { domain: "duplicate.dev", result: "available" },
      { domain: "duplicate.dev", result: "unavailable" },
      { domain: "bad-status.dev", result: "reserved" },
      { domain: "bad-price.dev", result: "available", premiumPricing: { price: 1 } },
      {
        domain: "huge-price.dev",
        result: "available",
        premiumPricing: [{ operation: "register", price: Infinity, currency: "USD" }],
      },
    ],
  });
  const domains = ["duplicate.dev", "bad-status.dev", "bad-price.dev", "huge-price.dev"];
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains(domains);

  assert.equal(report.complete, false);
  assert.equal(report.results.every((item) => item.availability === "unknown"), true);
  assert.equal(report.errors[0].code, "invalid_results");
});

test("rate limit marks current and remaining batches unknown", async () => {
  let calls = 0;
  const transport = async (_url, _headers, payload) => {
    calls += 1;
    if (calls === 2) {
      throw new SpaceshipAPIError("rate_limited", "Rate limited.", {
        status: 429,
        retryAfter: "10",
      });
    }
    return {
      domains: payload.domains.map((domain) => ({ domain, result: "available" })),
    };
  };
  const domains = Array.from({ length: 45 }, (_, index) => `candidate-${index}.dev`);
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains(domains);

  assert.equal(calls, 2);
  assert.equal(report.complete, false);
  assert.equal(report.results.slice(0, 20).every((item) => item.availability === "available"), true);
  assert.equal(report.results.slice(20).every((item) => item.availability === "unknown"), true);
  assert.equal(report.errors[0].retryAfter, "10");
});

test("missing provider results are never assumed available", async () => {
  const transport = async () => ({ domains: [] });
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains([
    "missing.dev",
  ]);

  assert.equal(report.complete, false);
  assert.equal(report.results[0].availability, "unknown");
  assert.equal(report.errors[0].code, "missing_results");
});

test("unexpected item invalidates the entire batch", async () => {
  const transport = async () => ({
    domains: [
      { domain: "first.dev", result: "available" },
      { domain: "second.dev", result: "unavailable" },
      { unexpected: true },
    ],
  });
  const report = await new SpaceshipClient("key", "secret", { transport }).checkDomains([
    "first.dev",
    "second.dev",
  ]);

  assert.equal(report.complete, false);
  assert.equal(report.results.every((item) => item.availability === "unknown"), true);
  assert.equal(report.errors.at(-1).code, "unexpected_results");
});

test("secrets are redacted from transport errors", async () => {
  const transport = async () => {
    throw new SpaceshipAPIError(
      "provider_error",
      "provider echoed top-secret and public-key",
      { status: 500 },
    );
  };
  const report = await new SpaceshipClient("public-key", "top-secret", {
    transport,
  }).checkDomains(["safe.dev"]);
  const encoded = JSON.stringify(report);

  assert.equal(encoded.includes("public-key"), false);
  assert.equal(encoded.includes("top-secret"), false);
  assert.equal(encoded.includes("[REDACTED]"), true);
});

test("overlapping secrets are fully redacted", async () => {
  const transport = async () => {
    throw new SpaceshipAPIError("provider_error", "provider echoed abcdef and abc", {
      status: 500,
    });
  };
  const report = await new SpaceshipClient("abc", "abcdef", { transport }).checkDomains([
    "safe.dev",
  ]);
  const encoded = JSON.stringify(report);

  assert.equal(encoded.includes("abc"), false);
  assert.equal(encoded.includes("abcdef"), false);
});

test("retry-after is redacted", async () => {
  const transport = async () => {
    throw new SpaceshipAPIError("rate_limited", "limited", {
      status: 429,
      retryAfter: "abcdef",
    });
  };
  const report = await new SpaceshipClient("abc", "abcdef", { transport }).checkDomains([
    "safe.dev",
  ]);
  const encoded = JSON.stringify(report);

  assert.equal(encoded.includes("abc"), false);
  assert.equal(encoded.includes("abcdef"), false);
});

test("credentials with header control characters are rejected safely", () => {
  const leakedSecret = "secret\nleak";
  assert.throws(
    () => new SpaceshipClient("key", leakedSecret),
    (error) => error instanceof ConfigurationError && !error.message.includes(leakedSecret),
  );
});

test("rejects non-finite timeout", () => {
  for (const timeout of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => new SpaceshipClient("key", "secret", { timeout }), TypeError);
  }
});

test("HTTP transport requests manual redirect handling", async () => {
  let redirectMode;
  const fetchImpl = async (_url, options) => {
    redirectMode = options.redirect;
    return new Response('{"domains":[]}', { status: 200 });
  };

  await postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl });
  assert.equal(redirectMode, "manual");
});

test("redirect is reported without following", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("", {
      status: 302,
      headers: { Location: "https://other.test/steal" },
    });
  };

  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "redirect_rejected",
  );
  assert.equal(calls, 1);
});

test("HTTP permission error is normalized", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = async () => new Response(body, { status: 403 });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "permission_denied",
  );
  assert.equal(cancelled, true);
});

test("invalid JSON is normalized", async () => {
  const fetchImpl = async () => new Response("not-json", { status: 200 });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "invalid_response",
  );
});

test("pathological JSON number is normalized", async () => {
  const fetchImpl = async () => new Response(`{"value":${"9".repeat(5000)}}`, { status: 200 });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "invalid_response",
  );
});

test("duplicate JSON members are rejected", async () => {
  const fetchImpl = async () =>
    new Response(
      '{"domains":[{"domain":"safe.dev","result":"unavailable","result":"available"}]}',
      { status: 200 },
    );
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "invalid_response",
  );
});

test("escaped duplicate JSON members are rejected", async () => {
  const fetchImpl = async () =>
    new Response('{"result":"taken","res\\u0075lt":"available"}', { status: 200 });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "invalid_response",
  );
});

test("non-standard JSON constant is rejected", async () => {
  const fetchImpl = async () => new Response('{"domains":NaN}', { status: 200 });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "invalid_response",
  );
});

test("oversized response is rejected before parsing", async () => {
  const fetchImpl = async () =>
    new Response("{}", { status: 200, headers: { "Content-Length": "2000001" } });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "invalid_response",
  );
});

test("invalid UTF-8 response is rejected", async () => {
  const fetchImpl = async () => new Response(new Uint8Array([0xff]), { status: 200 });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "invalid_response",
  );
});

test("request timeout is normalized", async () => {
  const fetchImpl = async (_url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 0.001, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "timeout",
  );
});

test("invalid header failure is normalized without leaking", async () => {
  const leakedSecret = "secret\nleak";
  const fetchImpl = async () => {
    throw new TypeError(`Invalid header value ${leakedSecret}`);
  };

  await assert.rejects(
    postJson(
      API_URL,
      { "X-API-Secret": leakedSecret },
      { domains: ["safe.dev"] },
      1,
      { fetchImpl },
    ),
    (error) => error instanceof SpaceshipAPIError && !error.message.includes(leakedSecret),
  );
});

test("non-200 success response is rejected", async () => {
  const fetchImpl = async () => new Response("{}", { status: 206 });
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "unexpected_status",
  );
});

test("protocol disconnect is normalized", async () => {
  const fetchImpl = async () => {
    throw new TypeError("closed");
  };
  await assert.rejects(
    postJson(API_URL, {}, { domains: ["safe.dev"] }, 1, { fetchImpl }),
    (error) => error instanceof SpaceshipAPIError && error.code === "network_error",
  );
});

test("missing process credentials return structured error", async () => {
  const output = captureOutput();
  const exitCode = await main(["example.dev"], { env: {}, stdout: output.stream });
  const report = JSON.parse(output.read());

  assert.equal(exitCode, 2);
  assert.equal(report.errors[0].code, "missing_credentials");
  assert.equal(report.results[0].availability, "unknown");
});

test("mixed valid and invalid input returns partial results", async () => {
  const transport = async (_url, _headers, payload) => ({
    domains: payload.domains.map((domain) => ({ domain, result: "available" })),
  });
  const output = captureOutput();
  const exitCode = await main(["valid.dev", "bad_label.dev"], {
    env: { SPACESHIP_API_KEY: "key", SPACESHIP_API_SECRET: "secret" },
    stdout: output.stream,
    transport,
  });
  const report = JSON.parse(output.read());

  assert.equal(exitCode, 2);
  assert.equal(report.complete, false);
  assert.equal(report.results[0].availability, "available");
  assert.equal(report.errors[0].code, "invalid_domain");
});

test("reads domains from stdin", async () => {
  const transport = async (_url, _headers, payload) => ({
    domains: payload.domains.map((domain) => ({ domain, result: "available" })),
  });
  const output = captureOutput();
  const exitCode = await main(["--stdin"], {
    env: { SPACESHIP_API_KEY: "key", SPACESHIP_API_SECRET: "secret" },
    stdin: Readable.from(["first.dev\nsecond.app\n"]),
    stdout: output.stream,
    transport,
  });
  const report = JSON.parse(output.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(report.results.map((item) => item.domain), ["first.dev", "second.app"]);
});

test("configuration error keeps input errors", async () => {
  const output = captureOutput();
  const exitCode = await main(["--timeout", "nan", "valid.dev", "bad_label.dev"], {
    env: { SPACESHIP_API_KEY: "key", SPACESHIP_API_SECRET: "secret" },
    stdout: output.stream,
  });
  const report = JSON.parse(output.read());

  assert.equal(exitCode, 2);
  assert.deepEqual(
    report.errors.map((error) => error.code),
    ["invalid_domain", "configuration_error"],
  );
});

test("configuration error never prints bad credential", async () => {
  const leakedSecret = "secret\nleak";
  const output = captureOutput();
  const exitCode = await main(["valid.dev"], {
    env: { SPACESHIP_API_KEY: "key", SPACESHIP_API_SECRET: leakedSecret },
    stdout: output.stream,
  });

  assert.equal(exitCode, 2);
  assert.equal(output.read().includes(leakedSecret), false);
});
