#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

export const API_URL = "https://spaceship.dev/api/v1/domains/available";
export const BATCH_SIZE = 20;
export const DEFAULT_TIMEOUT = 15;
export const MAX_DOMAINS = 60;
export const MAX_STDIN_BYTES = 16_384;
export const USER_AGENT = "dotmole/1.0";

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_JSON_DEPTH = 100;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const PREMIUM_OPERATIONS = new Set(["register", "transfer", "renew", "restore"]);
const AVAILABILITY_MAP = new Map([
  ["available", "available"],
  ["taken", "unavailable"],
  ["invalidDomainName", "unknown"],
  ["tldNotSupported", "unknown"],
  ["unexpectedError", "unknown"],
]);
const STATUS_ERRORS = new Map([
  [
    "invalidDomainName",
    ["provider_invalid_domain", "Spaceship considered one or more domain names invalid."],
  ],
  [
    "tldNotSupported",
    ["tld_not_supported", "Spaceship does not support one or more requested TLDs."],
  ],
  [
    "unexpectedError",
    [
      "availability_check_failed",
      "Spaceship could not determine availability for one or more domains.",
    ],
  ],
]);

export class DomainInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "DomainInputError";
  }
}

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class SpaceshipAPIError extends Error {
  constructor(code, message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = "SpaceshipAPIError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

class UsageError extends Error {}

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function normalizeDomain(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainInputError("Domain must be a non-empty string.");
  }
  if ([...value].some((character) => character.codePointAt(0) > 127)) {
    throw new DomainInputError("Internationalized domains are not accepted in this version.");
  }

  let domain = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "").toLowerCase();
  if (domain.endsWith(".")) {
    domain = domain.slice(0, -1);
  }
  if (domain.endsWith(".")) {
    throw new DomainInputError(`Domain has multiple trailing dots: ${JSON.stringify(value)}.`);
  }
  if (domain.length < 4 || domain.length > 253 || !domain.includes(".")) {
    throw new DomainInputError(`Domain must be a fully qualified name: ${JSON.stringify(value)}.`);
  }
  if (isIP(domain)) {
    throw new DomainInputError(`IP addresses are not domain names: ${JSON.stringify(value)}.`);
  }

  const labels = domain.split(".");
  if (labels.some((label) => !LABEL_PATTERN.test(label))) {
    throw new DomainInputError(`Domain contains an invalid label: ${JSON.stringify(value)}.`);
  }
  if (labels.some((label) => label.startsWith("xn--"))) {
    throw new DomainInputError("Internationalized domain labels are not accepted in this version.");
  }
  return domain;
}

export function normalizeDomains(values) {
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const domain = normalizeDomain(value);
    if (!seen.has(domain)) {
      normalized.push(domain);
      seen.add(domain);
    }
  }
  return normalized;
}

export function parseStrictJson(text) {
  if (typeof text !== "string") {
    throw new TypeError("JSON input must be a string.");
  }

  let index = 0;

  function fail(message) {
    throw new SyntaxError(`${message} at position ${index}.`);
  }

  function skipWhitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) {
      index += 1;
    }
  }

  function parseString() {
    if (text[index] !== '"') {
      fail("Expected a JSON string");
    }
    const start = index;
    index += 1;
    let escaped = false;

    while (index < text.length) {
      const character = text[index];
      const code = text.charCodeAt(index);
      if (!escaped && character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (!escaped && character === "\\") {
        escaped = true;
      } else {
        if (!escaped && code < 0x20) {
          fail("Unescaped control character in JSON string");
        }
        escaped = false;
      }
      index += 1;
    }
    fail("Unterminated JSON string");
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!match) {
      fail("Invalid JSON number");
    }
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      fail("JSON number is outside the supported finite range");
    }
    return value;
  }

  function parseArray(depth) {
    const result = [];
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }

    while (index < text.length) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") {
        fail("Expected ',' or ']' in JSON array");
      }
      index += 1;
      skipWhitespace();
    }
    fail("Unterminated JSON array");
  }

  function parseObject(depth) {
    const result = Object.create(null);
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }

    while (index < text.length) {
      const key = parseString();
      if (keys.has(key)) {
        fail(`Duplicate JSON object member ${JSON.stringify(key)}`);
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") {
        fail("Expected ':' after JSON object member");
      }
      index += 1;
      skipWhitespace();
      const value = parseValue(depth + 1);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") {
        fail("Expected ',' or '}' in JSON object");
      }
      index += 1;
      skipWhitespace();
    }
    fail("Unterminated JSON object");
  }

  function parseValue(depth) {
    if (depth > MAX_JSON_DEPTH) {
      fail("JSON nesting exceeds the safety limit");
    }
    skipWhitespace();
    const character = text[index];
    if (character === '"') return parseString();
    if (character === "{") return parseObject(depth);
    if (character === "[") return parseArray(depth);
    if (character === "-" || /[0-9]/.test(character ?? "")) return parseNumber();
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    fail("Unexpected JSON token");
  }

  const decoded = parseValue(0);
  skipWhitespace();
  if (index !== text.length) {
    fail("Unexpected trailing JSON data");
  }
  return decoded;
}

