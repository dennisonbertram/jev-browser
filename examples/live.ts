/**
 * One live run: real Chromium, real Jev decisions, real text generation.
 *
 *   set -a; . ../Partyline-v2/.env.local; set +a
 *   npx tsx poc/jev/live.ts --url http://127.0.0.1:8791/nested-scroll.html \
 *     --goal 'Open row 47.' [--headed] [--upload-dir poc/jev/uploads]
 *
 * Writes a trace to poc/jev/traces/. Timing starts at the first decision, after
 * the initial observation, so it is comparable to the numbers in the upstream
 * repo's performance.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { runOnce } from "../src/run.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const url = flag("url");
const goal = flag("goal");
if (!url || !goal) {
  console.error(
    "Usage: tsx poc/jev/live.ts --url <url> --goal <goal> [--headed] [--upload-dir <dir>] [--label <name>]"
  );
  process.exit(2);
}
if (!process.env.TYPESAFE_API_KEY) {
  console.error(
    "TYPESAFE_API_KEY is not set. Load ../Partyline-v2/.env.local first."
  );
  process.exit(2);
}

const browser = await chromium.launch({ headless: !args.includes("--headed") });
try {
  const result = await runOnce(browser, url, {
    goal,
    uploadDir: flag("upload-dir"),
    onStep: (step) =>
      console.log(
        [
          `${String(step.elapsedMs).padStart(6)}ms`,
          `#${step.step}`,
          step.operation.padEnd(11),
          `p=${step.probability.toFixed(2)}`,
          `jev=${step.latencyMs}ms`,
          step.textLatencyMs ? `text=${step.textLatencyMs}ms` : "",
          step.pageChanged === false ? "(no change)" : "",
          step.text ? `"${step.text}"` : "",
          step.action,
        ]
          .filter(Boolean)
          .join(" ")
      ),
  });

  const jev = result.decisions.map((d) => d.latencyMs).sort((a, b) => a - b);
  const middle = jev.length >> 1;
  const median = jev.length
    ? jev.length % 2 === 1
      ? (jev[middle] ?? 0)
      : Math.round(((jev[middle - 1] ?? 0) + (jev[middle] ?? 0)) / 2)
    : 0;
  console.log(
    [
      "",
      `status            ${result.status}`,
      `total             ${result.elapsedMs} ms`,
      `decisions         ${result.decisions.length} (median ${median} ms)`,
      `actions           ${result.history.length}`,
      `text calls        ${result.usage.text_calls}`,
      `jev tokens        ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`,
      `frames            ${result.frames.length} (${result.frames.filter((f) => f.crossOrigin).length} cross-origin)`,
      `tabs              ${result.tabs.length}`,
      `canvas regions    ${result.canvases.length}${result.canvases.length ? " -> vision escalation needed" : ""}`,
      `closed shadow     ${result.closedShadowHosts}`,
    ].join("\n")
  );

  const label = (
    flag("label") ?? new URL(url).pathname.replace(/\W+/gu, "-")
  ).replace(/^-|-$/gu, "");
  mkdirSync(new URL("./traces/", import.meta.url), { recursive: true });
  const path = new URL(
    `./traces/${label || "run"}-${result.elapsedMs}ms.json`,
    import.meta.url
  );
  writeFileSync(path, JSON.stringify({ url, ...result }, null, 2));
  console.log(`\ntrace             ${path.pathname}`);
  process.exitCode = result.status === "done" ? 0 : 1;
} finally {
  await browser.close();
}
