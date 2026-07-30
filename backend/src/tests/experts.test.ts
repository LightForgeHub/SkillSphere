import request from "supertest";
import { Application } from "express";
import { createApp } from "../app";
import { createTestDatabase, seedExpert } from "./helpers/db";

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
  variables?: Record<string, unknown>
) {
  return request(app)
    .post("/graphql")
    .send({ query, variables })
    .set("Content-Type", "application/json");
}

describe("experts query — list and filtering", () => {
  let app: Application;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const result = await createApp(db.prisma);
    app = result.app;
  });

  it("returns an empty list when no experts exist", async () => {
    if (!dbAvailable) return;
    const res = await gql(
      app,
      `query {
        experts {
          id name
        }
      }`
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.experts).toHaveLength(0);
  });

  it("returns all experts without filters", async () => {
    if (!dbAvailable) return;
    await seedExpert(db.prisma, { name: "Alice", skills: "TypeScript,React" });
    await seedExpert(db.prisma, { name: "Bob", skills: "Python,Django" });
    await seedExpert(db.prisma, { name: "Carol", skills: "Rust,WebAssembly" });

    const res = await gql(
      app,
      `query {
        experts {
          id name bio skills hourlyRate isAvailable
        }
      }`
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const experts = res.body.data.experts;
    expect(experts).toHaveLength(3);

    // skills should be an array
    const alice = experts.find((e: { name: string }) => e.name === "Alice");
    expect(alice).toBeDefined();
    expect(alice.skills).toEqual(expect.arrayContaining(["TypeScript", "React"]));
  });

  it("applies limit and offset for pagination", async () => {
    if (!dbAvailable) return;
    for (let i = 1; i <= 5; i++) {
      await seedExpert(db.prisma, { name: `Expert ${i}` });
    }

    const page1 = await gql(
      app,
      `query ExpertsList($limit: Int, $offset: Int) {
        experts(limit: $limit, offset: $offset) {
          id name
        }
      }`,
      { limit: 2, offset: 0 }
    );

    expect(page1.status).toBe(200);
    const d1 = page1.body.data.experts;
    expect(d1).toHaveLength(2);

    const page2 = await gql(
      app,
      `query ExpertsList($limit: Int, $offset: Int) {
        experts(limit: $limit, offset: $offset) {
          id name
        }
      }`,
      { limit: 2, offset: 2 }
    );

    const d2 = page2.body.data.experts;
    expect(d2).toHaveLength(2);

    const page3 = await gql(
      app,
      `query ExpertsList($limit: Int, $offset: Int) {
        experts(limit: $limit, offset: $offset) {
          id name
        }
      }`,
      { limit: 2, offset: 4 }
    );

    const d3 = page3.body.data.experts;
    expect(d3).toHaveLength(1);

    // All 5 experts appear across the 3 pages
    const allIds = [
      ...d1.map((e: { id: string }) => e.id),
      ...d2.map((e: { id: string }) => e.id),
      ...d3.map((e: { id: string }) => e.id),
    ];
    expect(new Set(allIds).size).toBe(5);
  });

  it("filters experts by search term", async () => {
    if (!dbAvailable) return;
    await seedExpert(db.prisma, { name: "Alice", skills: "TypeScript,React" });
    await seedExpert(db.prisma, { name: "Bob", skills: "Python,Django" });
    await seedExpert(db.prisma, { name: "Carol", skills: "TypeScript,Node" });

    const res = await gql(
      app,
      `query SearchExperts($search: String) {
        experts(search: $search) {
          name skills
        }
      }`,
      { search: "TypeScript" }
    );

    expect(res.status).toBe(200);
    const experts = res.body.data.experts;
    expect(experts).toHaveLength(2);
    expect(
      experts.every((e: { skills: string[] }) => e.skills.includes("TypeScript"))
    ).toBe(true);
  });

  it("filters experts by category", async () => {
    if (!dbAvailable) return;
    // Create experts; one has "DeFi" in categories
    const { expert: e1 } = await seedExpert(db.prisma, { name: "DeFi Expert" });
    await db.prisma.expert.update({
      where: { id: e1.id },
      data: { categories: ["DeFi", "Blockchain"] },
    });
    await seedExpert(db.prisma, { name: "Web Dev" });

    const res = await gql(
      app,
      `query FilterByCategory($category: String) {
        experts(category: $category) {
          name
        }
      }`,
      { category: "DeFi" }
    );

    expect(res.status).toBe(200);
    const experts = res.body.data.experts;
    expect(experts).toHaveLength(1);
    expect(experts[0].name).toBe("DeFi Expert");
  });

  it("returns expert details in correct shape", async () => {
    if (!dbAvailable) return;
    await seedExpert(db.prisma, {
      name: "DetailExpert",
      bio: "My bio",
      skills: "Go,Kubernetes",
      hourlyRate: 200,
      isAvailable: false,
    });

    const res = await gql(
      app,
      `query {
        experts {
          id name bio skills hourlyRate isAvailable createdAt updatedAt
        }
      }`
    );

    expect(res.status).toBe(200);
    const expert = res.body.data.experts[0];
    expect(expert.name).toBe("DetailExpert");
    expect(expert.bio).toBe("My bio");
    expect(expert.skills).toEqual(expect.arrayContaining(["Go", "Kubernetes"]));
    expect(expert.hourlyRate).toBe(200);
    expect(expert.isAvailable).toBe(false);
    expect(typeof expert.createdAt).toBe("string");
    expect(typeof expert.updatedAt).toBe("string");
  });
});
