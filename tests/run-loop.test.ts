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

describe("a browser that stops responding", () => {
  it("ends the run quickly instead of waiting for ever", async () => {
    // The click starts an endless loop on the page's main thread, so every
    // later browser call waits for a renderer that never answers. On Kernel
    // this happened on two real sites and held a run for eight minutes.
    stubModels("");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      '<button onclick="for (;;) {}">Start the long job</button>'
    );

    const started = Date.now();
    const result = await run(page, {
      goal: "start the long job",
      browserTimeoutMs: 2_000,
    });
    const took = Date.now() - started;
    await context.close().catch(() => undefined);

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("the browser stopped responding");
    // One click, then one bounded wait. Far under the old eight minutes.
    expect(took).toBeLessThan(10_000);
  }, 30_000);
});

describe("failing fast", () => {
  it("waits for a page that has not rendered its controls yet", async () => {
    stubModels("");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<div id="app"></div><script>
      setTimeout(() => {
        document.getElementById("app").innerHTML =
          '<button onclick="document.title=\\'clicked\\'">Continue</button>';
      }, 1200);
    </script>`);

    const result = await run(page, { goal: "continue" });
    const title = await page.title();
    await context.close();

    // It saw the button once it appeared, instead of deciding on a blank page.
    expect(result.history.length).toBeGreaterThan(0);
    expect(title).toBe("clicked");
  }, 30_000);

  it("gives up without a model call on a page that never offers anything", async () => {
    stubModels("");
    let calls = 0;
    const counted = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return counted(...args);
    }) as typeof fetch;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<p>Nothing here to press.</p>");

    const result = await run(page, { goal: "book a table" });
    await context.close();

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("the page has nothing to act on");
    expect(calls).toBe(0);
  }, 30_000);

  it("stops when it keeps toggling the same control", async () => {
    stubModels("");
    const context = await browser.newContext();
    const page = await context.newPage();
    // A disclosure that opens and closes on each click: every click changes
    // the page, so the no-progress rule alone never fires.
    await page.setContent(`<button onclick="
        const p = document.getElementById('panel'); p.hidden = !p.hidden;
      ">Select a date</button><div id="panel" hidden>September</div>`);

    const result = await run(page, { goal: "pick a date next month" });
    await context.close();

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("the run went back and forth without progress");
    expect(result.history.length).toBeLessThanOrEqual(5);
  }, 30_000);
});
