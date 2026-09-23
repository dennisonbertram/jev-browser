/**
 * The whole-task runner, driven with stubbed models against real pages.
 *
 * What is under test is the runner's own logic: that a subgoal ends only when
 * its end conditions hold on the page, that the classifier's DONE is a claim
 * rather than a verdict, that a fact is kept only with a quote the page
 * actually contains, and that a bad plan is refused. The stubs make the
 * models deterministic; they are not a model of how good the models are.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { observe, runTask } from "../src/index.js";
import { comparable } from "../src/task.js";

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

type Stubs = {
  /** The plan the planner returns. */
  plan: unknown;
  /** Operation the classifier prefers when offered. */
  operation: "CLICK" | "DONE" | "WAIT" | "BLOCKED";
  /** Whether one end-condition statement holds for this page text. */
  holds: (statement: string, pageText: string) => boolean;
  /** Facts the extractor returns, or a function of the page text. */
  facts?:
    | Record<string, { value: string; quote: string }>
    | ((text: string) => Record<string, { value: string; quote: string }>);
  /** What the planner returns when asked to repair its plan. */
  repair?: unknown;
  /** Delay before the extractor answers, honouring the request's signal. */
  extractDelayMs?: number;
  /** Candidates the lister returns. */
  items?: unknown[];
  /** Successive planner answers; the last one repeats. Overrides plan. */
  plans?: unknown[];
  /** Successive classifier operations; the last one repeats. Overrides operation. */
  operations?: string[];
};

/** Route each model request to a deterministic answer. */
function stubModels(stubs: Stubs): {
  classifierCalls: () => number;
  checked: string[];
  goals: string[];
  planCalls: () => number;
  planRequests: Record<string, unknown>[];
} {
  const planRequests: Record<string, unknown>[] = [];
  const checked: string[] = [];
  const goals: string[] = [];
  process.env.TYPESAFE_API_KEY = "test";
  process.env.TEXT_MODEL_API_KEY = "test";
  let classifierCalls = 0;
  let planCalls = 0;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url instanceof Request ? url.url : url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (href.includes("typesafe")) {
      const answers: Record<string, unknown> = {};
      const text = String(body.state?.page?.text ?? "");
      for (const [name, question] of Object.entries(
        body.questions as Record<
          string,
          { type: string; instructions: unknown; criteria?: object }
        >,
      )) {
        if (question.type === "noul") {
          checked.push(String(question.instructions));
          answers[name] = {
            type: "noul",
            noul: stubs.holds(String(question.instructions), text)
              ? 0.97
              : 0.03,
          };
          continue;
        }
        classifierCalls += name === "operation" ? 1 : 0;
        if (name === "operation")
          goals.push(
            String(
              (question as { instructions?: { goal?: string } }).instructions
                ?.goal,
            ),
          );
        const keys = Object.keys(question.criteria ?? {});
        const wanted = stubs.operations
          ? stubs.operations[
              Math.min(classifierCalls, stubs.operations.length) - 1
            ]!
          : stubs.operation;
        const choice =
          name === "operation" && keys.includes(wanted) ? wanted : keys[0]!;
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
    const system = String(body.messages?.[0]?.content ?? "");
    if (stubs.extractDelayMs && system.includes("You extract"))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, stubs.extractDelayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    const planning = system.includes("You plan");
    if (planning) {
      planCalls += 1;
      planRequests.push(
        JSON.parse(String(body.messages?.[1]?.content ?? "{}")),
      );
    }
    const content = planning
      ? stubs.plans
        ? stubs.plans[Math.min(planCalls, stubs.plans.length) - 1]
        : planCalls > 1 && stubs.repair !== undefined
          ? stubs.repair
          : stubs.plan
      : system.includes("You extract")
        ? typeof stubs.facts === "function"
          ? stubs.facts(
              String(
                (
                  JSON.parse(String(body.messages?.[1]?.content ?? "{}")) as {
                    page?: { text?: string };
                  }
                ).page?.text ?? "",
              ),
            )
          : (stubs.facts ?? {})
        : system.includes("You list")
          ? { items: stubs.items ?? [] }
          : { text: "" };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    });
  }) as typeof fetch;
  return {
    classifierCalls: () => classifierCalls,
    checked,
    goals,
    planCalls: () => planCalls,
    planRequests,
  };
}

const TIMES_PAGE = `
  <button onclick="setTimeout(() => {
    document.getElementById('out').textContent = 'Times: 9:00 AM, 11:30 AM. Price $69 per person.';
  }, 300)">Show times</button>
  <div id="out"></div>`;

