import { rpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import { PrismaClient } from "@prisma/client";
import {
  ingestEvent,
  processEvents,
  StellarEvent,
  StellarEventType,
} from "./eventListener";

const INDEXER_KEY = "stellar_soroban_indexer";
const GET_EVENTS_LIMIT = 100;
const MAX_PAGES_PER_TICK = 10;
const MAX_CONTRACT_IDS_PER_FILTER = 5;
const MAX_FILTERS = 5;
const LOOKBACK_LEDGERS = 10;

const EVENT_TYPE_BY_TOPIC: Record<string, StellarEventType> = {
  paymentstreamed: "PAYMENT_STREAMED",
  streamedpayment: "PAYMENT_STREAMED",
  refundsession: "SESSION_REFUNDED",
  sessionrefunded: "SESSION_REFUNDED",
  refund: "SESSION_REFUNDED",
  fundsession: "SESSION_BOOKED",
  sessionbooked: "SESSION_BOOKED",
  booked: "SESSION_BOOKED",
  pausesession: "SESSION_PAUSED",
  sessionpaused: "SESSION_PAUSED",
  pause: "SESSION_PAUSED",
  completesession: "SESSION_COMPLETED",
  sessioncompleted: "SESSION_COMPLETED",
  paymentreleased: "SESSION_COMPLETED",
  complete: "SESSION_COMPLETED",
  expertregistered: "EXPERT_REGISTERED",
  registerexpert: "EXPERT_REGISTERED",
};

/**
 * Convert scVal XDR (base64 string or xdr.ScVal) to native JS values.
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
  if (typeof val === "symbol") {
    return val.description ?? val.toString();
  }
  if (val instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(val);
    } catch {
      return Buffer.from(val).toString("base64");
    }
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

function topicToName(topic: unknown): string {
  if (typeof topic === "symbol") {
    return topic.description ?? "";
  }
  if (typeof topic === "string") return topic;
  if (typeof topic === "number" || typeof topic === "bigint") {
    return String(topic);
  }
  if (topic instanceof Uint8Array) {
    return new TextDecoder().decode(topic);
  }
  if (topic == null) return "";
  const plain = toPlainObject(topic);
  return typeof plain === "string" ? plain : "";
}

function normalizeEventName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Map a decoded Soroban topic name onto the off-chain event union.
 * Names must match exactly after normalization (no substring matching).
 */
export function classifyEventType(topicName: string): StellarEventType | null {
  const n = normalizeEventName(topicName);
  if (!n) return null;
  return EVENT_TYPE_BY_TOPIC[n] ?? null;
}

function assignAliasedFields(payload: Record<string, unknown>): void {
  const aliases: Array<[string, string]> = [
    ["session_id", "sessionId"],
    ["seeker_address", "seekerAddress"],
    ["expert_address", "expertAddress"],
    ["expert_id", "expertId"],
    ["escrow_amount", "amount"],
    ["wallet_address", "walletAddress"],
  ];
  for (const [from, to] of aliases) {
    if (payload[from] !== undefined && payload[to] === undefined) {
      payload[to] = payload[from];
    }
  }
}

function asScalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  return null;
}