function errorForStatus(status, retryAfter) {
  if (status === 401) {
    return new SpaceshipAPIError(
      "authentication_failed",
      "Spaceship rejected the API credentials (HTTP 401).",
      { status },
    );
  }
  if (status === 403) {
    return new SpaceshipAPIError(
      "permission_denied",
      "Spaceship denied the request; verify the key has domains:read permission (HTTP 403).",
      { status },
    );
  }
  if (status === 429) {
    const normalizedRetryAfter = retryAfter?.trim().slice(0, 128) || null;
    const suffix = normalizedRetryAfter ? ` Retry-After: ${normalizedRetryAfter}.` : "";
    return new SpaceshipAPIError(
      "rate_limited",
      `Spaceship rate limit reached (HTTP 429).${suffix}`,
      { status, retryAfter: normalizedRetryAfter },
    );
  }
  if (status >= 300 && status < 400) {
    return new SpaceshipAPIError(
      "redirect_rejected",
      `Spaceship availability endpoint attempted an unexpected redirect (HTTP ${status}).`,
      { status },
    );
  }
  if ([400, 404, 422].includes(status)) {
    return new SpaceshipAPIError(
      "request_rejected",
      `Spaceship rejected the availability request (HTTP ${status}).`,
      { status },
    );
  }
  if (status >= 200 && status < 300) {
    return new SpaceshipAPIError(
      "unexpected_status",
      `Spaceship availability service returned unexpected HTTP ${status}.`,
      { status },
    );
  }
  return new SpaceshipAPIError(
    "provider_error",
    `Spaceship availability service returned HTTP ${status}.`,
    { status },
  );
}

