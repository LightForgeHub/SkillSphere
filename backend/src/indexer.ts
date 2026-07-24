import { prisma } from "./prisma";
import { processEvents } from "./eventListener";

const INTERVAL_MS = Number(process.env.INDEXER_INTERVAL_MS ?? 5000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tick(): Promise<void> {
  const result = await processEvents(prisma);

  if (result.processed > 0 || result.skipped > 0 || result.errors.length > 0) {
    console.log(
      `[indexer] processed=${result.processed} skipped=${result.skipped} errors=${result.errors.length}`
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
