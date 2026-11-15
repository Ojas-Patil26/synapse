import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- usage limiter, against a fake counter collection ----
const counters = new Map<string, number>();
vi.mock("../../lambda/lib/data/mongo", () => ({
  collections: async () => ({
    db: {
      collection: () => ({
        createIndex: async () => undefined,
        findOneAndUpdate: async (filter: { userId: string; kind: string; day: string }) => {
          const key = `${filter.userId}|${filter.kind}|${filter.day}`;
          counters.set(key, (counters.get(key) ?? 0) + 1);
          return { count: counters.get(key) };
        },
        deleteMany: async () => ({ deletedCount: 0 }),
      }),
    },
  }),
  deleteUserData: async () => ({ courses: 1, concepts: 2 }),
}));

import { consume, limitFor } from "../../lambda/lib/usage";

describe("usage limiter", () => {
  beforeEach(() => {
    counters.clear();
    delete process.env.AI_DAILY_LIMIT;
    delete process.env.INGEST_DAILY_LIMIT;
  });

  it("allows up to the daily limit, then answers 429 rate_limited", async () => {
    process.env.INGEST_DAILY_LIMIT = "3";
    expect(limitFor("ingest")).toBe(3);
    for (let i = 0; i < 3; i++) await consume("user-a", "ingest");
    await expect(consume("user-a", "ingest")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("counts each user and each kind separately", async () => {
    process.env.AI_DAILY_LIMIT = "1";
    await consume("user-a", "ai");
    await consume("user-b", "ai");
    await consume("user-a", "ingest");
    await expect(consume("user-a", "ai")).rejects.toMatchObject({ status: 429 });
  });

  it("falls back to the defaults for a missing or invalid setting", () => {
    process.env.AI_DAILY_LIMIT = "abc";
    expect(limitFor("ai")).toBe(80);
    expect(limitFor("ingest")).toBe(8);
  });
});
