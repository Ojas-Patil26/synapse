// Idempotent schema setup for Tiger Data (review_events hypertable) and MongoDB (indexes).
// Run from /backend:  npx tsx --env-file=../.env ../scripts/migrate.ts
// Prints statuses only, never a connection string.

import { closeMongo, collections } from "../backend/lambda/lib/data/mongo";
import { safeError } from "../backend/lambda/lib/data/redact";
import { closePool, ensureSchema, getPool } from "../backend/lambda/lib/data/tiger";

async function main(): Promise<number> {
  let failed = false;

  try {
    const result = await ensureSchema();
    const rows = await getPool().query("SELECT count(*)::int AS c FROM review_events");
    const index = await getPool().query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'review_events' AND indexname = 'review_events_user_concept_ts_idx'",
    );
    console.log(`tiger: timescaledb extension ${result.extension ? "present" : "NOT available"}`);
    console.log(`tiger: review_events ${result.hypertable ? "is a hypertable" : "is a PLAIN table (not a hypertable)"}`);
    console.log(`tiger: index (user_id, concept_id, ts DESC) ${(index.rowCount ?? 0) > 0 ? "present" : "MISSING"}`);
    console.log(`tiger: review_events rows = ${rows.rows[0].c}`);
    if (result.note) console.log(`tiger: note: ${safeError(new Error(result.note))}`);
  } catch (err) {
    failed = true;
    console.error(`tiger: FAILED ${safeError(err)}`);
  } finally {
    await closePool().catch(() => {});
  }

  try {
    const c = await collections(); // creates the indexes
    for (const [name, col] of Object.entries({
      courses: c.courses,
      concepts: c.concepts,
      edges: c.edges,
      crossCourseLinks: c.links,
      quizzes: c.quizzes,
    })) {
      const indexes = await col.indexes();
      console.log(`mongo: ${name} indexes = ${indexes.map((i) => i.name).join(", ")}`);
    }
  } catch (err) {
    failed = true;
    console.error(`mongo: FAILED ${safeError(err)}`);
  } finally {
    await closeMongo().catch(() => {});
  }

  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`migrate: FAILED ${safeError(err)}`);
    process.exit(1);
  },
);
