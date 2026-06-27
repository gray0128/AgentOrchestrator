import { ErrorCode } from "../errors.ts";
import {
  getDelivery,
  insertDeliveryIfAbsent,
  updateDeliveryStatus,
} from "../state/sqlite-store.ts";
import type { DeliveryRow, StateDatabase } from "../state/sqlite-store.ts";

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

export type DeliveryStatusUpdate = {
  readonly status: DeliveryStatus;
  readonly processedAt?: string;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
};

export interface DeliveryStore {
  insertIfAbsent(record: DeliveryRecord): Promise<boolean>;
  get(deliveryId: string): Promise<DeliveryRecord | undefined>;
  updateStatus(deliveryId: string, update: DeliveryStatusUpdate): Promise<void>;
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

  async updateStatus(deliveryId: string, update: DeliveryStatusUpdate): Promise<void> {
    const existing = this.records.get(deliveryId);
    if (!existing) {
      return;
    }

    this.records.set(deliveryId, {
      ...existing,
      status: update.status,
      processedAt: update.processedAt ?? existing.processedAt,
      errorCode: update.errorCode ?? existing.errorCode,
      errorMessage: update.errorMessage ?? existing.errorMessage,
    });
  }
}

export class SqliteDeliveryStore implements DeliveryStore {
  private readonly database: StateDatabase;

  constructor(database: StateDatabase) {
    this.database = database;
  }

  async insertIfAbsent(record: DeliveryRecord): Promise<boolean> {
    return insertDeliveryIfAbsent(this.database, {
      deliveryId: record.deliveryId,
      eventName: record.eventName,
      action: record.action,
      repoOwner: record.repoOwner,
      repoName: record.repoName,
      receivedAt: record.receivedAt,
      status: record.status,
    });
  }

  async get(deliveryId: string): Promise<DeliveryRecord | undefined> {
    const row = getDelivery(this.database, deliveryId);
    return row ? mapDeliveryRow(row) : undefined;
  }

  async updateStatus(deliveryId: string, update: DeliveryStatusUpdate): Promise<void> {
    updateDeliveryStatus(this.database, {
      deliveryId,
      status: update.status,
      processedAt: update.processedAt,
      errorCode: update.errorCode,
      errorMessage: update.errorMessage,
    });
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

export async function finalizeDeliveryStatus(
  store: DeliveryStore,
  deliveryId: string,
  update: DeliveryStatusUpdate,
  now = new Date()
): Promise<void> {
  await store.updateStatus(deliveryId, {
    ...update,
    processedAt: update.processedAt ?? now.toISOString(),
  });
}

function mapDeliveryRow(row: DeliveryRow): DeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    eventName: row.event_name,
    action: row.action ?? undefined,
    repoOwner: row.repo_owner ?? undefined,
    repoName: row.repo_name ?? undefined,
    receivedAt: row.received_at,
    processedAt: row.processed_at ?? undefined,
    status: row.status,
    errorCode: row.error_code ? (row.error_code as ErrorCode) : undefined,
    errorMessage: row.error_message ?? undefined,
  };
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
