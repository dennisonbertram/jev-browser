/**
 * Step 2 of the whole-task design: actions that behave predictably.
 *
 * A run stops promptly when cancelled or out of time, waiting that changes
 * nothing is capped, input the page interrupted is recorded rather than
 * lost, and text that keeps changing somewhere else on the page does not
 * make every action look stale.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { run } from "../src/index.js";

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

type Stub = {
  /** The operation to choose when it is offered; otherwise the first. */
  prefer?: string;
  /** Delay before each classifier answer, honouring the request's signal. */
  delayMs?: number;
  /** The text model's answer for a field. */
  text?: string;
};

function stubModels(stub: Stub): { calls: () => number } {
  process.env.TYPESAFE_API_KEY = "test";
  process.env.TEXT_MODEL_API_KEY = "test";
  let calls = 0;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url instanceof Request ? url.url : url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls += 1;
    if (stub.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, stub.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    }
    if (href.includes("typesafe")) {
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(
        body.questions as Record<string, { criteria: object }>,
      )) {
        const keys = Object.keys(question.criteria);
        const choice =
          name === "operation" && stub.prefer && keys.includes(stub.prefer)
            ? stub.prefer
            : keys[0]!;
        answers[name] = {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            keys.map((k) => [k, k === choice ? 1 : 0]),
          ),
        };
      }
      return Response.json({
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    return Response.json({
      choices: [
        { message: { content: JSON.stringify({ text: stub.text ?? "" }) } },
      ],
    });
  }) as typeof fetch;
  return { calls: () => calls };
}

async function pageWith(html: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(html);
  return { context, page };
}

describe("cancellation and time budgets", () => {
  it("makes no model call when the signal is already aborted", async () => {
    const counter = stubModels({ prefer: "CLICK" });
    const { context, page } = await pageWith("<button>Go</button>");
    const controller = new AbortController();
    controller.abort();

    const result = await run(page, { goal: "go", signal: controller.signal });
    await context.close();

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("the run was cancelled");
    expect(counter.calls()).toBe(0);
  });

  it("stops a pending classifier request when cancelled", async () => {
    stubModels({ prefer: "CLICK", delayMs: 5_000 });
    const { context, page } = await pageWith("<button>Go</button>");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const started = Date.now();
    const result = await run(page, { goal: "go", signal: controller.signal });
    const took = Date.now() - started;
    await context.close();

    expect(result.reason).toBe("the run was cancelled");
    expect(took).toBeLessThan(2_500);
  }, 15_000);

  it("ends when its time budget runs out", async () => {
    stubModels({ prefer: "CLICK", delayMs: 250 });
    const { context, page } = await pageWith(
      `<button onclick="this.textContent = this.textContent === 'Open' ? 'Close' : 'Open'">Open</button>`,
    );

    const started = Date.now();
    const result = await run(page, {
      goal: "open it",
      deadlineAt: Date.now() + 700,
    });
    const took = Date.now() - started;
    await context.close();

    expect(result.reason).toBe("the time budget ran out");
    expect(took).toBeLessThan(3_000);
  }, 15_000);
});

describe("waiting", () => {
  it("stops waiting when waiting changes nothing", async () => {
    stubModels({ prefer: "WAIT" });
    const { context, page } = await pageWith("<button>Go</button>");

    const result = await run(page, { goal: "wait for results" });
    await context.close();

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe(
      "it waited three times and the page did not change",
    );
    expect(result.history.filter((h) => h.kind === "wait").length).toBe(3);
  }, 30_000);
});

describe("interrupted input", () => {
  it("records input the page interrupted, instead of losing it", async () => {
    stubModels({ text: "London" });
    // Focusing the field changes the page, so the check made after the click
    // and select-all, just before typing, finds a different page.
    const { context, page } = await pageWith(`
      <label>Destination <input onfocus="
        if (!window.opened) { window.opened = true;
          document.body.insertAdjacentHTML('beforeend', '<ul><li>London</li><li>Paris</li></ul>'); }
      "></label>`);

    const result = await run(page, { goal: "enter London as the destination" });
    await context.close();

    expect(
      result.history.some(
        (h) => h.kind === "fill" && /interrupted/i.test(h.action),
      ),
    ).toBe(true);
  }, 30_000);
});

describe("text that keeps changing elsewhere", () => {
  it("does not make an unrelated action look stale", async () => {
    // A realistic classifier latency. With no delay this passed alone and
    // failed under a loaded machine: any gap between reading the page and
    // acting lets the clock's text change first.
    stubModels({ prefer: "CLICK", delayMs: 150 });
    // A ticking clock: the text length changes constantly, the controls never do.
    const { context, page } = await pageWith(`
      <p id="clock">0</p>
      <button onclick="document.title = 'clicked'">Continue</button>
      <script>let n = 0; setInterval(() => {
        n += 1; document.getElementById('clock').textContent = String(n).repeat(n % 7 + 1);
      }, 5);</script>`);

    const result = await run(page, { goal: "continue" });
    const title = await page.title();
    await context.close();

    expect(title).toBe("clicked");
    expect(result.reason).not.toBe(
      "the page kept changing under every attempted action",
    );
  }, 30_000);
});

