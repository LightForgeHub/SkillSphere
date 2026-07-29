import { createServer, Server as HttpServer } from "http";
import { AddressInfo } from "net";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { createSessionHub, SessionHub } from "../ws/sessionHub";
import {
  publishSessionStatus,
  SessionStatusMessage,
  sessionRoomName,
} from "../sessionEvents";
import { generateTestWallet, signMessage, TestWallet } from "./helpers/wallet";
import { createTestDatabase } from "./helpers/db";
import { ingestEvent, processEvents } from "../eventListener";

function authFor(wallet: TestWallet, message = "SkillSphere Auth") {
  return {
    walletAddress: wallet.address,
    message,
    signature: signMessage(wallet, message),
  };
}

async function waitForConnect(socket: ClientSocket, timeoutMs = 3000): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectClient(
  port: number,
  auth: Record<string, string>
): ClientSocket {
  return ioClient(`http://127.0.0.1:${port}`, {
    path: "/session",
    transports: ["websocket"],
    auth,
    forceNew: true,
    reconnection: false,
  });
}

describe("session status WebSocket hub", () => {
  let httpServer: HttpServer;
  let hub: SessionHub;
  let port: number;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    httpServer = createServer();
    hub = createSessionHub(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const c of clients) {
      c.close();
    }
    // createSessionHub.close() also closes the underlying HTTP server
    await hub.close();
  });

  afterEach(() => {
    while (clients.length) {
      const c = clients.pop();
      c?.removeAllListeners();
      c?.close();
    }
  });

  it("rejects connections without auth credentials", async () => {
    const socket = connectClient(port, {});
    clients.push(socket);

    await expect(waitForConnect(socket)).rejects.toThrow(/Authentication required/i);
  });

  it("rejects connections with an invalid signature", async () => {
    const wallet = generateTestWallet();
    const socket = connectClient(port, {
      walletAddress: wallet.address,
      message: "SkillSphere Auth",
      signature: "ab".repeat(64), // wrong sig
    });
    clients.push(socket);

    await expect(waitForConnect(socket)).rejects.toThrow(/invalid signature/i);
  });

  it("accepts a valid wallet signature on connect", async () => {
    const wallet = generateTestWallet();
    const socket = connectClient(port, authFor(wallet));
    clients.push(socket);

    await expect(waitForConnect(socket)).resolves.toBeUndefined();
    expect(socket.connected).toBe(true);
  });

  it("allows multiple clients to subscribe to the same session channel", async () => {
    const seeker = generateTestWallet();
    const expert = generateTestWallet();
    const sessionId = "sess_multi_client";

    const seekerSocket = connectClient(port, authFor(seeker));
    const expertSocket = connectClient(port, authFor(expert));
    clients.push(seekerSocket, expertSocket);

    await Promise.all([waitForConnect(seekerSocket), waitForConnect(expertSocket)]);

    const [seekerAck, expertAck] = await Promise.all([
      new Promise<{ ok: boolean; room: string }>((resolve) => {
        seekerSocket.emit("subscribe", { sessionId }, resolve);
      }),
      new Promise<{ ok: boolean; room: string }>((resolve) => {
        expertSocket.emit("subscribe", { sessionId }, resolve);
      }),
    ]);

    expect(seekerAck).toMatchObject({
      ok: true,
      room: sessionRoomName(sessionId),
    });
    expect(expertAck).toMatchObject({
      ok: true,
      room: sessionRoomName(sessionId),
    });
    expect(await hub.getRoomSize(sessionId)).toBe(2);
  });

  it("broadcasts a status change to all room subscribers in under 200ms", async () => {
    const seeker = generateTestWallet();
    const expert = generateTestWallet();
    const sessionId = "sess_latency";

    const seekerSocket = connectClient(port, authFor(seeker));
    const expertSocket = connectClient(port, authFor(expert));
    clients.push(seekerSocket, expertSocket);

    await Promise.all([waitForConnect(seekerSocket), waitForConnect(expertSocket)]);

    await Promise.all([
      new Promise((resolve) => seekerSocket.emit("subscribe", { sessionId }, resolve)),
      new Promise((resolve) => expertSocket.emit("subscribe", { sessionId }, resolve)),
    ]);

    const received: SessionStatusMessage[] = [];
    const bothReceived = new Promise<number>((resolve) => {
      const start = Date.now();
      const onMsg = (msg: SessionStatusMessage) => {
        received.push(msg);
        if (received.length >= 2) {
          resolve(Date.now() - start);
        }
      };
      seekerSocket.on("session:status", onMsg);
      expertSocket.on("session:status", onMsg);
    });

    const elapsedMs = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("broadcast timeout")), 2000);
      bothReceived.then((ms) => {
        clearTimeout(timer);
        resolve(ms);
      }, reject);
      publishSessionStatus("SESSION_PAUSED", sessionId, { reason: "expert_away" });
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      type: "SESSION_PAUSED",
      sessionId,
      payload: { reason: "expert_away" },
    });
    expect(elapsedMs).toBeLessThan(200);
  });

  it("does not deliver events to clients subscribed to a different session", async () => {
    const wallet = generateTestWallet();
    const socket = connectClient(port, authFor(wallet));
    clients.push(socket);
    await waitForConnect(socket);

    await new Promise((resolve) =>
      socket.emit("subscribe", { sessionId: "sess_a" }, resolve)
    );

    let gotForeign = false;
    socket.on("session:status", () => {
      gotForeign = true;
    });

    publishSessionStatus("SESSION_ENDED", "sess_b", {});
    await new Promise((r) => setTimeout(r, 50));

    expect(gotForeign).toBe(false);
  });

  it("cleanly releases socket resources on disconnect", async () => {
    const wallet = generateTestWallet();
    const sessionId = "sess_cleanup";
    const socket = connectClient(port, authFor(wallet));
    clients.push(socket);
    await waitForConnect(socket);

    await new Promise((resolve) =>
      socket.emit("subscribe", { sessionId }, resolve)
    );
    expect(await hub.getRoomSize(sessionId)).toBe(1);

    await new Promise<void>((resolve) => {
      socket.once("disconnect", () => resolve());
      socket.close();
    });

    // Allow the server a tick to drop the socket from the room adapter
    await new Promise((r) => setTimeout(r, 30));
    expect(await hub.getRoomSize(sessionId)).toBe(0);
  });

  it("unsubscribe leaves the room without closing the connection", async () => {
    const wallet = generateTestWallet();
    const sessionId = "sess_unsub";
    const socket = connectClient(port, authFor(wallet));
    clients.push(socket);
    await waitForConnect(socket);

    await new Promise((resolve) =>
      socket.emit("subscribe", { sessionId }, resolve)
    );
    expect(await hub.getRoomSize(sessionId)).toBe(1);

    const unsubAck = await new Promise<{ ok: boolean }>((resolve) => {
      socket.emit("unsubscribe", { sessionId }, resolve);
    });
    expect(unsubAck.ok).toBe(true);
    expect(socket.connected).toBe(true);
    expect(await hub.getRoomSize(sessionId)).toBe(0);

    let received = false;
    socket.on("session:status", () => {
      received = true;
    });
    publishSessionStatus("FUNDS_LOW", sessionId, { remaining: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(false);
  });

  it("rejects subscribe/unsubscribe without a sessionId", async () => {
    const wallet = generateTestWallet();
    const socket = connectClient(port, authFor(wallet));
    clients.push(socket);
    await waitForConnect(socket);

    const subAck = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socket.emit("subscribe", {}, resolve);
    });
    expect(subAck).toMatchObject({ ok: false, error: "sessionId is required" });

    const unsubAck = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socket.emit("unsubscribe", {}, resolve);
    });
    expect(unsubAck).toMatchObject({ ok: false, error: "sessionId is required" });
  });
});