export async function postJson(
  url,
  headers,
  payload,
  timeout = DEFAULT_TIMEOUT,
  { fetchImpl = globalThis.fetch } = {},
) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    throw new SpaceshipAPIError("request_error", "Could not construct the Spaceship request.");
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.ceil(timeout * 1000));
  const { signal } = controller;

  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (timedOut || error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new SpaceshipAPIError("timeout", "Spaceship availability request timed out.");
      }
      throw new SpaceshipAPIError(
        "network_error",
        "Could not reach Spaceship availability service.",
      );
    }

    if (response.status !== 200) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw errorForStatus(response.status, response.headers.get("retry-after"));
    }
    if (!response.body) {
      throw new SpaceshipAPIError(
        "invalid_response",
        "Spaceship returned an unexpected response shape.",
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new SpaceshipAPIError(
        "invalid_response",
        "Spaceship response exceeded the safety limit.",
      );
    }

    const chunks = [];
    let totalBytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new SpaceshipAPIError(
            "invalid_response",
            "Spaceship response exceeded the safety limit.",
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof SpaceshipAPIError) throw error;
      if (timedOut || error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new SpaceshipAPIError("timeout", "Spaceship availability request timed out.");
      }
      throw new SpaceshipAPIError("network_error", "Spaceship connection failed.");
    }

    const raw = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }

    let decoded;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      decoded = parseStrictJson(text);
    } catch (error) {
      if (error instanceof RangeError || error instanceof SyntaxError || error instanceof TypeError) {
        throw new SpaceshipAPIError("invalid_response", "Spaceship returned invalid JSON.");
      }
      throw error;
    }
    if (!isObject(decoded)) {
      throw new SpaceshipAPIError(
        "invalid_response",
        "Spaceship returned an unexpected response shape.",
      );
    }
    return decoded;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function normalizePricing(value) {
  if (value == null) return [[], true];
  if (!Array.isArray(value)) return [[], false];

  const normalized = [];
  for (const item of value) {
    if (!isObject(item)) return [[], false];
    const { operation, price, currency } = item;
    if (
      typeof operation !== "string" ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price < 0 ||
      price > Number.MAX_SAFE_INTEGER ||
      typeof currency !== "string" ||
      !PREMIUM_OPERATIONS.has(operation) ||
      !CURRENCY_PATTERN.test(currency)
    ) {
      return [[], false];
    }
    normalized.push({ operation, price, currency: currency.toUpperCase() });
  }
  return [normalized, true];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownResult(domain) {
  return {
    domain,
    availability: "unknown",
    providerResult: null,
    premiumPricing: [],
  };
}

export class SpaceshipClient {
  constructor(
    apiKey,
    apiSecret,
    { timeout = DEFAULT_TIMEOUT, transport = postJson } = {},
  ) {
    if (!apiKey || !apiSecret) {
      throw new ConfigurationError(
        "SPACESHIP_API_KEY and SPACESHIP_API_SECRET must be present in the process environment.",
      );
    }
    for (const [name, credential] of [
      ["SPACESHIP_API_KEY", apiKey],
      ["SPACESHIP_API_SECRET", apiSecret],
    ]) {
      if (
        credential.length > 1024 ||
        [...credential].some(
          (character) => character.codePointAt(0) < 33 || character.codePointAt(0) > 126,
        )
      ) {
        throw new ConfigurationError(`${name} contains unsupported header characters.`);
      }
    }
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60) {
      throw new TypeError("Timeout must be greater than 0 and no more than 60 seconds.");
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.timeout = timeout;
    this.transport = transport;
  }

  safeMessage(message) {
    let safe = message;
    const secrets = [this.apiKey, this.apiSecret].sort((left, right) => right.length - left.length);
    for (const secret of secrets) {
      if (secret) safe = safe.split(secret).join("[REDACTED]");
    }
    return safe;
  }

  async checkDomains(values) {
    const domains = normalizeDomains(values);
    if (domains.length > MAX_DOMAINS) {
      return errorReport(
        "input_limit_exceeded",
        `At most ${MAX_DOMAINS} unique domains may be checked at once.`,
        domains,
      );
    }
    const checkedAt = utcNow();
    const results = new Map();
    const errors = [];
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-API-Key": this.apiKey,
      "X-API-Secret": this.apiSecret,
    };

    for (let start = 0; start < domains.length; start += BATCH_SIZE) {
      const batch = domains.slice(start, start + BATCH_SIZE);
      let items;
      try {
        const payload = await this.transport(
          API_URL,
          headers,
          { domains: batch },
          this.timeout,
        );
        items = payload?.domains;
        if (!Array.isArray(items)) {
          throw new SpaceshipAPIError(
            "invalid_response",
            "Spaceship response did not contain a domains array.",
          );
        }
      } catch (error) {
        if (!(error instanceof SpaceshipAPIError)) throw error;
        const affected = domains.slice(start);
        for (const domain of affected) {
          if (!results.has(domain)) results.set(domain, unknownResult(domain));
        }
        const normalizedError = {
          code: error.code,
          message: this.safeMessage(error.message),
          domains: affected,
        };
        if (error.status !== null) normalizedError.httpStatus = error.status;
        if (error.retryAfter) {
          normalizedError.retryAfter = this.safeMessage(String(error.retryAfter)).slice(0, 128);
        }
        errors.push(normalizedError);
        break;
      }

      const expected = new Set(batch);
      let batchResults = new Map();
      const invalidDomains = new Set();
      const statusErrors = new Map();
      let malformedItems = false;

      for (const item of items) {
        if (!isObject(item) || typeof item.domain !== "string") {
          malformedItems = true;
          continue;
        }
        let domain;
        try {
          domain = normalizeDomain(item.domain);
        } catch (error) {
          if (!(error instanceof DomainInputError)) throw error;
          malformedItems = true;
          continue;
        }
        if (!expected.has(domain)) {
          malformedItems = true;
          continue;
        }
        if (batchResults.has(domain) || invalidDomains.has(domain)) {
          invalidDomains.add(domain);
          batchResults.delete(domain);
          continue;
        }

        const providerResult = item.result;
        const [premiumPricing, validPricing] = normalizePricing(item.premiumPricing);
        if (!AVAILABILITY_MAP.has(providerResult) || !validPricing) {
          invalidDomains.add(domain);
          continue;
        }
        batchResults.set(domain, {
          domain,
          availability: AVAILABILITY_MAP.get(providerResult),
          providerResult,
          premiumPricing,
        });
        if (STATUS_ERRORS.has(providerResult)) {
          const affected = statusErrors.get(providerResult) ?? [];
          affected.push(domain);
          statusErrors.set(providerResult, affected);
        }
      }

      if (invalidDomains.size) {
        for (const domain of invalidDomains) batchResults.set(domain, unknownResult(domain));
        errors.push({
          code: "invalid_results",
          message: "Spaceship returned duplicate or malformed data for one or more domains.",
          domains: batch.filter((domain) => invalidDomains.has(domain)),
        });
      }
      for (const [providerResult, affectedDomains] of statusErrors) {
        const [code, message] = STATUS_ERRORS.get(providerResult);
        errors.push({ code, message, domains: affectedDomains });
      }
      if (malformedItems) {
        const affected = domains.slice(start);
        batchResults = new Map(affected.map((domain) => [domain, unknownResult(domain)]));
        errors.push({
          code: "unexpected_results",
          message:
            "Spaceship returned unexpected response items; the current and remaining batches were not trusted.",
          domains: affected,
        });
      }

      for (const [domain, result] of batchResults) results.set(domain, result);
      const missing = batch.filter((domain) => !batchResults.has(domain));
      if (missing.length) {
        for (const domain of missing) results.set(domain, unknownResult(domain));
        errors.push({
          code: "missing_results",
          message: "Spaceship omitted one or more requested domains from its response.",
          domains: missing,
        });
      }
      if (malformedItems) break;
    }

    return {
      provider: "spaceship",
      checkedAt,
      complete: errors.length === 0,
      results: domains.map((domain) => results.get(domain) ?? unknownResult(domain)),
      errors,
    };
  }
}