describe("the whole-task runner", () => {
  it("offers WAIT on every page, so a loading page can be waited for", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<button>Continue</button>");
    const kinds = (await observe(context)).actions.map((a) => a.kind);
    await context.close();
    expect(kinds).toContain("wait");
  });

  it("finishes a subgoal when its end condition holds, and keeps quoted facts", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
            collect: ["times", "price"],
          },
        ],
        report: ["times", "price"],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
      facts: {
        times: {
          value: "9:00 AM, 11:30 AM",
          quote: "Times: 9:00 AM, 11:30 AM",
        },
        price: { value: "$69", quote: "$69 per person" },
      },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, {
      task: "Show me the tour's times and price.",
    });
    await context.close();

    expect(result.status).toBe("done");
    expect(result.subgoals).toEqual([
      expect.objectContaining({ id: "times", status: "done" }),
    ]);
    expect(result.facts.times).toEqual(
      expect.objectContaining({ value: "9:00 AM, 11:30 AM", supported: true }),
    );
    expect(result.facts.price).toEqual(
      expect.objectContaining({ value: "$69", supported: true }),
    );
  }, 30_000);

  it("treats the classifier's DONE as a claim, and refuses it when the page disagrees", async () => {
    const counter = stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
          },
        ],
        report: [],
      },
      operation: "DONE",
      holds: () => false,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Show me the tour's times." });
    await context.close();

    expect(result.status).toBe("incomplete");
    expect(result.subgoals[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        reason: "the classifier claimed done, but the end condition is not met",
      }),
    );
    // It asked again after the first refused claim, rather than accepting it.
    expect(counter.classifierCalls()).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("re-checks the end condition when the classifier claims done", async () => {
    // The first check can run while the page is still settling, and a page
    // whose only change is visual keeps the same fingerprint, so it is never
    // checked again unless the claim triggers a fresh check.
    let checks = 0;
    stubModels({
      plan: {
        subgoals: [
          {
            id: "open",
            goal: "Open the calendar",
            done_when: ["The calendar is visible"],
          },
        ],
        report: [],
      },
      operation: "DONE",
      holds: () => {
        checks += 1;
        return checks >= 2;
      },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Open the calendar." });
    await context.close();

    expect(result.subgoals[0]).toEqual(
      expect.objectContaining({
        status: "done",
        reason: "the end condition is met",
      }),
    );
  }, 30_000);

  it("waits for results that arrive after the click, instead of acting again", async () => {
    // Peek loads a date's start times over the network after the click. The
    // check ran before they arrived, and the next action reopened the
    // calendar over them.
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
          },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`
      <button onclick="setTimeout(() => {
        document.getElementById('out').textContent = 'Times: 9:00 AM, 11:30 AM.';
      }, 1500)">Show times</button>
      <div id="out"></div>`);

    const result = await runTask(page, { task: "Show me the tour's times." });
    await context.close();

    expect(result.subgoals[0]).toEqual(
      expect.objectContaining({ status: "done", actions: 1 }),
    );
  }, 30_000);

  it("drops a fact whose quote is not on the page", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
            collect: ["price"],
          },
        ],
        report: ["price"],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
      facts: { price: { value: "$49", quote: "$49 per person" } },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Show me the tour's price." });
    await context.close();

    expect(result.facts.price).toEqual(
      expect.objectContaining({ value: null, supported: false }),
    );
    // What the model offered is kept aside, so a refusal can be explained.
    expect(result.facts.price?.rejected).toEqual(
      expect.objectContaining({ value: expect.any(String) }),
    );
  }, 30_000);

  it("accepts a fact quoted from a form control, not only from page text", async () => {
    // A quantity or a chosen date often lives in a control's value, which is
    // not part of the page's visible text. Peek's "1 - Adult" was dropped.
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
            collect: ["quantity"],
          },
        ],
        report: ["quantity"],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
      facts: { quantity: { value: "1 adult", quote: "1 - Adult" } },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      `<label>Guests <select><option>1 - Adult</option><option>2 - Adults</option></select></label>${TIMES_PAGE}`,
    );

    const result = await runTask(page, {
      task: "Show me the tour's times for one adult.",
    });
    await context.close();

    expect(result.facts.quantity).toEqual(
      expect.objectContaining({ value: "1 adult", supported: true }),
    );
  }, 30_000);

  it("plans against the page it starts on, not only its address", async () => {
    // Planning from the URL alone, the planner invented Child and Senior
    // quantity checks for a page that only had an Adult selector.
    let planRequest = "";
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
          },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: (_s, text) => text.includes("Times:"),
    });
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(body.messages?.[0]?.content ?? "").includes("You plan"))
        planRequest = String(body.messages?.[1]?.content ?? "");
      return stubbed(url, init);
    }) as typeof fetch;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<h1>Bagel tour</h1><p>From $69</p>${TIMES_PAGE}`);

    await runTask(page, { task: "Show me the tour's times." });
    await context.close();

    expect(planRequest).toContain("Show times");
    expect(planRequest).toContain("From $69");
  }, 30_000);

  it("sends back an end condition that compares with an earlier state", async () => {
    // The checker sees only the page as it is now, so "one month later than
    // the current month" can never be confirmed. On Peek the page had moved
    // to the right month and the subgoal was still refused.
    const plans = [
      {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["The page shows more times than it did before"],
          },
        ],
        report: [],
      },
      {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
          },
        ],
        report: [],
      },
    ];
    const planRequests: string[] = [];
    stubModels({
      plan: {},
      operation: "CLICK",
      holds: (_s, text) => text.includes("Times:"),
    });
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const system = String(body.messages?.[0]?.content ?? "");
      if (system.includes("You plan")) {
        planRequests.push(String(body.messages?.[1]?.content ?? ""));
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify(plans[planRequests.length - 1]),
              },
            },
          ],
        });
      }
      return stubbed(url, init);
    }) as typeof fetch;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Show me the tour's times." });
    await context.close();

    expect(planRequests).toHaveLength(2);
    expect(planRequests[1]).toContain("more times than it did before");
    expect(result.plan.subgoals[0]!.done_when).toEqual([
      "Start times are shown on the page",
    ]);
    expect(result.status).toBe("done");
  }, 30_000);

  it("sends back an end condition that ranks, since one yes/no check cannot", async () => {
    // "The earliest enabled date is selected" scored 0.66 on a page where it
    // was true; "a date in October 2026 is selected" scored 0.97. Ranking
    // belongs in code, not in a single check.
    const plans = [
      {
        subgoals: [
          {
            id: "pick",
            goal: "Pick the cheapest time",
            done_when: ["The cheapest time is selected"],
          },
        ],
        report: [],
      },
      {
        subgoals: [
          {
            id: "pick",
            goal: "Pick the cheapest time",
            done_when: ["Start times are shown on the page"],
          },
        ],
        report: [],
      },
    ];
    let planCalls = 0;
    stubModels({
      plan: {},
      operation: "CLICK",
      holds: (_s, text) => text.includes("Times:"),
    });
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(body.messages?.[0]?.content ?? "").includes("You plan")) {
        planCalls += 1;
        return Response.json({
          choices: [
            { message: { content: JSON.stringify(plans[planCalls - 1]) } },
          ],
        });
      }
      return stubbed(url, init);
    }) as typeof fetch;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Pick the cheapest time." });
    await context.close();

    expect(planCalls).toBe(2);
    expect(result.plan.subgoals[0]!.done_when).toEqual([
      "Start times are shown on the page",
    ]);
  }, 30_000);

  it("stops a task that is cancelled part way through", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "one",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
          },
          { id: "two", goal: "Pick a time", done_when: ["A time is selected"] },
        ],
        report: [],
      },
      operation: "WAIT",
      holds: () => false,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 800);

    const result = await runTask(page, {
      task: "Pick a time.",
      signal: controller.signal,
    });
    await context.close();

    expect(result.status).toBe("incomplete");
    expect(result.subgoals[0]).toEqual(
      expect.objectContaining({
        id: "one",
        status: "blocked",
        reason: "the run was cancelled",
      }),
    );
    expect(result.subgoals[1]).toEqual(
      expect.objectContaining({ status: "skipped" }),
    );
  }, 30_000);

  it("refuses a plan with no usable subgoal", async () => {
    stubModels({
      plan: { subgoals: [], report: [] },
      operation: "CLICK",
      holds: () => false,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    await expect(runTask(page, { task: "Do something." })).rejects.toThrow(
      "the planner returned no usable plan",
    );
    await context.close();
  }, 30_000);

  it("refuses a plan in which any subgoal cannot be checked, rather than dropping it", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "open",
            goal: "Show the times",
            done_when: ["Times are shown"],
            collect: [],
          },
          { id: "pick", goal: "Choose a time", done_when: [], collect: [] },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: () => true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    await expect(runTask(page, { task: "Choose a time." })).rejects.toThrow(
      "the planner returned no usable plan",
    );
    await context.close();
  }, 30_000);

  it("refuses a repair that is itself unusable, instead of keeping the uncheckable plan", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "pick",
            goal: "Pick the earliest date",
            done_when: ["The earliest date is selected"],
            collect: [],
          },
        ],
        report: [],
      },
      repair: { subgoals: [] },
      operation: "CLICK",
      holds: () => true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    await expect(
      runTask(page, { task: "Pick the earliest date." }),
    ).rejects.toThrow("the planner returned no usable plan");
    await context.close();
  }, 30_000);

  it("drops a fact whose quote is on the page but does not show the value", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
            collect: ["price"],
          },
        ],
        report: ["price"],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
      facts: { price: { value: "$999", quote: "per person" } },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Show me the tour's price." });
    await context.close();

    expect(result.facts.price).toEqual(
      expect.objectContaining({ value: null, supported: false }),
    );
  }, 30_000);

  it("does not take an option that is not selected as evidence", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
            collect: ["quantity"],
          },
        ],
        report: ["quantity"],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
      facts: { quantity: { value: "2 adults", quote: "2 - Adults" } },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      `<label>Guests <select><option>1 - Adult</option><option>2 - Adults</option></select></label>${TIMES_PAGE}`,
    );

    const result = await runTask(page, { task: "Show me the tour's times." });
    await context.close();

    expect(result.facts.quantity).toEqual(
      expect.objectContaining({ value: null, supported: false }),
    );
  }, 30_000);

  it("keeps the values the planner gives for the fields a subgoal will fill", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
            collect: [],
            inputs: { destination: "London", nights: 3 },
          },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Show the times." });
    await context.close();

    // Only strings: a value that is not text is not something to type.
    expect(result.plan.subgoals[0]!.inputs).toEqual({ destination: "London" });
  }, 30_000);

  it("returns what it has when cancelled while reading facts", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show the available times",
            done_when: ["Start times are shown on the page"],
            collect: ["price"],
          },
        ],
        report: ["price"],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
      extractDelayMs: 10_000,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);
    const controller = new AbortController();

    const pending = runTask(page, {
      task: "Show me the tour's price.",
      signal: controller.signal,
    });
    await page.waitForFunction(() =>
      document.body.innerText.includes("Times:"),
    );
    setTimeout(() => controller.abort(), 1_500);
    const result = await pending;
    await context.close();

    expect(result.status).toBe("incomplete");
    expect(result.subgoals[0]).toEqual(
      expect.objectContaining({ status: "done" }),
    );
    expect(result.missing).toEqual(["price"]);
  }, 30_000);

  describe("choosing and comparing in code", () => {
    // Options are links, as on a real listing: a choice must be something
    // the page offers to act on.
    const SHOP = `<ul><li><a href="#b">Blue mug</a> $1,050</li><li><a href="#r">Red mug</a> $980</li></ul><button>Filter</button>`;

    it("chooses among quoted candidates in code, and names the choice in later steps", async () => {
      const stub = stubModels({
        plan: {
          subgoals: [
            {
              id: "open",
              goal: "Open {cheapest_mug}",
              done_when: ["{cheapest_mug} is shown"],
              collect: [],
              choose: {
                name: "cheapest_mug",
                items: "mugs",
                by: "price",
                order: "min",
              },
            },
          ],
          report: ["cheapest_mug"],
        },
        operation: "CLICK",
        holds: () => true,
        items: [
          { key: "Blue mug", value: "$1,050", quote: "Blue mug $1,050" },
          { key: "Red mug", value: "$980", quote: "Red mug $980" },
          // Not on the page: never a candidate, however cheap.
          { key: "Green mug", value: "$5", quote: "Green mug $5" },
        ],
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(SHOP);

      const result = await runTask(page, { task: "Open the cheapest mug." });
      await context.close();

      expect(result.facts.cheapest_mug).toEqual(
        expect.objectContaining({ value: "Red mug", supported: true }),
      );
      expect(result.subgoals[0]).toEqual(
        expect.objectContaining({ goal: "Open Red mug", status: "done" }),
      );
      expect(stub.checked).toContain("Red mug is shown");
      expect(result.status).toBe("done");
    }, 30_000);

    it("compares facts read on different steps, in code", async () => {
      stubModels({
        plan: {
          subgoals: [
            {
              id: "a",
              goal: "Show the first",
              done_when: ["Shown"],
              collect: ["esb_height"],
            },
            {
              id: "b",
              goal: "Show the second",
              done_when: ["Shown"],
              collect: ["chrysler_height"],
            },
          ],
          report: ["esb_height", "chrysler_height", "taller"],
          derive: [
            {
              name: "taller",
              among: {
                "Empire State Building": "esb_height",
                "Chrysler Building": "chrysler_height",
              },
              order: "max",
            },
          ],
        },
        operation: "CLICK",
        holds: () => true,
        facts: {
          esb_height: { value: "443.2 m", quote: "Empire State 443.2 m" },
          chrysler_height: { value: "318.9 m", quote: "Chrysler 318.9 m" },
        },
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(
        `<p>Empire State 443.2 m. Chrysler 318.9 m.</p><button>Next</button>`,
      );

      const result = await runTask(page, { task: "Which is taller?" });
      await context.close();

      expect(result.facts.taller).toEqual(
        expect.objectContaining({
          value: "Empire State Building",
          supported: true,
        }),
      );
      expect(result.status).toBe("done");
    }, 30_000);

    it("does not run a step that names a value that was never found", async () => {
      stubModels({
        plan: {
          subgoals: [
            {
              id: "list",
              goal: "Show the mugs",
              done_when: ["Mugs are listed"],
              collect: [],
              choose: {
                name: "cheapest_mug",
                items: "mugs",
                by: "price",
                order: "min",
              },
            },
            {
              id: "open",
              goal: "Open {cheapest_mug}",
              done_when: ["{cheapest_mug} is shown"],
              collect: [],
            },
          ],
          report: [],
        },
        operation: "CLICK",
        holds: () => true,
        items: [],
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(SHOP);

      const result = await runTask(page, { task: "Open the cheapest mug." });
      await context.close();

      expect(result.subgoals[0]).toEqual(
        expect.objectContaining({ status: "blocked" }),
      );
      // Re-planned around, with the same plan, until re-planning runs out;
      // a step naming the missing value never runs.
      expect(result.subgoals.every((s) => s.actions === 0)).toBe(true);
      expect(result.status).toBe("incomplete");
    }, 60_000);

    it("orders times of day and dates as times and dates, not as their first number", async () => {
      stubModels({
        plan: {
          subgoals: [
            {
              id: "list",
              goal: "Show the times",
              done_when: ["Times are listed"],
              collect: [],
              choose: {
                name: "first_time",
                items: "start times",
                by: "time",
                order: "min",
              },
            },
          ],
          report: ["first_time"],
        },
        operation: "CLICK",
        holds: () => true,
        items: [
          { key: "11:30 AM", value: "11:30 AM", quote: "11:30 AM" },
          { key: "2:00 PM", value: "2:00 PM", quote: "2:00 PM" },
          { key: "9:15 AM", value: "9:15 AM", quote: "9:15 AM" },
        ],
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(
        `<button>11:30 AM</button><button>2:00 PM</button><button>9:15 AM</button>`,
      );

      const result = await runTask(page, { task: "Find the earliest time." });
      await context.close();

      expect(result.facts.first_time?.value).toBe("9:15 AM");
    }, 30_000);
  });

  it("tells the classifier what done looks like, not only what to do", async () => {
    // Told only "Click date picker button", the classifier clicked it once,
    // the calendar did not open, and it declared the goal done twice.
    const stub = stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Click Show times",
            done_when: ["Start times are shown on the page"],
            collect: [],
          },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    await runTask(page, { task: "Show the times." });
    await context.close();

    expect(stub.goals[0]).toContain("Click Show times");
    expect(stub.goals[0]).toContain("Start times are shown on the page");
  }, 30_000);

  it("fills a subgoal's own input into its goal", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "times",
            goal: "Show times for {guests} guest",
            done_when: ["Start times are shown on the page"],
            collect: [],
            inputs: { guests: "1" },
          },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Show the times." });
    await context.close();

    expect(result.subgoals[0]).toEqual(
      expect.objectContaining({
        goal: "Show times for 1 guest",
        status: "done",
      }),
    );
  }, 30_000);

  it("sends back an end condition that names a widget state instead of what shows", async () => {
    // On Peek, "Date picker calendar is open" scored 0.68 with the calendar
    // open; "A calendar showing September 2026 is visible" scored 0.98.
    const stub = stubModels({
      plan: {
        subgoals: [
          {
            id: "open",
            goal: "Open the times",
            done_when: ["The times panel is open"],
            collect: [],
          },
        ],
        report: [],
      },
      repair: {
        subgoals: [
          {
            id: "open",
            goal: "Open the times",
            done_when: ["Start times are shown on the page"],
            collect: [],
          },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: (_statement, text) => text.includes("Times:"),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(TIMES_PAGE);

    const result = await runTask(page, { task: "Show the times." });
    await context.close();

    expect(result.plan.subgoals[0]!.done_when).toEqual([
      "Start times are shown on the page",
    ]);
    expect(stub.checked).not.toContain("The times panel is open");
  }, 30_000);

  it("chooses among controls whose value the page shows in parts, like a calendar", async () => {
    // A calendar day's date is its month heading plus its own button: no
    // single passage says "October 3, 2026".
    const stub = stubModels({
      plan: {
        subgoals: [
          {
            id: "pick",
            goal: "Click {earliest_date}",
            done_when: ["{earliest_date} is selected"],
            collect: [],
            choose: {
              name: "earliest_date",
              items: "enabled dates",
              by: "date",
              order: "min",
            },
          },
        ],
        report: ["earliest_date"],
      },
      operation: "CLICK",
      holds: () => true,
      items: [
        { key: "10", value: "October 10, 2026", quote: "October 2026 ... 10" },
        { key: "3", value: "October 3, 2026", quote: "October 2026 ... 3" },
        // A control, but its value is not on the page.
        { key: "10", value: "September 1, 2026", quote: "x" },
        // Not a control, and not quoted.
        { key: "1", value: "October 1, 2026", quote: "October 2026 ... 1" },
      ],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      `<h2>October 2026</h2><p>1 2</p><button>3</button><button>10</button>`,
    );

    const result = await runTask(page, { task: "Pick the earliest date." });
    await context.close();

    expect(result.facts.earliest_date?.value).toBe("3");
    // "3 is selected" could not be checked on Peek; the full date can.
    expect(result.subgoals[0]!.goal).toBe("Click 3 (October 3, 2026)");
    expect(stub.checked).toContain("October 3, 2026 is selected");
  }, 30_000);

  it("waits for options that load after the page it starts on", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "open",
            goal: "Open {cheapest_mug}",
            done_when: ["{cheapest_mug} is shown"],
            collect: [],
            choose: {
              name: "cheapest_mug",
              items: "mugs",
              by: "price",
              order: "min",
            },
          },
        ],
        report: ["cheapest_mug"],
      },
      operation: "CLICK",
      holds: () => true,
      items: [{ key: "Red mug", value: "$980", quote: "Red mug $980" }],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<ul id="list"></ul><button>Filter</button>
      <script>setTimeout(() => { document.getElementById('list').innerHTML = '<li><a href=#r>Red mug</a> $980</li>'; }, 1200);</script>`);

    const result = await runTask(page, { task: "Open the cheapest mug." });
    await context.close();

    expect(result.facts.cheapest_mug?.value).toBe("Red mug");
  }, 30_000);

  it("counts a reading step done when every fact it reads is quoted from the page", async () => {
    // Peek's planner kept waiting for "the start times list"; the page had
    // one start time, which the checker would not call a list.
    stubModels({
      plan: {
        subgoals: [
          {
            id: "read",
            goal: "Wait for the start times list",
            done_when: ["A list of start times is displayed"],
            collect: ["start_time"],
          },
        ],
        report: ["start_time"],
      },
      operation: "WAIT",
      holds: () => false,
      facts: { start_time: { value: "11:30 AM", quote: "11:30 AM" } },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      `<p>11:30 AM - 2 Hour(s)</p><button>Reserve</button>`,
    );

    const result = await runTask(page, { task: "Report the start times." });
    await context.close();

    expect(result.subgoals[0]).toEqual(
      expect.objectContaining({
        status: "done",
        reason: "every fact it reads is on the page",
      }),
    );
    expect(result.status).toBe("done");
  }, 60_000);

  it("does not count a reading step done when a fact it reads is missing", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "read",
            goal: "Wait for the times",
            done_when: ["Start times are shown"],
            collect: ["start_time", "price"],
          },
        ],
        report: ["start_time", "price"],
      },
      operation: "WAIT",
      holds: () => false,
      facts: {
        start_time: { value: "11:30 AM", quote: "11:30 AM" },
        price: { value: "$69", quote: "$69 per person" },
      },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      `<p>11:30 AM - 2 Hour(s)</p><button>Reserve</button>`,
    );

    const result = await runTask(page, {
      task: "Report the start times and price.",
    });
    await context.close();

    expect(result.subgoals[0]!.status).toBe("blocked");
    expect(result.status).toBe("incomplete");
  }, 60_000);

  it("does not count a step that had to act as done just because its facts are on the page", async () => {
    // An earlier, wrong date still on the page must not stand in for a
    // selection that never happened.
    stubModels({
      plan: {
        subgoals: [
          {
            id: "pick",
            goal: "Click October 3",
            done_when: ["October 3, 2026 is selected"],
            collect: ["selected_date"],
          },
        ],
        report: ["selected_date"],
      },
      operation: "CLICK",
      holds: () => false,
      facts: {
        selected_date: { value: "October 31, 2026", quote: "October 31, 2026" },
      },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<p>October 31, 2026</p><button>3</button>`);

    const result = await runTask(page, { task: "Select October 3." });
    await context.close();

    expect(result.subgoals[0]!.status).toBe("blocked");
  }, 60_000);

  it("reads a missing fact again from the final page", async () => {
    // On Peek the date field updated after the step that read it.
    stubModels({
      plan: {
        subgoals: [
          {
            id: "pick",
            goal: "Pick the date",
            done_when: ["A date is chosen"],
            collect: ["selected_date"],
          },
          {
            id: "confirm",
            goal: "Wait for the date",
            done_when: ["Selected is shown"],
            collect: [],
          },
        ],
        report: ["selected_date"],
      },
      operation: "WAIT",
      holds: (statement, text) =>
        statement !== "Selected is shown" || text.includes("Selected"),
      facts: {
        selected_date: {
          value: "October 3, 2026",
          quote: "Selected: October 3, 2026",
        },
      },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<p id="out"></p><button>Go</button>
      <script>setTimeout(() => { document.getElementById('out').textContent = 'Selected: October 3, 2026'; }, 1500);</script>`);

    const result = await runTask(page, { task: "Pick the date." });
    await context.close();

    expect(result.facts.selected_date?.value).toBe("October 3, 2026");
    expect(result.status).toBe("done");
  }, 60_000);

  describe("re-planning", () => {
    // Times appear only once Show is clicked. A blocked step counts as
    // recovered only when its end condition holds on the final page.
    const STUCK = `<button onclick="document.getElementById('o').textContent = 'Times: 9:00 AM'">Show</button><p id="o"></p>`;
    const timesShown = (_statement: string, text: string) =>
      text.includes("Times:");
    const stuckPlan = {
      subgoals: [
        {
          id: "a",
          goal: "Do the impossible",
          done_when: ["Times are shown"],
          collect: [],
        },
      ],
      report: [],
    };
    const recoveryPlan = {
      subgoals: [
        {
          id: "b",
          goal: "Show the times",
          done_when: ["Times are shown"],
          collect: [],
        },
      ],
      report: [],
    };

    it("asks once more when the first plan is not usable", async () => {
      const stub = stubModels({
        plan: {},
        plans: [
          { subgoals: [{ id: "a", goal: "x", done_when: [] }] },
          recoveryPlan,
        ],
        operation: "CLICK",
        holds: timesShown,
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(STUCK);

      const result = await runTask(page, { task: "Show the times." });
      await context.close();

      expect(stub.planCalls()).toBe(2);
      expect(result.status).toBe("done");
    }, 60_000);

    it("plans the rest from the current page when a step is blocked", async () => {
      const stub = stubModels({
        plan: {},
        plans: [stuckPlan, recoveryPlan],
        operation: "CLICK",
        // The first step is judged unreachable; the re-plan clicks Show.
        operations: ["BLOCKED", "CLICK"],
        holds: timesShown,
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(STUCK);

      const result = await runTask(page, { task: "Show the times." });
      await context.close();

      expect(stub.planCalls()).toBe(2);
      expect(result.subgoals.map((s) => `${s.id}:${s.status}`)).toEqual([
        "a:blocked",
        "b:done",
      ]);
      expect(result.status).toBe("done");
    }, 60_000);

    it("re-plans at most twice", async () => {
      const stub = stubModels({
        plan: {},
        plans: [stuckPlan],
        operation: "CLICK",
        holds: () => false,
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(STUCK);

      const result = await runTask(page, { task: "Show the times." });
      await context.close();

      expect(stub.planCalls()).toBe(3);
      expect(result.status).toBe("incomplete");
    }, 90_000);
  });

  it("reports a verified value that changed before the end, instead of success", async () => {
    // On Peek, wandering after the date was verified moved it to October 31.
    stubModels({
      plan: {
        subgoals: [
          {
            id: "pick",
            goal: "Pick the date",
            done_when: ["A date is chosen"],
            collect: ["selected_date"],
          },
          {
            id: "other",
            goal: "Click Other",
            done_when: ["Other was clicked"],
            collect: [],
          },
        ],
        report: ["selected_date"],
      },
      operation: "CLICK",
      holds: (statement, text) =>
        statement !== "Other was clicked" || text.includes("31"),
      facts: (text) => {
        const date = /October \d+, 2026/u.exec(text)?.[0] ?? "";
        return { selected_date: { value: date, quote: `Selected: ${date}` } };
      },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<p id="s">Selected: October 3, 2026</p>
      <button onclick="document.getElementById('s').textContent = 'Selected: October 31, 2026'">Other</button>`);

    const result = await runTask(page, { task: "Pick October 3." });
    await context.close();

    expect(result.conflicts).toEqual([
      {
        name: "selected_date",
        earlier: "October 3, 2026",
        final: "October 31, 2026",
      },
    ]);
    expect(result.facts.selected_date?.value).toBe("October 31, 2026");
    expect(result.status).toBe("incomplete");
  }, 60_000);

  describe("re-planning and final checks, as seen on Peek", () => {
    it("does not call the same value written two ways a conflict", async () => {
      let reads = 0;
      stubModels({
        plan: {
          subgoals: [
            {
              id: "read",
              goal: "Show times",
              done_when: ["Times are shown"],
              collect: ["start_time"],
            },
          ],
          report: ["start_time"],
        },
        operation: "CLICK",
        holds: () => true,
        facts: () => {
          reads += 1;
          return reads === 1
            ? {
                start_time: {
                  value: "11:30 AM - 2 Hour(s)",
                  quote: "11:30 AM - 2 Hour(s)",
                },
              }
            : { start_time: { value: "11:30 AM", quote: "11:30 AM" } };
        },
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(
        `<p>11:30 AM - 2 Hour(s)</p><button>Reserve</button>`,
      );

      const result = await runTask(page, { task: "Report the start time." });
      await context.close();

      expect(result.conflicts).toEqual([]);
      expect(result.status).toBe("done");
    }, 60_000);

    it("counts a step done when the classifier says so and every fact it reads is quoted", async () => {
      stubModels({
        plan: {
          subgoals: [
            {
              id: "read",
              goal: "Read the times",
              done_when: ["A list of start times is displayed"],
              collect: ["start_time"],
            },
          ],
          report: ["start_time"],
        },
        // As on Peek: a claim, a click on the date field, then the claim again.
        operation: "DONE",
        operations: ["DONE", "CLICK", "DONE"],
        holds: () => false,
        facts: { start_time: { value: "11:30 AM", quote: "11:30 AM" } },
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(
        `<p>11:30 AM - 2 Hour(s)</p><button>Reserve</button>`,
      );

      const result = await runTask(page, { task: "Report the start time." });
      await context.close();

      expect(result.subgoals[0]).toEqual(
        expect.objectContaining({ status: "done" }),
      );
    }, 60_000);

    it("re-plans knowing the plan so far and each chosen value in full", async () => {
      const stub = stubModels({
        plan: {},
        plans: [
          {
            subgoals: [
              {
                id: "pick",
                goal: "Click {earliest_date}",
                done_when: ["{earliest_date} is selected"],
                collect: [],
                choose: {
                  name: "earliest_date",
                  items: "enabled dates",
                  by: "date",
                  order: "min",
                },
              },
              {
                id: "stuck",
                goal: "Do the impossible",
                done_when: ["Never true"],
                collect: [],
              },
            ],
            report: [],
          },
          {
            subgoals: [
              {
                id: "end",
                goal: "Finish",
                done_when: ["Finished"],
                collect: [],
              },
            ],
            report: [],
          },
        ],
        operation: "CLICK",
        holds: (statement) => statement !== "Never true",
        items: [{ key: "3", value: "October 3, 2026", quote: "3" }],
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(
        `<h2>October 2026</h2><button>3</button><button>10</button>`,
      );

      await runTask(page, { task: "Pick the earliest date." });
      await context.close();

      const replan = stub.planRequests[1]!;
      expect(replan.plan_so_far).toEqual([
        expect.objectContaining({
          goal: "Click 3 (October 3, 2026)",
          status: "done",
        }),
        expect.objectContaining({
          goal: "Do the impossible",
          status: "blocked",
        }),
      ]);
      expect(replan.known_facts).toEqual(
        expect.objectContaining({ earliest_date: "3 (October 3, 2026)" }),
      );
    }, 60_000);
  });
});

describe("fixes from the reviews of steps 4 and 5", () => {
  const page = async (html: string) => {
    const context = await browser.newContext();
    const tab = await context.newPage();
    await tab.setContent(html);
    return { context, tab };
  };

  it("does not count a step that must select a value as read, when the value is wrong", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "pick",
            goal: "Select October 3",
            done_when: ["October 3, 2026 is selected"],
            collect: ["selected_date"],
          },
        ],
        report: ["selected_date"],
      },
      operation: "DONE",
      holds: () => false,
      facts: {
        selected_date: { value: "October 31, 2026", quote: "October 31, 2026" },
      },
    });
    const { context, tab } = await page(
      `<p>October 31, 2026</p><button>3</button>`,
    );
    const result = await runTask(tab, { task: "Select October 3." });
    await context.close();

    expect(result.subgoals[0]!.status).toBe("blocked");
    expect(result.status).toBe("incomplete");
  }, 60_000);

  it("chooses only options the page offers, each paired with its own value", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "open",
            goal: "Open {cheapest_mug}",
            done_when: ["{cheapest_mug} is shown"],
            collect: [],
            choose: {
              name: "cheapest_mug",
              items: "mugs",
              by: "price",
              order: "min",
            },
          },
        ],
        report: ["cheapest_mug"],
      },
      operation: "CLICK",
      holds: () => true,
      items: [
        // A real control, but paired with another option's price.
        { key: "Blue mug", value: "$5", quote: "$5" },
        // On the page, but not something it offers to act on.
        { key: "Green mug", value: "$1", quote: "Green mug $1" },
        { key: "Red mug", value: "$980", quote: "Red mug $980" },
      ],
    });
    const { context, tab } = await page(
      `<ul><li><a href="#b">Blue mug</a> $1,050</li><li><a href="#r">Red mug</a> $980</li><li>Green mug $1 (sold out)</li></ul><p>$5 off today</p>`,
    );
    const result = await runTask(tab, { task: "Open the cheapest mug." });
    await context.close();

    expect(result.facts.cheapest_mug?.value).toBe("Red mug");
  }, 60_000);

  it("chooses among a select's options, not only the one already selected", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "plan",
            goal: "Choose {cheapest_plan}",
            done_when: ["{cheapest_plan} is chosen"],
            collect: [],
            choose: {
              name: "cheapest_plan",
              items: "plans",
              by: "price",
              order: "min",
            },
          },
        ],
        report: ["cheapest_plan"],
      },
      operation: "CLICK",
      holds: () => true,
      items: [
        { key: "Basic $5", value: "$5", quote: "Basic $5" },
        { key: "Premium $20", value: "$20", quote: "Premium $20" },
      ],
    });
    const { context, tab } = await page(
      `<label>Plan <select><option>Basic $5</option><option selected>Premium $20</option></select></label>`,
    );
    const result = await runTask(tab, { task: "Choose the cheapest plan." });
    await context.close();

    expect(result.facts.cheapest_plan?.value).toBe("Basic $5");
  }, 60_000);

  it("orders ISO dates, dates without a year, free prices, and dates with times", () => {
    const year = new Date().getFullYear();
    expect(comparable("2026-10-03")! > comparable("2026-09-30")!).toBe(true);
    expect(comparable(`October 3`)).toBe(comparable(`October 3, ${year}`));
    expect(comparable("Free")).toBe(0);
    expect(
      comparable("October 3, 2026 9:00 AM")! <
        comparable("October 3, 2026 11:30 AM")!,
    ).toBe(true);
    expect(
      comparable("October 3, 2026 9:00 AM")! >
        comparable("October 2, 2026 11:30 AM")!,
    ).toBe(true);
  });

  it("never lets a model's reading stand in for a comparison made in code", async () => {
    stubModels({
      plan: {
        subgoals: [
          { id: "a", goal: "Show", done_when: ["Shown"], collect: ["a", "b"] },
        ],
        report: ["a", "b", "winner"],
        derive: [{ name: "winner", among: { A: "a", B: "b" }, order: "max" }],
      },
      operation: "CLICK",
      holds: () => true,
      facts: {
        a: { value: "1", quote: "A 1" },
        b: { value: "2", quote: "B 2" },
        winner: { value: "A", quote: "A 1" },
      },
    });
    const { context, tab } = await page(
      `<p>A 1</p><p>B 2</p><button>Go</button>`,
    );
    const result = await runTask(tab, { task: "Which is larger?" });
    await context.close();

    expect(result.facts.winner?.value).toBe("B");
  }, 60_000);

  it("types nothing in a step that was given no inputs", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "a",
            goal: "Fill the form",
            done_when: ["Never true"],
            collect: [],
          },
        ],
        report: [],
      },
      operation: "CLICK",
      operations: ["TYPE_TEXT"],
      holds: () => false,
    });
    const { context, tab } = await page(
      `<label>City <input id="city"></label>`,
    );
    process.env.TEXT_MODEL_API_KEY = "test";
    // The text model's answer in this stub is "" for fields; make it invent.
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (
        String(body.messages?.[0]?.content ?? "").startsWith(
          "Return a JSON object with exactly one key",
        )
      )
        return Response.json({
          choices: [
            { message: { content: JSON.stringify({ text: "San Francisco" }) } },
          ],
        });
      return stubbed(url, init);
    }) as typeof fetch;
    await runTask(tab, { task: "Fill the form." });
    const typed = await tab.inputValue("#city");
    await context.close();

    expect(typed).toBe("");
  }, 90_000);

  it("fills an input that names a fact, and the goal that names the input", async () => {
    stubModels({
      plan: {},
      plans: [
        {
          subgoals: [
            {
              id: "read",
              goal: "Read the city",
              done_when: ["City is shown"],
              collect: ["place"],
            },
            {
              id: "type",
              goal: "Type {destination}",
              done_when: ["{destination} is entered"],
              collect: [],
              inputs: { destination: "{place}" },
            },
          ],
          report: [],
        },
      ],
      operation: "CLICK",
      holds: () => true,
      facts: { place: { value: "London", quote: "London" } },
    });
    const { context, tab } = await page(`<p>London</p><button>Go</button>`);
    const result = await runTask(tab, { task: "Enter the city." });
    await context.close();

    expect(result.subgoals[1]!.goal).toBe("Type London");
  }, 60_000);

  it("keeps a short product name in checks rather than its price", async () => {
    const stub = stubModels({
      plan: {
        subgoals: [
          {
            id: "pick",
            goal: "Open {cheapest}",
            done_when: ["{cheapest} is selected"],
            collect: [],
            choose: {
              name: "cheapest",
              items: "products",
              by: "price",
              order: "min",
            },
          },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: () => true,
      items: [{ key: "Go", value: "$5", quote: "Go $5" }],
    });
    const { context, tab } = await page(`<p><a href="#go">Go</a> $5</p>`);
    await runTask(tab, { task: "Open the cheapest." });
    await context.close();

    expect(stub.checked).toContain("Go is selected");
  }, 60_000);

  it("is not done when a blocked step's outcome was never recovered", async () => {
    stubModels({
      plan: {},
      plans: [
        {
          subgoals: [
            {
              id: "save",
              goal: "Save the settings",
              done_when: ["Settings are saved"],
              collect: [],
            },
          ],
          report: [],
        },
        {
          subgoals: [
            {
              id: "help",
              goal: "Open help",
              done_when: ["Help is shown"],
              collect: [],
            },
          ],
          report: [],
        },
      ],
      operation: "CLICK",
      holds: (statement) => statement === "Help is shown",
    });
    const { context, tab } = await page(
      `<button>Save</button><button>Help</button>`,
    );
    const result = await runTask(tab, { task: "Save the settings." });
    await context.close();

    expect(result.status).toBe("incomplete");
  }, 90_000);

  it("reports a verified fact that is no longer on the final page", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "pick",
            goal: "Pick",
            done_when: ["Picked"],
            collect: ["selected_date"],
          },
          {
            id: "clear",
            goal: "Click Clear",
            done_when: ["Cleared"],
            collect: [],
          },
        ],
        report: ["selected_date"],
      },
      operation: "CLICK",
      holds: (statement, text) =>
        statement !== "Cleared" || !text.includes("October"),
      facts: (text) =>
        text.includes("October 3, 2026")
          ? {
              selected_date: {
                value: "October 3, 2026",
                quote: "October 3, 2026",
              },
            }
          : { selected_date: { value: "", quote: "" } },
    });
    const { context, tab } = await page(
      `<p id="d">October 3, 2026</p><button onclick="document.getElementById('d').textContent = ''">Clear</button>`,
    );
    const result = await runTask(tab, { task: "Pick October 3." });
    await context.close();

    expect(result.conflicts.map((c) => c.name)).toEqual(["selected_date"]);
    expect(result.status).toBe("incomplete");
  }, 60_000);

  it("records a conflict when a later step reads a different value under the same name", async () => {
    stubModels({
      plan: {
        subgoals: [
          {
            id: "a",
            goal: "Pick",
            done_when: ["Picked"],
            collect: ["selected_date"],
          },
          {
            id: "b",
            goal: "Click Other",
            done_when: ["Other"],
            collect: ["selected_date"],
          },
        ],
        report: ["selected_date"],
      },
      operation: "CLICK",
      holds: (statement, text) => statement !== "Other" || text.includes("31"),
      facts: (text) => {
        const date = /October \d+, 2026/u.exec(text)?.[0] ?? "";
        return { selected_date: { value: date, quote: date } };
      },
    });
    const { context, tab } = await page(
      `<p id="s">October 3, 2026</p><button onclick="document.getElementById('s').textContent = 'October 31, 2026'">Other</button>`,
    );
    const result = await runTask(tab, { task: "Pick October 3." });
    await context.close();

    expect(result.conflicts).toEqual([
      {
        name: "selected_date",
        earlier: "October 3, 2026",
        final: "October 31, 2026",
      },
    ]);
  }, 60_000);

  it("tells morning from evening, and one thousand from 1,000", async () => {
    for (const [first, second, differ] of [
      ["9:00 AM", "9:00 PM", true],
      ["$1,000", "$1000", false],
      ["$10.50", "$50.10", true],
    ] as const) {
      let reads = 0;
      stubModels({
        plan: {
          subgoals: [
            { id: "a", goal: "Show", done_when: ["Shown"], collect: ["v"] },
          ],
          report: ["v"],
        },
        operation: "CLICK",
        holds: () => true,
        facts: () => {
          reads += 1;
          const value = reads === 1 ? first : second;
          return { v: { value, quote: value } };
        },
      });
      const { context, tab } = await page(
        `<p>9:00 AM 9:00 PM $1,000 $1000 $10.50 $50.10</p><button>Go</button>`,
      );
      const result = await runTask(tab, { task: "Show v." });
      await context.close();
      expect([first, second, result.conflicts.length > 0]).toEqual([
        first,
        second,
        differ,
      ]);
    }
  }, 120_000);

  it("keeps re-planning and the final check within the task's time budget", async () => {
    stubModels({
      plan: {
        subgoals: [
          { id: "a", goal: "Show", done_when: ["Shown"], collect: ["v"] },
        ],
        report: ["v"],
      },
      operation: "CLICK",
      holds: () => true,
      facts: { v: { value: "", quote: "" } },
      extractDelayMs: 20_000,
    });
    const { context, tab } = await page(`<p>1</p><button>Go</button>`);
    const started = Date.now();
    const result = await runTask(tab, { task: "Show v.", deadlineMs: 3_000 });
    const took = Date.now() - started;
    await context.close();

    expect(took).toBeLessThan(6_000);
    expect(result.status).toBe("incomplete");
  }, 60_000);

  it("reads a fact a second time before taking it as missing", async () => {
    // On Peek's final page the extractor returned every field empty in one
    // call of five on identical input.
    let reads = 0;
    stubModels({
      plan: {
        subgoals: [
          { id: "a", goal: "Show", done_when: ["Shown"], collect: ["v"] },
        ],
        report: ["v"],
      },
      operation: "CLICK",
      holds: () => true,
      facts: () => {
        reads += 1;
        // Read once, then the final check's reading comes back empty.
        return reads === 2
          ? { v: { value: "", quote: "" } }
          : { v: { value: "11:30 AM", quote: "11:30 AM" } };
      },
    });
    const { context, tab } = await page(`<p>11:30 AM</p><button>Go</button>`);
    const result = await runTask(tab, { task: "Show v." });
    await context.close();

    expect(result.facts.v?.value).toBe("11:30 AM");
    expect(result.conflicts).toEqual([]);
    expect(result.status).toBe("done");
  }, 60_000);

  it("sends back an end condition relative to today, like next month", async () => {
    const stub = stubModels({
      plan: {
        subgoals: [
          {
            id: "month",
            goal: "Go to next month",
            done_when: ["Next month calendar is displayed"],
            collect: [],
          },
        ],
        report: [],
      },
      repair: {
        subgoals: [
          {
            id: "month",
            goal: "Go to next month",
            done_when: ["October 2026 is shown"],
            collect: [],
          },
        ],
        report: [],
      },
      operation: "CLICK",
      holds: () => true,
    });
    const { context, tab } = await page(`<button>Next</button>`);
    const result = await runTask(tab, { task: "Open next month." });
    await context.close();

    expect(stub.planCalls()).toBe(2);
    expect(result.plan.subgoals[0]!.done_when).toEqual([
      "October 2026 is shown",
    ]);
  }, 60_000);

  it("checks a blocked step once more before planning around it", async () => {
    // A page that had already done it: on Peek the calendar was on October
    // when the check gave up, and the re-plan went on to November.
    let checks = 0;
    const stub = stubModels({
      plan: {
        subgoals: [
          {
            id: "month",
            goal: "Go to next month",
            done_when: ["October 2026 is shown"],
            collect: [],
          },
        ],
        report: [],
      },
      operation: "DONE",
      // Three checks inside the run say no; the next one says yes.
      holds: () => ++checks > 3,
    });
    const { context, tab } = await page(`<button>Next</button>`);
    const result = await runTask(tab, { task: "Open next month." });
    await context.close();

    expect(stub.planCalls()).toBe(1);
    expect(result.subgoals[0]).toEqual(
      expect.objectContaining({
        status: "done",
        reason: "the end condition holds after all",
      }),
    );
    expect(result.status).toBe("done");
  }, 60_000);

  it("counts a blocked step recovered when a later step reaches the same end condition", async () => {
    // A picker opened on the second try is closed again by the end, as it
    // should be; its step is still recovered.
    const seen = new Map<string, number>();
    const stub = stubModels({
      plan: {},
      plans: [
        {
          subgoals: [
            {
              id: "open",
              goal: "Open the picker",
              done_when: ["The picker is visible"],
              collect: [],
            },
          ],
          report: [],
        },
        {
          subgoals: [
            {
              id: "open",
              goal: "Open the picker again",
              done_when: ["The picker is visible"],
              collect: [],
            },
          ],
          report: [],
        },
      ],
      operation: "CLICK",
      operations: ["BLOCKED", "CLICK"],
      holds: (statement) => {
        const n = (seen.get(statement) ?? 0) + 1;
        seen.set(statement, n);
        // Blocked run: 1 check; recheck: 2; second step: 3 holds; final: 4 no.
        return n === 3;
      },
    });
    const { context, tab } = await page(`<button>Open</button>`);
    const result = await runTask(tab, { task: "Open the picker." });
    await context.close();

    expect(stub.planCalls()).toBe(2);
    expect(result.subgoals.map((s) => s.status)).toEqual(["blocked", "done"]);
    expect(result.status).toBe("done");
  }, 60_000);

  it("shows a re-plan each earlier step's end conditions", async () => {
    const stub = stubModels({
      plan: {},
      plans: [
        {
          subgoals: [
            {
              id: "a",
              goal: "Do it",
              done_when: ["October 2026 is shown"],
              collect: [],
            },
          ],
          report: [],
        },
        {
          subgoals: [
            { id: "b", goal: "Finish", done_when: ["Finished"], collect: [] },
          ],
          report: [],
        },
      ],
      operation: "BLOCKED",
      holds: () => false,
    });
    const { context, tab } = await page(`<button>Go</button>`);
    await runTask(tab, { task: "Do it." });
    await context.close();

    expect(stub.planRequests[1]!.plan_so_far).toEqual([
      expect.objectContaining({
        done_when: ["October 2026 is shown"],
        status: "blocked",
      }),
    ]);
  }, 60_000);
});
