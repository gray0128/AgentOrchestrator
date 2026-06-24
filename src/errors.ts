export const ErrorCode = {
  AgentProcessFailed: "AGENT_PROCESS_FAILED",
  AgentSchemaInvalid: "AGENT_SCHEMA_INVALID",
  DeliveryDuplicate: "DELIVERY_DUPLICATE",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",
  WebhookSignatureInvalid: "WEBHOOK_SIGNATURE_INVALID",
  WebhookPayloadInvalid: "WEBHOOK_PAYLOAD_INVALID"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class OrchestratorError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}
