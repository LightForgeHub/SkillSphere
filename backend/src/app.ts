import { ApolloServer } from "@apollo/server";
import { GraphQLFormattedError } from "graphql";
import { expressMiddleware } from "@apollo/server/express4";
import express from "express";
import cors from "cors";
import { json } from "body-parser";
import { PrismaClient } from "@prisma/client";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";
import { GraphQLContext } from "./context";
import { extractAuthFromHeaders, verifyWalletSignature } from "./auth";
import { createSurgeMultiplierRouter } from "./surgeMultiplier";

export async function createApp(prismaClient: PrismaClient) {
  const app = express();

  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    formatError: (formattedError: GraphQLFormattedError, error: unknown) => {
      // Log the original error for debugging internally
      console.error("[GraphQL Error]", error);

      // For known user-facing errors (validation, auth, not-found), pass through as-is
      const code = formattedError.extensions?.code as string | undefined;
      if (
        code === "BAD_USER_INPUT" ||
        code === "UNAUTHENTICATED" ||
        code === "FORBIDDEN" ||
        code === "NOT_FOUND"
      ) {
        return formattedError;
      }

      // Sanitize unexpected internal errors
      if (formattedError.message.startsWith("Variable") || formattedError.message.startsWith("Cannot")) {
        return formattedError;
      }

      // For all other unhandled errors, return a generic safe message
      const isInternalError =
        !code || code === "INTERNAL_SERVER_ERROR";

      if (isInternalError) {
        return {
          message: "An internal server error occurred. Please try again later.",
          extensions: {
            code: "INTERNAL_SERVER_ERROR",
          },
        };
      }

      return formattedError;
    },
  });

  await server.start();

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/surge-multiplier", createSurgeMultiplierRouter(prismaClient));

  // Wallet auth is optional on GraphQL via context; use walletAuthMiddleware on REST routes that require it.
  app.use(
    "/graphql",
    cors<cors.CorsRequest>(),
    json(),
    expressMiddleware(server, {
      context: async ({ req }) => {
        const authPayload = extractAuthFromHeaders(
          req.headers as Record<string, string | string[] | undefined>
        );

        let walletAddress: string | null = null;

        if (authPayload) {
          const result = verifyWalletSignature(authPayload);
          if (result.valid && result.walletAddress) {
            walletAddress = result.walletAddress;
          }
        }

        return {
          prisma: prismaClient,
          walletAddress,
        };
      },
    })
  );

  return { app, server };
}
