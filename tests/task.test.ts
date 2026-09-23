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
  operation: "CLICK" | "DONE" | "WAIT";
  /** Whether one end-condition statement holds for this page text. */
  holds: (statement: string, pageText: string) => boolean;
  /** Facts the extractor returns. */
  facts?: Record<string, { value: string; quote: string }>;
  /** What the planner returns when asked to repair its plan. */
  repair?: unknown;
};

/** Route each model request to a deterministic answer. */
function stubModels(stubs: Stubs): { classifierCalls: () => number } {
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
          answers[name] = {
            type: "noul",
            noul: stubs.holds(String(question.instructions), text)
              ? 0.97
              : 0.03,
          };
          continue;
        }
        classifierCalls += name === "operation" ? 1 : 0;
        const keys = Object.keys(question.criteria ?? {});
        const choice =
          name === "operation" && keys.includes(stubs.operation)
            ? stubs.operation
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
    const system = String(body.messages?.[0]?.content ?? "");
    const planning = system.includes("You plan");
    if (planning) planCalls += 1;
    const content = planning
      ? planCalls > 1 && stubs.repair !== undefined
        ? stubs.repair
        : stubs.plan
      : system.includes("You extract")
        ? (stubs.facts ?? {})
        : { text: "" };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    });
  }) as typeof fetch;
  return { classifierCalls: () => classifierCalls };
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
});
