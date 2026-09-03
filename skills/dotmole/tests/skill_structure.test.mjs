import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("frontmatter matches skill loader constraints", async () => {
  const content = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");
  const match = /^---\n(.*?)\n---/s.exec(content);
  assert.ok(match);

  const frontmatter = match[1];
  const topLevelKeys = new Set(
    frontmatter
      .split("\n")
      .filter((line) => line && !line.startsWith(" ") && line.includes(":"))
      .map((line) => line.split(":", 1)[0]),
  );
  const allowedKeys = new Set([
    "name",
    "description",
    "license",
    "allowed-tools",
    "metadata",
    "compatibility",
  ]);
  assert.equal([...topLevelKeys].every((key) => allowedKeys.has(key)), true);
  assert.match(frontmatter, /^name: dotmole$/m);

  const description = /^description: (.+)$/m.exec(frontmatter)?.[1];
  assert.ok(description);
  assert.ok(description.length <= 1024);
  assert.doesNotMatch(description, /[<>]/);
});

test("referenced resources exist", async () => {
  for (const relativePath of [
    "scripts/check_domains.mjs",
    "references/spaceship-api.md",
    "references/tld-guidance.md",
    "evals/evals.json",
  ]) {
    await assert.doesNotReject(readFile(resolve(skillDirectory, relativePath)));
  }
});

test("checker contains only the allowed Spaceship endpoint", async () => {
  const source = await readFile(resolve(skillDirectory, "scripts/check_domains.mjs"), "utf8");
  const spaceshipUrls = source.match(/https:\/\/spaceship\.dev[^"']+/g) ?? [];
  assert.deepEqual(spaceshipUrls, ["https://spaceship.dev/api/v1/domains/available"]);
});

test("checker runs when invoked through a symlinked installation", async () => {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "dotmole-test-"));
  const target = resolve(skillDirectory, "scripts/check_domains.mjs");
  const link = resolve(temporaryDirectory, "check_domains.mjs");
  await symlink(target, link);

  try {
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [link, "example.dev"], {
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    });

    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).errors[0].code, "missing_credentials");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
