/**
 * Prisma Client singleton for SkillSphere.
 *
 * A single PrismaClient instance is reused across the application lifecycle.
 * In development and test environments the instance is attached to `globalThis`
 * so that hot-module-reload / ts-node restarts don't exhaust the connection pool.
 *
 * Connection pool knobs are read from environment variables so that each
 * deployment context (local, staging, production) can tune independently:
 *
 *   DATABASE_CONNECTION_LIMIT  – max simultaneous connections  (default: 10)
 *   DATABASE_POOL_TIMEOUT      – seconds to wait for a free connection (default: 10)
 *   DATABASE_CONNECT_TIMEOUT   – seconds to wait when opening a new connection (default: 10)
 */

import { PrismaClient } from "@prisma/client";

// ── Pool configuration ────────────────────────────────────────────────────────

const connectionLimit = parseInt(process.env.DATABASE_CONNECTION_LIMIT ?? "10", 10);
const poolTimeout     = parseInt(process.env.DATABASE_POOL_TIMEOUT     ?? "10", 10);
const connectTimeout  = parseInt(process.env.DATABASE_CONNECT_TIMEOUT  ?? "10", 10);

/**
 * Build the DATABASE_URL with Prisma connection-pooling query params appended.
 * Prisma's query engine honours `connection_limit`, `pool_timeout`, and
 * `connect_timeout` when they appear in the connection string.
 */
function buildDatasourceUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error("DATABASE_URL environment variable is not set.");
  }

  const url = new URL(base);
  url.searchParams.set("connection_limit", String(connectionLimit));
  url.searchParams.set("pool_timeout",     String(poolTimeout));
  url.searchParams.set("connect_timeout",  String(connectTimeout));

  return url.toString();
}

// ── Singleton setup ───────────────────────────────────────────────────────────

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: buildDatasourceUrl() },
    },
    log:
      process.env.NODE_ENV === "production"
        ? ["error"]
        : process.env.NODE_ENV === "test"
          ? []
          : ["query", "info", "warn", "error"],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

// Persist the instance on globalThis outside production to avoid exhausting
// the connection pool during hot-reload (ts-node / jest watch mode).
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
