import { EventEmitter } from "events";

/**
 * Status events pushed to clients subscribed to a consultation session room.
 * Covers on-chain indexer outcomes and immediate in-session state changes
 * (pause, end, funds).
 */
export type SessionStatusEventType =
  | "SESSION_BOOKED"
  | "SESSION_COMPLETED"
  | "SESSION_PAUSED"
  | "SESSION_RESUMED"
  | "SESSION_ENDED"
  | "PAYMENT_RELEASED"
  | "FUNDS_UPDATED"
  | "FUNDS_LOW"
  | "PEER_DISCONNECTED";

export interface SessionStatusMessage {
  type: SessionStatusEventType;
  sessionId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

const SESSION_STATUS_EVENT = "session:status";

/**
 * Process-local bus that decouples event producers (indexer, future DB hooks)
 * from the WebSocket broadcaster. Keeps circular imports out of the graph.
 */
const bus = new EventEmitter();
// Many concurrent session rooms may subscribe in tests / multi-client scenarios.
bus.setMaxListeners(0);

export function publishSessionStatus(
  type: SessionStatusEventType,
  sessionId: string,
  payload: Record<string, unknown> = {}
): SessionStatusMessage {
  if (!sessionId) {
    throw new Error("sessionId is required to publish a session status event");
  }

  const message: SessionStatusMessage = {
    type,
    sessionId,
    payload,
    timestamp: new Date().toISOString(),
  };

  bus.emit(SESSION_STATUS_EVENT, message);
  return message;
}

export function onSessionStatus(
  listener: (message: SessionStatusMessage) => void
): () => void {
  bus.on(SESSION_STATUS_EVENT, listener);
  return () => {
    bus.off(SESSION_STATUS_EVENT, listener);
  };
}

export function sessionStatusIterator(
  sessionId: string
): AsyncIterableIterator<SessionStatusMessage> {
  const queued: SessionStatusMessage[] = [];
  let pending: ((result: IteratorResult<SessionStatusMessage>) => void) | undefined;
  let closed = false;

  const off = onSessionStatus((message) => {
    if (closed || message.sessionId !== sessionId) return;

    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve({ value: message, done: false });
    } else {
      queued.push(message);
    }
  });

  const close = () => {
    if (closed) return;
    closed = true;
    off();
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve({ value: undefined, done: true });
    }
  };

  return {
    next: () => {
      if (queued.length > 0) {
        return Promise.resolve({ value: queued.shift()!, done: false });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<SessionStatusMessage>>((resolve) => {
        pending = resolve;
      });
    },
    return: () => {
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw: (error) => {
      close();
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

export function sessionRoomName(sessionId: string): string {
  return `session:${sessionId}`;
}
