import { parse, subscribe } from "graphql";
import { graphqlSchema } from "../app";
import { publishSessionStatus } from "../sessionEvents";

describe("GraphQL sessionUpdated subscription", () => {
  it("streams an indexed escrow confirmation to the requested session", async () => {
    const result = await subscribe({
      schema: graphqlSchema,
      document: parse(`
        subscription SessionStatus($sessionId: ID!) {
          sessionUpdated(sessionId: $sessionId) {
            type
            sessionId
            payload
            timestamp
          }
        }
      `),
      variableValues: { sessionId: "session_1" },
    });

    expect(Symbol.asyncIterator in result).toBe(true);
    if (!(Symbol.asyncIterator in result)) return;

    const event = result as AsyncIterator<{
      data?: {
        sessionUpdated: {
          type: string;
          sessionId: string;
          payload: { escrowAmount: string };
        };
      };
    }>;
    const nextEvent = event.next();

    publishSessionStatus("SESSION_BOOKED", "session_1", {
      escrowAmount: "100",
      txHash: "tx_1",
    });

    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: {
        data: {
          sessionUpdated: {
            type: "SESSION_BOOKED",
            sessionId: "session_1",
            payload: { escrowAmount: "100", txHash: "tx_1" },
          },
        },
      },
    });

    await event.return?.();
  });
});