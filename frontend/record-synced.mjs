/**
 * Record one continuous dark-theme walkthrough with scene durations
 * taken from demo/scenes/timings.json so picture matches VO.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const timings = JSON.parse(readFileSync(join(ROOT, "demo/scenes/timings.json"), "utf8"));
const OUT = join(__dirname, "raw-synced");
mkdirSync(OUT, { recursive: true });

const EMAIL = "demo@synapse-op.us";
const PASS = "Synapse-c2db99-Demo7";
const BASE = "https://www.synapse-op.us";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forceDark(page) {
  await page.evaluate(() => {
    try {
      localStorage.setItem("synapse.theme", "dark");
    } catch {}
    document.documentElement.setAttribute("data-theme", "dark");
  });
}

async function smoothWheel(page, totalY, msBudget) {
  const steps = Math.max(8, Math.round(msBudget / 80));
  const dy = totalY / steps;
  const stepMs = msBudget / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy);
    await sleep(stepMs);
  }
}

/** Spend exactly `seconds` on this beat (accounting for work already done). */
async function holdFor(page, seconds, workMs = 0) {
  const remain = Math.max(0, seconds * 1000 - workMs);
  await sleep(remain);
}

async function main() {
  const byId = Object.fromEntries(timings.map((t) => [t.id, t.duration]));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("synapse.theme", "dark");
    } catch {}
    document.documentElement.setAttribute("data-theme", "dark");
  });

  const marks = [];
  const t0 = Date.now();
  const mark = (id) => marks.push({ id, at: (Date.now() - t0) / 1000 });

  // 01 intro — landing hero
  mark("01-intro");
  let t = Date.now();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 });
  await forceDark(page);
  await holdFor(page, byId["01-intro"], Date.now() - t);

  // 02 landing scroll / map idea
  mark("02-landing-map");
  t = Date.now();
  const d2 = byId["02-landing-map"];
  await smoothWheel(page, 420, Math.min(3500, d2 * 250));
  await sleep(800);
  await smoothWheel(page, 500, Math.min(4000, d2 * 280));
  await sleep(600);
  await smoothWheel(page, 400, Math.min(3000, d2 * 200));
  await holdFor(page, d2, Date.now() - t);

  // 03 login
  mark("03-login");
  t = Date.now();
  await smoothWheel(page, -1400, 1200);
  await page.getByRole("link", { name: /^Log in$/i }).first().click();
  await page.waitForURL("**/login**");
  await forceDark(page);
  await sleep(500);
  await page.locator('input[type="email"]').click();
  await page.locator('input[type="email"]').pressSequentially(EMAIL, { delay: 35 });
  await page.locator('input[type="password"]').click();
  await page.locator('input[type="password"]').pressSequentially(PASS, { delay: 30 });
  await holdFor(page, byId["03-login"], Date.now() - t);
  // submit just before home scene so login VO ends on filled form / transition
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL("**/app/**", { timeout: 30000 });
  await forceDark(page);

  // 04 home map
  mark("04-home-map");
  t = Date.now();
  const d4 = byId["04-home-map"];
  await sleep(1500);
  for (const [x, y] of [
    [500, 340],
    [640, 360],
    [780, 390],
    [700, 430],
    [560, 400],
  ]) {
    await page.mouse.move(x, y, { steps: 14 });
    await sleep(Math.min(900, (d4 * 1000) / 10));
  }
  await holdFor(page, d4, Date.now() - t);

  // 05 review next + popup
  mark("05-review");
  t = Date.now();
  const d5 = byId["05-review"];
  const reviewBtn = page.getByText(/review now/i).first();
  if (await reviewBtn.isVisible().catch(() => false)) {
    await reviewBtn.click();
    await sleep(Math.min(6000, d5 * 450));
  } else {
    await sleep(Math.min(5000, d5 * 400));
  }
  await holdFor(page, d5, Date.now() - t);
  const close = page.getByRole("button", { name: /close|got it|dismiss/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
  else await page.keyboard.press("Escape").catch(() => {});
  await sleep(400);

  // 06 upload
  mark("06-upload");
  t = Date.now();
  await page.getByRole("link", { name: /Upload Course/i }).click();
  await page.waitForURL("**/upload**");
  await forceDark(page);
  await sleep(1200);
  await smoothWheel(page, 260, 2000);
  await holdFor(page, byId["06-upload"], Date.now() - t);

  // 07 guide
  mark("07-guide");
  t = Date.now();
  const d7 = byId["07-guide"];
  await page.getByRole("link", { name: /^Guide$/i }).click();
  await page.waitForURL("**/guide**");
  await forceDark(page);
  await sleep(1500);
  await smoothWheel(page, 450, Math.min(4000, d7 * 280));
  await sleep(800);
  await smoothWheel(page, 500, Math.min(4000, d7 * 280));
  await holdFor(page, d7, Date.now() - t);

  // 08 close on home
  mark("08-close");
  t = Date.now();
  await page.getByRole("link", { name: /^Home$/i }).click();
  await page.waitForURL("**/home**");
  await forceDark(page);
  await sleep(1000);
  await page.mouse.move(640, 380, { steps: 20 });
  await holdFor(page, byId["08-close"], Date.now() - t);

  writeFileSync(join(ROOT, "demo/scenes/record-marks.json"), JSON.stringify({ marks, timings }, null, 2));
  const video = page.video();
  await context.close();
  await browser.close();
  console.log("RAW_VIDEO", await video.path());
  console.log("MARKS", marks);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