/**
 * Decode XDR topics and value payloads into a typed StellarEvent structure.
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
    const eventType = classifyEventType(topicToName(decodedTopics[0]));

    let rawPayloadObj: unknown;
    if (decodedValue && typeof decodedValue === "object") {
      rawPayloadObj = toPlainObject(decodedValue);
    } else if (decodedValue !== undefined && decodedValue !== null) {
      rawPayloadObj = { amount: toPlainObject(decodedValue) };
    } else {
      rawPayloadObj = {};
    }

    const payload: Record<string, unknown> = Array.isArray(rawPayloadObj)
      ? { data: rawPayloadObj }
      : rawPayloadObj && typeof rawPayloadObj === "object"
        ? { ...(rawPayloadObj as Record<string, unknown>) }
        : {};

    assignAliasedFields(payload);

    if (Array.isArray(payload["data"]) && payload["amount"] === undefined) {
      const first = asScalar(payload["data"][0]);
      if (first !== null) {
        payload["amount"] = first;
      }
    }

    if (!payload["sessionId"] && decodedTopics[1] != null) {
      const sessionId = asScalar(toPlainObject(decodedTopics[1]));
      if (sessionId !== null) {
        payload["sessionId"] = String(sessionId);
      }
    }
    if (!payload["amount"] && decodedTopics[2] != null) {
      const amount = asScalar(toPlainObject(decodedTopics[2]));
      if (amount !== null) {
        payload["amount"] = amount;
      }
    }

    return { eventType, payload };
  } catch (err) {
    console.error("[sorobanIndexer] Safe decode error (swallowed):", err);
    return { eventType: null, payload: {} };
  }
}

export async function getIndexerState(
  prisma: PrismaClient,
  key: string = INDEXER_KEY
): Promise<{ lastLedger: number; lastCursor: string | null }> {
  const state = await prisma.indexerState.findUnique({
    where: { key },
  });
  return {
    lastLedger: state?.lastLedger ?? 0,
    lastCursor: state?.lastCursor ?? null,
  };
}

export async function getLastProcessedLedger(
  prisma: PrismaClient,
  key: string = INDEXER_KEY
): Promise<number> {
  const state = await getIndexerState(prisma, key);
  return state.lastLedger;
}

export async function getIndexerCursor(
  prisma: PrismaClient,
  key: string = INDEXER_KEY
): Promise<string | null> {
  const state = await getIndexerState(prisma, key);
  return state.lastCursor;
}

export async function saveLastProcessedLedger(
  prisma: PrismaClient,
  lastLedger: number,
  key: string = INDEXER_KEY,
  lastCursor?: string | null
): Promise<void> {
  await prisma.indexerState.upsert({
    where: { key },
    create: {
      key,
      lastLedger,
      lastCursor: lastCursor ?? null,
    },
    update: {
      lastLedger,
      ...(lastCursor !== undefined ? { lastCursor } : {}),
    },
  });
}

export interface SorobanIndexerOptions {
  rpcUrl?: string;
  contractIds?: string[];
  server?: rpc.Server;
}

export function buildContractEventFilters(
  contractIds: string[]
): rpc.Api.EventFilter[] {
  if (contractIds.length === 0) {
    return [{ type: "contract" }];
  }

  const filters: rpc.Api.EventFilter[] = [];
  for (
    let i = 0;
    i < contractIds.length && filters.length < MAX_FILTERS;
    i += MAX_CONTRACT_IDS_PER_FILTER
  ) {
    filters.push({
      type: "contract",
      contractIds: contractIds.slice(i, i + MAX_CONTRACT_IDS_PER_FILTER),
    });
  }
  return filters;
}

function ingestTxHash(event: rpc.Api.EventResponse): string {
  if (event.txHash) return event.txHash;
  if (event.id) return event.id;
  throw new Error("Soroban event missing txHash and id");
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
      .map((id) => id.trim())
      .filter(Boolean);

    this.contractIds = options.contractIds ?? envContractIds;

    if (this.contractIds.length === 0) {
      console.warn(
        "[sorobanIndexer] No contract IDs configured; getEvents will match all contract events"
      );
    }
  }

  /**
   * One polling tick: getEvents by contract ID → decode → EventLog → Session/Transaction.
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
      const state = await getIndexerState(this.prisma);
      let lastLedger = state.lastLedger;
      const cursor = state.lastCursor;
      let knownLatest: number | undefined;

      if (lastLedger === 0 && !cursor) {
        try {
          const latestRes = await this.server.getLatestLedger();
          knownLatest = latestRes.sequence;
          lastLedger = Math.max(1, (latestRes.sequence ?? 1) - LOOKBACK_LEDGERS);
        } catch (err) {
          console.warn(
            "[sorobanIndexer] Unable to fetch latest ledger, defaulting to ledger 1:",
            err
          );
          lastLedger = 1;
        }
        await saveLastProcessedLedger(this.prisma, lastLedger, INDEXER_KEY, null);
      }

      const filters = buildContractEventFilters(this.contractIds);
      const collected: rpc.Api.EventResponse[] = [];
      let newLastLedger = lastLedger;
      let newCursor = cursor;
      let startLedger = lastLedger + 1;

      if (!cursor) {
        try {
          const sequence =
            knownLatest ?? (await this.server.getLatestLedger()).sequence;
          if (typeof sequence === "number") {
            startLedger = Math.min(Math.max(1, startLedger), sequence);
          }
        } catch {
          // Keep lastLedger+1 when latest ledger is unavailable.
        }
      }

      for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
        let eventResponse: rpc.Api.GetEventsResponse;
        try {
          const request: rpc.Api.GetEventsRequest = newCursor
            ? { filters, cursor: newCursor, limit: GET_EVENTS_LIMIT }
            : { filters, startLedger, limit: GET_EVENTS_LIMIT };

          eventResponse = await this.server.getEvents(request);
        } catch (err) {
          console.error("[sorobanIndexer] RPC getEvents error:", err);
          break;
        }

        const rawEvents = eventResponse.events ?? [];
        collected.push(...rawEvents);

        for (const rawEv of rawEvents) {
          if (rawEv.ledger) {
            newLastLedger = Math.max(newLastLedger, rawEv.ledger);
          }
        }

        if (eventResponse.cursor) {
          newCursor = eventResponse.cursor;
        }

        // Only fast-forward to RPC latest when this page is empty. A short
        // non-empty page may still be a truncated scan; cursor continues it.
        if (rawEvents.length === 0 && typeof eventResponse.latestLedger === "number") {
          newLastLedger = Math.max(newLastLedger, eventResponse.latestLedger);
        }

        if (rawEvents.length < GET_EVENTS_LIMIT) {
          break;
        }
      }

      for (const rawEv of collected) {
        const { eventType, payload } = decodeEventPayload(
          rawEv.topic ?? [],
          rawEv.value
        );

        if (!eventType) {
          continue;
        }

        const event: StellarEvent = {
          txHash: ingestTxHash(rawEv),
          eventType,
          payload: {
            ...payload,
            ledger: rawEv.ledger,
            ledgerClosedAt: rawEv.ledgerClosedAt,
          },
        };

        await ingestEvent(this.prisma, event);
      }

      const processRes = await processEvents(this.prisma);

      if (newLastLedger > lastLedger || (newCursor && newCursor !== cursor)) {
        await saveLastProcessedLedger(
          this.prisma,
          newLastLedger,
          INDEXER_KEY,
          newCursor
        );
      }

      return {
        eventsFetched: collected.length,
        processedCount: processRes.processed,
        latestLedger: newLastLedger,
      };
    } finally {
      this.isRunning = false;
    }
  }
}
