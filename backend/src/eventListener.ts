import { Prisma, PrismaClient } from "@prisma/client";
import { getNotificationService } from "./notificationService";
import {
  publishSessionStatus,
  SessionStatusEventType,
} from "./sessionEvents";

export type StellarEventType =
  | "SESSION_BOOKED"
  | "SESSION_COMPLETED"
  | "PAYMENT_RELEASED"
  | "PAYMENT_STREAMED"
  | "EXPERT_REGISTERED"
  | "SESSION_PAUSED"
  | "SESSION_REFUNDED";

/** Map indexer event types that belong in a session room to WS status types. */
const SESSION_SCOPED_EVENTS: ReadonlySet<StellarEventType> = new Set([
  "SESSION_BOOKED",
  "SESSION_COMPLETED",
  "PAYMENT_RELEASED",
  "PAYMENT_STREAMED",
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

  try {
    const created = await prisma.eventLog.create({
      data: {
        txHash: event.txHash,
        eventType: event.eventType,
        payload: JSON.stringify(event.payload),
        processed: false,
      },
    });
    return { created: true, id: created.id };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const raced = await prisma.eventLog.findUnique({
        where: { txHash: event.txHash },
      });
      if (raced) {
        return { created: false, id: raced.id };
      }
    }
    throw err;
  }
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
    case "PAYMENT_STREAMED":
      await handlePaymentStreamed(prisma, payload, txHash);
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

  const existingSession = await prisma.session.findUnique({
    where: { sessionId },
  });
  const isNewSession = !existingSession;

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

  // Ping Discord / Telegram only for newly created session rows (fire-and-forget).
  if (isNewSession) {
    const expert = await prisma.expert.findUnique({
      where: { id: finalExpertId },
    });
    getNotificationService().notifyBookingAsync({
      seekerAddress,
      expertAddress,
      sessionId,
      hourlyRate: expert?.hourlyRate,
      escrowAmount,
      expertName: expert?.name,
    });
  }

  const hash = transactionHash(payload, txHash);
  if (hash) {
    await prisma.transaction.upsert({
      where: { txHash: hash },
      create: {
        txHash: hash,
        sessionId,
        amount: escrowAmount,
        type: "ESCROW_FUNDED",
        ledgerTime: ledgerTimeFromPayload(payload),
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

  const hash = transactionHash(payload, txHash);
  const amountStr = payload["amount"] ?? payload["escrowAmount"];
  if (hash && amountStr !== undefined) {
    const amount = BigInt(String(amountStr));
    await prisma.transaction.upsert({
      where: { txHash: hash },
      create: {
        txHash: hash,
        sessionId,
        amount,
        type: "PAYMENT_RELEASED",
        ledgerTime: ledgerTimeFromPayload(payload),
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

  const hash = transactionHash(payload, txHash);
  if (hash && sessionId) {
    await prisma.transaction.upsert({
      where: { txHash: hash },
      create: {
        txHash: hash,
        sessionId,
        amount,
        type: "PAYMENT_RELEASED",
        ledgerTime: ledgerTimeFromPayload(payload),
      },
      update: {},
    });
  }
}

/**
 * Incremental expert earnings during an active session (on-chain PaymentStreamed).
 * Records a PAYMENT_RELEASED transaction without completing the session.
 */
async function handlePaymentStreamed(
  prisma: PrismaClient,
  payload: Record<string, unknown>,
  txHash?: string
): Promise<void> {
  if (!payload["sessionId"]) throw new Error("PAYMENT_STREAMED: missing sessionId");
  if (payload["amount"] === undefined || payload["amount"] === null) {
    throw new Error("PAYMENT_STREAMED: missing amount");
  }

  const sessionId = String(payload["sessionId"]);
  const amount = BigInt(String(payload["amount"]));

  const session = await prisma.session.findUnique({
    where: { sessionId },
  });
  if (!session) {
    throw new Error(`PAYMENT_STREAMED: session not found: ${sessionId}`);
  }

  const hash = transactionHash(payload, txHash);
  if (!hash) {
    throw new Error("PAYMENT_STREAMED: missing txHash");
  }

  await prisma.transaction.upsert({
    where: { txHash: hash },
    create: {
      txHash: hash,
      sessionId,
      amount,
      type: "PAYMENT_RELEASED",
      ledgerTime: ledgerTimeFromPayload(payload),
    },
    update: {
      amount,
      ledgerTime: ledgerTimeFromPayload(payload),
    },
  });
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

  const hash = transactionHash(payload, txHash);
  const amountStr = payload["amount"] ?? payload["escrowAmount"];
  if (hash && amountStr !== undefined) {
    const amount = BigInt(String(amountStr));
    await prisma.transaction.upsert({
      where: { txHash: hash },
      create: {
        txHash: hash,
        sessionId,
        amount,
        type: "REFUND_ISSUED",
        ledgerTime: ledgerTimeFromPayload(payload),
      },
      update: {},
    });
  }
}

function transactionHash(
  payload: Record<string, unknown>,
  txHash?: string
): string | undefined {
  if (typeof payload["txHash"] === "string" && payload["txHash"]) {
    return payload["txHash"];
  }
  if (typeof txHash === "string" && txHash) {
    return txHash;
  }
  return undefined;
}

function ledgerTimeFromPayload(payload: Record<string, unknown>): Date {
  const raw = payload["ledgerClosedAt"] ?? payload["ledgerTime"];
  if (typeof raw === "string" && raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
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
  } else if (eventType === "PAYMENT_STREAMED") {
    wsType = "PAYMENT_RELEASED";
  }

  publishSessionStatus(
    wsType,
    sessionId,
    payload
  );
}
