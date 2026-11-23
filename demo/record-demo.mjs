/**
 * Screen-record Synapse for the JFF Future of Work demo.
 * Timing aligned to demo/voiceover.wav (~127s).
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "raw");
mkdirSync(OUT, { recursive: true });

const EMAIL = "demo@synapse-op.us";
const PASS = "Synapse-c2db99-Demo7";
const BASE = "https://www.synapse-op.us";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();

  // 0–18s — landing hero + scroll
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await sleep(5000);
  await page.mouse.wheel(0, 420);
  await sleep(4500);
  await page.mouse.wheel(0, 520);
  await sleep(4500);
  await page.mouse.wheel(0, 600);
  await sleep(4000);

  // 18–40s — login
  await page.getByRole("link", { name: /^Log in$/i }).first().click();
  await page.waitForURL("**/login**");
  await sleep(2000);
  await page.locator('input[type="email"]').click();
  await page.locator('input[type="email"]').fill(EMAIL);
  await sleep(1200);
  await page.locator('input[type="password"]').click();
  await page.locator('input[type="password"]').fill(PASS);
  await sleep(1500);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL("**/app/**", { timeout: 30000 });
  await sleep(2500);

  // 40–78s — home map
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await sleep(4000);
  // open legend / filter a bit
  const semester = page.getByText(/Show semester|All semesters/i).first();
  if (await semester.isVisible().catch(() => false)) {
    await semester.click().catch(() => {});
    await sleep(1200);
    await page.keyboard.press("Escape").catch(() => {});
  }
  await sleep(2500);
  const reviewBtn = page.getByText(/review now/i).first();
  if (await reviewBtn.isVisible().catch(() => false)) {
    await reviewBtn.click();
    await sleep(4500);
    // dismiss popup if any close control
    const close = page.getByRole("button", { name: /close|got it|dismiss/i }).first();
    if (await close.isVisible().catch(() => false)) await close.click();
    else await page.keyboard.press("Escape").catch(() => {});
    await sleep(2000);
  } else {
    await sleep(6000);
  }
  // click into canvas area gently
  await page.mouse.move(640, 360);
  await sleep(1500);
  await page.mouse.move(720, 400);
  await sleep(2500);

  // 78–95s — upload
  await page.getByRole("link", { name: /Upload Course/i }).click();
  await page.waitForURL("**/upload**");
  await sleep(5000);
  await page.locator('input[placeholder*="Course" i], input[name*="course" i], label:has-text("Course name") + input, .field input').first().click().catch(() => {});
  await sleep(1500);
  await page.mouse.wheel(0, 200);
  await sleep(4000);

  // 95–118s — guide
  await page.getByRole("link", { name: /^Guide$/i }).click();
  await page.waitForURL("**/guide**");
  await sleep(4500);
  await page.mouse.wheel(0, 500);
  await sleep(4500);
  await page.mouse.wheel(0, 600);
  await sleep(4500);

  // 118–end — return home for close
  await page.getByRole("link", { name: /^Home$/i }).click();
  await page.waitForURL("**/home**");
  await sleep(6000);

  const video = page.video();
  await context.close();
  await browser.close();
  const path = await video.path();
  console.log("RAW_VIDEO", path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
