/**
 * The loop. Observe, ask Jev for one operation plus a speculative target,
 * generate text only when the operation is TYPE_TEXT, execute, repeat.
 *
 * Structure follows jev-ultrafast's agent.py, including the two properties
 * that make its ordering safe: a decision is consumed before any mutation, so
 * a retry cannot double-click, and an executed action is recorded before the
 * post-action observation, so a stale read cannot erase it.
 */
import { readdirSync } from "node:fs";
import { contextOf, type BrowserTarget } from "./target.ts";
import type { Browser, BrowserContext, Page } from "playwright";
import { actionSpace } from "./actions.ts";
import { decide, fieldText } from "./decide.ts";
import { execute, getActivePage } from "./execute.ts";
import { fresh, observe, settle } from "./observe.ts";
import {
  StalePage,
  type Decision,
  type ObservedAction,
  type PageObservation,
} from "./types.ts";

const MAX_ACTIONS = 30;
const MAX_DECISIONS = MAX_ACTIONS * 2;

export type HistoryEntry = {
  step: number;
  action: string;
  kind: ObservedAction["kind"];
  choice: string;
  operation: Decision["operation"];
  target: string | null;
  confidence: number;
  probability: number;
  text: string | null;
  latencyMs: number;
  textLatencyMs: number;
  pageChanged: boolean | null;
  url: string;
  elapsedMs: number;
  usage: Decision["usage"];
};

export type RunResult = {
  status: "done" | "blocked";
  /** Why the loop stopped. A caller needs to tell a refusal from a cap. */
  reason: string;
  goal: string;
  history: HistoryEntry[];
  decisions: (Decision & { elapsedMs: number })[];
  elapsedMs: number;
  /** Canvas regions the DOM could not describe. The honest escalation signal. */
  canvases: PageObservation["canvases"];
  closedShadowHosts: number;
  frames: PageObservation["frames"];
  tabs: PageObservation["tabs"];
  usage: { input_tokens: number; output_tokens: number; text_calls: number };
};

export type RunOptions = {
  goal: string;
  uploadDir?: string;
  /** Screenshots stay off in the default path; that is half the speed win. */
  screenshots?: boolean;
  onStep?: (entry: HistoryEntry) => void;
};

/**
 * Run a whole task against a context you already have: observe, decide, write
 * text when the operation needs it, execute, and repeat until the classifier
 * stops or a bound trips.
 *
 * Use this when your product owns the browser. `runOnce` is the same loop with
 * a context of its own.
 */
