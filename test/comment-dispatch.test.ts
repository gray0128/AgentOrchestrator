import { strict as assert } from "node:assert";
import test from "node:test";

import { resolveLinkedIssueNumber } from "../src/webhooks/comment-dispatch.ts";

test("resolveLinkedIssueNumber prefers agent branch naming", () => {
  assert.equal(
    resolveLinkedIssueNumber({
      body: "Closes #99",
      headRef: "agent/issue-13-task"
    }),
    13
  );
});

test("resolveLinkedIssueNumber falls back to Closes marker", () => {
  assert.equal(
    resolveLinkedIssueNumber({
      body: "Plan link\n\nCloses #13"
    }),
    13
  );
});
