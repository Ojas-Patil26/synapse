// Browser end-to-end check of the frontend in HTTP mode against a running API.
//
// Local (mock login, API on :3001, seeded "dev-user"):
//   VITE_USE_FIXTURES=false VITE_MOCK_AUTH=true VITE_API_BASE_URL=http://localhost:3001 npx vite --port 5173
//   node scripts/e2e-http.mjs
// Deployed site (real Cognito; signs up a fresh account unless EMAIL/PASSWORD are given):
//   SITE_URL=https://dxxxx.cloudfront.net API_URL=https://xxxx.execute-api.us-east-2.amazonaws.com node scripts/e2e-http.mjs --signup
//
// Screenshots go to screenshots/e2e-*.png.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "screenshots");
mkdirSync(out, { recursive: true });
const SITE = (process.env.SITE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const SIGNUP = process.argv.includes("--signup");
const EMAIL = process.env.EMAIL ?? (SIGNUP ? `e2e-${Date.now()}@example.com` : "demo@asu.edu");
const PASSWORD = process.env.PASSWORD ?? "synapse-e2e-1234";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
const problems = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("synapse.e2e", "1");
  } catch {}
});
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
const apiCalls = [];
page.on("response", (r) => {
  const u = new URL(r.url());
  if (!u.host.startsWith("localhost:5173") && !/\.(js|css|png|svg|woff2?)$/.test(u.pathname) && r.request().method() !== "OPTIONS") {
    apiCalls.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
  }
});
const shot = (name) => page.screenshot({ path: join(out, `e2e-${name}.png`) });

try {
  // ---- sign up / log in ----
  await page.goto(`${SITE}/${SIGNUP ? "signup" : "login"}`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app\/(home|upload)/, { timeout: 30000 });
  const landed = new URL(page.url()).pathname;
  check(`${SIGNUP ? "sign up" : "log in"} lands inside the app`, true, landed);

  if (landed.endsWith("/upload")) {
    check("account with no courses lands on Upload Course", true);
    await shot("upload-empty");
    console.log("No courses on this account; upload flow is covered by the API smoke test with --uploads.");
  } else {
    // ---- home graph from the real API ----
    await page.waitForSelector("canvas", { timeout: 20000 });
    await wait(6000); // let the force layout settle
    const heading = (await page.locator("main").innerText()).split("\n").slice(0, 3).join(" | ");
    check("Home renders the graph heading from API data", /\d+ concepts/.test(heading), heading);
    const options = await page.locator(".course-filter option").allTextContents();
    check("course dropdown lists All courses plus each course", options.length >= 2, options.join(" | "));
    await shot("home");

    // pick a top-level concept from what the page itself loaded (test hook in GraphView)
    let target = null;
    const ids = await page.evaluate(() => window.__synapseGraph?.ids?.() ?? []);
    for (const id of ids) {
      const c = await page.evaluate((i) => window.__synapseGraph?.coords(i), id);
      if (c && c.x > 60 && c.x < 1380 && c.y > 140 && c.y < 760) {
        target = { id, ...c };
        break;
      }
    }
    check("a concept node can be located on the canvas", Boolean(target), target ? target.id : "set NODE_ID=<concept id>");

    if (target) {
      await page.mouse.click(target.x, target.y);
      await page.waitForSelector(".popup", { timeout: 5000 });
      const instant = await page.locator(".popup").innerText();
      check("popup opens at once with retention, confidence and a summary", /Retention/.test(instant) && /Confidence/.test(instant) && instant.length > 150);
      await shot("popup-instant");
      const before = apiCalls.length;
      await page.waitForResponse((r) => /\/guide\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === "GET", { timeout: 40000 }).catch(() => null);
      await wait(500);
      check("popup fetched GET /guide/:conceptId", apiCalls.slice(before - 3).some((c) => /^200 GET \/guide\/.+/.test(c)) || apiCalls.some((c) => /^200 GET \/guide\/.+/.test(c)));
      await shot("popup-personalized");

      // ---- mark reviewed ----
      await page.click("text=Got it");
      await page.waitForSelector(".note-ok", { timeout: 15000 });
      check("Mark reviewed -> Got it succeeds", apiCalls.includes("200 POST /review"));
      const afterReview = await page.locator(".popup .stats dd").first().textContent();
      check("retention shows 100% after the review", /100%/.test(afterReview ?? ""), afterReview ?? "");

      // ---- generated quiz ----
      await page.click("text=Take quiz");
      await page.waitForSelector("text=Have a Canvas quiz for this concept?");
      await page.click("text=No, quiz me");
      await page.waitForSelector(".question", { timeout: 45000 });
      const count = await page.locator(".question").count();
      const points = await page.locator(".q-points").allTextContents();
      check("full quiz shows 10 questions with point values", count === 10 && points.length === 10, `${count} questions; ${points.join(",")}`);
      await shot("quiz-questions");
      for (let i = 0; i < count; i++) await page.locator(".question").nth(i).locator(".option").nth(i % 4).click();
      await page.click("text=Submit quiz");
      await page.waitForSelector(".result-card", { timeout: 30000 });
      const result = (await page.locator(".result-card").innerText()).replace(/\n/g, " ");
      check("quiz submit returns a graded result", /\d+\s*\/\s*19|\d+%/.test(result), result.slice(0, 120));
      await shot("quiz-results");
      await page.click("text=Done");
      await wait(600);
      const conf = await page.locator(".popup .stats dd").nth(1).textContent();
      check("popup confidence updated live after the quiz", /(Low|Medium|High)/.test(conf ?? ""), conf ?? "");
      await shot("home-after-quiz");

      // ---- guide ----
      await page.click("text=View full guide entry");
      await page.waitForURL(/\/app\/guide\/.+/, { timeout: 10000 });
      await page.waitForSelector("text=Mark reviewed", { timeout: 40000 });
      await wait(800);
      const entryText = await page.locator("main").innerText();
      check("Guide entry shows the full explanation and resource links", entryText.length > 600 && (await page.locator('main a[target="_blank"]').count()) >= 3, `${entryText.length} chars`);
      await shot("guide-entry");
    }

    await page.click("nav >> text=Guide");
    await page.waitForSelector(".guide-row", { timeout: 20000 });
    const rows = await page.locator(".guide-row").count();
    check("Guide lists every concept", rows >= 5, `${rows} rows`);
    const badges = await page.locator("text=Fading faster than expected").count();
    console.log(`     anomaly badges shown: ${badges}`);
    await shot("guide-list");

    // ---- single-course filter ----
    await page.click("nav >> text=Home");
    await page.waitForSelector("canvas");
    const values = await page.locator(".course-filter option").evaluateAll((os) => os.map((o) => o.value));
    if (values.length >= 2) {
      await page.selectOption(".course-filter select", values[1]);
      await wait(5000);
      check("dropdown filter calls GET /graph/:courseId", apiCalls.some((c) => /^200 GET \/graph\/.+/.test(c)));
      await shot("home-single-course");
    }
  }
} catch (err) {
  failures.push(`crashed: ${err.message.split("\n")[0]}`);
  console.log(`CRASH ${err.message.split("\n")[0]}`);
  await shot("crash").catch(() => {});
}

await browser.close();
const bad = apiCalls.filter((c) => /^[45]\d\d /.test(c));
console.log(`\nAPI calls seen: ${apiCalls.length}; non-2xx: ${bad.length ? bad.join("; ") : "none"}`);
console.log(`browser errors: ${problems.length ? problems.slice(0, 5).join(" || ") : "none"}`);
console.log(`${passed} passed, ${failures.length} failed${failures.length ? ": " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
