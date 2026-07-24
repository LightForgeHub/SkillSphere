import { PrismaClient } from "@prisma/client";

export interface GraphQLContext {
  prisma: PrismaClient;
  /** Wallet address of authenticated user, or null if unauthenticated */
  walletAddress: string | null;
}
