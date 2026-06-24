import { createHmac, timingSafeEqual } from "node:crypto";

import { ErrorCode, OrchestratorError } from "../errors.ts";

const signaturePrefix = "sha256=";

export const defaultWebhookMaxPayloadBytes = 25 * 1024 * 1024;

export type RawWebhookPayload = Buffer | Uint8Array | string;

export type VerifyWebhookSignatureInput = {
  readonly payload: RawWebhookPayload;
  readonly secret: string;
  readonly signatureHeader: string | undefined;
  readonly maxPayloadBytes?: number;
};

export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): void {
  assertWebhookPayloadSize(input.payload, input.maxPayloadBytes);
  assertWebhookSecret(input.secret);

  const expected = createSignature(input.payload, input.secret);
  const actual = parseSignatureHeader(input.signatureHeader);

  if (!actual || !timingSafeSignatureEqual(actual, expected)) {
    throw new OrchestratorError(
      ErrorCode.WebhookSignatureInvalid,
      "GitHub webhook signature verification failed"
    );
  }
}

export function createSignature(payload: RawWebhookPayload, secret: string): string {
  assertWebhookSecret(secret);
  return `${signaturePrefix}${createHmac("sha256", secret).update(toBuffer(payload)).digest("hex")}`;
}

export function assertWebhookPayloadSize(
  payload: RawWebhookPayload,
  maxPayloadBytes = defaultWebhookMaxPayloadBytes
): void {
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new OrchestratorError(ErrorCode.WebhookPayloadInvalid, "Webhook payload limit is invalid");
  }

  const payloadBytes = Buffer.byteLength(toBuffer(payload));
  if (payloadBytes > maxPayloadBytes) {
    throw new OrchestratorError(ErrorCode.WebhookPayloadInvalid, "Webhook payload exceeds size limit");
  }
}

function assertWebhookSecret(secret: string): void {
  if (secret.length === 0) {
    throw new OrchestratorError(ErrorCode.WebhookSignatureInvalid, "Webhook secret is required");
  }
}

function parseSignatureHeader(header: string | undefined): Buffer | undefined {
  if (!header?.startsWith(signaturePrefix)) {
    return undefined;
  }

  const hex = header.slice(signaturePrefix.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return undefined;
  }

  return Buffer.from(hex, "hex");
}

function timingSafeSignatureEqual(actual: Buffer, expectedHeader: string): boolean {
  const expected = parseSignatureHeader(expectedHeader);
  if (!expected || actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

function toBuffer(payload: RawWebhookPayload): Buffer {
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}
