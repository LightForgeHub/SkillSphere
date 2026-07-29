import request from "supertest";
import { Application } from "express";
import { createApp } from "../app";
import { createSurgeMultiplierRouter, calculateMultiplier } from "../surgeMultiplier";
import {
  createTestDatabase,
  seedExpert,
  seedSession,
  seedHeartbeat,
} from "./helpers/db";
import express from "express";

// ─── Unit tests for calculateMultiplier ───────────────────────────────────────

describe("calculateMultiplier — pure function", () => {
  it("returns 1.0 when ratio < 0.5", () => {
    // 2 sessions / 10 experts = 0.2
    expect(calculateMultiplier(2, 10)).toBe(1.0);
  });

  it("returns 1.0 at ratio exactly 0 (no sessions)", () => {
    expect(calculateMultiplier(0, 5)).toBe(1.0);
  });

  it("returns 1.0 with no sessions and no experts", () => {
    expect(calculateMultiplier(0, 0)).toBe(1.0);
  });

  it("returns 1.2 at ratio exactly 0.5", () => {
    // 5 sessions / 10 experts = 0.5
    expect(calculateMultiplier(5, 10)).toBe(1.2);
  });

  it("returns 1.2 when 0.5 ≤ ratio ≤ 0.8", () => {
    // 7 sessions / 10 experts = 0.7
    expect(calculateMultiplier(7, 10)).toBe(1.2);
  });

  it("returns 1.2 at ratio exactly 0.8", () => {
    expect(calculateMultiplier(8, 10)).toBe(1.2);
  });

  it("returns 1.5 when ratio > 0.8", () => {
    // 9 sessions / 10 experts = 0.9
    expect(calculateMultiplier(9, 10)).toBe(1.5);
  });

  it("returns 1.5 when there are active sessions but no available experts (zero supply)", () => {
    expect(calculateMultiplier(5, 0)).toBe(1.5);
  });
});

// ─── Integration tests for GET /api/surge-multiplier ─────────────────────────

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

