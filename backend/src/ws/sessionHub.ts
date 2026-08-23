import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import {
  extractAuthFromHeaders,
  verifyWalletSignature,
  AuthPayload,
} from "../auth";
import {
  onSessionStatus,
  publishSessionStatus,
  sessionRoomName,
  SessionStatusMessage,
} from "../sessionEvents";

export interface SessionHub {
  io: Server;
  /** Number of sockets currently joined to session:${sessionId}. */
  getRoomSize: (sessionId: string) => Promise<number>;
  /** Gracefully close the Socket.IO server and detach the bus listener. */
  close: () => Promise<void>;
}

export interface SessionHubOptions {
  /** Socket.IO path. Defaults to /session. */
  path?: string;
  corsOrigin?: string | string[] | boolean;
  /** Engine heartbeat interval in milliseconds. Defaults to 10 seconds. */
  pingIntervalMs?: number;
  /** Engine heartbeat timeout in milliseconds. Defaults to 60 seconds. */
  pingTimeoutMs?: number;
  /** Time to wait before settling a session after a peer disconnects. */
  disconnectGracePeriodMs?: number;
  /** Called after the disconnect grace period expires. */
  fallbackSettlement?: (sessionId: string) => Promise<void> | void;
}

interface AuthenticatedSocket extends Socket {
  data: {
    walletAddress: string;
  };
}

function authPayloadFromHandshake(socket: Socket): AuthPayload | null {
  const auth = socket.handshake.auth as Record<string, unknown>;

  // Preferred: Socket.IO handshake.auth (wallet signature = this project's auth "token")
  if (
    typeof auth.walletAddress === "string" &&
    typeof auth.message === "string" &&
    typeof auth.signature === "string"
  ) {
    return {
      walletAddress: auth.walletAddress,
      message: auth.message,
      signature: auth.signature,
    };
  }

  // Fallback: same headers used by GraphQL, passed via handshake.headers
  return extractAuthFromHeaders(
    socket.handshake.headers as Record<string, string | string[] | undefined>
  );
}

function authenticateConnection(socket: Socket, next: (err?: Error) => void): void {
  const payload = authPayloadFromHandshake(socket);

  if (!payload) {
    next(new Error("Authentication required"));
    return;
  }

  const result = verifyWalletSignature(payload);
  if (!result.valid || !result.walletAddress) {
    next(new Error(result.error ?? "Invalid authentication"));
    return;
  }

  (socket as AuthenticatedSocket).data.walletAddress = result.walletAddress;
  next();
}

function parseSessionId(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && "sessionId" in data) {
    return String((data as { sessionId: unknown }).sessionId ?? "");
  }
  return "";
}

/**
 * Attach a Socket.IO hub to an existing HTTP server.
 *
 * Protocol:
 * - Connect with wallet auth in handshake.auth
 *   { walletAddress, message, signature }
 * - Client emits `subscribe` / `unsubscribe` with { sessionId }
 * - Server emits `session:status` to room session:${sessionId}
 */
export function createSessionHub(
  httpServer: HttpServer,
  options: SessionHubOptions = {}
): SessionHub {
  const io = new Server(httpServer, {
    path: options.path ?? "/session",
    pingInterval: options.pingIntervalMs ?? 10_000,
    pingTimeout: options.pingTimeoutMs ?? 60_000,
    cors: {
      origin: options.corsOrigin ?? true,
    },
  });

  io.use(authenticateConnection);

  const disconnectGracePeriodMs = options.disconnectGracePeriodMs ?? 60_000;
  const fallbackSettlement =
    options.fallbackSettlement ?? ((sessionId: string) => {
      publishSessionStatus("SESSION_ENDED", sessionId, {
        reason: "peer_disconnect_timeout",
      });
    });
  const settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancelSettlement = (sessionId: string): void => {
    const timer = settlementTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      settlementTimers.delete(sessionId);
    }
  };

  const scheduleSettlement = (sessionId: string): void => {
    cancelSettlement(sessionId);
    const timer = setTimeout(() => {
      settlementTimers.delete(sessionId);
      void Promise.resolve(fallbackSettlement(sessionId)).catch((error: unknown) => {
        console.error(`[SessionHub] fallback settlement failed for ${sessionId}:`, error);
      });
    }, disconnectGracePeriodMs);
    settlementTimers.set(sessionId, timer);
  };

  io.on("connection", (socket: Socket) => {
    const authed = socket as AuthenticatedSocket;
    const subscribedSessions = new Set<string>();

    socket.on("subscribe", (data: unknown, ack?: (response: unknown) => void) => {
      const sessionId = parseSessionId(data);

      if (!sessionId) {
        ack?.({ ok: false, error: "sessionId is required" });
        return;
      }

      const room = sessionRoomName(sessionId);
      subscribedSessions.add(sessionId);
      cancelSettlement(sessionId);
      void socket.join(room);
      ack?.({
        ok: true,
        room,
        walletAddress: authed.data.walletAddress,
      });
    });

    socket.on("unsubscribe", (data: unknown, ack?: (response: unknown) => void) => {
      const sessionId = parseSessionId(data);

      if (!sessionId) {
        ack?.({ ok: false, error: "sessionId is required" });
        return;
      }

      const room = sessionRoomName(sessionId);
      subscribedSessions.delete(sessionId);
      void socket.leave(room);
      ack?.({ ok: true, room });
    });

    socket.on("disconnect", (reason: string) => {
      for (const sessionId of subscribedSessions) {
        publishSessionStatus("PEER_DISCONNECTED", sessionId, {
          walletAddress: authed.data.walletAddress,
          reason,
        });
        scheduleSettlement(sessionId);
      }
    });
  });

  const unsubscribeBus = onSessionStatus((message: SessionStatusMessage) => {
    io.to(sessionRoomName(message.sessionId)).emit("session:status", message);
  });

  return {
    io,
    getRoomSize: async (sessionId: string) => {
      const sockets = await io.in(sessionRoomName(sessionId)).fetchSockets();
      return sockets.length;
    },
    close: async () => {
      for (const timer of settlementTimers.values()) clearTimeout(timer);
      settlementTimers.clear();
      unsubscribeBus();
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}
