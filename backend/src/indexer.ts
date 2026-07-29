import { prisma } from "./prisma";
import { processEvents } from "./eventListener";
import { SorobanIndexerService } from "./sorobanIndexer";

const INTERVAL_MS = Number(process.env.INDEXER_INTERVAL_MS ?? 5000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sorobanIndexer = new SorobanIndexerService(prisma);

async function tick(): Promise<void> {
  // Poll Stellar / Soroban RPC endpoint for contract events
  const sorobanRes = await sorobanIndexer.pollOnce();

  // Process any pending / unhandled event logs
  const result = await processEvents(prisma);

  if (
    sorobanRes.eventsFetched > 0 ||
    result.processed > 0 ||
    result.skipped > 0 ||
    result.errors.length > 0
  ) {
    console.log(
      `[indexer] sorobanEvents=${sorobanRes.eventsFetched} processed=${result.processed} skipped=${result.skipped} errors=${result.errors.length} latestLedger=${sorobanRes.latestLedger}`
    );

    for (const error of result.errors) {
      console.error(`[indexer] ${error}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `SkillSphere indexer running (interval=${INTERVAL_MS}ms)`
  );

  // Verify DB connectivity before entering the poll loop
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
