import { rpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import { PrismaClient } from "@prisma/client";
import {
  ingestEvent,
  processEvents,
  StellarEvent,
  StellarEventType,
} from "./eventListener";

const INDEXER_KEY = "stellar_soroban_indexer";

/**
 * Utility function to convert scVal XDR (either base64 string or xdr.ScVal)
 * to native JS primitives or objects.
 */
export function parseScVal(val: unknown): unknown {
  if (val === null || val === undefined) return val;

  if (typeof val === "string") {
    try {
      const parsed = xdr.ScVal.fromXDR(val, "base64");
      return scValToNative(parsed);
    } catch {
      return val;
    }
  }

  if (typeof val === "object" && val !== null && "switch" in val) {
    try {
      return scValToNative(val as xdr.ScVal);
    } catch {
      return val;
    }
  }

  return val;
}

/**
 * Recursively convert BigInts, Maps, and nested objects into JSON-serializable primitives.
 */
export function toPlainObject(val: unknown): unknown {
  if (typeof val === "bigint") {
    return val.toString();
  }
  if (val instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of val.entries()) {
      obj[String(k)] = toPlainObject(v);
    }
    return obj;
  }
  if (Array.isArray(val)) {
    return val.map(toPlainObject);
  }
  if (val !== null && typeof val === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = toPlainObject(v);
    }
    return obj;
  }
  return val;
}

/**
 * Safely decode XDR topics and value payloads into a typed StellarEvent structure.
 * Catches any XDR parsing or mapping errors to ensure service resilience.
 */
export function decodeEventPayload(
  topicRaw: unknown[],
  valueRaw: unknown
): { eventType: StellarEventType | null; payload: Record<string, unknown> } {
  try {
    const decodedTopics = (Array.isArray(topicRaw) ? topicRaw : []).map((t) =>
      parseScVal(t)
    );
    const decodedValue = parseScVal(valueRaw);

    const topicName = String(decodedTopics[0] ?? "").toLowerCase();

    let eventType: StellarEventType | null = null;
    if (
      topicName.includes("refund_session") ||
      topicName.includes("refund") ||
      topicName.includes("session_refunded")
    ) {
      eventType = "SESSION_REFUNDED";
    } else if (
      topicName.includes("fund_session") ||
      topicName.includes("fund") ||
      topicName.includes("session_booked") ||
      topicName.includes("booked")
    ) {
      eventType = "SESSION_BOOKED";
    } else if (
      topicName.includes("pause_session") ||
      topicName.includes("pause") ||
      topicName.includes("session_paused")
    ) {
      eventType = "SESSION_PAUSED";
    } else if (
      topicName.includes("complete_session") ||
      topicName.includes("complete") ||
      topicName.includes("payment_released") ||
      topicName.includes("payment")
    ) {
      eventType = "SESSION_COMPLETED";
    }

    const rawPayloadObj =
      decodedValue && typeof decodedValue === "object"
        ? (toPlainObject(decodedValue) as Record<string, unknown>)
        : {};

    const payload: Record<string, unknown> = { ...rawPayloadObj };

    // Standardise common Soroban snake_case keys to camelCase
    if (payload["session_id"] !== undefined && !payload["sessionId"]) {
      payload["sessionId"] = payload["session_id"];
    }
    if (payload["seeker_address"] !== undefined && !payload["seekerAddress"]) {
      payload["seekerAddress"] = payload["seeker_address"];
    }
    if (payload["expert_address"] !== undefined && !payload["expertAddress"]) {
      payload["expertAddress"] = payload["expert_address"];
    }
    if (payload["expert_id"] !== undefined && !payload["expertId"]) {
      payload["expertId"] = payload["expert_id"];
    }
    if (payload["escrow_amount"] !== undefined && !payload["amount"]) {
      payload["amount"] = payload["escrow_amount"];
    }

    // Check if topic array carries positional args e.g. [topicName, sessionId]
    if (!payload["sessionId"] && decodedTopics[1]) {
      payload["sessionId"] = String(decodedTopics[1]);
    }

    return { eventType, payload };
  } catch (err) {
    console.error("[sorobanIndexer] Safe decode error (swallowed):", err);
    return { eventType: null, payload: {} };
  }
}

/**
 * Get the last processed ledger sequence from database state.
 */
export async function getLastProcessedLedger(
  prisma: PrismaClient,
  key: string = INDEXER_KEY
): Promise<number> {
  const state = await prisma.indexerState.findUnique({
    where: { key },
  });
  return state?.lastLedger ?? 0;
}

/**
 * Update the last processed ledger sequence in database state.
 */