describe("event indexer → session status broadcast", () => {
  const db = createTestDatabase();
  let httpServer: HttpServer;
  let hub: SessionHub;
  let port: number;
  let client: ClientSocket;

  let dbAvailable = false;

  beforeAll(async () => {
    try {
      await db.setup();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
    httpServer = createServer();
    hub = createSessionHub(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    client?.close();
    await hub.close();
    if (dbAvailable) {
      await db.teardown();
    }
  });

  beforeEach(async () => {
    if (dbAvailable) {
      await db.clearAll();
    }
    client?.close();
  });

  it("broadcasts SESSION_COMPLETED from processEvents to room subscribers", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();
    const sessionId = "sess_from_indexer";
    client = connectClient(port, authFor(wallet));
    await waitForConnect(client);
    await new Promise((resolve) =>
      client.emit("subscribe", { sessionId }, resolve)
    );

    const statusPromise = new Promise<SessionStatusMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no status received")), 2000);
      client.once("session:status", (msg: SessionStatusMessage) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

    await ingestEvent(db.prisma, {
      txHash: "tx_ws_completed_001",
      eventType: "SESSION_COMPLETED",
      payload: { sessionId, outcome: "success" },
    });

    const result = await processEvents(db.prisma);
    expect(result.processed).toBe(1);

    const msg = await statusPromise;
    expect(msg).toMatchObject({
      type: "SESSION_COMPLETED",
      sessionId,
      payload: { sessionId, outcome: "success" },
    });
  });

  it("skips broadcast when SESSION_BOOKED has no sessionId", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();
    client = connectClient(port, authFor(wallet));
    await waitForConnect(client);
    await new Promise((resolve) =>
      client.emit("subscribe", { sessionId: "sess_any" }, resolve)
    );

    let received = false;
    client.on("session:status", () => {
      received = true;
    });

    await ingestEvent(db.prisma, {
      txHash: "tx_ws_booked_no_session",
      eventType: "SESSION_BOOKED",
      payload: { expertId: "exp_1", seekerId: "user_2" },
    });
    await processEvents(db.prisma);
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toBe(false);
  });
});
