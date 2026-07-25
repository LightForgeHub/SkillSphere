import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import {
  extractAuthFromHeaders,
  verifyWalletSignature,
  AuthPayload,
} from "../auth";
import {
  onSessionStatus,
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
    cors: {
      origin: options.corsOrigin ?? true,
    },
  });

  io.use(authenticateConnection);

  io.on("connection", (socket: Socket) => {
    const authed = socket as AuthenticatedSocket;

    socket.on("subscribe", (data: unknown, ack?: (response: unknown) => void) => {
      const sessionId = parseSessionId(data);

      if (!sessionId) {
        ack?.({ ok: false, error: "sessionId is required" });
        return;
      }

      const room = sessionRoomName(sessionId);
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
      void socket.leave(room);
      ack?.({ ok: true, room });
    });

    // Socket.IO removes the socket from all rooms on disconnect automatically.
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
      unsubscribeBus();
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}
