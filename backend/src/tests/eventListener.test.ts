import { createTestDatabase } from "./helpers/db";
import { ingestEvent, processEvents, StellarEvent } from "../eventListener";

const db = createTestDatabase();

beforeAll(async () => {
  await db.setup();
});

afterAll(async () => {
  await db.teardown();
});

beforeEach(async () => {
  await db.clearAll();
});

describe("ingestEvent", () => {
  it("stores a new event in the database", async () => {
    const event: StellarEvent = {
      txHash: "tx_abc123",
      eventType: "SESSION_BOOKED",
      payload: { expertId: "exp_1", seekerId: "user_2", sessionDate: "2026-08-01" },
    };

    const result = await ingestEvent(db.prisma, event);

    expect(result.created).toBe(true);
    expect(typeof result.id).toBe("string");

    const stored = await db.prisma.eventLog.findUnique({ where: { txHash: "tx_abc123" } });
    expect(stored).not.toBeNull();
    expect(stored?.eventType).toBe("SESSION_BOOKED");
    expect(stored?.processed).toBe(false);
    expect(JSON.parse(stored?.payload ?? "{}")).toMatchObject({
      expertId: "exp_1",
    });
  });

  it("deduplicates events with the same txHash", async () => {
    const event: StellarEvent = {
      txHash: "tx_dup456",
      eventType: "PAYMENT_RELEASED",
      payload: { amount: 100 },
    };

    const first = await ingestEvent(db.prisma, event);
    const second = await ingestEvent(db.prisma, event);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const count = await db.prisma.eventLog.count({ where: { txHash: "tx_dup456" } });
    expect(count).toBe(1);
  });

  it("stores multiple distinct events", async () => {
    const events: StellarEvent[] = [
      { txHash: "tx_1", eventType: "SESSION_BOOKED", payload: { expertId: "e1" } },
      { txHash: "tx_2", eventType: "SESSION_COMPLETED", payload: { sessionId: "s1" } },
      { txHash: "tx_3", eventType: "PAYMENT_RELEASED", payload: { amount: 50 } },
    ];

    for (const event of events) {
      await ingestEvent(db.prisma, event);
    }

    const count = await db.prisma.eventLog.count();
    expect(count).toBe(3);
  });
});

