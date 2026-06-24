import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ErrorCode,
  OrchestratorError,
  assertWebhookPayloadSize,
  createSignature,
  defaultWebhookMaxPayloadBytes,
  verifyWebhookSignature
} from "../src/index.ts";

test("valid GitHub sha256 webhook signatures pass", () => {
  const payload = Buffer.from(JSON.stringify({ action: "labeled", issue: { number: 1 } }));
  const secret = "test-webhook-secret";
  const signatureHeader = createSignature(payload, secret);

  assert.doesNotThrow(() => verifyWebhookSignature({ payload, secret, signatureHeader }));
});

test("invalid GitHub sha256 webhook signatures fail", () => {
  const payload = Buffer.from(JSON.stringify({ action: "labeled" }));
  const secret = "test-webhook-secret";
  const signatureHeader = createSignature(Buffer.from("different-payload"), secret);

  assertOrchestratorError(
    () => verifyWebhookSignature({ payload, secret, signatureHeader }),
    ErrorCode.WebhookSignatureInvalid
  );
});

test("missing or malformed signature headers fail", () => {
  const payload = "{}";
  const secret = "test-webhook-secret";

  for (const signatureHeader of [undefined, "", "sha1=abc", "sha256=not-hex"]) {
    assertOrchestratorError(
      () => verifyWebhookSignature({ payload, secret, signatureHeader }),
      ErrorCode.WebhookSignatureInvalid
    );
  }
});

test("payload size limits are enforced before signature acceptance", () => {
  const payload = "123456";
  const secret = "test-webhook-secret";
  const signatureHeader = createSignature(payload, secret);

  assertOrchestratorError(
    () => verifyWebhookSignature({ payload, secret, signatureHeader, maxPayloadBytes: 5 }),
    ErrorCode.WebhookPayloadInvalid
  );
  assert.doesNotThrow(() => verifyWebhookSignature({ payload, secret, signatureHeader, maxPayloadBytes: 6 }));
});

test("default webhook payload limit is 25 MiB", () => {
  assert.equal(defaultWebhookMaxPayloadBytes, 25 * 1024 * 1024);
  assert.doesNotThrow(() => assertWebhookPayloadSize(Buffer.alloc(1), defaultWebhookMaxPayloadBytes));
});

function assertOrchestratorError(fn: () => void, code: ErrorCode): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof OrchestratorError && error.code === code
  );
}
