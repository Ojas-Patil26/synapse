// LIVE integration test against the real MongoDB and Tiger Data databases.
// Run from /backend:  npx tsx --env-file=../.env tests/data/integration.ts
// Uses a throwaway user id (itest-<random>) and deletes everything it created.

import { randomBytes } from "node:crypto";
import { closeMongo } from "../../lambda/lib/data/mongo";
import { safeError } from "../../lambda/lib/data/redact";
import { closePool } from "../../lambda/lib/data/tiger";
import { runScenario } from "./scenario";

async function main(): Promise<number> {
  const userId = `itest-${randomBytes(6).toString("hex")}`;
  console.log(`integration user: ${userId}`);
  const failures = await runScenario(userId, (line) => console.log(line));
  await closeMongo().catch(() => {});
  await closePool().catch(() => {});
  console.log(failures.length === 0 ? "\nINTEGRATION OK" : `\nINTEGRATION FAILED (${failures.length})`);
  for (const failure of failures) console.log(`  ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`integration crashed: ${safeError(err)}`);
    process.exit(1);
  },
);
