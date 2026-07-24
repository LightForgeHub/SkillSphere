import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import express from "express";
import cors from "cors";
import { json } from "body-parser";
import { PrismaClient } from "@prisma/client";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";
import { GraphQLContext } from "./context";
import { extractAuthFromHeaders, verifyWalletSignature } from "./auth";

export async function createApp(prismaClient: PrismaClient) {
  const app = express();

  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
  });

  await server.start();

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
