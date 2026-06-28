import { strict as assert } from "node:assert";
import { test } from "node:test";

import * as publicApi from "../src/index.ts";

test("public entrypoint exports only stable operator-facing API", () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    "ErrorCode",
    "OrchestratorError",
    "defaultUiHost",
    "defaultUiPort",
    "getRuntimeInfo",
    "runCli",
    "runUiBrowserSmoke",
    "startServeRuntime",
    "startUiRuntime",
  ]);
  assert.equal("FakeGitHubApiAdapter" in publicApi, false);
  assert.equal("openStateDatabase" in publicApi, false);
  assert.equal("normalizeGitHubWebhook" in publicApi, false);
});
