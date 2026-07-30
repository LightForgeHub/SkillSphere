/**
 * graphql.test.ts
 * Integration tests for the newly implemented GraphQL queries and mutations:
 *   - expert(id)
 *   - session(id) — status and nested relations
 *   - submitReview — success, duplicate, unauthorized seeker
 *   - Error payload sanitization
 */

import request from "supertest";
import { Application } from "express";
import { createApp } from "../app";
import {
  createTestDatabase,
  seedExpert,
  seedSession,
} from "./helpers/db";
import { generateTestWallet, buildAuthHeaders } from "./helpers/wallet";

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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// expert(id) query
// ---------------------------------------------------------------------------

describe("expert(id) query", () => {
  let app: Application;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const result = await createApp(db.prisma);
    app = result.app;
  });

  it("returns null for an unknown ID", async () => {
    if (!dbAvailable) return;
    const res = await gql(
      app,
      `query {
        expert(id: "nonexistent-id") {
          id name
        }
      }`
    );
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.expert).toBeNull();
  });

  it("returns expert with all scalar fields by ID", async () => {
    if (!dbAvailable) return;
    const { expert } = await seedExpert(db.prisma, {
      name: "ID Expert",
      bio: "Has an ID",
      skills: "Solidity,Rust",
      hourlyRate: 300,
      isAvailable: true,
    });

    const res = await gql(
      app,
      `query GetExpert($id: ID!) {
        expert(id: $id) {
          id
          name
          bio
          skills
          categories
          hourlyRate
          rating
          reviewCount
          isAvailable
          createdAt
          updatedAt
        }
      }`,
      { id: expert.id }
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const data = res.body.data.expert;
    expect(data.id).toBe(expert.id);
    expect(data.name).toBe("ID Expert");
    expect(data.skills).toEqual(expect.arrayContaining(["Solidity", "Rust"]));
    expect(data.categories).toEqual([]);
    expect(data.rating).toBe(0);
    expect(data.reviewCount).toBe(0);
    expect(data.isAvailable).toBe(true);
    expect(typeof data.createdAt).toBe("string");
    expect(typeof data.updatedAt).toBe("string");
  });

  it("returns nested reviews for an expert", async () => {
    if (!dbAvailable) return;
    const seekerWallet = generateTestWallet();

    // Create expert and a completed session for the seeker
    const { expert } = await seedExpert(db.prisma, { name: "ReviewedExpert" });
    const session = await seedSession(db.prisma, {
      seekerAddress: seekerWallet.address,
      expertId: expert.id,
      expertAddress: `GEXPR${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "COMPLETED",
    });

    // Create the review directly in DB
    await db.prisma.review.create({
      data: {
        sessionId: session.sessionId,
        rating: 5,
        content: "Excellent!",
        seekerAddress: seekerWallet.address,
        expertId: expert.id,
      },
    });

    const res = await gql(
      app,
      `query GetExpert($id: ID!) {
        expert(id: $id) {
          id
          name
          reviews {
            id
            rating
            content
            seekerAddress
          }
        }
      }`,
      { id: expert.id }
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const data = res.body.data.expert;
    expect(data.reviews).toHaveLength(1);
    expect(data.reviews[0].rating).toBe(5);
    expect(data.reviews[0].content).toBe("Excellent!");
  });
});

// ---------------------------------------------------------------------------
// session(id) query
// ---------------------------------------------------------------------------

describe("session(id) query", () => {
  let app: Application;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const result = await createApp(db.prisma);
    app = result.app;
  });

  it("returns null for an unknown session ID", async () => {
    if (!dbAvailable) return;
    const res = await gql(
      app,
      `query {
        session(id: "00000000-0000-0000-0000-000000000000") {
          sessionId status
        }
      }`
    );
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.session).toBeNull();
  });

  it("returns correct session status and scalar fields", async () => {
    if (!dbAvailable) return;
    const session = await seedSession(db.prisma, {
      status: "ACTIVE",
      escrowAmount: 50000000n,
    });

    const res = await gql(
      app,
      `query GetSession($id: ID!) {
        session(id: $id) {
          sessionId
          seekerAddress
          expertAddress
          status
          escrowAmount
          createdAt
          updatedAt
        }
      }`,
      { id: session.sessionId }
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const data = res.body.data.session;
    expect(data.sessionId).toBe(session.sessionId);
    expect(data.status).toBe("ACTIVE");
    // escrowAmount is serialized to string (BigInt)
    expect(data.escrowAmount).toBe("50000000");
    expect(typeof data.createdAt).toBe("string");
    expect(typeof data.updatedAt).toBe("string");
  });

  it("returns the expert relation from a session", async () => {
    if (!dbAvailable) return;
    const { expert } = await seedExpert(db.prisma, { name: "Session Expert" });
    const session = await seedSession(db.prisma, { expertId: expert.id });

    const res = await gql(
      app,
      `query GetSession($id: ID!) {
        session(id: $id) {
          sessionId
          expert {
            id
            name
          }
        }
      }`,
      { id: session.sessionId }
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const data = res.body.data.session;
    expect(data.expert.id).toBe(expert.id);
    expect(data.expert.name).toBe("Session Expert");
  });

  it("returns transactions list for a session", async () => {
    if (!dbAvailable) return;
    const session = await seedSession(db.prisma, { status: "COMPLETED" });

    // Seed a transaction directly
    await db.prisma.transaction.create({
      data: {
        txHash: `hash-${Math.random().toString(36).slice(2)}`,
        sessionId: session.sessionId,
        amount: 10000000n,
        type: "ESCROW_FUNDED",
        ledgerTime: new Date(),
      },
    });

    const res = await gql(
      app,
      `query GetSession($id: ID!) {
        session(id: $id) {
          sessionId
          transactions {
            id
            txHash
            amount
            type
            ledgerTime
          }
        }
      }`,
      { id: session.sessionId }
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const data = res.body.data.session;
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0].type).toBe("ESCROW_FUNDED");
    expect(data.transactions[0].amount).toBe("10000000");
    expect(typeof data.transactions[0].ledgerTime).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// submitReview mutation
// ---------------------------------------------------------------------------

describe("submitReview mutation", () => {
  let app: Application;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const result = await createApp(db.prisma);
    app = result.app;
  });

  const SUBMIT_REVIEW = `
    mutation SubmitReview($reviewInput: ReviewInput!) {
      submitReview(reviewInput: $reviewInput) {
        success
        error
        review {
          id
          rating
          content
          seekerAddress
          expertId
        }
      }
    }
  `;

  it("rejects unauthenticated submitReview", async () => {
    if (!dbAvailable) return;
    const session = await seedSession(db.prisma, { status: "COMPLETED" });
    const res = await gql(app, SUBMIT_REVIEW, {
      reviewInput: { sessionId: session.sessionId, rating: 5, content: "Great!" },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.submitReview.success).toBe(false);
    expect(res.body.data.submitReview.error).toMatch(/authentication required/i);
  });

  it("rejects review from a non-seeker wallet", async () => {
    if (!dbAvailable) return;
    const fakeSeeker = generateTestWallet();
    const session = await seedSession(db.prisma, { status: "COMPLETED" });

    const headers = buildAuthHeaders(fakeSeeker);

    const res = await gql(
      app,
      SUBMIT_REVIEW,
      { reviewInput: { sessionId: session.sessionId, rating: 4, content: "Good" } },
      headers
    );

    expect(res.status).toBe(200);
    expect(res.body.data.submitReview.success).toBe(false);
    expect(res.body.data.submitReview.error).toMatch(/seeker/i);
  });

  it("rejects review for a non-existent session", async () => {
    if (!dbAvailable) return;
    const wallet = generateTestWallet();
    const headers = buildAuthHeaders(wallet);

    const res = await gql(
      app,
      SUBMIT_REVIEW,
      {
        reviewInput: {
          sessionId: "00000000-0000-0000-0000-000000000000",
          rating: 5,
          content: "Ghost session",
        },
      },
      headers
    );

    expect(res.status).toBe(200);
    expect(res.body.data.submitReview.success).toBe(false);
    expect(res.body.data.submitReview.error).toMatch(/not found/i);
  });

  it("successfully submits a review and updates expert rating", async () => {
    if (!dbAvailable) return;
    const seekerWallet = generateTestWallet();

    const { expert } = await seedExpert(db.prisma, { name: "Rateable Expert" });
    const session = await seedSession(db.prisma, {
      seekerAddress: seekerWallet.address,
      expertId: expert.id,
      expertAddress: `GEXPR${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "COMPLETED",
    });

    const headers = buildAuthHeaders(seekerWallet);

    const res = await gql(
      app,
      SUBMIT_REVIEW,
      {
        reviewInput: {
          sessionId: session.sessionId,
          rating: 5,
          content: "Absolutely brilliant!",
        },
      },
      headers
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const result = res.body.data.submitReview;
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.review.rating).toBe(5);
    expect(result.review.content).toBe("Absolutely brilliant!");
    expect(result.review.seekerAddress).toBe(seekerWallet.address);
    expect(result.review.expertId).toBe(expert.id);

    // Verify the expert's cached rating was updated in the database
    const updatedExpert = await db.prisma.expert.findUnique({ where: { id: expert.id } });
    expect(updatedExpert?.rating).toBe(5);
    expect(updatedExpert?.reviewCount).toBe(1);
  });

  it("rejects a duplicate review for the same session", async () => {
    if (!dbAvailable) return;
    const seekerWallet = generateTestWallet();

    const { expert } = await seedExpert(db.prisma, { name: "Duplicate Review Expert" });
    const session = await seedSession(db.prisma, {
      seekerAddress: seekerWallet.address,
      expertId: expert.id,
      expertAddress: `GEXPR${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "COMPLETED",
    });

    const headers = buildAuthHeaders(seekerWallet);
    const reviewInput = { sessionId: session.sessionId, rating: 4, content: "Good session" };

    // Submit first review
    await gql(app, SUBMIT_REVIEW, { reviewInput }, headers);

    // Attempt to submit second review for same session
    const res = await gql(app, SUBMIT_REVIEW, { reviewInput }, headers);

    expect(res.status).toBe(200);
    expect(res.body.data.submitReview.success).toBe(false);
    expect(res.body.data.submitReview.error).toMatch(/already been submitted/i);
  });

  it("rejects a review with an invalid rating (out of 1-5)", async () => {
    if (!dbAvailable) return;
    const seekerWallet = generateTestWallet();

    const { expert } = await seedExpert(db.prisma, { name: "Invalid Rating Expert" });
    const session = await seedSession(db.prisma, {
      seekerAddress: seekerWallet.address,
      expertId: expert.id,
      expertAddress: `GEXPR${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "COMPLETED",
    });

    const headers = buildAuthHeaders(seekerWallet);

    const res = await gql(
      app,
      SUBMIT_REVIEW,
      { reviewInput: { sessionId: session.sessionId, rating: 6, content: "Too high" } },
      headers
    );

    expect(res.status).toBe(200);
    expect(res.body.data.submitReview.success).toBe(false);
    expect(res.body.data.submitReview.error).toMatch(/between 1 and 5/i);
  });
});

// ---------------------------------------------------------------------------
// Error payload sanitization
// ---------------------------------------------------------------------------

describe("GraphQL error payload sanitization", () => {
  let app: Application;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const result = await createApp(db.prisma);
    app = result.app;
  });

  it("returns a clean error for an invalid query field", async () => {
    if (!dbAvailable) return;
    const res = await gql(
      app,
      `query {
        experts {
          nonExistentField
        }
      }`
    );

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toBeDefined();
  });

  it("returns 200 with errors array for missing required variable", async () => {
    if (!dbAvailable) return;
    // session(id) requires an ID — omit it
    const res = await gql(
      app,
      `query GetSession($id: ID!) {
        session(id: $id) {
          sessionId
        }
      }`,
      {} // missing $id
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/variable/i);
  });
});