function errorReport(code, message, domains = []) {
  return {
    provider: "spaceship",
    checkedAt: utcNow(),
    complete: false,
    results: domains.map(unknownResult),
    errors: [{ code, message, domains: [...domains] }],
  };
}

function parseArgs(argv) {
  const args = {
    domains: [],
    stdin: false,
    timeout: DEFAULT_TIMEOUT,
    pretty: false,
  };
  let parseOptions = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (parseOptions && argument === "--") {
      parseOptions = false;
    } else if (parseOptions && argument === "--stdin") {
      args.stdin = true;
    } else if (parseOptions && argument === "--pretty") {
      args.pretty = true;
    } else if (parseOptions && (argument === "--timeout" || argument.startsWith("--timeout="))) {
      const raw = argument === "--timeout" ? argv[++index] : argument.slice("--timeout=".length);
      if (raw === undefined || raw === "") throw new UsageError("--timeout requires a value.");
      args.timeout = /^[+-]?(?:inf|infinity)$/i.test(raw)
        ? raw.startsWith("-")
          ? -Infinity
          : Infinity
        : Number(raw);
    } else if (parseOptions && argument.startsWith("-")) {
      throw new UsageError(`Unknown option: ${argument}`);
    } else {
      args.domains.push(argument);
    }
  }
  return args;
}

