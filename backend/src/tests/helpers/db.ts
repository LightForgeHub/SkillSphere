import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

// Resolve the backend root directory robustly regardless of __dirname value
// Walk up from this file's location until we find package.json
function findBackendRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  throw new Error(`Could not find backend root from ${startDir}`);
}

const BACKEND_ROOT = findBackendRoot(__dirname);

const DEFAULT_DATABASE_URL =
  "postgresql://skillsphere:skillsphere@localhost:5432/skillsphere?schema=public";

/**
 * Creates an isolated PostgreSQL schema for a test suite.
 * Each suite gets its own schema so tests don't interfere with each other.
 */
export function createTestDatabase(): {
  prisma: PrismaClient;
  dbPath: string;
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
  clearAll: () => Promise<void>;
} {
  const baseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const schema = `test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  const databaseUrl = url.toString();

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [],
  });

  const setup = async () => {
    execSync(
      `npx prisma db push --skip-generate --accept-data-loss --schema="${path.join(BACKEND_ROOT, "prisma", "schema.prisma")}"`,
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        cwd: BACKEND_ROOT,
        stdio: "pipe",
      }
    );

    await prisma.$connect();
  };

  const teardown = async () => {
    try {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Schema may not exist if setup failed
    }
    await prisma.$disconnect();
  };

  const clearAll = async () => {
    // Delete in dependency order (children before parents)
    await prisma.eventLog.deleteMany();
    await prisma.expert.deleteMany();
    await prisma.user.deleteMany();
  };

  return { prisma, dbPath: schema, setup, teardown, clearAll };
}

/**
 * Seed a user + expert fixture for tests.
 */
export async function seedExpert(
  prisma: PrismaClient,
  overrides: Partial<{
    walletAddress: string;
    name: string;
    bio: string;
    skills: string;
    hourlyRate: number;
    isAvailable: boolean;
  }> = {}
) {
  const walletAddress =
    overrides.walletAddress ??
    `GTEST${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  const user = await prisma.user.create({ data: { walletAddress } });

  const expert = await prisma.expert.create({
    data: {
      userId: user.id,
      name: overrides.name ?? "Test Expert",
      bio: overrides.bio ?? "A test bio",
      skills: overrides.skills ?? "TypeScript,GraphQL",
      hourlyRate: overrides.hourlyRate ?? 100,
      isAvailable: overrides.isAvailable ?? true,
    },
  });

  return { user, expert };
}
