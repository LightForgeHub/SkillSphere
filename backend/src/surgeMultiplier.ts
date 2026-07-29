import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

/**
 * The calculated surge state, cached for CACHE_TTL_MS to avoid hammering the DB
 * on every request.
 */
export interface SurgeResult {
  multiplier: number;
  activeSessions: number;
  availableExperts: number;
}

interface CacheEntry {
  value: SurgeResult;
  expiresAt: number; // ms since epoch
}

/** Experts who sent a heartbeat within the last 5 minutes are considered online. */
const HEARTBEAT_WINDOW_MS = 5 * 60 * 1000;

/** Cache TTL — 30 seconds. */
const CACHE_TTL_MS = 30 * 1_000;

/**
 * Calculate the surge multiplier based on demand/supply ratio:
 *   ratio < 0.5  → 1.0
 *   0.5 ≤ ratio ≤ 0.8 → 1.2
 *   ratio > 0.8  → 1.5
 */
export function calculateMultiplier(
  activeSessions: number,
  availableExperts: number
): number {
  // No demand regardless of supply — no surge
  if (activeSessions === 0) return 1.0;

  // Demand exists but no supply — maximum surge
  if (availableExperts === 0) return 1.5;

  const ratio = activeSessions / availableExperts;

  if (ratio < 0.5) return 1.0;
  if (ratio <= 0.8) return 1.2;
  return 1.5;
}

/**
 * Create an Express Router for the surge-multiplier endpoint.
 *
 * The router keeps an in-process cache keyed by PrismaClient instance so that
 * each test suite (which creates its own isolated DB) gets its own fresh cache,
 * while production code reuses the cached value for the full 30-second window.
 *
 * Pass `_getCacheEntry` / `_setCacheEntry` overrides in tests to control the
 * cache directly without time manipulation.
 */
export function createSurgeMultiplierRouter(
  prisma: PrismaClient,
  options: {
    cacheTtlMs?: number;
    /** Injected in tests to bypass the real cache. */
    _getCache?: () => CacheEntry | undefined;
    _setCache?: (entry: CacheEntry) => void;
  } = {}
): Router {
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;

  let cache: CacheEntry | undefined;

  const getCache = options._getCache ?? (() => cache);
  const setCache =
    options._setCache ??
    ((entry: CacheEntry) => {
      cache = entry;
    });

  const router = Router();

  router.get("/", async (_req: Request, res: Response) => {
    const now = Date.now();
    const cached = getCache();

    if (cached && now < cached.expiresAt) {
      // Serve from cache
      res.set("Cache-Control", `public, max-age=${Math.floor(ttl / 1000)}`);
      res.json(cached.value);
      return;
    }

    // Query fresh data
    const heartbeatCutoff = new Date(now - HEARTBEAT_WINDOW_MS);

    const [activeSessions, availableExperts] = await Promise.all([
      prisma.session.count({ where: { status: "ACTIVE" } }),
      prisma.expert.count({
        where: { lastHeartbeat: { gte: heartbeatCutoff } },
      }),
    ]);

    const multiplier = calculateMultiplier(activeSessions, availableExperts);

    const result: SurgeResult = { multiplier, activeSessions, availableExperts };

    setCache({ value: result, expiresAt: now + ttl });

    res.set("Cache-Control", `public, max-age=${Math.floor(ttl / 1000)}`);
    res.json(result);
  });

  return router;
}
