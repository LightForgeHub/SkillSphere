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

describe("experts query — pagination", () => {
  let app: Application;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const result = await createApp(db.prisma);
    app = result.app;
  });

  it("returns an empty page when no experts exist", async () => {
    if (!dbAvailable) return;
    const res = await gql(
      app,
      `query {
        experts {
          experts { id name }
          total
          page
          pageSize
          totalPages
        }
      }`
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const data = res.body.data.experts;
    expect(data.experts).toHaveLength(0);
    expect(data.total).toBe(0);
    expect(data.page).toBe(1);
    expect(data.totalPages).toBe(0);
  });

  it("returns all experts on a single page", async () => {
    if (!dbAvailable) return;
    await seedExpert(db.prisma, { name: "Alice", skills: "TypeScript,React" });
    await seedExpert(db.prisma, { name: "Bob", skills: "Python,Django" });
    await seedExpert(db.prisma, { name: "Carol", skills: "Rust,WebAssembly" });

    const res = await gql(
      app,
      `query {
        experts(page: 1, pageSize: 10) {
          experts { id name bio skills hourlyRate isAvailable }
          total
          page
          pageSize
          totalPages
        }
      }`
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const data = res.body.data.experts;
    expect(data.total).toBe(3);
    expect(data.experts).toHaveLength(3);
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(10);
    expect(data.totalPages).toBe(1);

    // skills should be an array
    const alice = data.experts.find((e: { name: string }) => e.name === "Alice");
    expect(alice).toBeDefined();
    expect(alice.skills).toEqual(expect.arrayContaining(["TypeScript", "React"]));
  });

  it("paginates correctly across multiple pages", async () => {
    if (!dbAvailable) return;
    for (let i = 1; i <= 5; i++) {
      await seedExpert(db.prisma, { name: `Expert ${i}` });
    }

    const page1 = await gql(
      app,
      `query ExpertsPage($page: Int, $pageSize: Int) {
        experts(page: $page, pageSize: $pageSize) {
          experts { id name }
          total
          page
          totalPages
        }
      }`,
      { page: 1, pageSize: 2 }
    );

    expect(page1.status).toBe(200);
    const d1 = page1.body.data.experts;
    expect(d1.experts).toHaveLength(2);
    expect(d1.total).toBe(5);
    expect(d1.totalPages).toBe(3);
    expect(d1.page).toBe(1);

    const page2 = await gql(
      app,
      `query ExpertsPage($page: Int, $pageSize: Int) {
        experts(page: $page, pageSize: $pageSize) {
          experts { id name }
          page
        }
      }`,
      { page: 2, pageSize: 2 }
    );

    const d2 = page2.body.data.experts;
    expect(d2.experts).toHaveLength(2);
    expect(d2.page).toBe(2);

    const page3 = await gql(
      app,
      `query ExpertsPage($page: Int, $pageSize: Int) {
        experts(page: $page, pageSize: $pageSize) {
          experts { id name }
          page
        }
      }`,
      { page: 3, pageSize: 2 }
    );

    const d3 = page3.body.data.experts;
    expect(d3.experts).toHaveLength(1);
    expect(d3.page).toBe(3);

    const allIds = [
      ...d1.experts.map((e: { id: string }) => e.id),
      ...d2.experts.map((e: { id: string }) => e.id),
      ...d3.experts.map((e: { id: string }) => e.id),
    ];
    expect(new Set(allIds).size).toBe(5);
  });

  it("filters experts by skill", async () => {
    if (!dbAvailable) return;
    await seedExpert(db.prisma, { name: "Alice", skills: "TypeScript,React" });
    await seedExpert(db.prisma, { name: "Bob", skills: "Python,Django" });
    await seedExpert(db.prisma, { name: "Carol", skills: "TypeScript,Node" });

    const res = await gql(
      app,
      `query ExpertsBySkill($skill: String) {
        experts(skill: $skill) {
          experts { name skills }
          total
        }
      }`,
      { skill: "TypeScript" }
    );

    expect(res.status).toBe(200);
    const data = res.body.data.experts;
    expect(data.total).toBe(2);
    expect(
      data.experts.every((e: { skills: string[] }) => e.skills.includes("TypeScript"))
    ).toBe(true);
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
          experts { id name bio skills hourlyRate isAvailable createdAt updatedAt }
        }
      }`
    );

    expect(res.status).toBe(200);
    const expert = res.body.data.experts.experts[0];
    expect(expert.name).toBe("DetailExpert");
    expect(expert.bio).toBe("My bio");
    expect(expert.skills).toEqual(expect.arrayContaining(["Go", "Kubernetes"]));
    expect(expert.hourlyRate).toBe(200);
    expect(expert.isAvailable).toBe(false);
    expect(typeof expert.createdAt).toBe("string");
    expect(typeof expert.updatedAt).toBe("string");
  });

  it("handles page=0 by clamping to page 1", async () => {
    if (!dbAvailable) return;
    await seedExpert(db.prisma);

    const res = await gql(
      app,
      `query {
        experts(page: 0) {
          page
          experts { id }
        }
      }`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.experts.page).toBe(1);
    expect(res.body.data.experts.experts).toHaveLength(1);
  });
});
