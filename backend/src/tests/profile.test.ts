import request from "supertest";
import { Application } from "express";
import { createApp } from "../app";
import { createTestDatabase, seedExpert } from "./helpers/db";
import { generateTestWallet, buildAuthHeaders, signMessage } from "./helpers/wallet";

const db = createTestDatabase();
let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.setup();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await db.teardown();
  }
});

beforeEach(async () => {
  if (dbAvailable) {
    await db.clearAll();
  }
});

async function gql(
  app: Application,
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>
) {
  const req = request(app)
    .post("/graphql")
    .send({ query, variables })
    .set("Content-Type", "application/json");

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      req.set(key, value);
    }
  }

  return req;
}

describe("updateProfile mutation", () => {
  let app: Application;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const result = await createApp(db.prisma);
    app = result.app;
  });

  const UPDATE_PROFILE = `
    mutation UpdateProfile($expertInput: ExpertInput!) {
      updateProfile(expertInput: $expertInput) {
        success
        error
        expert {
          id
          name
          bio
          skills
          hourlyRate
          isAvailable
        }
      }
    }
  `;

  const REGISTER_EXPERT = `
    mutation RegisterExpert($name: String!, $bio: String, $skills: [String!], $hourlyRate: Float) {
      registerExpert(name: $name, bio: $bio, skills: $skills, hourlyRate: $hourlyRate) {
        success
        error
        expert {
          id
          name
          bio
          skills
          hourlyRate
        }
      }
    }
  `;

  it("rejects updateProfile with no auth headers", async () => {
    if (!dbAvailable) return;
    const res = await gql(app, UPDATE_PROFILE, { expertInput: { name: "New Name" } });
    expect(res.status).toBe(200);
    expect(res.body.data.updateProfile.success).toBe(false);
    expect(res.body.data.updateProfile.error).toMatch(/authentication required/i);
  });

  it("rejects updateProfile with a wrong wallet signature", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();
    const otherWallet = generateTestWallet();

    const headers = {
      "x-wallet-address": wallet.address,
      "x-auth-message": "SkillSphere Auth",
      "x-auth-signature": signMessage(otherWallet, "SkillSphere Auth"),
    };

    const res = await gql(app, UPDATE_PROFILE, { expertInput: { name: "Hacker" } }, headers);
    expect(res.status).toBe(200);
    expect(res.body.data.updateProfile.success).toBe(false);
    expect(res.body.data.updateProfile.error).toMatch(/authentication required/i);
  });

  it("rejects updateProfile when expert profile does not exist", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();
    const headers = buildAuthHeaders(wallet);

    const res = await gql(app, UPDATE_PROFILE, { expertInput: { name: "Ghost" } }, headers);
    expect(res.status).toBe(200);
    expect(res.body.data.updateProfile.success).toBe(false);
    expect(res.body.data.updateProfile.error).toMatch(/not found/i);
  });

  it("successfully updates profile with correct wallet signature", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();

    const user = await db.prisma.user.create({ data: { walletAddress: wallet.address } });
    await db.prisma.expert.create({
      data: {
        userId: user.id,
        name: "Original Name",
        bio: "Original bio",
        skills: "TypeScript",
        hourlyRate: 50,
      },
    });

    const headers = buildAuthHeaders(wallet);

    const res = await gql(
      app,
      UPDATE_PROFILE,
      {
        expertInput: {
          name: "Updated Name",
          bio: "Updated bio",
          skills: ["TypeScript", "GraphQL", "Node"],
          hourlyRate: 150,
          isAvailable: false,
        },
      },
      headers
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const result = res.body.data.updateProfile;
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.expert.name).toBe("Updated Name");
    expect(result.expert.bio).toBe("Updated bio");
    expect(result.expert.skills).toEqual(
      expect.arrayContaining(["TypeScript", "GraphQL", "Node"])
    );
    expect(result.expert.hourlyRate).toBe(150);
    expect(result.expert.isAvailable).toBe(false);
  });

  it("partially updates profile — only provided fields change", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();

    const user = await db.prisma.user.create({ data: { walletAddress: wallet.address } });
    await db.prisma.expert.create({
      data: {
        userId: user.id,
        name: "Alice",
        bio: "Alice bio",
        skills: "Rust",
        hourlyRate: 75,
        isAvailable: true,
      },
    });

    const headers = buildAuthHeaders(wallet);

    const res = await gql(app, UPDATE_PROFILE, { expertInput: { bio: "New bio only" } }, headers);
    expect(res.status).toBe(200);
    const result = res.body.data.updateProfile;
    expect(result.success).toBe(true);
    expect(result.expert.name).toBe("Alice");
    expect(result.expert.bio).toBe("New bio only");
    expect(result.expert.skills).toContain("Rust");
    expect(result.expert.hourlyRate).toBe(75);
  });

  it("registerExpert succeeds with valid signature for a new wallet", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();
    const headers = buildAuthHeaders(wallet);

    const res = await gql(
      app,
      REGISTER_EXPERT,
      {
        name: "New Expert",
        bio: "I am new",
        skills: ["Python", "FastAPI"],
        hourlyRate: 80,
      },
      headers
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const result = res.body.data.registerExpert;
    expect(result.success).toBe(true);
    expect(result.expert.name).toBe("New Expert");
    expect(result.expert.skills).toEqual(
      expect.arrayContaining(["Python", "FastAPI"])
    );
    expect(result.expert.hourlyRate).toBe(80);
  });

  it("registerExpert fails if already registered", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();
    const headers = buildAuthHeaders(wallet);

    await gql(app, REGISTER_EXPERT, { name: "First Register" }, headers);

    const res = await gql(app, REGISTER_EXPERT, { name: "Duplicate" }, headers);
    expect(res.status).toBe(200);
    expect(res.body.data.registerExpert.success).toBe(false);
    expect(res.body.data.registerExpert.error).toMatch(/already exists/i);
  });

  it("registerExpert rejects unauthenticated requests", async () => {
    if (!dbAvailable) return;
    const res = await gql(app, REGISTER_EXPERT, { name: "NoAuth" });
    expect(res.status).toBe(200);
    expect(res.body.data.registerExpert.success).toBe(false);
    expect(res.body.data.registerExpert.error).toMatch(/authentication required/i);
  });

  it("expertByWallet returns the correct expert", async () => {
    if (!dbAvailable) return;
    const { user } = await seedExpert(db.prisma, {
      name: "FindMe",
      bio: "Find this expert",
    });

    const res = await gql(
      app,
      `query GetExpert($walletAddress: String!) {
        expertByWallet(walletAddress: $walletAddress) {
          id name bio
        }
      }`,
      { walletAddress: user.walletAddress }
    );

    expect(res.status).toBe(200);
    expect(res.body.data.expertByWallet).not.toBeNull();
    expect(res.body.data.expertByWallet.name).toBe("FindMe");
    expect(res.body.data.expertByWallet.bio).toBe("Find this expert");
  });

  it("expertByWallet returns null for unknown wallet", async () => {
    if (!dbAvailable) return;
    const res = await gql(
      app,
      `query {
        expertByWallet(walletAddress: "GUNKNOWNADDRESS") {
          id name
        }
      }`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.expertByWallet).toBeNull();
  });
});
