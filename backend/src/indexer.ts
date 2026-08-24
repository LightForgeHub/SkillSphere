import { prisma } from "./prisma";
import { processEvents } from "./eventListener";
import { SorobanIndexerService } from "./sorobanIndexer";

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 100;

function resolveIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

const INTERVAL_MS = resolveIntervalMs(process.env.INDEXER_INTERVAL_MS);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sorobanIndexer = new SorobanIndexerService(prisma);

async function tick(): Promise<void> {
  const sorobanRes = await sorobanIndexer.pollOnce();
  // Catch events ingested if processEvents inside pollOnce was interrupted.
  const result = await processEvents(prisma);
  const processed = sorobanRes.processedCount + result.processed;

  if (
    sorobanRes.eventsFetched > 0 ||
    processed > 0 ||
    result.skipped > 0 ||
    result.errors.length > 0
  ) {
    console.log(
      `[indexer] sorobanEvents=${sorobanRes.eventsFetched} processed=${processed} skipped=${result.skipped} errors=${result.errors.length} latestLedger=${sorobanRes.latestLedger}`
    );

    for (const error of result.errors) {
      console.error(`[indexer] ${error}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`SkillSphere indexer running (interval=${INTERVAL_MS}ms)`);

  await prisma.$connect();
  console.log("[indexer] connected to database");

  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("[indexer] tick failed:", err);
    }

    await sleep(INTERVAL_MS);
  }
}

main().catch(async (err) => {
  console.error("Fatal indexer error:", err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
