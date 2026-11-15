// MongoDB access: courses, concepts, edges, crossCourseLinks, quizzes.
// Every document carries userId and every query filters by it.

import { MongoClient } from "mongodb";
import type { Collection, Db } from "mongodb";
import type {
  ConfidenceSource,
  CourseStatus,
  QuizMode,
  RelationType,
  Resource,
  StoredQuiz,
} from "../contracts";

export interface CourseDoc {
  userId: string;
  id: string;
  name: string;
  conceptCount: number;
  industrySkills: string[];
  skillsSummary: string;
  status: CourseStatus;
  error: string | null;
  createdAt: string;
  semester?: string | null;
  sourceText?: string;
}

export interface ConceptDoc {
  userId: string;
  id: string;
  courseId: string;
  label: string;
  summary: string;
  lastReviewed: string;
  stability: number;
  /** Retention right after the last review (R0). Absent or null means 1. */
  retentionStart?: number | null;
  /** Cache written by the scan and by reviews. Never served: reads recompute it. */
  retention: number;
  confidence: number | null;
  confidenceSource: ConfidenceSource | null;
  connectionCount: number;
  lastGenerated: { mode: QuizMode; score: number; at: string } | null;
  lastUploaded: { score: number; at: string } | null;
  zScore: number | null;
  anomalous: boolean;
  scannedAt: string | null;
  explanation: string | null;
  resources: Resource[];
  generatedAt: string | null;
  createdAt: string;
}

export interface EdgeDoc {
  userId: string;
  courseId: string;
  source: string;
  target: string;
  relationType: RelationType;
  isCrossCourse: boolean;
}

export interface LinkDoc {
  userId: string;
  sourceCourseId: string;
  targetCourseId: string;
  sharedConceptIds: string[];
  description: string;
  createdAt: string;
}

export type QuizDoc = StoredQuiz & { userId: string };

export interface Collections {
  db: Db;
  courses: Collection<CourseDoc>;
  concepts: Collection<ConceptDoc>;
  edges: Collection<EdgeDoc>;
  links: Collection<LinkDoc>;
  quizzes: Collection<QuizDoc>;
}

let client: MongoClient | null = null;
let ready: Promise<Collections> | null = null;

async function createIndexes(c: Collections): Promise<void> {
  await Promise.all([
    c.courses.createIndex({ userId: 1, id: 1 }, { unique: true }),
    c.courses.createIndex({ userId: 1, status: 1 }),
    c.concepts.createIndex({ userId: 1, id: 1 }, { unique: true }),
    c.concepts.createIndex({ userId: 1, courseId: 1 }),
    c.edges.createIndex({ userId: 1, courseId: 1 }),
    c.links.createIndex({ userId: 1, sourceCourseId: 1, targetCourseId: 1 }),
    c.quizzes.createIndex({ userId: 1, quizId: 1 }, { unique: true }),
  ]);
}

async function connect(): Promise<Collections> {
  const uri = process.env.MONGODB_URI;
  if (!uri || !uri.trim()) throw new Error("MONGODB_URI is not set");
  client = new MongoClient(uri.trim(), {
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    maxPoolSize: 5,
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? "synapse");
  const c: Collections = {
    db,
    courses: db.collection<CourseDoc>("courses"),
    concepts: db.collection<ConceptDoc>("concepts"),
    edges: db.collection<EdgeDoc>("edges"),
    links: db.collection<LinkDoc>("crossCourseLinks"),
    quizzes: db.collection<QuizDoc>("quizzes"),
  };
  // Once per cold start; a no-op on the server when the indexes already exist.
  await createIndexes(c);
  return c;
}

/** Lazily connected, module-level client so warm Lambda invocations reuse it. */
export function collections(): Promise<Collections> {
  if (!ready) {
    ready = connect().catch(async (err) => {
      ready = null;
      const stale = client;
      client = null;
      if (stale) await stale.close().catch(() => {});
      throw err;
    });
  }
  return ready;
}

export async function closeMongo(): Promise<void> {
  const c = client;
  client = null;
  ready = null;
  if (c) await c.close();
}

/** Removes everything one user owns. Used by the seed's --reset and by tests. */
export async function deleteUserData(userId: string): Promise<Record<string, number>> {
  const c = await collections();
  const [courses, concepts, edges, links, quizzes] = await Promise.all([
    c.courses.deleteMany({ userId }),
    c.concepts.deleteMany({ userId }),
    c.edges.deleteMany({ userId }),
    c.links.deleteMany({ userId }),
    c.quizzes.deleteMany({ userId }),
  ]);
  return {
    courses: courses.deletedCount,
    concepts: concepts.deletedCount,
    edges: edges.deletedCount,
    crossCourseLinks: links.deletedCount,
    quizzes: quizzes.deletedCount,
  };
}

export async function countUserData(userId: string): Promise<Record<string, number>> {
  const c = await collections();
  const [courses, concepts, edges, links, quizzes] = await Promise.all([
    c.courses.countDocuments({ userId }),
    c.concepts.countDocuments({ userId }),
    c.edges.countDocuments({ userId }),
    c.links.countDocuments({ userId }),
    c.quizzes.countDocuments({ userId }),
  ]);
  return { courses, concepts, edges, crossCourseLinks: links, quizzes };
}