describe("end conditions", () => {
  it("accepts a finished page that has nothing left to act on", async () => {
    stubModels({ prefer: "BLOCKED" });
    const { context, page } = await pageWith(
      "<p>Your booking is confirmed.</p>",
    );

    const started = Date.now();
    const result = await run(page, {
      goal: "confirm the booking",
      isDone: async (observation) => observation.text.includes("confirmed"),
    });
    const took = Date.now() - started;
    await context.close();

    expect(result.reason).toBe("the end condition is met");
    expect(took).toBeLessThan(2_000);
  }, 15_000);

  it("does not accept a met condition when the page changed during the check", async () => {
    stubModels({ prefer: "BLOCKED" });
    const { context, page } = await pageWith(
      "<p>Success</p><button>Retry</button>",
    );
    let changed = false;

    const result = await run(page, {
      goal: "finish",
      isDone: async (observation) => {
        const holds = observation.text.includes("Success");
        if (holds && !changed) {
          changed = true;
          // The page moves on while the check is in flight.
          await page.evaluate(() => {
            document.body.innerHTML =
              "<p>Failure</p><button>Retry</button><button>Help</button>";
          });
        }
        return holds;
      },
    });
    await context.close();

    expect(result.status).toBe("blocked");
  }, 15_000);

  it("counts a change that lands during the condition window as progress", async () => {
    stubModels({ prefer: "CLICK" });
    // Each click adds a line 700 ms later, after the action has settled and
    // inside the window in which the end condition is re-checked.
    const { context, page } = await pageWith(`
      <button onclick="setTimeout(() => {
        document.getElementById('log').insertAdjacentHTML('beforeend', '<li>step</li>');
      }, 700)">Next</button>
      <ul id="log"></ul>`);

    const result = await run(page, {
      goal: "advance four times",
      isDone: async (observation) =>
        (observation.text.match(/step/g) ?? []).length >= 4,
    });
    await context.close();

    expect(result.reason).toBe("the end condition is met");
  }, 60_000);
});

describe("planned inputs", () => {
  it("types only a value it was given, and refuses one the text model invents", async () => {
    stubModels({ prefer: "TYPE_TEXT", text: "San Francisco" });
    const { context, page } = await pageWith(
      `<label>Where else? <input id="where"></label>`,
    );

    const result = await run(page, {
      goal: "enter the destination",
      inputs: { destination: "London" },
    });
    const typed = await page.inputValue("#where");
    await context.close();

    expect(typed).toBe("");
    expect(result.reason).toBe(
      "the text model gave no value for the chosen field",
    );
  }, 30_000);

  it("types a value it was given", async () => {
    stubModels({ prefer: "TYPE_TEXT", text: "London" });
    const { context, page } = await pageWith(
      `<label>Where else? <input id="where"></label>`,
    );

    await run(page, {
      goal: "enter the destination",
      inputs: { destination: "London" },
    });
    const typed = await page.inputValue("#where");
    await context.close();

    expect(typed).toBe("London");
  }, 30_000);
});

describe("stopping, again", () => {
  it("does not report success from an end-condition check that finished after the budget", async () => {
    stubModels({ prefer: "BLOCKED" });
    const { context, page } = await pageWith("<p>Done</p><button>Go</button>");

    const result = await run(page, {
      goal: "finish",
      deadlineAt: Date.now() + 200,
      // A check that ignores the signal and answers late.
      isDone: () =>
        new Promise((resolve) => setTimeout(() => resolve(true), 800)),
    });
    await context.close();

    expect(result.reason).toBe("the time budget ran out");
  }, 15_000);

  it("hands its stop signal to the end-condition check", async () => {
    stubModels({ prefer: "BLOCKED" });
    const { context, page } = await pageWith("<button>Go</button>");
    let aborted = false;

    await run(page, {
      goal: "finish",
      deadlineAt: Date.now() + 200,
      isDone: (_observation, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve(false);
          });
        }),
    });
    await context.close();

    expect(aborted).toBe(true);
  }, 15_000);

  it("keeps the reason that stopped it first", async () => {
    stubModels({ prefer: "CLICK", delayMs: 400 });
    const { context, page } = await pageWith("<button>Go</button>");
    const controller = new AbortController();
    // The budget runs out first; cancellation comes after.
    setTimeout(() => controller.abort(), 300);

    const result = await run(page, {
      goal: "go",
      signal: controller.signal,
      deadlineAt: Date.now() + 100,
    });
    await context.close();

    expect(result.reason).toBe("the time budget ran out");
  }, 15_000);

  it("caps waiting even when unrelated text keeps changing", async () => {
    stubModels({ prefer: "WAIT" });
    const { context, page } = await pageWith(`
      <p id="clock">00</p><button>Go</button>
      <script>let n = 10; setInterval(() => {
        n = n === 99 ? 10 : n + 1; document.getElementById('clock').textContent = String(n);
      }, 100);</script>`);

    const result = await run(page, { goal: "wait for results" });
    await context.close();

    expect(result.status).toBe("blocked");
    expect(
      result.history.filter((h) => h.kind === "wait").length,
    ).toBeLessThanOrEqual(8);
  }, 90_000);
});

describe("an inconsistent classifier answer", () => {
  it("is asked again instead of ending the run", async () => {
    // On Elsewhere a TypeSafe answer named a choice that was not its most
    // probable one, and the whole task ended with an error.
    process.env.TYPESAFE_API_KEY = "test";
    let calls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls += 1;
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(
        body.questions as Record<string, { criteria: object }>
      )) {
        const keys = Object.keys(question.criteria);
        const choice = name === "operation" && keys.includes("BLOCKED") ? "BLOCKED" : keys[0]!;
        const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0]));
        // The first answer names BLOCKED but gives it no probability.
        if (calls === 1) {
          for (const k of keys) probabilities[k] = k === keys[0] ? 1 : 0;
        }
        answers[name] = { type: "choice", choice, confidence: 1, probabilities };
      }
      return Response.json({ answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch;
    const { context, page } = await pageWith("<button>Go</button>");

    const result = await run(page, { goal: "go" });
    await context.close();

    expect(calls).toBe(2);
    expect(result.reason).toBe("the classifier judged the goal unreachable from this page");
  }, 30_000);
});