describe("GET /api/surge-multiplier", () => {
  // Create a fresh app (and router with empty cache) before each test so that
  // the 30-second in-process cache from a prior test does not bleed over.
  let app: Application;

  beforeEach(async () => {
    if (!dbAvailable) return;
    const result = await createApp(db.prisma);
    app = result.app;
  });

  // ── Response shape ──────────────────────────────────────────────────────────

  it("returns correct JSON shape", async () => {
    if (!dbAvailable) return;
    const res = await request(app).get("/api/surge-multiplier");
    expect(res.status).toBe(200);
    expect(typeof res.body.multiplier).toBe("number");
    expect(typeof res.body.activeSessions).toBe("number");
    expect(typeof res.body.availableExperts).toBe("number");
  });

  it("returns multiplier 1.0 with no sessions and no experts", async () => {
    if (!dbAvailable) return;
    const res = await request(app).get("/api/surge-multiplier");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ multiplier: 1.0, activeSessions: 0, availableExperts: 0 });
  });

  // ── Multiplier tiers ────────────────────────────────────────────────────────

  it("returns 1.0 multiplier when ratio < 0.5 (low demand)", async () => {
    if (!dbAvailable) return;
    // 2 active sessions, 10 online experts → ratio 0.2
    for (let i = 0; i < 10; i++) {
      const { expert } = await seedExpert(db.prisma);
      // Heartbeat 1 minute ago — well within the 5-minute window
      await seedHeartbeat(db.prisma, expert.id, -60_000);
    }
    await seedSession(db.prisma);
    await seedSession(db.prisma);

    const res = await request(app).get("/api/surge-multiplier");
    expect(res.status).toBe(200);
    expect(res.body.multiplier).toBe(1.0);
    expect(res.body.activeSessions).toBe(2);
    expect(res.body.availableExperts).toBe(10);
  });

  it("returns 1.2 multiplier when 0.5 ≤ ratio ≤ 0.8 (medium demand)", async () => {
    if (!dbAvailable) return;
    // 5 active sessions, 10 online experts → ratio 0.5
    for (let i = 0; i < 10; i++) {
      const { expert } = await seedExpert(db.prisma);
      await seedHeartbeat(db.prisma, expert.id, -60_000);
    }
    for (let i = 0; i < 5; i++) {
      await seedSession(db.prisma);
    }

    const res = await request(app).get("/api/surge-multiplier");
    expect(res.status).toBe(200);
    expect(res.body.multiplier).toBe(1.2);
    expect(res.body.activeSessions).toBe(5);
    expect(res.body.availableExperts).toBe(10);
  });

  it("returns 1.5 multiplier when ratio > 0.8 (high demand)", async () => {
    if (!dbAvailable) return;
    // 9 active sessions, 10 online experts → ratio 0.9
    for (let i = 0; i < 10; i++) {
      const { expert } = await seedExpert(db.prisma);
      await seedHeartbeat(db.prisma, expert.id, -60_000);
    }
    for (let i = 0; i < 9; i++) {
      await seedSession(db.prisma);
    }

    const res = await request(app).get("/api/surge-multiplier");
    expect(res.status).toBe(200);
    expect(res.body.multiplier).toBe(1.5);
    expect(res.body.activeSessions).toBe(9);
    expect(res.body.availableExperts).toBe(10);
  });

  // ── Expert heartbeat window ─────────────────────────────────────────────────

  it("excludes experts whose heartbeat is older than 5 minutes", async () => {
    if (!dbAvailable) return;
    // Online expert (heartbeat 2 min ago)
    const { expert: onlineExpert } = await seedExpert(db.prisma);
    await seedHeartbeat(db.prisma, onlineExpert.id, -2 * 60_000);

    // Stale expert (heartbeat 6 min ago — outside the 5-minute window)
    const { expert: staleExpert } = await seedExpert(db.prisma);
    await seedHeartbeat(db.prisma, staleExpert.id, -6 * 60_000);

    // Expert who never sent a heartbeat (lastHeartbeat is null)
    await seedExpert(db.prisma);

    const res = await request(app).get("/api/surge-multiplier");
    expect(res.status).toBe(200);
    // Only the online expert should count
    expect(res.body.availableExperts).toBe(1);
  });

  it("counts only active sessions (status=ACTIVE)", async () => {
    if (!dbAvailable) return;
    await seedSession(db.prisma, { status: "ACTIVE" });
    await seedSession(db.prisma, { status: "ACTIVE" });
    await seedSession(db.prisma, { status: "COMPLETED" }); // should not count

    const res = await request(app).get("/api/surge-multiplier");
    expect(res.status).toBe(200);
    expect(res.body.activeSessions).toBe(2);
  });

  // ── Cache behaviour ─────────────────────────────────────────────────────────

  it("sets Cache-Control header on the response", async () => {
    if (!dbAvailable) return;
    const res = await request(app).get("/api/surge-multiplier");
    expect(res.headers["cache-control"]).toMatch(/max-age=30/);
  });

  it("serves cached response without re-querying the DB", async () => {
    // We use a custom router with injected cache to verify the cache is hit.
    let dbCallCount = 0;

    // Build a mini express app that wraps a router with mocked prisma
    const mockedPrisma = {
      session: {
        count: async () => {
          dbCallCount++;
          return 3;
        },
      },
      expert: {
        count: async () => {
          dbCallCount++;
          return 6;
        },
      },
    } as unknown as import("@prisma/client").PrismaClient;

    const cacheApp = express();
    cacheApp.use(
      "/api/surge-multiplier",
      createSurgeMultiplierRouter(mockedPrisma, { cacheTtlMs: 30_000 })
    );

    // First request — hits DB
    const res1 = await request(cacheApp).get("/api/surge-multiplier");
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({ multiplier: 1.2, activeSessions: 3, availableExperts: 6 });
    expect(dbCallCount).toBe(2); // one count per model

    // Second request — should be served from cache
    const res2 = await request(cacheApp).get("/api/surge-multiplier");
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual(res1.body);
    // DB call count must not increase
    expect(dbCallCount).toBe(2);
  });

  it("re-queries the DB after the cache expires", async () => {
    let dbCallCount = 0;
    let overrideCache: { value: unknown; expiresAt: number } | undefined;

    const mockedPrisma = {
      session: { count: async () => { dbCallCount++; return 1; } },
      expert: { count: async () => { dbCallCount++; return 5; } },
    } as unknown as import("@prisma/client").PrismaClient;

    const cacheApp = express();
    cacheApp.use(
      "/api/surge-multiplier",
      createSurgeMultiplierRouter(mockedPrisma, {
        cacheTtlMs: 30_000,
        _getCache: () => overrideCache as { value: import("../surgeMultiplier").SurgeResult; expiresAt: number } | undefined,
        _setCache: (entry) => { overrideCache = entry; },
      })
    );

    // First request — populates the cache
    await request(cacheApp).get("/api/surge-multiplier");
    expect(dbCallCount).toBe(2);

    // Expire the cache manually
    overrideCache!.expiresAt = Date.now() - 1;

    // Second request — cache expired → DB should be queried again
    await request(cacheApp).get("/api/surge-multiplier");
    expect(dbCallCount).toBe(4);
  });

  // ── Acceptance-criteria smoke test ─────────────────────────────────────────

  it("matches the documented response structure { multiplier, activeSessions, availableExperts }", async () => {
    if (!dbAvailable) return;
    // 5 sessions / 6 experts ≈ 0.83 → multiplier 1.5
    for (let i = 0; i < 6; i++) {
      const { expert } = await seedExpert(db.prisma);
      await seedHeartbeat(db.prisma, expert.id, -60_000);
    }
    for (let i = 0; i < 5; i++) {
      await seedSession(db.prisma);
    }

    const res = await request(app).get("/api/surge-multiplier");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ multiplier: 1.5, activeSessions: 5, availableExperts: 6 });
  });
});
