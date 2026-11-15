// Tiger Data (TimescaleDB) access: the append-only `review_events` hypertable.
// Source of truth for stability, last review time and the z-score anomaly statistic.

import pg from "pg";
import { SIGMA_DEFAULT, SIGMA_FLOOR, ZSCORE_ANOMALY, ZSCORE_WINDOW } from "../contracts";
import type { EventType } from "../contracts";

export interface ReviewEvent {
  ts: Date;
  userId: string;
  courseId: string;
  conceptId: string;
  eventType: EventType;
  result: number | null;
  predictedRetention: number | null;
  stabilityBefore: number | null;
  stabilityAfter: number;
}

export interface LatestState {
  conceptId: string;
  lastEventAt: Date;
  stability: number;
}

export interface ZScoreRow {
  conceptId: string;
  n: number;
  meanResidual: number;
  sigma: number;
  zScore: number | null;
  anomalous: boolean;
}

let pool: pg.Pool | null = null;

/** Lazily created, module-level pool so warm Lambda invocations reuse connections. */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const raw = process.env.TIGERDATA_URL;
  if (!raw || !raw.trim()) throw new Error("TIGERDATA_URL is not set");
  // Strip sslmode/ssl* query params: pg lets them override the explicit `ssl` option below.
  let connectionString = raw.trim();
  try {
    const url = new URL(connectionString);
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("ssl")) url.searchParams.delete(key);
    }
    connectionString = url.toString();
  } catch {
    // Not URL-parseable (e.g. key=value DSN): hand it to pg unchanged.
  }
  pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    allowExitOnIdle: true,
  });
  // An idle client dropped by the server (frozen Lambda) must not crash the process.
  pool.on("error", () => {});
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/** Idempotent schema setup. Returns what happened so the migrate script can report it. */
export async function ensureSchema(): Promise<{ extension: boolean; hypertable: boolean; note: string | null }> {
  const db = getPool();
  let extension = false;
  let note: string | null = null;
  try {
    await db.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
    extension = true;
  } catch (err) {
    const existing = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
    extension = (existing.rowCount ?? 0) > 0;
    if (!extension) note = `timescaledb extension unavailable: ${(err as Error).message}`;
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS review_events (
      ts                  timestamptz      NOT NULL,
      user_id             text             NOT NULL,
      course_id           text             NOT NULL,
      concept_id          text             NOT NULL,
      event_type          text             NOT NULL,
      result              double precision,
      predicted_retention double precision,
      stability_before    double precision,
      stability_after     double precision
    )`);
  let hypertable = false;
  if (extension) {
    try {
      await db.query("SELECT create_hypertable('review_events', 'ts', if_not_exists => TRUE, migrate_data => TRUE)");
    } catch (err) {
      note = `create_hypertable failed: ${(err as Error).message}`;
    }
    const check = await db.query(
      "SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'review_events'",
    );
    hypertable = (check.rowCount ?? 0) > 0;
  }
  await db.query(
    "CREATE INDEX IF NOT EXISTS review_events_user_concept_ts_idx ON review_events (user_id, concept_id, ts DESC)",
  );
  return { extension, hypertable, note };
}

const INSERT_SQL = `
  INSERT INTO review_events
    (ts, user_id, course_id, concept_id, event_type, result, predicted_retention, stability_before, stability_after)
  SELECT * FROM unnest(
    $1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[],
    $6::float8[], $7::float8[], $8::float8[], $9::float8[])`;

/** Batched insert: one round trip per 500 events. */
export async function insertEvents(events: ReviewEvent[]): Promise<void> {
  const db = getPool();
  for (let i = 0; i < events.length; i += 500) {
    const chunk = events.slice(i, i + 500);
    await db.query(INSERT_SQL, [
      chunk.map((e) => e.ts.toISOString()),
      chunk.map((e) => e.userId),
      chunk.map((e) => e.courseId),
      chunk.map((e) => e.conceptId),
      chunk.map((e) => e.eventType),
      chunk.map((e) => e.result),
      chunk.map((e) => e.predictedRetention),
      chunk.map((e) => e.stabilityBefore),
      chunk.map((e) => e.stabilityAfter),
    ]);
  }
}

export async function insertEvent(event: ReviewEvent): Promise<void> {
  await insertEvents([event]);
}

/** Latest event per concept for one user: the authoritative lastReviewed and S. */
export async function latestStates(userId: string, conceptIds?: string[]): Promise<Map<string, LatestState>> {
  const db = getPool();
  const res = await db.query(
    `SELECT DISTINCT ON (concept_id) concept_id, ts, stability_after
       FROM review_events
      WHERE user_id = $1 AND ($2::text[] IS NULL OR concept_id = ANY($2::text[]))
      ORDER BY concept_id, ts DESC`,
    [userId, conceptIds ?? null],
  );
  const out = new Map<string, LatestState>();
  for (const row of res.rows) {
    if (row.stability_after === null) continue;
    out.set(row.concept_id, {
      conceptId: row.concept_id,
      lastEventAt: new Date(row.ts),
      stability: Number(row.stability_after),
    });
  }
  return out;
}

/** Number of non-ingested events per concept. */
export async function reviewCounts(userId: string, courseId?: string): Promise<Map<string, number>> {
  const db = getPool();
  const res = await db.query(
    `SELECT concept_id, count(*)::int AS reviews
       FROM review_events
      WHERE user_id = $1 AND ($2::text IS NULL OR course_id = $2::text) AND event_type <> 'ingested'
      GROUP BY concept_id`,
    [userId, courseId ?? null],
  );
  return new Map(res.rows.map((row) => [row.concept_id as string, Number(row.reviews)]));
}

// Z-score of anomalous decay, computed entirely in SQL (CONTRACTS.md section 2):
//   residual_i = result_i - predicted_retention_i          (quiz events only)
//   window     = each concept's last ZSCORE_WINDOW quiz events (n of them)
//   sigma      = sample stddev of ALL the user's quiz residuals in the last 90 days,
//                SIGMA_DEFAULT when there are fewer than 5 of them, floored at SIGMA_FLOOR
//   zScore     = mean(window residuals) * sqrt(n) / sigma
//   anomalous  = n >= 2 AND zScore <= ZSCORE_ANOMALY
const ZSCORE_SQL = `
  WITH quiz AS (
    SELECT concept_id, ts, result - predicted_retention AS residual
      FROM review_events
     WHERE user_id = $1
       AND event_type IN ('generated-quiz', 'uploaded-quiz')
       AND result IS NOT NULL
       AND predicted_retention IS NOT NULL
  ),
  sigma AS (
    SELECT GREATEST(
             CASE WHEN count(*) < 5 THEN $3::float8
                  ELSE COALESCE(stddev_samp(residual), $3::float8) END,
             $4::float8) AS sigma
      FROM quiz
     WHERE ts >= now() - INTERVAL '90 days'
  ),
  ranked AS (
    SELECT concept_id, ts, residual,
           row_number() OVER (PARTITION BY concept_id ORDER BY ts DESC) AS recency
      FROM quiz
  ),
  windowed AS (
    SELECT concept_id, count(*) AS n, avg(residual) AS mean_residual
      FROM ranked
     WHERE recency <= $2::int
     GROUP BY concept_id
  )
  SELECT w.concept_id,
         w.n::int                                       AS n,
         w.mean_residual                                AS mean_residual,
         s.sigma                                        AS sigma,
         w.mean_residual * sqrt(w.n::float8) / s.sigma  AS z_score,
         (w.n >= 2 AND w.mean_residual * sqrt(w.n::float8) / s.sigma <= $5::float8) AS anomalous
    FROM windowed w CROSS JOIN sigma s
   WHERE $6::text[] IS NULL OR w.concept_id = ANY($6::text[])`;

/**
 * One query for all of a user's concepts (optionally narrowed to some ids).
 * Concepts with no quiz events are absent from the map: zScore null, anomalous false.
 */
export async function zScores(userId: string, conceptIds?: string[]): Promise<Map<string, ZScoreRow>> {
  const db = getPool();
  const res = await db.query(ZSCORE_SQL, [
    userId,
    ZSCORE_WINDOW,
    SIGMA_DEFAULT,
    SIGMA_FLOOR,
    ZSCORE_ANOMALY,
    conceptIds ?? null,
  ]);
  const out = new Map<string, ZScoreRow>();
  for (const row of res.rows) {
    const n = Number(row.n);
    const z = row.z_score === null ? null : Number(row.z_score);
    out.set(row.concept_id, {
      conceptId: row.concept_id,
      n,
      meanResidual: Number(row.mean_residual),
      sigma: Number(row.sigma),
      zScore: n > 0 && z !== null && Number.isFinite(z) ? z : null,
      anomalous: row.anomalous === true,
    });
  }
  return out;
}

export async function deleteCourseEvents(userId: string, courseId: string): Promise<number> {
  const res = await getPool().query("DELETE FROM review_events WHERE user_id = $1 AND course_id = $2", [
    userId,
    courseId,
  ]);
  return res.rowCount ?? 0;
}

export async function deleteUserEvents(userId: string): Promise<number> {
  const res = await getPool().query("DELETE FROM review_events WHERE user_id = $1", [userId]);
  return res.rowCount ?? 0;
}

export async function countUserEvents(userId: string): Promise<number> {
  const res = await getPool().query("SELECT count(*)::int AS c FROM review_events WHERE user_id = $1", [userId]);
  return Number(res.rows[0].c);
}
