import { createTestDatabase } from "./helpers/db";
import {
  parseScVal,
  toPlainObject,
  decodeEventPayload,
  getLastProcessedLedger,
  saveLastProcessedLedger,
  SorobanIndexerService,
} from "../sorobanIndexer";

describe("sorobanIndexer — XDR & Payload Decoding (Pure Unit Tests)", () => {
  it("decodes scVal strings and native topic strings", () => {
    const parsed = parseScVal("fund_session");
    expect(parsed).toBe("fund_session");
  });

  it("converts BigInt and Maps to plain JSON-serializable objects", () => {
    const map = new Map<string, unknown>();
    map.set("amount", 10000000n);
    map.set("nested", { count: 5n });

    const plain = toPlainObject(map) as Record<string, unknown>;
    expect(plain["amount"]).toBe("10000000");
    expect((plain["nested"] as Record<string, unknown>)["count"]).toBe("5");
  });

  it("decodes fund_session event topic and payload", () => {
    const payloadMap = new Map<string, unknown>([
      ["session_id", "sess-123-abc"],
      ["seeker_address", "GSEEKER_123"],
      ["expert_address", "GEXPERT_456"],
      ["expert_id", "exp_789"],
      ["amount", "50000000"],
    ]);

    const { eventType, payload } = decodeEventPayload(["fund_session"], payloadMap);

    expect(eventType).toBe("SESSION_BOOKED");
    expect(payload["sessionId"]).toBe("sess-123-abc");
    expect(payload["seekerAddress"]).toBe("GSEEKER_123");
    expect(payload["expertAddress"]).toBe("GEXPERT_456");
    expect(payload["expertId"]).toBe("exp_789");
    expect(payload["amount"]).toBe("50000000");
  });

  it("decodes pause_session event topic and payload", () => {
    const value = { session_id: "sess-pause-1" };
    const { eventType, payload } = decodeEventPayload(["pause_session"], value);

    expect(eventType).toBe("SESSION_PAUSED");
    expect(payload["sessionId"]).toBe("sess-pause-1");
  });

  it("decodes refund_session event topic and payload", () => {
    const value = { session_id: "sess-refund-1", amount: "2000" };
    const { eventType, payload } = decodeEventPayload(["refund_session"], value);

    expect(eventType).toBe("SESSION_REFUNDED");
    expect(payload["sessionId"]).toBe("sess-refund-1");
    expect(payload["amount"]).toBe("2000");
  });

  it("decodes complete_session event topic and payload", () => {
    const value = { session_id: "sess-complete-1", amount: "10000" };
    const { eventType, payload } = decodeEventPayload(["complete_session"], value);

    expect(eventType).toBe("SESSION_COMPLETED");
    expect(payload["sessionId"]).toBe("sess-complete-1");
    expect(payload["amount"]).toBe("10000");
  });

  it("gracefully handles invalid / unparsable event XDR without crashing", () => {
    const result = decodeEventPayload(["INVALID_NON_XDR_SYMBOL_***"], { invalid: Symbol("bad") });

    expect(result).toBeDefined();
    expect(result.eventType).toBeNull();
  });
});

