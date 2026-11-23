/**
 * Screen-record Synapse for JFF Future of Work demo.
 * Always dark theme. Smooth paced transitions for HeyGen VO (~2–3 min).
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

async function forceDark(page) {
  await page.evaluate(() => {
    try {
      localStorage.setItem("synapse.theme", "dark");
    } catch {}
    document.documentElement.setAttribute("data-theme", "dark");
  });
}

/** Smooth scroll in small steps so motion reads continuous on camera. */
async function smoothWheel(page, totalY, steps = 18, stepMs = 90) {
  const dy = totalY / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy);
    await sleep(stepMs);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();

  // Seed dark before first paint where possible
  await page.addInitScript(() => {
    try {
      localStorage.setItem("synapse.theme", "dark");
    } catch {}
    document.documentElement.setAttribute("data-theme", "dark");
  });

  // —— Landing (descriptive open) ——
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 });
  await forceDark(page);
  await sleep(5500);
  await smoothWheel(page, 380, 16, 85);
  await sleep(3500);
  await smoothWheel(page, 480, 18, 85);
  await sleep(4000);
  await smoothWheel(page, 520, 18, 85);
  await sleep(3500);
  await smoothWheel(page, -900, 20, 70);
  await sleep(2000);

  // —— Login ——
  await page.getByRole("link", { name: /^Log in$/i }).first().click();
  await page.waitForURL("**/login**");
  await forceDark(page);
  await sleep(2200);
  await page.locator('input[type="email"]').click();
  await sleep(400);
  await page.locator('input[type="email"]').pressSequentially(EMAIL, { delay: 45 });
  await sleep(900);
  await page.locator('input[type="password"]').click();
  await sleep(350);
  await page.locator('input[type="password"]').pressSequentially(PASS, { delay: 40 });
  await sleep(1400);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL("**/app/**", { timeout: 30000 });
  await forceDark(page);
  await sleep(2800);

  // —— Home map ——
  await forceDark(page);
  await sleep(5000);
  // drift pointer across graph
  for (const [x, y] of [
    [520, 340],
    [640, 360],
    [760, 380],
    [700, 420],
    [580, 400],
  ]) {
    await page.mouse.move(x, y, { steps: 18 });
    await sleep(700);
  }
  await sleep(2000);

  const reviewBtn = page.getByText(/review now/i).first();
  if (await reviewBtn.isVisible().catch(() => false)) {
    await reviewBtn.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(800);
    await reviewBtn.click();
    await sleep(5500);
    const close = page.getByRole("button", { name: /close|got it|dismiss/i }).first();
    if (await close.isVisible().catch(() => false)) await close.click();
    else await page.keyboard.press("Escape").catch(() => {});
    await sleep(2200);
  } else {
    await sleep(7000);
  }
  await sleep(2500);

  // —— Upload ——
  await page.getByRole("link", { name: /Upload Course/i }).click();
  await page.waitForURL("**/upload**");
  await forceDark(page);
  await sleep(3500);
  await smoothWheel(page, 220, 12, 80);
  await sleep(4500);
  await smoothWheel(page, 180, 10, 80);
  await sleep(3000);

  // —— Guide ——
  await page.getByRole("link", { name: /^Guide$/i }).click();
  await page.waitForURL("**/guide**");
  await forceDark(page);
  await sleep(4500);
  await smoothWheel(page, 420, 16, 90);
  await sleep(4000);
  await smoothWheel(page, 520, 18, 90);
  await sleep(4500);
  await smoothWheel(page, 480, 16, 90);
  await sleep(3500);

  // —— Close on home ——
  await page.getByRole("link", { name: /^Home$/i }).click();
  await page.waitForURL("**/home**");
  await forceDark(page);
  await sleep(7000);

  const video = page.video();
  await context.close();
  await browser.close();
  const path = await video?.path();
  console.log("RAW_VIDEO", path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
