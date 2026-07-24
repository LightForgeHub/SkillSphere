import { GraphQLContext } from "./context";

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

interface ExpertsArgs {
  page?: number;
  pageSize?: number;
  skill?: string;
}

interface ExpertByWalletArgs {
  walletAddress: string;
}

interface UpdateProfileArgs {
  name?: string;
  bio?: string;
  skills?: string[];
  hourlyRate?: number;
  isAvailable?: boolean;
}

interface RegisterExpertArgs {
  name: string;
  bio?: string;
  skills?: string[];
  hourlyRate?: number;
}

export const resolvers = {
  Query: {
    experts: async (
      _: unknown,
      { page = 1, pageSize = 10, skill }: ExpertsArgs,
      { prisma }: GraphQLContext
    ) => {
      const safePage = Math.max(1, page);
      const safePageSize = Math.min(100, Math.max(1, pageSize));
      const skip = (safePage - 1) * safePageSize;

      const where = skill
        ? { skills: { contains: skill } }
        : {};

      const [experts, total] = await Promise.all([
        prisma.expert.findMany({
          where,
          skip,
          take: safePageSize,
          orderBy: { createdAt: "desc" },
        }),
        prisma.expert.count({ where }),
      ]);

      return {
        experts: experts.map((e) => ({
          ...e,
          skills: parseSkills(e.skills),
          createdAt: e.createdAt.toISOString(),
          updatedAt: e.updatedAt.toISOString(),
        })),
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
      };
    },

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

      return {
        ...user.expert,
        skills: parseSkills(user.expert.skills),
        createdAt: user.expert.createdAt.toISOString(),
        updatedAt: user.expert.updatedAt.toISOString(),
      };
    },
  },

  Mutation: {
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
          expert: {
            ...expert,
            skills: parseSkills(expert.skills),
            createdAt: expert.createdAt.toISOString(),
            updatedAt: expert.updatedAt.toISOString(),
          },
          error: null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, expert: null, error: msg };
      }
    },

    updateProfile: async (
      _: unknown,
      { name, bio, skills, hourlyRate, isAvailable }: UpdateProfileArgs,
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

        const updateData: Record<string, unknown> = {};
        if (name !== undefined) updateData["name"] = name;
        if (bio !== undefined) updateData["bio"] = bio;
        if (skills !== undefined) updateData["skills"] = serializeSkills(skills);
        if (hourlyRate !== undefined) updateData["hourlyRate"] = hourlyRate;
        if (isAvailable !== undefined) updateData["isAvailable"] = isAvailable;

        const updated = await prisma.expert.update({
          where: { id: user.expert.id },
          data: updateData,
        });

        return {
          success: true,
          expert: {
            ...updated,
            skills: parseSkills(updated.skills),
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          },
          error: null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, expert: null, error: msg };
      }
    },
  },
};
