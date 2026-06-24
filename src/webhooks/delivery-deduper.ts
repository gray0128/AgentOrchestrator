import { ErrorCode } from "../errors.ts";

export type DeliveryStatus = "received" | "ignored" | "processed" | "failed";

export type DeliveryRecord = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action?: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
  readonly receivedAt: string;
  readonly processedAt?: string;
  readonly status: DeliveryStatus;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
};

export type DeliveryInput = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action?: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
};

export type DeliveryDeduperResult =
  | { readonly accepted: true; readonly record: DeliveryRecord }
  | { readonly accepted: false; readonly errorCode: typeof ErrorCode.DeliveryDuplicate; readonly record: DeliveryRecord };

export interface DeliveryStore {
  insertIfAbsent(record: DeliveryRecord): Promise<boolean>;
  get(deliveryId: string): Promise<DeliveryRecord | undefined>;
}

export class InMemoryDeliveryStore implements DeliveryStore {
  readonly records = new Map<string, DeliveryRecord>();

  async insertIfAbsent(record: DeliveryRecord): Promise<boolean> {
    if (this.records.has(record.deliveryId)) {
      return false;
    }

    this.records.set(record.deliveryId, record);
    return true;
  }

  async get(deliveryId: string): Promise<DeliveryRecord | undefined> {
    return this.records.get(deliveryId);
  }
}

export async function recordDeliveryOnce(
  store: DeliveryStore,
  input: DeliveryInput,
  now = new Date()
): Promise<DeliveryDeduperResult> {
  const record = createDeliveryRecord(input, now);
  const inserted = await store.insertIfAbsent(record);

  if (!inserted) {
    const existingRecord = await store.get(input.deliveryId);
    return {
      accepted: false,
      errorCode: ErrorCode.DeliveryDuplicate,
      record: existingRecord ?? record
    };
  }

  return { accepted: true, record };
}

function createDeliveryRecord(input: DeliveryInput, now: Date): DeliveryRecord {
  if (input.deliveryId.length === 0) {
    throw new Error("deliveryId is required");
  }
  if (input.eventName.length === 0) {
    throw new Error("eventName is required");
  }

  return {
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    action: input.action,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    receivedAt: now.toISOString(),
    status: "received"
  };
}
