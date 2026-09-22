/**
 * The Google Flights journey, on the same boundary jev-ultrafast measured.
 *
 * Their run: Zurich to London, one way, one adult, economy, stopping when
 * flight options are visible. 7.073 s, 17 classifier requests, 10 interactions
 * and 2 text calls. Timing began at the first decision after the initial
 * observation and ended at the accepted DONE. `run()` starts its clock in the
 * same place.
 *
 *   set -a; . .env; set +a
 *   npx tsx examples/flights.ts [reps]
 */
import { chromium } from "playwright";
import { run } from "../src/index.js";

const REPS = Number(process.argv[2] ?? 3);
const URL = "https://www.google.com/travel/flights?hl=en";
const GOAL =
  "Find one-way flights from Zurich to London on November 20, 2026, for one " +
  "adult in economy. Stop when matching flight options are visible.";

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : Math.round(((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2);
};

const totals: number[] = [];
const browser = await chromium.launch({ headless: true });

for (let rep = 1; rep <= REPS; rep += 1) {
  const context = await browser.newContext({
    viewport: { width: 1120, height: 780 },
    locale: "en-US",
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: "load", timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);

  console.log(`\n=== run ${rep} ===`);
  const result = await run(context, {
    goal: GOAL,
    onStep: (step) =>
      console.log(
        `  ${String(step.elapsedMs).padStart(5)}ms  ${step.operation.padEnd(10)} ` +
          `jev=${String(step.latencyMs).padStart(4)}ms` +
          `${step.textLatencyMs ? ` text=${step.textLatencyMs}ms` : ""}` +
          `${step.text ? ` “${step.text}”` : ""}  ${step.action.slice(0, 46)}`
      ),
  });

  // An independent check, not the agent's own opinion.
  const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const url = page.url().toLowerCase();
  const sawZurich = body.includes("zurich") || body.includes("zürich") || url.includes("zrh");
  const sawLondon = body.includes("london") || url.includes("lon");
  const sawFlights = /\b\d{1,2}\s*hr\b|\bnonstop\b|\b1 stop\b/u.test(body);
  // The upstream run checks the one-way setting and the date too. Checking
  // less would make "verified" a weaker word here than it is there.
  const sawOneWay = /one way/iu.test(body) || /\btfs=[^&]*QAE/u.test(url);
  const sawDate = /nov(ember)?\s*20|20 nov/iu.test(body);

  const latencies = result.decisions.map((d) => d.latencyMs);
  console.log(
    `  status ${result.status} (${result.reason})  total ${result.elapsedMs}ms  ` +
      `${result.decisions.length} decisions (median ${median(latencies)}ms)  ` +
      `${result.history.length} actions  ${result.usage.text_calls} text calls  ` +
      `${result.usage.input_tokens} in / ${result.usage.output_tokens} out`
  );
  // Where the wall clock went. Anything not spent waiting on a model is
  // spent in the browser: settling, observing and executing.
  const classifierMs = result.decisions.reduce((sum, d) => sum + d.latencyMs, 0);
  const textMs = result.history.reduce((sum, h) => sum + h.textLatencyMs, 0);
  const browserMs = result.elapsedMs - classifierMs - textMs;
  console.log(
    `  time: classifier ${classifierMs}ms  text ${textMs}ms  browser ${browserMs}ms`
  );
  console.log(
    `  independent check: zurich=${sawZurich} london=${sawLondon} ` +
      `one-way=${sawOneWay} date=${sawDate} flight options=${sawFlights}`
  );
  if (
    result.status === "done" &&
    sawZurich &&
    sawLondon &&
    sawOneWay &&
    sawDate &&
    sawFlights
  )
    totals.push(result.elapsedMs);
  await context.close();
}

await browser.close();
console.log(
  `\nverified runs: ${totals.length}/${REPS}` +
    (totals.length ? `  median ${median(totals)}ms  ${JSON.stringify(totals)}` : "")
);
console.log("jev-ultrafast reported 7073ms for the same journey and boundary.");
process.exit(0);
