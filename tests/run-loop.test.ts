/**
 * The loop's bounded paths, driven with a stubbed classifier and text model.
 *
 * The one behaviour under test is that an action the loop abandons still
 * reaches history. History is what `decide` sends as `recent_actions`, so a
 * path that skips it leaves the classifier choosing the same target for ever.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { run, type RunStep } from "../src/index.js";

let browser: Browser;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every classifier question with its first offered key. */
function stubModels(text: string): void {
  process.env.TYPESAFE_API_KEY = "test";
  process.env.TEXT_MODEL_API_KEY = "test";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (href.includes("typesafe")) {
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(body.questions)) {
        const keys = Object.keys((question as { criteria: object }).criteria);
        // TYPE_TEXT is the operation under test, so prefer it when offered.
        const choice = keys.includes("TYPE_TEXT") ? "TYPE_TEXT" : keys[0]!;
        const probabilities = Object.fromEntries(
          keys.map((k) => [k, k === choice ? 1 : 0])
        );
        answers[name] = { type: "choice", choice, confidence: 1, probabilities };
      }
      return Response.json({ answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ text }) } }],
    });
  }) as typeof fetch;
}

describe("the run loop", () => {
  it("records an abandoned action, so the classifier can see it failed", async () => {
    stubModels("");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<label>Where else? <input name="q"></label>');

    const steps: RunStep[] = [];
    const result = await run(page, {
      goal: "type a city",
      onStep: (s) => steps.push(s),
    });
    await context.close();

    expect(result.status).toBe("blocked");
    // Three empty answers are recorded; the fourth trips the bound and stops.
    expect(result.history).toHaveLength(3);
    expect(result.history.map((h) => h.text)).toEqual([null, null, null]);
    expect(result.history.map((h) => h.kind)).toEqual(["fill", "fill", "fill"]);
    expect(steps).toHaveLength(3);
  }, 60_000);
});
