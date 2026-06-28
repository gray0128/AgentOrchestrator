import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ErrorCode,
  InMemoryDeliveryStore,
  SqliteDeliveryStore,
  listRecentDeliveries,
  migrateStateDatabase,
  openStateDatabase,
  recordDeliveryOnce,
} from "../src/internal.ts";

test("first webhook delivery id is recorded as received", async () => {
  const store = new InMemoryDeliveryStore();
  const receivedAt = new Date("2026-06-24T00:00:00.000Z");

  const result = await recordDeliveryOnce(
    store,
    {
      deliveryId: "delivery-1",
      eventName: "issues",
      action: "labeled",
      repoOwner: "octo",
      repoName: "repo"
    },
    receivedAt
  );

  assert.equal(result.accepted, true);
  assert.equal(result.record.status, "received");
  assert.equal(result.record.receivedAt, receivedAt.toISOString());
  assert.equal(store.records.size, 1);
});

test("replayed webhook delivery ids are ignored without replacing the original record", async () => {
  const store = new InMemoryDeliveryStore();

  const first = await recordDeliveryOnce(
    store,
    { deliveryId: "delivery-1", eventName: "issues", action: "labeled" },
    new Date("2026-06-24T00:00:00.000Z")
  );
  const replay = await recordDeliveryOnce(
    store,
    { deliveryId: "delivery-1", eventName: "pull_request", action: "opened" },
    new Date("2026-06-24T00:01:00.000Z")
  );

  assert.equal(first.accepted, true);
  assert.equal(replay.accepted, false);
  assert.equal(replay.errorCode, ErrorCode.DeliveryDuplicate);
  assert.equal(replay.record.eventName, "issues");
  assert.equal(replay.record.action, "labeled");
  assert.equal(replay.record.receivedAt, "2026-06-24T00:00:00.000Z");
  assert.equal(store.records.size, 1);
});

test("sqlite delivery store persists dedupe records across new store instances", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const firstStore = new SqliteDeliveryStore(database);
  const receivedAt = new Date("2026-06-24T00:00:00.000Z");

  const first = await recordDeliveryOnce(
    firstStore,
    {
      deliveryId: "delivery-restart",
      eventName: "issues",
      action: "labeled",
      repoOwner: "octo",
      repoName: "repo",
    },
    receivedAt
  );
  await firstStore.updateStatus("delivery-restart", {
    status: "processed",
    processedAt: "2026-06-24T00:00:05.000Z",
  });

  const secondStore = new SqliteDeliveryStore(database);
  const replay = await recordDeliveryOnce(
    secondStore,
    {
      deliveryId: "delivery-restart",
      eventName: "issues",
      action: "labeled",
      repoOwner: "octo",
      repoName: "repo",
    },
    new Date("2026-06-24T00:01:00.000Z")
  );

  assert.equal(first.accepted, true);
  assert.equal(replay.accepted, false);
  assert.equal(replay.errorCode, ErrorCode.DeliveryDuplicate);
  assert.equal(replay.record.status, "processed");
  assert.equal(replay.record.repoOwner, "octo");
  assert.equal(replay.record.repoName, "repo");

  const deliveries = listRecentDeliveries(database, { limit: 10 });
  assert.equal(deliveries.total, 1);
  assert.equal(deliveries.items[0]?.deliveryId, "delivery-restart");
  assert.equal(deliveries.items[0]?.status, "processed");
  database.close();
});
