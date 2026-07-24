import { PrismaClient } from "@prisma/client";

export type StellarEventType =
  | "SESSION_BOOKED"
  | "SESSION_COMPLETED"
  | "PAYMENT_RELEASED"
  | "EXPERT_REGISTERED";

export interface StellarEvent {
  txHash: string;
  eventType: StellarEventType;
  payload: Record<string, unknown>;
}

export interface ProcessResult {
  processed: number;
  skipped: number;
  errors: string[];
}

/**
 * Ingest a single Stellar event into the EventLog table.
 * Deduplicates by txHash.
 */
export async function ingestEvent(
  prisma: PrismaClient,
  event: StellarEvent
): Promise<{ created: boolean; id: string }> {
  const existing = await prisma.eventLog.findUnique({
    where: { txHash: event.txHash },
  });

  if (existing) {
    return { created: false, id: existing.id };
  }

  const created = await prisma.eventLog.create({
    data: {
      txHash: event.txHash,
      eventType: event.eventType,
      payload: JSON.stringify(event.payload),
      processed: false,
    },
  });

  return { created: true, id: created.id };
}

/**
 * Process all unprocessed events in the EventLog.
 * Dispatches to the appropriate handler for each event type.
 */
export async function processEvents(
  prisma: PrismaClient
): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, skipped: 0, errors: [] };

  const unprocessed = await prisma.eventLog.findMany({
    where: { processed: false },
    orderBy: { createdAt: "asc" },
  });

  for (const log of unprocessed) {
    try {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(log.payload) as Record<string, unknown>;
      } catch {
        result.errors.push(`${log.id}: invalid JSON payload`);
        result.skipped++;
        continue;
      }

      await handleEvent(prisma, log.eventType as StellarEventType, payload);

      await prisma.eventLog.update({
        where: { id: log.id },
        data: { processed: true, processedAt: new Date() },
      });

      result.processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${log.id}: ${msg}`);
      result.skipped++;
    }
  }

  return result;
}

/**
 * Route an event to its specific handler.
 */
async function handleEvent(
  prisma: PrismaClient,
  eventType: StellarEventType,
  payload: Record<string, unknown>
): Promise<void> {
  switch (eventType) {
    case "EXPERT_REGISTERED":
      await handleExpertRegistered(prisma, payload);
      break;
    case "SESSION_BOOKED":
      await handleSessionBooked(prisma, payload);
      break;
    case "SESSION_COMPLETED":
      await handleSessionCompleted(prisma, payload);
      break;
    case "PAYMENT_RELEASED":
      await handlePaymentReleased(prisma, payload);
      break;
    default:
      throw new Error(`Unknown event type: ${eventType}`);
  }
}

async function handleExpertRegistered(
  prisma: PrismaClient,
  payload: Record<string, unknown>
): Promise<void> {
  const walletAddress = payload["walletAddress"] as string;
  const name = (payload["name"] as string) ?? "Unknown";

  if (!walletAddress) throw new Error("EXPERT_REGISTERED: missing walletAddress");

  // Upsert user
  const user = await prisma.user.upsert({
    where: { walletAddress },
    create: { walletAddress },
    update: {},
  });

  // Upsert expert profile
  await prisma.expert.upsert({
    where: { userId: user.id },
    create: { userId: user.id, name },
    update: { name },
  });
}

async function handleSessionBooked(
  _prisma: PrismaClient,
  payload: Record<string, unknown>
): Promise<void> {
  // Future: create a Session record
  if (!payload["expertId"]) throw new Error("SESSION_BOOKED: missing expertId");
  // No-op for now — recorded in EventLog
}

async function handleSessionCompleted(
  _prisma: PrismaClient,
  payload: Record<string, unknown>
): Promise<void> {
  // Future: update Session status
  if (!payload["sessionId"]) throw new Error("SESSION_COMPLETED: missing sessionId");
  // No-op for now
}

async function handlePaymentReleased(
  _prisma: PrismaClient,
  payload: Record<string, unknown>
): Promise<void> {
  // Future: record payment transaction
  if (!payload["amount"]) throw new Error("PAYMENT_RELEASED: missing amount");
  // No-op for now
}
