import { strict as assert } from "node:assert";
import test from "node:test";

import { evaluatePathPolicy, matchesPathPattern } from "../src/index.ts";

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

test("path pattern matcher supports directory and simple glob patterns", () => {
  assert.equal(matchesPathPattern("src/a.ts", "src/**"), true);
  assert.equal(matchesPathPattern("nested/package.json", "**/package.json"), true);
  assert.equal(matchesPathPattern("src/a.test.ts", "src/*.test.ts"), true);
  assert.equal(matchesPathPattern("src/nested/a.test.ts", "src/*.test.ts"), false);
});