async function readAll(stream, maxBytes) {
  let content = "";
  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new DomainInputError(`Standard input exceeds the ${maxBytes}-byte limit.`);
    }
    content += chunk.toString();
  }
  return content;
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!isObject(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortedJsonValue(value[key]);
  return sorted;
}

function stringifyReport(report, pretty) {
  return JSON.stringify(sortedJsonValue(report), null, pretty ? 2 : undefined).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    transport,
  } = {},
) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`dotmole: ${error.message}\n`);
    return 2;
  }

  const rawDomains = [...args.domains];
  if (args.stdin) {
    let content;
    try {
      content = await readAll(stdin, MAX_STDIN_BYTES);
    } catch (error) {
      if (!(error instanceof DomainInputError)) throw error;
      const report = errorReport("input_limit_exceeded", error.message);
      stdout.write(`${stringifyReport(report, args.pretty)}\n`);
      return 2;
    }
    rawDomains.push(...content.split(/\r?\n/).filter((line) => line.trim()));
  }

  const valid = [];
  const inputErrors = [];
  const seen = new Set();
  for (const value of rawDomains) {
    try {
      const domain = normalizeDomain(value);
      if (!seen.has(domain)) {
        valid.push(domain);
        seen.add(domain);
      }
    } catch (error) {
      if (!(error instanceof DomainInputError)) throw error;
      inputErrors.push({ code: "invalid_domain", message: error.message, domains: [value] });
    }
  }

  if (!valid.length) {
    const report = errorReport("invalid_input", "No valid domains were provided.");
    report.errors = inputErrors.length ? inputErrors : report.errors;
    stdout.write(`${stringifyReport(report, args.pretty)}\n`);
    return 2;
  }

  if (valid.length > MAX_DOMAINS) {
    const report = errorReport(
      "input_limit_exceeded",
      `At most ${MAX_DOMAINS} unique domains may be checked at once.`,
      valid,
    );
    report.errors = [...inputErrors, ...report.errors];
    stdout.write(`${stringifyReport(report, args.pretty)}\n`);
    return 2;
  }

  const apiKey = env.SPACESHIP_API_KEY ?? "";
  const apiSecret = env.SPACESHIP_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    const missing = [
      ["SPACESHIP_API_KEY", apiKey],
      ["SPACESHIP_API_SECRET", apiSecret],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const report = errorReport(
      "missing_credentials",
      `Missing process environment variables: ${missing.join(", ")}.`,
      valid,
    );
    report.errors = [...inputErrors, ...report.errors];
    stdout.write(`${stringifyReport(report, args.pretty)}\n`);
    return 2;
  }

  let client;
  try {
    client = new SpaceshipClient(apiKey, apiSecret, {
      timeout: args.timeout,
      ...(transport ? { transport } : {}),
    });
  } catch (error) {
    if (!(error instanceof ConfigurationError || error instanceof TypeError)) throw error;
    const report = errorReport("configuration_error", error.message, valid);
    report.errors = [...inputErrors, ...report.errors];
    stdout.write(`${stringifyReport(report, args.pretty)}\n`);
    return 2;
  }

  const report = await client.checkDomains(valid);
  if (inputErrors.length) {
    report.complete = false;
    report.errors = [...inputErrors, ...report.errors];
  }
  stdout.write(`${stringifyReport(report, args.pretty)}\n`);
  if (report.errors.some((error) => error.code !== "invalid_domain")) return 3;
  return inputErrors.length ? 2 : 0;
}

const isMain =
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.exitCode = await main();
  } catch {
    process.stderr.write("dotmole: unexpected checker failure.\n");
    process.exitCode = 1;
  }
}
