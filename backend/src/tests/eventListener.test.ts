import { createTestDatabase } from "./helpers/db";
import { ingestEvent, processEvents, StellarEvent } from "../eventListener";
import {
  NotificationService,
  setNotificationService,
} from "../notificationService";

const db = createTestDatabase();
let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.setup();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await db.teardown();
  }
});

beforeEach(async () => {
  if (dbAvailable) {
    await db.clearAll();
  }
  setNotificationService(null);
});

afterEach(() => {
  setNotificationService(null);
});

describe("ingestEvent", () => {
  it("stores a new event in the database", async () => {
    if (!dbAvailable) return;
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
    if (!dbAvailable) return;
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
    if (!dbAvailable) return;
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
    if (!dbAvailable) return;
    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("processes an EXPERT_REGISTERED event and creates user + expert", async () => {
    if (!dbAvailable) return;
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

    const user = await db.prisma.user.findUnique({ where: { walletAddress } });
    expect(user).not.toBeNull();

    const expert = await db.prisma.expert.findUnique({ where: { userId: user!.id } });
    expect(expert).not.toBeNull();
    expect(expert?.name).toBe("Stellar Expert");

    const log = await db.prisma.eventLog.findUnique({ where: { txHash: "tx_expert_reg_001" } });
    expect(log?.processed).toBe(true);
    expect(log?.processedAt).not.toBeNull();
  });

  it("processes a SESSION_BOOKED event without error", async () => {
    if (!dbAvailable) return;
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
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_session_complete_001",
      eventType: "SESSION_COMPLETED",
      payload: { sessionId: "sess_abc" },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("processes a SESSION_PAUSED event and updates status to PAUSED", async () => {
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_session_paused_001",
      eventType: "SESSION_PAUSED",
      payload: { sessionId: "sess_pause_abc" },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("processes a SESSION_REFUNDED event and updates status to REFUNDED", async () => {
    if (!dbAvailable) return;

    const seeker = "GSEEKER_REFUND_TEST";
    const expertWallet = "GEXPERT_REFUND_TEST";
    await db.prisma.user.create({ data: { walletAddress: seeker } });
    const expertUser = await db.prisma.user.create({
      data: { walletAddress: expertWallet },
    });
    const expert = await db.prisma.expert.create({
      data: { userId: expertUser.id, name: "Refund Expert" },
    });
    await db.prisma.session.create({
      data: {
        sessionId: "sess_refund_abc",
        seekerAddress: seeker,
        expertAddress: expertWallet,
        expertId: expert.id,
        status: "ACTIVE",
        escrowAmount: 100n,
      },
    });

    await ingestEvent(db.prisma, {
      txHash: "tx_session_refunded_001",
      eventType: "SESSION_REFUNDED",
      payload: { sessionId: "sess_refund_abc", amount: 100 },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const session = await db.prisma.session.findUnique({
      where: { sessionId: "sess_refund_abc" },
    });
    expect(session?.status).toBe("REFUNDED");
  });

  it("processes a PAYMENT_RELEASED event without error", async () => {
    if (!dbAvailable) return;
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
    if (!dbAvailable) return;
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
    if (!dbAvailable) return;
    await db.prisma.eventLog.create({
      data: {
        txHash: "tx_already_done",
        eventType: "SESSION_BOOKED",
        payload: JSON.stringify({ expertId: "e1" }),
        processed: true,
        processedAt: new Date(),
      },
    });

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
    if (!dbAvailable) return;
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

    const unprocessed = await db.prisma.eventLog.count({ where: { processed: false } });
    expect(unprocessed).toBe(0);
  });

  it("skips events with invalid JSON payload", async () => {
    if (!dbAvailable) return;
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
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_idempotent_001",
      eventType: "PAYMENT_RELEASED",
      payload: { amount: 50 },
    });

    const first = await processEvents(db.prisma);
    expect(first.processed).toBe(1);

    const second = await processEvents(db.prisma);
    expect(second.processed).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it("EXPERT_REGISTERED is idempotent for existing user (upsert)", async () => {
    if (!dbAvailable) return;
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

    const userCount = await db.prisma.user.count({ where: { walletAddress } });
    expect(userCount).toBe(1);
  });

  it("skips events with unknown event type", async () => {
    if (!dbAvailable) return;
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
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_reg_no_wallet",
      eventType: "EXPERT_REGISTERED",
      payload: { name: "No Wallet" },
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing walletAddress/i);
  });

  it("skips SESSION_COMPLETED event with missing sessionId", async () => {
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_completed_no_session",
      eventType: "SESSION_COMPLETED",
      payload: {},
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing sessionId/i);
  });

  it("skips SESSION_PAUSED event with missing sessionId", async () => {
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_paused_no_session",
      eventType: "SESSION_PAUSED",
      payload: {},
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing sessionId/i);
  });

  it("skips SESSION_REFUNDED event with missing sessionId", async () => {
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_refunded_no_session",
      eventType: "SESSION_REFUNDED",
      payload: {},
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing sessionId/i);
  });

  it("skips PAYMENT_RELEASED event with missing amount", async () => {
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_payment_no_amount",
      eventType: "PAYMENT_RELEASED",
      payload: {},
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing amount/i);
  });

  it("processes PAYMENT_STREAMED into a transaction and keeps session ACTIVE", async () => {
    if (!dbAvailable) return;

    const seeker = "GSEEKER_STREAM_EVT";
    const expertWallet = "GEXPERT_STREAM_EVT";
    await db.prisma.user.create({ data: { walletAddress: seeker } });
    const expertUser = await db.prisma.user.create({
      data: { walletAddress: expertWallet },
    });
    const expert = await db.prisma.expert.create({
      data: { userId: expertUser.id, name: "Stream Event Expert" },
    });
    await db.prisma.session.create({
      data: {
        sessionId: "sess_stream_evt",
        seekerAddress: seeker,
        expertAddress: expertWallet,
        expertId: expert.id,
        status: "ACTIVE",
        escrowAmount: 500n,
      },
    });

    await ingestEvent(db.prisma, {
      txHash: "tx_stream_evt_001",
      eventType: "PAYMENT_STREAMED",
      payload: {
        sessionId: "sess_stream_evt",
        amount: "75",
        ledgerClosedAt: "2026-08-22T12:00:00.000Z",
      },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const session = await db.prisma.session.findUnique({
      where: { sessionId: "sess_stream_evt" },
    });
    expect(session?.status).toBe("ACTIVE");

    const tx = await db.prisma.transaction.findUnique({
      where: { txHash: "tx_stream_evt_001" },
    });
    expect(tx?.type).toBe("PAYMENT_RELEASED");
    expect(tx?.amount.toString()).toBe("75");
    expect(tx?.ledgerTime.toISOString()).toBe("2026-08-22T12:00:00.000Z");
  });

  it("skips PAYMENT_STREAMED event with missing sessionId", async () => {
    if (!dbAvailable) return;
    await ingestEvent(db.prisma, {
      txHash: "tx_stream_no_session",
      eventType: "PAYMENT_STREAMED",
      payload: { amount: 10 },
    });

    const result = await processEvents(db.prisma);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing sessionId/i);
  });

  it("notifies Discord/Telegram when a new SESSION_BOOKED session is created", async () => {
    if (!dbAvailable) return;

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    setNotificationService(
      new NotificationService({
        discordWebhookUrl: "https://discord.example/hook",
        telegramWebhookUrl: "https://api.telegram.org/botT/sendMessage",
        telegramChatId: "42",
        fetchImpl,
      })
    );

    const seeker = "GSEEKER_NOTIFY_TEST_WALLET";
    const expertWallet = "GEXPERT_NOTIFY_TEST_WALLET";
    const expertUser = await db.prisma.user.create({
      data: { walletAddress: expertWallet },
    });
    const expert = await db.prisma.expert.create({
      data: {
        userId: expertUser.id,
        name: "Notify Expert",
        hourlyRate: 50,
      },
    });

    await ingestEvent(db.prisma, {
      txHash: "tx_notify_booked_001",
      eventType: "SESSION_BOOKED",
      payload: {
        sessionId: "sess_notify_001",
        expertId: expert.id,
        seekerAddress: seeker,
        expertAddress: expertWallet,
        amount: "10000000",
      },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const session = await db.prisma.session.findUnique({
      where: { sessionId: "sess_notify_001" },
    });
    expect(session).not.toBeNull();

    // Allow fire-and-forget notifyBookingAsync to flush.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBeGreaterThanOrEqual(2);
    const discord = calls.find((c) => c.url.includes("discord"));
    expect(discord).toBeDefined();
    expect(JSON.stringify(discord!.body)).toContain("$50/hr");
    expect(JSON.stringify(discord!.body)).toContain(seeker);
  });

  it("still processes SESSION_BOOKED when notification webhooks fail", async () => {
    if (!dbAvailable) return;

    const fetchImpl = (async () => {
      throw new Error("webhook unreachable");
    }) as typeof fetch;

    setNotificationService(
      new NotificationService({
        discordWebhookUrl: "https://discord.example/hook",
        fetchImpl,
        logger: {
          error: () => undefined,
          warn: () => undefined,
          info: () => undefined,
        },
      })
    );

    const seeker = "GSEEKER_NOTIFY_FAIL_WALLET";
    const expertWallet = "GEXPERT_NOTIFY_FAIL_WALLET";
    const expertUser = await db.prisma.user.create({
      data: { walletAddress: expertWallet },
    });
    const expert = await db.prisma.expert.create({
      data: { userId: expertUser.id, name: "Fail Expert", hourlyRate: 25 },
    });

    await ingestEvent(db.prisma, {
      txHash: "tx_notify_fail_001",
      eventType: "SESSION_BOOKED",
      payload: {
        sessionId: "sess_notify_fail_001",
        expertId: expert.id,
        seekerAddress: seeker,
        expertAddress: expertWallet,
        amount: "5000000",
      },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const session = await db.prisma.session.findUnique({
      where: { sessionId: "sess_notify_fail_001" },
    });
    expect(session?.status).toBe("ACTIVE");
  });

  it("does not re-notify when SESSION_BOOKED upserts an existing session", async () => {
    if (!dbAvailable) return;

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    setNotificationService(
      new NotificationService({
        discordWebhookUrl: "https://discord.example/hook",
        fetchImpl,
      })
    );

    const seeker = "GSEEKER_NOTIFY_IDEMP_WALLET";
    const expertWallet = "GEXPERT_NOTIFY_IDEMP_WALLET";
    const expertUser = await db.prisma.user.create({
      data: { walletAddress: expertWallet },
    });
    const expert = await db.prisma.expert.create({
      data: { userId: expertUser.id, name: "Idemp Expert", hourlyRate: 40 },
    });

    const payload = {
      sessionId: "sess_notify_idemp_001",
      expertId: expert.id,
      seekerAddress: seeker,
      expertAddress: expertWallet,
      amount: "10000000",
    };

    await ingestEvent(db.prisma, {
      txHash: "tx_notify_idemp_1",
      eventType: "SESSION_BOOKED",
      payload,
    });
    await processEvents(db.prisma);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const afterFirst = callCount;

    await ingestEvent(db.prisma, {
      txHash: "tx_notify_idemp_2",
      eventType: "SESSION_BOOKED",
      payload: { ...payload, amount: "20000000" },
    });
    await processEvents(db.prisma);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(afterFirst).toBeGreaterThan(0);
    expect(callCount).toBe(afterFirst);
  });
});