describe("processEvents", () => {
  it("returns zero processed when no unprocessed events exist", async () => {
    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("processes an EXPERT_REGISTERED event and creates user + expert", async () => {
    const walletAddress = "GTEST_STELLAR_WALLET_PROCESSEVENTS";
    await ingestEvent(db.prisma, {
      txHash: "tx_expert_reg_001",
      eventType: "EXPERT_REGISTERED",
      payload: { walletAddress, name: "Stellar Expert" },
    });

    const result = await processEvents(db.prisma);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify the expert was created
    const user = await db.prisma.user.findUnique({ where: { walletAddress } });
    expect(user).not.toBeNull();

    const expert = await db.prisma.expert.findUnique({ where: { userId: user!.id } });
    expect(expert).not.toBeNull();
    expect(expert?.name).toBe("Stellar Expert");

    // Verify the event is now marked processed
    const log = await db.prisma.eventLog.findUnique({ where: { txHash: "tx_expert_reg_001" } });
    expect(log?.processed).toBe(true);
    expect(log?.processedAt).not.toBeNull();
  });

  it("processes a SESSION_BOOKED event without error", async () => {
    await ingestEvent(db.prisma, {
      txHash: "tx_session_booked_001",
      eventType: "SESSION_BOOKED",
      payload: { expertId: "exp_1", seekerId: "user_2", sessionDate: "2026-08-01" },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("processes a SESSION_COMPLETED event without error", async () => {
    await ingestEvent(db.prisma, {
      txHash: "tx_session_complete_001",
      eventType: "SESSION_COMPLETED",
      payload: { sessionId: "sess_abc" },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("processes a PAYMENT_RELEASED event without error", async () => {
    await ingestEvent(db.prisma, {
      txHash: "tx_payment_001",
      eventType: "PAYMENT_RELEASED",
      payload: { amount: 250, currency: "XLM" },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("skips and records error for events with missing required fields", async () => {
    // SESSION_BOOKED without expertId
    await ingestEvent(db.prisma, {
      txHash: "tx_bad_booked",
      eventType: "SESSION_BOOKED",
      payload: { seekerId: "user_2" }, // missing expertId
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/missing expertId/i);
  });

  it("processes only unprocessed events", async () => {
    // Insert one already-processed event
    await db.prisma.eventLog.create({
      data: {
        txHash: "tx_already_done",
        eventType: "SESSION_BOOKED",
        payload: JSON.stringify({ expertId: "e1" }),
        processed: true,
        processedAt: new Date(),
      },
    });

    // Insert one unprocessed event
    await ingestEvent(db.prisma, {
      txHash: "tx_needs_processing",
      eventType: "PAYMENT_RELEASED",
      payload: { amount: 100 },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("handles multiple events in a single batch", async () => {
    const events: StellarEvent[] = [
      { txHash: "tx_batch_1", eventType: "SESSION_BOOKED", payload: { expertId: "e1" } },
      { txHash: "tx_batch_2", eventType: "SESSION_COMPLETED", payload: { sessionId: "s1" } },
      { txHash: "tx_batch_3", eventType: "PAYMENT_RELEASED", payload: { amount: 75 } },
    ];

    for (const event of events) {
      await ingestEvent(db.prisma, event);
    }

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // All events should now be marked processed
    const unprocessed = await db.prisma.eventLog.count({ where: { processed: false } });
    expect(unprocessed).toBe(0);
  });

  it("skips events with invalid JSON payload", async () => {
    // Bypass ingestEvent to insert a bad payload directly
    await db.prisma.eventLog.create({
      data: {
        txHash: "tx_bad_json",
        eventType: "SESSION_BOOKED",
        payload: "this is not json {{{{",
        processed: false,
      },
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/invalid json payload/i);
  });

  it("idempotent — re-running processEvents does not re-process already processed events", async () => {
    await ingestEvent(db.prisma, {
      txHash: "tx_idempotent_001",
      eventType: "PAYMENT_RELEASED",
      payload: { amount: 50 },
    });

    const first = await processEvents(db.prisma);
    expect(first.processed).toBe(1);

    // Run again — should process nothing
    const second = await processEvents(db.prisma);
    expect(second.processed).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it("EXPERT_REGISTERED is idempotent for existing user (upsert)", async () => {
    const walletAddress = "GTEST_UPSERT_WALLET";

    await ingestEvent(db.prisma, {
      txHash: "tx_reg_upsert_1",
      eventType: "EXPERT_REGISTERED",
      payload: { walletAddress, name: "First Name" },
    });
    await processEvents(db.prisma);

    await ingestEvent(db.prisma, {
      txHash: "tx_reg_upsert_2",
      eventType: "EXPERT_REGISTERED",
      payload: { walletAddress, name: "Updated Name" },
    });
    await processEvents(db.prisma);

    const user = await db.prisma.user.findUnique({ where: { walletAddress } });
    const expert = await db.prisma.expert.findUnique({ where: { userId: user!.id } });
    expect(expert?.name).toBe("Updated Name");

    // Only one user and expert should exist
    const userCount = await db.prisma.user.count({ where: { walletAddress } });
    expect(userCount).toBe(1);
  });

  it("skips events with unknown event type", async () => {
    // Insert an event with an unrecognised type directly
    await db.prisma.eventLog.create({
      data: {
        txHash: "tx_unknown_type",
        eventType: "UNKNOWN_EVENT",
        payload: JSON.stringify({ foo: "bar" }),
        processed: false,
      },
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/unknown event type/i);
  });

  it("skips EXPERT_REGISTERED event with missing walletAddress", async () => {
    await ingestEvent(db.prisma, {
      txHash: "tx_reg_no_wallet",
      eventType: "EXPERT_REGISTERED",
      payload: { name: "No Wallet" }, // missing walletAddress
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing walletAddress/i);
  });

  it("skips SESSION_COMPLETED event with missing sessionId", async () => {
    await ingestEvent(db.prisma, {
      txHash: "tx_completed_no_session",
      eventType: "SESSION_COMPLETED",
      payload: {}, // missing sessionId
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing sessionId/i);
  });

  it("skips PAYMENT_RELEASED event with missing amount", async () => {
    await ingestEvent(db.prisma, {
      txHash: "tx_payment_no_amount",
      eventType: "PAYMENT_RELEASED",
      payload: {}, // missing amount
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing amount/i);
  });
});