export async function saveLastProcessedLedger(
  prisma: PrismaClient,
  lastLedger: number,
  key: string = INDEXER_KEY
): Promise<void> {
  await prisma.indexerState.upsert({
    where: { key },
    create: { key, lastLedger },
    update: { lastLedger },
  });
}

export interface SorobanIndexerOptions {
  rpcUrl?: string;
  contractIds?: string[];
  server?: rpc.Server;
}

export class SorobanIndexerService {
  private prisma: PrismaClient;
  private server: rpc.Server;
  private contractIds: string[];
  private isRunning: boolean = false;

  constructor(prisma: PrismaClient, options: SorobanIndexerOptions = {}) {
    this.prisma = prisma;
    const rpcUrl =
      options.rpcUrl ??
      process.env.SOROBAN_RPC_URL ??
      process.env.STELLAR_RPC_URL ??
      "https://soroban-testnet.stellar.org";
    this.server = options.server ?? new rpc.Server(rpcUrl);

    const envContractIds = [
      process.env.ESCROW_CONTRACT_ID,
      process.env.DISPUTE_CONTRACT_ID,
      process.env.SOROBAN_CONTRACT_IDS,
    ]
      .filter(Boolean)
      .flatMap((id) => (id ? id.split(",") : []))
      .map((id) => id.trim());

    this.contractIds = options.contractIds ?? (envContractIds.length > 0 ? envContractIds : []);
  }

  /**
   * Perform one polling tick:
   * 1. Retrieve last processed ledger sequence.
   * 2. Query Soroban RPC endpoint for contract events.
   * 3. Decode event payloads safely.
   * 4. Ingest into EventLog and execute processEvents (updating database Session/Transaction).
   * 5. Update last processed ledger sequence.
   */
  async pollOnce(): Promise<{
    eventsFetched: number;
    processedCount: number;
    latestLedger: number;
  }> {
    if (this.isRunning) {
      return { eventsFetched: 0, processedCount: 0, latestLedger: 0 };
    }
    this.isRunning = true;

    try {
      let lastLedger = await getLastProcessedLedger(this.prisma);

      if (lastLedger === 0) {
        try {
          const latestRes = await this.server.getLatestLedger();
          lastLedger = Math.max(1, (latestRes.sequence ?? 1) - 10);
        } catch (err) {
          console.warn("[sorobanIndexer] Unable to fetch latest ledger, defaulting to ledger 1:", err);
          lastLedger = 1;
        }
        await saveLastProcessedLedger(this.prisma, lastLedger);
      }

      const startLedger = lastLedger + 1;

      // Query Soroban RPC for contract events
      let eventResponse: rpc.Api.GetEventsResponse;
      try {
        const filters: rpc.Api.EventFilter[] = [
          {
            type: "contract",
            ...(this.contractIds.length > 0 ? { contractIds: this.contractIds } : {}),
          },
        ];

        eventResponse = await this.server.getEvents({
          startLedger,
          filters,
          limit: 100,
        });
      } catch (err) {
        console.error("[sorobanIndexer] RPC getEvents error:", err);
        return { eventsFetched: 0, processedCount: 0, latestLedger: lastLedger };
      }

      const rawEvents = eventResponse.events ?? [];
      let ingestedCount = 0;
      let newLastLedger = lastLedger;

      for (const rawEv of rawEvents) {
        if (rawEv.ledger) {
          newLastLedger = Math.max(newLastLedger, rawEv.ledger);
        }

        const topicRaw = (rawEv as unknown as { topic?: unknown[] }).topic ?? [];
        const valueRaw = (rawEv as unknown as { value?: unknown }).value;
        const txHash = (rawEv as unknown as { txHash?: string }).txHash ?? `tx_${rawEv.id}`;

        const { eventType, payload } = decodeEventPayload(topicRaw, valueRaw);

        if (eventType) {
          const event: StellarEvent = {
            txHash,
            eventType,
            payload: {
              ...payload,
              ledger: rawEv.ledger,
              ledgerClosedAt: rawEv.ledgerClosedAt,
            },
          };

          const ingestRes = await ingestEvent(this.prisma, event);
          if (ingestRes.created) {
            ingestedCount++;
          }
        }
      }

      const processRes = await processEvents(this.prisma);

      if (newLastLedger > lastLedger) {
        await saveLastProcessedLedger(this.prisma, newLastLedger);
      }

      return {
        eventsFetched: rawEvents.length,
        processedCount: processRes.processed,
        latestLedger: newLastLedger,
      };
    } finally {
      this.isRunning = false;
    }
  }
}