describe("sorobanIndexer — Database & Service Logic", () => {
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
  });

  it("defaults to ledger sequence 0 when uninitialized", async () => {
    if (!dbAvailable) return;
    const ledger = await getLastProcessedLedger(db.prisma);
    expect(ledger).toBe(0);
  });

  it("saves and retrieves last processed ledger sequence", async () => {
    if (!dbAvailable) return;
    await saveLastProcessedLedger(db.prisma, 12345);

    const retrieved = await getLastProcessedLedger(db.prisma);
    expect(retrieved).toBe(12345);
  });

  it("updates ledger sequence across service restarts", async () => {
    if (!dbAvailable) return;
    await saveLastProcessedLedger(db.prisma, 500);

    let cursor = await getLastProcessedLedger(db.prisma);
    expect(cursor).toBe(500);

    await saveLastProcessedLedger(db.prisma, 510);
    cursor = await getLastProcessedLedger(db.prisma);
    expect(cursor).toBe(510);
  });

  it("polls events, decodes payload, and updates Session & Transaction in database", async () => {
    if (!dbAvailable) return;
    const fundValue = {
      session_id: "sess-poll-test-1",
      seeker_address: "GSEEKER_POLL",
      expert_address: "GEXPERT_POLL",
      expert_id: "exp_poll_1",
      amount: "10000000",
    };

    const mockEvents = [
      {
        id: "0000001000-0000000001",
        ledger: 100,
        ledgerClosedAt: new Date().toISOString(),
        contractId: "CCONTRACT123",
        topic: ["fund_session"],
        value: fundValue,
        txHash: "tx_soroban_fund_001",
      },
    ];

    const mockServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 105 }),
      getEvents: jest.fn().mockResolvedValue({ events: mockEvents }),
    } as unknown as any;

    const service = new SorobanIndexerService(db.prisma, {
      server: mockServer,
      contractIds: ["CCONTRACT123"],
    });

    await saveLastProcessedLedger(db.prisma, 99);

    const pollRes = await service.pollOnce();

    expect(pollRes.eventsFetched).toBe(1);
    expect(pollRes.processedCount).toBe(1);
    expect(pollRes.latestLedger).toBe(100);

    const session = await db.prisma.session.findUnique({
      where: { sessionId: "sess-poll-test-1" },
    });

    expect(session).not.toBeNull();
    expect(session?.status).toBe("ACTIVE");
    expect(session?.escrowAmount.toString()).toBe("10000000");

    const tx = await db.prisma.transaction.findUnique({
      where: { txHash: "tx_soroban_fund_001" },
    });
    expect(tx).not.toBeNull();
    expect(tx?.type).toBe("ESCROW_FUNDED");

    const lastLedger = await getLastProcessedLedger(db.prisma);
    expect(lastLedger).toBe(100);
  });

  it("resumes polling from saved ledger sequence after restart", async () => {
    if (!dbAvailable) return;
    await saveLastProcessedLedger(db.prisma, 250);

    const mockServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 300 }),
      getEvents: jest.fn().mockImplementation((params) => {
        expect(params.startLedger).toBe(251);
        return Promise.resolve({ events: [] });
      }),
    } as unknown as any;

    const service = new SorobanIndexerService(db.prisma, {
      server: mockServer,
    });

    await service.pollOnce();

    expect(mockServer.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 251 })
    );
  });

  it("processes complete_session and updates Session status to COMPLETED", async () => {
    if (!dbAvailable) return;
    await db.prisma.user.create({ data: { walletAddress: "GSEEKER_COMP" } });
    const expUser = await db.prisma.user.create({ data: { walletAddress: "GEXPERT_COMP" } });
    const exp = await db.prisma.expert.create({
      data: { id: "exp_comp", userId: expUser.id, name: "Comp Expert" },
    });

    await db.prisma.session.create({
      data: {
        sessionId: "sess-comp-999",
        seekerAddress: "GSEEKER_COMP",
        expertAddress: "GEXPERT_COMP",
        expertId: exp.id,
        status: "ACTIVE",
        escrowAmount: 50000n,
      },
    });

    const mockEvents = [
      {
        id: "0000002000-0000000001",
        ledger: 200,
        ledgerClosedAt: new Date().toISOString(),
        topic: ["complete_session"],
        value: { session_id: "sess-comp-999", amount: "50000" },
        txHash: "tx_complete_999",
      },
    ];

    const mockServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 205 }),
      getEvents: jest.fn().mockResolvedValue({ events: mockEvents }),
    } as unknown as any;

    const service = new SorobanIndexerService(db.prisma, { server: mockServer });

    await saveLastProcessedLedger(db.prisma, 199);
    await service.pollOnce();

    const updatedSession = await db.prisma.session.findUnique({
      where: { sessionId: "sess-comp-999" },
    });

    expect(updatedSession?.status).toBe("COMPLETED");

    const tx = await db.prisma.transaction.findUnique({
      where: { txHash: "tx_complete_999" },
    });
    expect(tx?.type).toBe("PAYMENT_RELEASED");
  });
});
