import { PrismaClient } from "@prisma/client";
import {
  publishSessionStatus,
  SessionStatusEventType,
} from "./sessionEvents";

export type StellarEventType =
  | "SESSION_BOOKED"
  | "SESSION_COMPLETED"
  | "PAYMENT_RELEASED"
  | "EXPERT_REGISTERED"
  | "SESSION_PAUSED"
  | "SESSION_REFUNDED";

/** Map indexer event types that belong in a session room to WS status types. */
const SESSION_SCOPED_EVENTS: ReadonlySet<StellarEventType> = new Set([
  "SESSION_BOOKED",
  "SESSION_COMPLETED",
  "PAYMENT_RELEASED",
  "SESSION_PAUSED",
  "SESSION_REFUNDED",
]);

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

      const eventType = log.eventType as StellarEventType;
      await handleEvent(prisma, eventType, payload, log.txHash);

      // Push immediate status updates to any clients in session:${sessionId}.
      maybeBroadcastSessionStatus(eventType, payload);

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
  payload: Record<string, unknown>,
  txHash?: string
): Promise<void> {
  switch (eventType) {
    case "EXPERT_REGISTERED":
      await handleExpertRegistered(prisma, payload);
      break;
    case "SESSION_BOOKED":
      await handleSessionBooked(prisma, payload, txHash);
      break;
    case "SESSION_COMPLETED":
      await handleSessionCompleted(prisma, payload, txHash);
      break;
    case "PAYMENT_RELEASED":
      await handlePaymentReleased(prisma, payload, txHash);
      break;
    case "SESSION_PAUSED":
      await handleSessionPaused(prisma, payload);
      break;
    case "SESSION_REFUNDED":
      await handleSessionRefunded(prisma, payload, txHash);
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
  prisma: PrismaClient,
  payload: Record<string, unknown>,
  txHash?: string
): Promise<void> {
  if (!payload["expertId"]) throw new Error("SESSION_BOOKED: missing expertId");

  const sessionId = payload["sessionId"] ? String(payload["sessionId"]) : undefined;
  if (!sessionId) return;

  const seekerAddress = (payload["seekerAddress"] as string) ?? (payload["seeker"] as string) ?? "GSEEKER_DEFAULT";
  const expertAddress = (payload["expertAddress"] as string) ?? (payload["expert"] as string) ?? "GEXPERT_DEFAULT";
  const expertId = String(payload["expertId"]);

  // Ensure seeker user exists
  await prisma.user.upsert({
    where: { walletAddress: seekerAddress },
    create: { walletAddress: seekerAddress },
    update: {},
  });

  // Ensure expert user & profile exist
  const expertUser = await prisma.user.upsert({
    where: { walletAddress: expertAddress },
    create: { walletAddress: expertAddress },
    update: {},
  });

  const existingExpert = await prisma.expert.findUnique({ where: { id: expertId } });
  let finalExpertId = expertId;

  if (!existingExpert) {
    const upsertedExpert = await prisma.expert.upsert({
      where: { userId: expertUser.id },
      create: {
        id: expertId,
        userId: expertUser.id,
        name: "Indexed Expert",
      },
      update: {},
    });
    finalExpertId = upsertedExpert.id;
  }

  const amountStr = payload["amount"] ?? payload["escrowAmount"] ?? "0";
  const escrowAmount = BigInt(String(amountStr));

  await prisma.session.upsert({
    where: { sessionId },
    create: {
      sessionId,
      seekerAddress,
      expertAddress,
      expertId: finalExpertId,
      status: "ACTIVE",
      escrowAmount,
    },
    update: {
      status: "ACTIVE",
      escrowAmount,
    },
  });

  const hash = txHash ?? (payload["txHash"] as string);
  if (hash) {
    const ledgerTime = payload["ledgerTime"] ? new Date(payload["ledgerTime"] as string) : new Date();
    await prisma.transaction.upsert({
      where: { txHash: hash },
      create: {
        txHash: hash,
        sessionId,
        amount: escrowAmount,
        type: "ESCROW_FUNDED",
        ledgerTime,
      },
      update: {},
    });
  }
}

async function handleSessionCompleted(
  prisma: PrismaClient,
  payload: Record<string, unknown>,
  txHash?: string
): Promise<void> {
  if (!payload["sessionId"]) throw new Error("SESSION_COMPLETED: missing sessionId");

  const sessionId = String(payload["sessionId"]);
  await prisma.session.updateMany({
    where: { sessionId },
    data: { status: "COMPLETED", endTime: new Date() },
  });

  const hash = txHash ?? (payload["txHash"] as string);
  const amountStr = payload["amount"] ?? payload["escrowAmount"];
  if (hash && amountStr !== undefined) {
    const amount = BigInt(String(amountStr));
    const ledgerTime = payload["ledgerTime"] ? new Date(payload["ledgerTime"] as string) : new Date();
    await prisma.transaction.upsert({
      where: { txHash: hash },
      create: {
        txHash: hash,
        sessionId,
        amount,
        type: "PAYMENT_RELEASED",
        ledgerTime,
      },
      update: {},
    });
  }
}

async function handlePaymentReleased(
  prisma: PrismaClient,
  payload: Record<string, unknown>,
  txHash?: string
): Promise<void> {
  if (payload["amount"] === undefined || payload["amount"] === null) {
    throw new Error("PAYMENT_RELEASED: missing amount");
  }

  const amount = BigInt(String(payload["amount"]));
  const sessionId = payload["sessionId"] ? String(payload["sessionId"]) : undefined;

  if (sessionId) {
    await prisma.session.updateMany({
      where: { sessionId },
      data: { status: "COMPLETED", endTime: new Date() },
    });
  }

  const hash = txHash ?? (payload["txHash"] as string);
  if (hash && sessionId) {
    const ledgerTime = payload["ledgerTime"] ? new Date(payload["ledgerTime"] as string) : new Date();
    await prisma.transaction.upsert({
      where: { txHash: hash },
      create: {
        txHash: hash,
        sessionId,
        amount,
        type: "PAYMENT_RELEASED",
        ledgerTime,
      },
      update: {},
    });
  }
}

async function handleSessionPaused(
  prisma: PrismaClient,
  payload: Record<string, unknown>
): Promise<void> {
  if (!payload["sessionId"]) throw new Error("SESSION_PAUSED: missing sessionId");

  const sessionId = String(payload["sessionId"]);
  await prisma.session.updateMany({
    where: { sessionId },
    data: { status: "PAUSED" },
  });
}

async function handleSessionRefunded(
  prisma: PrismaClient,
  payload: Record<string, unknown>,
  txHash?: string
): Promise<void> {
  if (!payload["sessionId"]) throw new Error("SESSION_REFUNDED: missing sessionId");

  const sessionId = String(payload["sessionId"]);
  await prisma.session.updateMany({
    where: { sessionId },
    data: { status: "REFUNDED" },
  });

  const hash = txHash ?? (payload["txHash"] as string);
  const amountStr = payload["amount"] ?? payload["escrowAmount"];
  if (hash && amountStr !== undefined) {
    const amount = BigInt(String(amountStr));
    const ledgerTime = payload["ledgerTime"] ? new Date(payload["ledgerTime"] as string) : new Date();
    await prisma.transaction.upsert({
      where: { txHash: hash },
      create: {
        txHash: hash,
        sessionId,
        amount,
        type: "REFUND_ISSUED",
        ledgerTime,
      },
      update: {},
    });
  }
}

/**
 * If the indexer payload includes a sessionId, fan out to the session room.
 * Producers without a sessionId (e.g. early SESSION_BOOKED stubs) are skipped.
 */
function maybeBroadcastSessionStatus(
  eventType: StellarEventType,
  payload: Record<string, unknown>
): void {
  if (!SESSION_SCOPED_EVENTS.has(eventType)) return;

  const sessionId = payload["sessionId"];
  if (typeof sessionId !== "string" || !sessionId) return;

  let wsType: SessionStatusEventType = eventType as SessionStatusEventType;
  if (eventType === "SESSION_REFUNDED") {
    wsType = "SESSION_ENDED";
  }

  publishSessionStatus(
    wsType,
    sessionId,
    payload
  );
}
