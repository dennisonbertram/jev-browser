/**
 * A spread of journeys, so a change is judged on more than one site.
 *
 * Half are local fixtures, which are deterministic and cover the hard
 * capabilities: shadow DOM, a cross-origin iframe, a nested scroll container
 * and a select. The rest are ordinary public pages, which are not
 * deterministic but are the only honest check that a change is not tuned to
 * one site.
 *
 * Each journey states a check that reads the finished page, not the agent's
 * own opinion of how it went.
 *
 *   npx tsx examples/journeys.ts [repetitions]
 */
import { chromium, type Page } from "playwright";
import { start, stop } from "../tests/fixtures/serve.ts";
import { run } from "../src/index.ts";

type Journey = {
  name: string;
  url: (port: number, foreign: number) => string;
  goal: string;
  check: (page: Page) => Promise<boolean>;
};

const JOURNEYS: Journey[] = [
  {
    name: "shadow-dom",
    url: (p) => `http://localhost:${p}/shadow.html`,
    goal: "Enter ada@example.com as the email address and submit the form.",
    check: async (page) =>
      /^submitted:ada@example\.com$/u.test(
        (await page.locator("#shadow-result").innerText()).trim()
      ),
  },
  {
    name: "nested-scroll",
    url: (p) => `http://localhost:${p}/nested-scroll.html`,
    goal: "Open Row 47.",
    check: async (page) => (await page.title()) === "row-47",
  },
  {
    name: "cross-origin-iframe",
    // The child frame's origin comes from the query string, so it is a
    // genuinely foreign origin and not the same server on another path.
    url: (p, foreign) =>
      `http://localhost:${p}/iframe-cross.html?foreign=` +
      encodeURIComponent(`http://127.0.0.1:${foreign}`),
    goal: "Enter the promo code SAVE10 in the embedded frame and apply it.",
    check: async (page) => {
      for (const frame of page.frames()) {
        const out = await frame
          .locator("#out")
          .innerText()
          .catch(() => "");
        if (/^applied:SAVE10$/iu.test(out.trim())) return true;
      }
      return false;
    },
  },
  {
    name: "select",
    url: (p) => `http://localhost:${p}/select.html`,
    goal: "Choose the VIP ticket tier.",
    check: async (page) =>
      (await page.locator("#select-result").innerText()).trim() === "tier:vip",
  },
  {
    name: "wikipedia",
    url: () => "https://en.wikipedia.org",
    goal: "Search Wikipedia for Ada Lovelace and open her article.",
    check: async (page) => /\/wiki\/Ada_Lovelace/u.test(page.url()),
  },
  {
    name: "hacker-news",
    url: () => "https://news.ycombinator.com",
    goal: "Open the comments page for the top story.",
    check: async (page) => /item\?id=/u.test(page.url()),
  },
  {
    name: "mdn",
    url: () => "https://developer.mozilla.org",
    goal: "Search the site for Array.prototype.map and open the reference page.",
    check: async (page) => /\/map/iu.test(page.url()),
  },
];

const reps = Number(process.argv[2] ?? 1);
const { server, port } = await start(0);
const foreign = await start(0);
const browser = await chromium.launch({ headless: true });
const results: Record<string, { ok: number; total: number; ms: number[] }> = {};

for (let rep = 0; rep < reps; rep += 1) {
  for (const journey of JOURNEYS) {
    const context = await browser.newContext({
      viewport: { width: 1120, height: 780 },
    });
    const page = await context.newPage();
    const slot = (results[journey.name] ??= { ok: 0, total: 0, ms: [] });
    slot.total += 1;
    try {
      await page.goto(journey.url(port, foreign.port), {
        waitUntil: "load",
        timeout: 30_000,
      });
      // iframe-cross.html attaches its child after load.
      await page.waitForLoadState("networkidle").catch(() => {});
      const result = await run(context, { goal: journey.goal });
      const passed = await journey.check(page);
      if (passed) {
        slot.ok += 1;
        slot.ms.push(result.elapsedMs);
      }
      console.log(
        `  ${journey.name.padEnd(22)} ${passed ? "pass" : "FAIL"}  ` +
          `${String(result.elapsedMs).padStart(6)}ms  ` +
          `${String(result.decisions.length).padStart(3)} decisions  ` +
          `${String(result.history.length).padStart(3)} actions  ${result.reason}`
      );
    } catch (error) {
      console.log(
        `  ${journey.name.padEnd(22)} ERROR ${String(error).slice(0, 80)}`
      );
    }
    await context.close();
  }
}

console.log("\nsummary");
let passed = 0;
let attempted = 0;
for (const [name, slot] of Object.entries(results)) {
  passed += slot.ok;
  attempted += slot.total;
  const median = slot.ms.length
    ? [...slot.ms].sort((a, b) => a - b)[Math.floor(slot.ms.length / 2)]
    : null;
  console.log(
    `  ${name.padEnd(22)} ${slot.ok}/${slot.total}` +
      (median === null ? "" : `  median ${median}ms`)
  );
}
console.log(`  TOTAL                  ${passed}/${attempted}`);

await browser.close();
await stop(server);
await stop(foreign.server);
