// Dev tool, not a real test: runs the local API server with in-memory MongoDB and
// Tiger Data (the same fakes the data tests use) and the seeded demo data set, so the
// HTTP layer, the data service and live Gemini can be exercised together without
// database credentials. Skipped unless FAKE_SERVER=1.
//
// From /backend:
//   FAKE_SERVER=1 node --env-file=../.env node_modules/vitest/vitest.mjs run tests/e2e/fake-server.test.ts
// Then in another shell:  npx tsx tests/e2e/http-smoke.ts
// Stops after FAKE_SERVER_SECONDS (default 900) or when the port is killed.

import { describe, it, vi } from "vitest";

vi.mock("../../lambda/lib/data/mongo", async () => (await import("../data/fakes")).fakeMongoModule);
vi.mock("../../lambda/lib/data/tiger", async () => (await import("../data/fakes")).fakeTigerModule);

const enabled = process.env.FAKE_SERVER === "1";
const seconds = Number(process.env.FAKE_SERVER_SECONDS ?? 900);

describe.skipIf(!enabled)("fake-backed local server", () => {
  it(
    "serves until the timer runs out",
    async () => {
      const { seedUser } = await import("../../../scripts/seed-data");
      const counts = await seedUser("dev-user", { reset: true });
      console.log(`seeded dev-user: ${JSON.stringify(counts)}`);
      await import("../../local-server");
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    },
    (seconds + 60) * 1000,
  );
});
