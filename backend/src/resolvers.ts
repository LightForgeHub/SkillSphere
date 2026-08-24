import { GraphQLError } from "graphql";
import { GraphQLContext } from "./context";
import { GraphQLScalarType, Kind } from "graphql";
import { sessionStatusIterator } from "./sessionEvents";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert comma-separated skills string to array */
function parseSkills(skills: string): string[] {
  return skills
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Convert skills array to comma-separated string */
function serializeSkills(skills: string[]): string {
  return skills.map((s) => s.trim()).join(",");
}

/** Serialize a Prisma Expert row to GraphQL ExpertType shape */
function serializeExpert(e: {
  id: string;
  userId: string;
  name: string;
  bio: string;
  skills: string;
  categories: string[];
  hourlyRate: number;
  rating: number;
  reviewCount: number;
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...e,
    skills: parseSkills(e.skills),
    categories: e.categories,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/** Serialize a Prisma Session row to GraphQL SessionType shape */
function serializeSession(s: {
  sessionId: string;
  seekerAddress: string;
  expertAddress: string;
  expertId: string;
  status: string;
  escrowAmount: bigint;
  startTime: Date | null;
  endTime: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...s,
    escrowAmount: s.escrowAmount.toString(),
    startTime: s.startTime ? s.startTime.toISOString() : null,
    endTime: s.endTime ? s.endTime.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Serialize a Prisma Review row to GraphQL ReviewType shape */
function serializeReview(r: {
  id: string;
  rating: number;
  content: string;
  sessionId: string;
  seekerAddress: string;
  expertId: string;
  createdAt: Date;
}) {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Serialize a Prisma Transaction row to GraphQL TransactionType shape */
function serializeTransaction(t: {
  id: string;
  txHash: string;
  sessionId: string;
  amount: bigint;
  type: string;
  ledgerTime: Date;
  createdAt: Date;
}) {
  return {
    ...t,
    amount: t.amount.toString(),
    ledgerTime: t.ledgerTime.toISOString(),
    createdAt: t.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Argument interfaces
// ---------------------------------------------------------------------------

interface ExpertsArgs {
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

interface ExpertArgs {
  id: string;
}

interface SessionArgs {
  id: string;
}

interface ExpertByWalletArgs {
  walletAddress: string;
}

interface UpdateProfileArgs {
  expertInput: {
    name?: string;
    bio?: string;
    skills?: string[];
    categories?: string[];
    hourlyRate?: number;
    isAvailable?: boolean;
  };
}

interface RegisterExpertArgs {
  name: string;
  bio?: string;
  skills?: string[];
  hourlyRate?: number;
}

interface SubmitReviewArgs {
  reviewInput: {
    sessionId: string;
    rating: number;
    content: string;
  };
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export const resolvers = {
  // -------------------------------------------------------------------------
  // Query Resolvers
  // -------------------------------------------------------------------------
  JSON: new GraphQLScalarType({
    name: "JSON",
    serialize: (value: unknown) => value,
    parseValue: (value: unknown) => value,
    parseLiteral: (ast) => {
      if (ast.kind === Kind.STRING) return JSON.parse(ast.value);
      return null;
    },
  }),

  Query: {
    /**
     * experts(category, search, limit, offset)
     * Returns a sorted, filtered, paginated list of experts.
     */
    experts: async (
      _: unknown,
      { category, search, limit = 20, offset = 0 }: ExpertsArgs,
      { prisma }: GraphQLContext
    ) => {
      const safeLimit = Math.min(100, Math.max(1, limit));
      const safeOffset = Math.max(0, offset);

      // Build where clause
      const where: Record<string, unknown> = {};

      if (category) {
        where["categories"] = { has: category };
      }

      if (search) {
        where["OR"] = [
          { name: { contains: search, mode: "insensitive" } },
          { bio: { contains: search, mode: "insensitive" } },
          { skills: { contains: search, mode: "insensitive" } },
        ];
      }

      const experts = await prisma.expert.findMany({
        where,
        skip: safeOffset,
        take: safeLimit,
        orderBy: { createdAt: "desc" },
      });

      return experts.map(serializeExpert);
    },

    /**
     * expert(id)
     * Returns a single expert by their ID, with reviews eagerly loaded.
     */
    expert: async (
      _: unknown,
      { id }: ExpertArgs,
      { prisma }: GraphQLContext
    ) => {
      const expert = await prisma.expert.findUnique({
        where: { id },
      });

      if (!expert) return null;
      return serializeExpert(expert);
    },

    /**
     * session(id)
     * Returns a single session and its status by session ID.
     */
    session: async (
      _: unknown,
      { id }: SessionArgs,
      { prisma }: GraphQLContext
    ) => {
      const session = await prisma.session.findUnique({
        where: { sessionId: id },
      });

      if (!session) return null;
      return serializeSession(session);
    },

    /**
     * expertByWallet(walletAddress)
     * Returns an expert by the wallet address of their associated user.
     */
    expertByWallet: async (
      _: unknown,
      { walletAddress }: ExpertByWalletArgs,
      { prisma }: GraphQLContext
    ) => {
      const user = await prisma.user.findUnique({
        where: { walletAddress },
        include: { expert: true },
      });

      if (!user?.expert) return null;
      return serializeExpert(user.expert);
    },
  },

  // -------------------------------------------------------------------------
  // Mutation Resolvers
  // -------------------------------------------------------------------------
  Mutation: {
    /**
     * registerExpert
     * Creates an expert profile for the authenticated wallet.
     */
    registerExpert: async (
      _: unknown,
      { name, bio = "", skills = [], hourlyRate = 0 }: RegisterExpertArgs,
      { prisma, walletAddress }: GraphQLContext
    ) => {
      if (!walletAddress) {
        return { success: false, expert: null, error: "Authentication required" };
      }

      try {
        const user = await prisma.user.upsert({
          where: { walletAddress },
          create: { walletAddress },
          update: {},
        });

        const existing = await prisma.expert.findUnique({
          where: { userId: user.id },
        });

        if (existing) {
          return { success: false, expert: null, error: "Expert profile already exists" };
        }

        const expert = await prisma.expert.create({
          data: {
            userId: user.id,
            name,
            bio,
            skills: serializeSkills(skills),
            hourlyRate,
          },
        });

        return {
          success: true,
          expert: serializeExpert(expert),
          error: null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, expert: null, error: msg };
      }
    },

    /**
     * updateProfile(expertInput)
     * Updates the expert profile for the authenticated wallet.
     * Protected by wallet auth.
     */
    updateProfile: async (
      _: unknown,
      { expertInput }: UpdateProfileArgs,
      { prisma, walletAddress }: GraphQLContext
    ) => {
      if (!walletAddress) {
        return { success: false, expert: null, error: "Authentication required" };
      }

      try {
        const user = await prisma.user.findUnique({
          where: { walletAddress },
          include: { expert: true },
        });

        if (!user?.expert) {
          return { success: false, expert: null, error: "Expert profile not found" };
        }

        const { name, bio, skills, categories, hourlyRate, isAvailable } = expertInput;
        const updateData: Record<string, unknown> = {};
        if (name !== undefined) updateData["name"] = name;
        if (bio !== undefined) updateData["bio"] = bio;
        if (skills !== undefined) updateData["skills"] = serializeSkills(skills);
        if (categories !== undefined) updateData["categories"] = categories;
        if (hourlyRate !== undefined) updateData["hourlyRate"] = hourlyRate;
        if (isAvailable !== undefined) updateData["isAvailable"] = isAvailable;

        const updated = await prisma.expert.update({
          where: { id: user.expert.id },
          data: updateData,
        });

        return {
          success: true,
          expert: serializeExpert(updated),
          error: null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, expert: null, error: msg };
      }
    },

    /**
     * submitReview(reviewInput)
     * Allows the session seeker to leave a review.
     * - Verifies the caller is the seeker.
     * - Prevents duplicate reviews.
     * - Updates the expert's cached rating and reviewCount.
     */
    submitReview: async (
      _: unknown,
      { reviewInput }: SubmitReviewArgs,
      { prisma, walletAddress }: GraphQLContext
    ) => {
      if (!walletAddress) {
        return { success: false, review: null, error: "Authentication required" };
      }

      const { sessionId, rating, content } = reviewInput;

      // Validate rating range
      if (rating < 1 || rating > 5) {
        return { success: false, review: null, error: "Rating must be between 1 and 5" };
      }

      try {
        const session = await prisma.session.findUnique({
          where: { sessionId },
          include: { review: true },
        });

        if (!session) {
          return { success: false, review: null, error: "Session not found" };
        }

        // Only the seeker can leave a review
        if (session.seekerAddress !== walletAddress) {
          return { success: false, review: null, error: "Only the session seeker can submit a review" };
        }

        // Prevent duplicate reviews
        if (session.review) {
          return { success: false, review: null, error: "A review has already been submitted for this session" };
        }

        // Create the review
        const review = await prisma.review.create({
          data: {
            sessionId,
            rating,
            content,
            seekerAddress: walletAddress,
            expertId: session.expertId,
          },
        });

        // Recalculate expert's cached average rating
        const aggregate = await prisma.review.aggregate({
          where: { expertId: session.expertId },
          _avg: { rating: true },
          _count: { rating: true },
        });

        await prisma.expert.update({
          where: { id: session.expertId },
          data: {
            rating: aggregate._avg.rating ?? 0,
            reviewCount: aggregate._count.rating,
          },
        });

        return {
          success: true,
          review: serializeReview(review),
          error: null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, review: null, error: msg };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Field Resolvers — ExpertType
  // -------------------------------------------------------------------------
  ExpertType: {
    /** Lazily load reviews for an expert */
    reviews: async (
      parent: { id: string },
      _: unknown,
      { prisma }: GraphQLContext
    ) => {
      const reviews = await prisma.review.findMany({
        where: { expertId: parent.id },
        orderBy: { createdAt: "desc" },
      });
      return reviews.map(serializeReview);
    },
  },

  // -------------------------------------------------------------------------
  // Field Resolvers — SessionType
  // -------------------------------------------------------------------------
  SessionType: {
    /** Lazily load the expert for a session */
    expert: async (
      parent: { expertId: string },
      _: unknown,
      { prisma }: GraphQLContext
    ) => {
      const expert = await prisma.expert.findUnique({
        where: { id: parent.expertId },
      });
      if (!expert) {
        throw new GraphQLError("Expert not found for session", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return serializeExpert(expert);
    },

    /** Lazily load the review for a session */
    review: async (
      parent: { sessionId: string },
      _: unknown,
      { prisma }: GraphQLContext
    ) => {
      const review = await prisma.review.findUnique({
        where: { sessionId: parent.sessionId },
      });
      return review ? serializeReview(review) : null;
    },

    /** Lazily load all transactions for a session */
    transactions: async (
      parent: { sessionId: string },
      _: unknown,
      { prisma }: GraphQLContext
    ) => {
      const txs = await prisma.transaction.findMany({
        where: { sessionId: parent.sessionId },
        orderBy: { ledgerTime: "asc" },
      });
      return txs.map(serializeTransaction);
    },
  },

  // -------------------------------------------------------------------------
  // Field Resolvers — ReviewType
  // -------------------------------------------------------------------------
  ReviewType: {
    /** Lazily load the session for a review */
    session: async (
      parent: { sessionId: string },
      _: unknown,
      { prisma }: GraphQLContext
    ) => {
      const session = await prisma.session.findUnique({
        where: { sessionId: parent.sessionId },
      });
      if (!session) {
        throw new GraphQLError("Session not found for review", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return serializeSession(session);
    },

    /** Lazily load the expert for a review */
    expert: async (
      parent: { expertId: string },
      _: unknown,
      { prisma }: GraphQLContext
    ) => {
      const expert = await prisma.expert.findUnique({
        where: { id: parent.expertId },
      });
      if (!expert) {
        throw new GraphQLError("Expert not found for review", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return serializeExpert(expert);
    },
  },

  // -------------------------------------------------------------------------
  // Field Resolvers — TransactionType
  // -------------------------------------------------------------------------
  TransactionType: {
    /** Lazily load the session for a transaction */
    session: async (
      parent: { sessionId: string },
      _: unknown,
      { prisma }: GraphQLContext
    ) => {
      const session = await prisma.session.findUnique({
        where: { sessionId: parent.sessionId },
      });
      if (!session) {
        throw new GraphQLError("Session not found for transaction", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return serializeSession(session);
    },
  },

  Subscription: {
    sessionUpdated: {
      subscribe: (_: unknown, { sessionId }: { sessionId: string }) =>
        sessionStatusIterator(sessionId),
      resolve: (event: unknown) => event,
    },
  },
};
