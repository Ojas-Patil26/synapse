// In-memory stand-ins for lib/data/mongo and lib/data/tiger, used by the offline
// vitest suites (vi.mock). They implement only what service.ts and the seed call.

import type { ReviewEvent, LatestState, ZScoreRow } from "../../lambda/lib/data/tiger";
import { computeZScores } from "../../lambda/lib/data/zscore";

type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return (value as Doc[]).some((sub) => matches(doc, sub));
    if (value && typeof value === "object" && !Array.isArray(value) && "$in" in value) {
      return (value.$in as unknown[]).includes(doc[key]);
    }
    return (doc[key] ?? null) === (value ?? null);
  });
}

const strip = (doc: Doc): Doc => {
  const { _id, ...rest } = structuredClone(doc);
  return rest;
};

export class FakeCollection {
  docs: Doc[] = [];
  private seq = 0;

  find(filter: Doc = {}, _opts?: unknown) {
    let rows = this.docs.filter((doc) => matches(doc, filter));
    const cursor = {
      sort: (spec: Record<string, 1 | -1>) => {
        const keys = Object.entries(spec);
        rows = [...rows].sort((a, b) => {
          for (const [key, dir] of keys) {
            if (a[key] < b[key]) return -dir;
            if (a[key] > b[key]) return dir;
          }
          return 0;
        });
        return cursor;
      },
      toArray: async () => rows.map(strip),
    };
    return cursor;
  }
  async findOne(filter: Doc, _opts?: unknown) {
    const doc = this.docs.find((d) => matches(d, filter));
    return doc ? strip(doc) : null;
  }
  async insertOne(doc: Doc) {
    this.docs.push({ ...structuredClone(doc), _id: ++this.seq });
  }
  async insertMany(docs: Doc[]) {
    for (const doc of docs) await this.insertOne(doc);
  }
  async updateOne(filter: Doc, update: Doc) {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, structuredClone(update.$set ?? {}));
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async replaceOne(filter: Doc, replacement: Doc, opts?: { upsert?: boolean }) {
    const index = this.docs.findIndex((d) => matches(d, filter));
    if (index >= 0) this.docs[index] = { ...structuredClone(replacement), _id: this.docs[index]._id };
    else if (opts?.upsert) await this.insertOne(replacement);
  }
  async bulkWrite(ops: { updateOne: { filter: Doc; update: Doc } }[], _opts?: unknown) {
    for (const op of ops) await this.updateOne(op.updateOne.filter, op.updateOne.update);
  }
  async deleteMany(filter: Doc) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matches(d, filter));
    return { deletedCount: before - this.docs.length };
  }
  async countDocuments(filter: Doc = {}) {
    return this.docs.filter((d) => matches(d, filter)).length;
  }
  async distinct(field: string) {
    return [...new Set(this.docs.map((d) => d[field]))];
  }
  async createIndex() {
    return "fake";
  }
  async indexes() {
    return [];
  }
}

const fake = {
  courses: new FakeCollection(),
  concepts: new FakeCollection(),
  edges: new FakeCollection(),
  links: new FakeCollection(),
  quizzes: new FakeCollection(),
};
const allCollections = (): [string, FakeCollection][] => [
  ["courses", fake.courses],
  ["concepts", fake.concepts],
  ["edges", fake.edges],
  ["crossCourseLinks", fake.links],
  ["quizzes", fake.quizzes],
];

/** Replacement for lib/data/mongo. */
export const fakeMongoModule = {
  collections: async () => fake,
  closeMongo: async () => {},
  deleteUserData: async (userId: string) => {
    const out: Record<string, number> = {};
    for (const [name, col] of allCollections()) out[name] = (await col.deleteMany({ userId })).deletedCount;
    return out;
  },
  countUserData: async (userId: string) => {
    const out: Record<string, number> = {};
    for (const [name, col] of allCollections()) out[name] = await col.countDocuments({ userId });
    return out;
  },
};

/** Raw event store, exposed so tests can backdate history. */
export const fakeTigerState: { events: ReviewEvent[] } = { events: [] };

const mine = (userId: string, conceptIds?: string[]) =>
  fakeTigerState.events.filter((e) => e.userId === userId && (!conceptIds || conceptIds.includes(e.conceptId)));

/** Replacement for lib/data/tiger. zScores uses the TypeScript mirror of the SQL. */
export const fakeTigerModule = {
  getPool: () => {
    throw new Error("no pool in the fake");
  },
  closePool: async () => {},
  ensureSchema: async () => ({ extension: false, hypertable: false, note: "fake" }),
  insertEvents: async (events: ReviewEvent[]) => {
    fakeTigerState.events.push(...events.map((e) => ({ ...e, ts: new Date(e.ts) })));
  },
  insertEvent: async (event: ReviewEvent) => {
    fakeTigerState.events.push({ ...event, ts: new Date(event.ts) });
  },
  latestStates: async (userId: string, conceptIds?: string[]) => {
    const out = new Map<string, LatestState>();
    for (const e of mine(userId, conceptIds)) {
      const current = out.get(e.conceptId);
      if (!current || e.ts.getTime() > current.lastEventAt.getTime()) {
        out.set(e.conceptId, { conceptId: e.conceptId, lastEventAt: e.ts, stability: e.stabilityAfter });
      }
    }
    return out;
  },
  reviewCounts: async (userId: string, courseId?: string) => {
    const out = new Map<string, number>();
    for (const e of mine(userId)) {
      if (e.eventType === "ingested" || (courseId && e.courseId !== courseId)) continue;
      out.set(e.conceptId, (out.get(e.conceptId) ?? 0) + 1);
    }
    return out;
  },
  zScores: async (userId: string, conceptIds?: string[]) => {
    const all = computeZScores(mine(userId));
    if (!conceptIds) return all;
    return new Map<string, ZScoreRow>([...all].filter(([id]) => conceptIds.includes(id)));
  },
  deleteCourseEvents: async (userId: string, courseId: string) => {
    const before = fakeTigerState.events.length;
    fakeTigerState.events = fakeTigerState.events.filter((e) => !(e.userId === userId && e.courseId === courseId));
    return before - fakeTigerState.events.length;
  },
  deleteUserEvents: async (userId: string) => {
    const before = fakeTigerState.events.length;
    fakeTigerState.events = fakeTigerState.events.filter((e) => e.userId !== userId);
    return before - fakeTigerState.events.length;
  },
  countUserEvents: async (userId: string) => mine(userId).length,
};
