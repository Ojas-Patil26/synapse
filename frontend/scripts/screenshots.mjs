// Visual check of the fixture-mode app. Usage (dev server must be running on :5173):
//   node scripts/screenshots.mjs [main|flow|all]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "screenshots");
const tmp = join(out, "tmp");
mkdirSync(tmp, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const which = process.argv[2] ?? "all";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", ...opts });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return page;
}
const shot = async (page, name) => {
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log("saved", name);
};
async function login(page, fixture) {
  await page.goto(`${BASE}/login?fixture=${fixture}`);
  await page.fill('input[type="email"]', "demo@asu.edu");
  await page.fill('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
}
const nodeAt = (page, id) => page.evaluate((i) => window.__synapseGraph?.coords(i), id);

async function main(browser) {
  const page = await newPage(browser);
  await page.goto(`${BASE}/?fixture=merged`);
  await wait(500);
  await shot(page, "01-landing-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await wait(300);
  await shot(page, "02-landing-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await login(page, "merged");
  await page.waitForURL("**/app/home");
  await page.waitForSelector("canvas");
  await wait(6500);
  await shot(page, "03-home-merged-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await wait(600);
  await shot(page, "04-home-merged-dark");

  // hover a cross-course edge endpoint + a node (dimming) in dark
  const q = await nodeAt(page, "cse471-q-learning");
  await page.mouse.move(q.x, q.y);
  await wait(500);
  await shot(page, "05-home-hover-dark");
  await page.mouse.move(5, 300);
  await page.emulateMedia({ colorScheme: "light" });
  await wait(300);

  await page.selectOption(".course-filter select", "cse471");
  await wait(5500);
  await shot(page, "06-home-single-course");
  await page.selectOption(".course-filter select", "all");
  await wait(5500);

  const mdp = await nodeAt(page, "cse471-mdp");
  await page.mouse.click(mdp.x, mdp.y);
  await page.waitForSelector(".popup");
  await wait(300);
  await shot(page, "07-popup-instant");
  await wait(3500);
  await shot(page, "08-popup-personalized");

  await page.click("text=Take quiz");
  await page.waitForSelector("text=Have a Canvas quiz for this concept?");
  await shot(page, "09-quiz-ask");
  await page.click("text=No, quiz me");
  await page.waitForSelector(".question");
  await shot(page, "10-quiz-questions");
  const count = await page.locator(".question").count();
  for (let i = 0; i < count; i++) await page.locator(".question").nth(i).locator(".option").nth(i % 4).click();
  await page.click("text=Submit quiz");
  await page.waitForSelector(".result-card");
  await wait(600);
  await shot(page, "11-quiz-results");
  await page.click("text=Done");
  await wait(500);
  await shot(page, "12-home-after-quiz");

  await page.click("text=Got it");
  await page.waitForSelector(".note-ok");
  await shot(page, "13-popup-after-review");

  await page.click("nav >> text=Guide");
  await page.waitForSelector(".guide-row");
  await wait(900);
  await shot(page, "14-guide-list");
  await page.locator(".guide-row").first().click();
  await page.waitForSelector(".generating, .explanation h2");
  await shot(page, "15-guide-entry-loading");
  await page.waitForSelector(".explanation h2", { timeout: 15000 });
  await wait(300);
  await shot(page, "16-guide-entry");
  await page.emulateMedia({ colorScheme: "dark" });
  await wait(300);
  await shot(page, "17-guide-entry-dark");

  // narrow width
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 780 });
  await page.click("nav >> text=Home");
  await wait(6000);
  await shot(page, "18-home-narrow");
  await page.click("nav >> text=Guide");
  await page.waitForSelector(".guide-row");
  await wait(500);
  await shot(page, "19-guide-narrow");
  await page.context().close();
}

async function flow(browser) {
  const page = await newPage(browser);
  const notes1 = join(tmp, "week1-notes.txt");
  const notes2 = join(tmp, "ml-notes.md");
  const canvas = join(tmp, "canvas-quiz-export.txt");
  for (const f of [notes1, notes2, canvas]) writeFileSync(f, "Sample notes for the fixture flow.\n");
  const log = (s) => console.log("flow:", s);

  await login(page, "empty");
  await page.waitForURL("**/app/upload");
  log("empty -> landed on /app/upload");
  await page.waitForSelector("text=Upload your first course");
  await page.click("text=Build my map");
  await page.waitForSelector("text=Enter a course name.");
  await page.waitForSelector("text=Add at least one file.");
  await shot(page, "20-upload-validation");
  await page.fill('input[placeholder="e.g. CSE 360"]', "CSE 471 Intro to AI");
  await page.setInputFiles('input[type="file"]', notes1);
  await shot(page, "21-upload-ready");
  await page.click("text=Build my map");
  await page.waitForSelector("text=Building your map.");
  await shot(page, "22-upload-processing");
  await page.waitForURL("**/app/home", { timeout: 30000 });
  await page.waitForSelector("canvas");
  await wait(6000);
  log("first upload -> home; legend has cross-course: " + (await page.locator("text=Cross-course").count()));
  await shot(page, "23-flow-one-course");

  await page.click("nav >> text=Upload Course");
  await page.waitForSelector("text=Upload a course");
  await page.fill('input[placeholder="e.g. CSE 360"]', "CSE 475 Foundations of ML");
  await page.setInputFiles('input[type="file"]', notes2);
  await page.click("text=Build my map");
  await page.waitForURL("**/app/home", { timeout: 30000 });
  await page.waitForSelector("canvas");
  await wait(6500);
  log("second upload -> home; legend has cross-course: " + (await page.locator("text=Cross-course").count()));
  log("dropdown options: " + (await page.locator(".course-filter option").allTextContents()).join(" | "));
  await shot(page, "24-flow-merged");

  await page.selectOption(".course-filter select", "cse475");
  await wait(5500);
  await shot(page, "25-flow-filtered");

  // Quiz with a Canvas upload on an unassessed node; watch the ring change.
  const id = "cse475-backpropagation";
  const before = await page.evaluate(() => null);
  void before;
  const c = await nodeAt(page, id);
  await page.mouse.click(c.x, c.y);
  await page.waitForSelector(".popup");
  log("popup confidence before: " + (await page.locator(".popup .stats dd").nth(1).textContent()));
  await page.click("text=Take quiz");
  await page.click("text=Yes, upload it");
  await page.waitForSelector(".disclaimer");
  await page.setInputFiles('.file-pick input[type="file"]', canvas);
  await shot(page, "26-quiz-upload");
  await page.click("text=Upload quiz");
  await page.waitForSelector("text=Got your quiz. A few quick questions to confirm.");
  await page.waitForSelector(".question");
  log("short quiz questions: " + (await page.locator(".question").count()) + ", points: " + (await page.locator(".q-points").allTextContents()).join(","));
  await shot(page, "27-quiz-short");
  const n = await page.locator(".question").count();
  for (let i = 0; i < n; i++) await page.locator(".question").nth(i).locator(".option").nth(0).click();
  await page.click("text=Submit quiz");
  await page.waitForSelector(".result-card");
  await wait(500);
  log("result: " + (await page.locator(".result-card").innerText()).replace(/\n/g, " "));
  await shot(page, "28-quiz-short-results");
  await page.click("text=Done");
  await wait(400);
  log("popup confidence after: " + (await page.locator(".popup .stats dd").nth(1).textContent()));
  await shot(page, "29-flow-after-quiz");

  // parseFailed path: a non-Canvas file goes straight to the full quiz with no error.
  await page.click("text=Take quiz");
  await page.click("text=Yes, upload it");
  await page.setInputFiles('.file-pick input[type="file"]', notes1);
  await page.click("text=Upload quiz");
  await page.waitForSelector(".question");
  log("parseFailed path -> questions: " + (await page.locator(".question").count()) + ", error notes: " + (await page.locator(".drawer .note-error").count()) + ", success line: " + (await page.locator("text=Got your quiz.").count()));
  await page.context().close();
}

const browser = await chromium.launch();
try {
  if (which === "main" || which === "all") await main(browser);
  if (which === "flow" || which === "all") await flow(browser);
} finally {
  await browser.close();
}
console.log(problems.length ? "PROBLEMS:\n" + [...new Set(problems)].join("\n") : "no console errors");