export async function run(
  target: BrowserTarget,
  options: RunOptions
): Promise<RunResult> {
  const context = contextOf(target);
  const goal = options.goal.trim();
  if (!goal) throw new Error("Supply a goal");
  const uploadDir = options.uploadDir;
  // Fail before the first model call rather than at the one action that needs it.
  if (uploadDir !== undefined) readdirSync(uploadDir);

  const history: HistoryEntry[] = [];
  const decisions: (Decision & { elapsedMs: number })[] = [];
  let observation = await observe(context, { screenshot: options.screenshots });
  let status: "ready" | "done" | "blocked" = "ready";
  let reason = "the loop ended without a stated reason";
  // Keyed by the entire text-helper input, so a generated value survives a
  // stale-page retry only when nothing that produced it changed.
  const pendingText = new Map<string, { value: string; latencyMs: number }>();
  // A stale retry re-runs the whole action, including any input it already
  // dispatched before going stale. Unbounded, that clicked the same field 60
  // times with nothing in history and no strike against the stuck rule.
  const MAX_STALE_RETRIES = 8;
  let staleRetries = 0;
  // An empty text answer abandons the action. The attempt is still recorded,
  // so the no-progress rule and the classifier's recent_actions can both see
  // it, but the count is bounded as well.
  const MAX_EMPTY_TEXT = 3;
  let emptyText = 0;
  const startedAt = performance.now();
  const since = () => Math.round(performance.now() - startedAt);
  const usage = { input_tokens: 0, output_tokens: 0, text_calls: 0 };

  while (status === "ready") {
    if (decisions.length >= MAX_DECISIONS) {
      status = "blocked";
      reason = `reached the limit of ${MAX_DECISIONS} decisions`;
      break;
    }
    if (!(await fresh(context, observation))) {
      if (process.env.JEV_TRACE_WASTE) console.error("      [waste] pre-decide re-observe");
      observation = await observe(context, { screenshot: options.screenshots });
    }

    const decision = await decide(observation, goal, history);
    decisions.push({ ...decision, elapsedMs: since() });
    usage.input_tokens += decision.usage.input_tokens;
    usage.output_tokens += decision.usage.output_tokens;

    if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
      // A terminal choice is only accepted against the page it was made on.
      if (!(await fresh(context, observation))) {
        if (process.env.JEV_TRACE_WASTE) console.error("      [waste] terminal-not-fresh");
        observation = await observe(context, { screenshot: options.screenshots });
        continue;
      }
      status = decision.operation === "DONE" ? "done" : "blocked";
      reason =
        decision.operation === "DONE"
          ? "the classifier judged the goal met"
          : "the classifier judged the goal unreachable from this page";
      break;
    }

    const action = observation.actions.find(
      (candidate) => candidate.id === decision.choice
    );
    if (!action)
      throw new Error(
        `Decision named an action this observation does not contain: ${decision.choice}`
      );
    if (history.length >= MAX_ACTIONS) {
      status = "blocked";
      reason = `reached the limit of ${MAX_ACTIONS} actions`;
      break;
    }

    let text: string | null = null;
    let textLatencyMs = 0;
    try {
      if (action.kind === "fill") {
        // Re-check before spending money on text for a page that already moved.
        if (!(await fresh(context, observation, action)))
          throw new StalePage("Page moved before text generation");
        const key = textKey(goal, action, observation, history);
        const cached = pendingText.get(key);
        if (cached !== undefined) {
          text = cached.value;
          textLatencyMs = cached.latencyMs;
        } else {
          const generated = await fieldText({
            goal,
            field: {
              label: action.label,
              role: action.role,
              value: action.currentValue ?? action.value,
              // The field's own name is sometimes too local to act on. The
              // dialog around it carries the rest: Google Flights names its
              // origin field "Where else?" inside "Enter your origin".
              group: action.group,
            },
            page: {
              title: observation.title,
              text: observation.text.slice(0, 6000),
            },
            recent_actions: history
              .slice(-6)
              .map((entry) => ({ action: entry.action, text: entry.text })),
          });
          text = generated.value;
          textLatencyMs = generated.latencyMs;
          if (text === "") {
            if (process.env.JEV_TRACE_WASTE) console.error("      [waste] empty-text", action.label);
            emptyText += 1;
            if (emptyText > MAX_EMPTY_TEXT) {
              status = "blocked";
              reason = "the text model gave no value for the chosen field";
              break;
            }
            // Record the attempt. recent_actions is how the classifier learns
            // what already failed, and a path that skips history leaves it
            // choosing the same field for ever: on a real page it chose the
            // same one twenty times at confidence 1.00.
            const barren: HistoryEntry = {
              step: history.length + 1,
              action: action.label,
              kind: action.kind,
              choice: action.id,
              operation: decision.operation,
              target: decision.target,
              confidence: decision.confidence,
              probability: decision.probabilities[action.id] ?? 0,
              text: null,
              latencyMs: decision.latencyMs,
              textLatencyMs,
              pageChanged: false,
              url: observation.url,
              elapsedMs: since(),
              usage: decision.usage,
            };
            history.push(barren);
            options.onStep?.(barren);
            observation = await observe(context, { screenshot: options.screenshots });
            continue;
          }
          usage.text_calls += 1;
          // Survives one stale retry, but only if the entire helper input is unchanged.
          pendingText.set(key, { value: text, latencyMs: textLatencyMs });
        }
      }
      await execute(context, observation, action, {
        text: text ?? undefined,
        uploadDir,
      });
      pendingText.clear();
    } catch (error) {
      if (!(error instanceof StalePage)) throw error;
      if (process.env.JEV_TRACE_WASTE) console.error("      [waste] stale:", String(error).slice(0, 80));
      staleRetries += 1;
      if (staleRetries > MAX_STALE_RETRIES) {
        status = "blocked";
        reason = "the page kept changing under every attempted action";
        break;
      }
      observation = await observe(context, { screenshot: options.screenshots });
      continue;
    }
    staleRetries = 0;

    const before = observation;
    const entry: HistoryEntry = {
      step: history.length + 1,
      action: action.label,
      kind: action.kind,
      choice: action.id,
      operation: decision.operation,
      target: decision.target,
      confidence: decision.confidence,
      probability: decision.probabilities[action.id] ?? 0,
      text,
      latencyMs: decision.latencyMs,
      textLatencyMs,
      pageChanged: null,
      url: before.url,
      elapsedMs: since(),
      usage: decision.usage,
    };
    // Recorded before observing: a stale post-action read must not erase it.
    history.push(entry);

    await settle(activePage(context), action);
    observation = await observe(context, { screenshot: options.screenshots });
    entry.pageChanged = observation.fingerprint !== before.fingerprint;
    entry.url = observation.url;
    entry.elapsedMs = since();
    options.onStep?.(entry);

    const recent = history.slice(-3);
    const stuck =
      recent.length === 3 &&
      recent.every((h) => h.pageChanged === false && h.kind !== "wait");
    if (stuck) reason = "three actions in a row changed nothing on the page";
    status = stuck ? "blocked" : "ready";
  }

  return {
    status: status === "done" ? "done" : "blocked",
    reason,
    goal,
    history,
    decisions,
    elapsedMs: since(),
    canvases: observation.canvases,
    closedShadowHosts: observation.closedShadowHosts,
    frames: observation.frames,
    tabs: observation.tabs,
    usage,
  };
}

function textKey(
  goal: string,
  action: ObservedAction,
  observation: PageObservation,
  history: HistoryEntry[]
) {
  return JSON.stringify([
    goal,
    action.label,
    action.role,
    action.currentValue ?? action.value,
    observation.title,
    observation.text.slice(0, 6000),
    history.slice(-6).map((entry) => [entry.action, entry.text]),
  ]);
}

function activePage(context: BrowserContext): Page {
  // The executor owns which tab is active, since SWITCH_TAB is an action.
  const page = getActivePage(context);
  if (!page) throw new Error("The context has no page");
  return page;
}

export async function runOnce(
  browser: Browser,
  url: string,
  options: RunOptions
) {
  const context = await browser.newContext({
    viewport: { width: 1120, height: 780 },
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return await run(context, options);
  } finally {
    await context.close();
  }
}
