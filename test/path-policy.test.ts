import { strict as assert } from "node:assert";
import test from "node:test";

import { evaluatePathPolicy, matchesPathPattern, resolvePathPolicyBlock } from "../src/internal.ts";

test("path policy allows actual changed files inside allow rules", () => {
  assert.deepEqual(
    evaluatePathPolicy({
      changedFiles: ["src/a.ts", "test/a.test.ts"],
      allow: ["src/**", "test/**"],
      deny: [".github/**"],
      highRisk: ["package-lock.json"]
    }),
    {
      allowed: true,
      denied: [],
      highRisk: [],
      outsideAllow: []
    }
  );
});

test("path policy blocks deny, high-risk, and outside-allow files from actual diff", () => {
  assert.deepEqual(
    evaluatePathPolicy({
      changedFiles: ["src/a.ts", ".github/workflows/ci.yml", "package-lock.json", "docs/readme.md"],
      allow: ["src/**", "test/**"],
      deny: [".github/**"],
      highRisk: ["package-lock.json"]
    }),
    {
      allowed: false,
      denied: [".github/workflows/ci.yml"],
      highRisk: ["package-lock.json"],
      outsideAllow: [".github/workflows/ci.yml", "package-lock.json", "docs/readme.md"]
    }
  );
});

test("resolvePathPolicyBlock returns null when actual diff paths are allowed", () => {
  const decision = evaluatePathPolicy({
    changedFiles: ["docs/example.md"],
    allow: ["docs/**"],
    deny: [".github/**"],
    highRisk: ["package-lock.json"]
  });
  assert.equal(resolvePathPolicyBlock(decision), null);
});

test("resolvePathPolicyBlock maps deny, high-risk, and outside-allow violations to blocked handling", () => {
  const denied = resolvePathPolicyBlock(
    evaluatePathPolicy({
      changedFiles: [".github/workflows/ci.yml"],
      allow: ["docs/**"],
      deny: [".github/**"],
      highRisk: []
    })
  );
  assert.equal(denied?.errorCode, "POLICY_DENIED_PATH");
  assert.match(denied?.explanation ?? "", /Denied paths from actual git diff: \.github\/workflows\/ci\.yml/);

  const highRisk = resolvePathPolicyBlock(
    evaluatePathPolicy({
      changedFiles: ["package-lock.json"],
      allow: [],
      deny: [],
      highRisk: ["package-lock.json"]
    })
  );
  assert.equal(highRisk?.errorCode, "POLICY_HIGH_RISK_PATH");
  assert.match(highRisk?.explanation ?? "", /High-risk paths from actual git diff: package-lock\.json/);

  const outsideAllow = resolvePathPolicyBlock(
    evaluatePathPolicy({
      changedFiles: ["src/main.ts"],
      allow: ["docs/**"],
      deny: [],
      highRisk: []
    })
  );
  assert.equal(outsideAllow?.errorCode, "POLICY_DENIED_PATH");
  assert.match(outsideAllow?.explanation ?? "", /Paths outside allow rules from actual git diff: src\/main\.ts/);
});

test("path pattern matcher supports directory and simple glob patterns", () => {
  assert.equal(matchesPathPattern("src/a.ts", "src/**"), true);
  assert.equal(matchesPathPattern("nested/package.json", "**/package.json"), true);
  assert.equal(matchesPathPattern("src/a.test.ts", "src/*.test.ts"), true);
  assert.equal(matchesPathPattern("src/nested/a.test.ts", "src/*.test.ts"), false);
});
