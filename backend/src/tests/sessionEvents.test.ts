import {
  publishSessionStatus,
  onSessionStatus,
  sessionStatusIterator,
  sessionRoomName,
  SessionStatusMessage,
} from "../sessionEvents";

describe("sessionEvents bus", () => {
  it("builds session room names as session:${sessionId}", () => {
    expect(sessionRoomName("abc")).toBe("session:abc");
  });

  it("rejects publish without a sessionId", () => {
    expect(() => publishSessionStatus("SESSION_ENDED", "")).toThrow(/sessionId/i);
  });

  it("delivers published messages to listeners and supports unsubscribe", () => {
    const received: SessionStatusMessage[] = [];
    const off = onSessionStatus((msg) => received.push(msg));

    const message = publishSessionStatus("FUNDS_UPDATED", "sess_1", {
      remaining: 42,
    });

    expect(received).toEqual([message]);
    expect(message).toMatchObject({
      type: "FUNDS_UPDATED",
      sessionId: "sess_1",
      payload: { remaining: 42 },
    });
    expect(typeof message.timestamp).toBe("string");

    off();
    publishSessionStatus("FUNDS_LOW", "sess_1", {});
    expect(received).toHaveLength(1);
  });

  it("delivers only events for the subscribed session and closes cleanly", async () => {
    const iterator = sessionStatusIterator("sess_1");
    const nextEvent = iterator.next();

    publishSessionStatus("SESSION_BOOKED", "sess_other");
    publishSessionStatus("SESSION_BOOKED", "sess_1", { escrowAmount: "100" });

    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: {
        sessionId: "sess_1",
        payload: { escrowAmount: "100" },
      },
    });

    await expect(iterator.return!()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });
});
