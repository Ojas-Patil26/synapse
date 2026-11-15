// Seeds the demo data set (CSE 471 + CSE 475 with backdated review history) for one user.
// Run from /backend:
//   npx tsx --env-file=../.env ../scripts/seed.ts --user <userId> [--reset]
//   npx tsx ../scripts/seed.ts --dry-run          (no database: prints the planned end state)
// --reset first deletes ALL of that user's data in MongoDB and Tiger Data.
// Prints counts only.

import { closeMongo } from "../backend/lambda/lib/data/mongo";
import { safeError } from "../backend/lambda/lib/data/redact";
import { closePool } from "../backend/lambda/lib/data/tiger";
import { dryRun, seedUser } from "./seed-data";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--dry-run")) {
    const rows = dryRun();
    console.table(rows);
    console.log(`anomalous concepts: ${rows.filter((r) => r.anomalous).length}`);
    return 0;
  }
  const userIndex = args.indexOf("--user");
  const userId = userIndex >= 0 ? args[userIndex + 1] : undefined;
  if (!userId || userId.startsWith("--")) {
    console.error("usage: seed.ts --user <userId> [--reset]   |   seed.ts --dry-run");
    return 2;
  }
  try {
    const counts = await seedUser(userId, { reset: args.includes("--reset") });
    console.log(`seeded: ${JSON.stringify(counts)}`);
    return counts.anomalousConcepts >= 2 ? 0 : 1;
  } catch (err) {
    console.error(`seed FAILED: ${safeError(err)}`);
    return 1;
  } finally {
    await closeMongo().catch(() => {});
    await closePool().catch(() => {});
  }
}

main().then((code) => process.exit(code));
