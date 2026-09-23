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
import { contextOf, type BrowserTarget } from "./target.js";
import type { Browser, BrowserContext, Page } from "playwright";
import { actionSpace } from "./actions.js";
import { decide, fieldText } from "./decide.js";
import { execute, getActivePage } from "./execute.js";
import { closedShadowHosts, fresh, observe, settle } from "./observe.js";
import {
  StalePage,
  type Decision,
  type ObservedAction,
  type PageObservation,
} from "./types.js";

const MAX_ACTIONS = 30;
const MAX_DECISIONS = MAX_ACTIONS * 2;
// How long to wait for a page with no controls to render some, before
// deciding it has nothing to act on. A slow single-page app usually needs
// one or two seconds.
const EMPTY_PAGE_WAIT_MS = 5_000;
// How long results that load after an action are waited for, when the run
// has an end condition to check.
const CONDITION_WAIT_MS = 2_000;

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
  /**
   * The longest any single browser call may take before the run gives up
   * with "the browser stopped responding". Default 15 s.
   */
  browserTimeoutMs?: number;
  /**
   * The goal's end condition, checked against the page. When given, the run
   * ends as soon as it holds, and the classifier's DONE is only a claim: it
   * is refused when this says otherwise. Without it, DONE is accepted as
   * before.
   */
  isDone?: (observation: PageObservation) => Promise<boolean>;
  /**
   * Stops the run. No new model call, observation or action starts after it
   * aborts, and a model request in flight is abandoned; a browser action
   * already dispatched finishes first. The run returns "the run was
   * cancelled".
   */
  signal?: AbortSignal;
  /** Epoch milliseconds after which the run stops with "the time budget ran out". */
  deadlineAt?: number;
};

/**
 * Run a whole task against a context you already have: observe, decide, write
 * text when the operation needs it, execute, and repeat until the classifier
 * stops or a bound trips.
 *
 * Use this when your product owns the browser. `runOnce` is the same loop with
 * a context of its own.
 */
const BROWSER_TIMEOUT_MS = 15_000;

class BrowserTimeout extends Error {}

/**
 * A browser call that does not return in time.
 *
 * A page whose main thread never yields, or a navigation that never commits,
 * leaves every later Playwright call waiting with no deadline of its own. On
 * Kernel this held a run for eight minutes on two real sites. The abandoned
 * call is left to fail when the caller disconnects; its rejection is caught
 * here so it cannot surface as an unhandled one.
 */
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Whether the run is repeating itself without getting anywhere.
 *
 * The no-progress rule only catches actions that change nothing. A control
 * that toggles, or two tabs switched between, change the page every time and
 * slipped past it: on real sites a date picker was opened and shut 30 times,
 * and two tabs were switched between for 30 actions. Scrolling, waiting and
 * key presses legitimately repeat, so they are exempt.
 */
function oscillating(history: HistoryEntry[]): boolean {
  const repeats = (entry: HistoryEntry) =>
    entry.kind === "scroll" || entry.kind === "wait" || entry.kind === "press";
  const same = (a: HistoryEntry, b: HistoryEntry) =>
    a.kind === b.kind && a.action === b.action;

  const four = history.slice(-4);
  if (
    four.length === 4 &&
    !four.some(repeats) &&
    four.every((entry) => same(entry, four[0]!))
  )
    return true;

  const six = history.slice(-6);
  if (six.length === 6 && !six.some(repeats) && !same(six[0]!, six[1]!))
    return six.every((entry, i) => same(entry, six[i % 2]!));
  return false;
}

/** Whether the page offers any control, not counting the always-present WAIT. */
function offersSomething(observation: PageObservation): boolean {
  return observation.actions.some((action) => action.kind !== "wait");
}

export async function run(
  target: BrowserTarget,
  options: RunOptions,
): Promise<RunResult> {
  const context = contextOf(target);
  const goal = options.goal.trim();
  if (!goal) throw new Error("Supply a goal");
  const uploadDir = options.uploadDir;
  // Fail before the first model call rather than at the one action that needs it.
  if (uploadDir !== undefined) readdirSync(uploadDir);

  const history: HistoryEntry[] = [];
  const decisions: (Decision & { elapsedMs: number })[] = [];
  const limit = options.browserTimeoutMs ?? BROWSER_TIMEOUT_MS;
  const look = () =>
    bounded(
      observe(context, { screenshot: options.screenshots, diagnostics: false }),
      limit,
    );
  const stillFresh = (seen: PageObservation, action?: ObservedAction) =>
    bounded(fresh(context, seen, action), limit);
  // A met condition counts only if the page it was checked on is still the
  // page: the check is a model call, and the page can move while it runs.
  const holds = async (seen: PageObservation) =>
    options.isDone !== undefined &&
    (await options.isDone(seen)) &&
    (await stillFresh(seen));
  let observation: PageObservation | undefined;
  let status: "ready" | "done" | "blocked" = "ready";
  let reason = "the loop ended without a stated reason";
  // Answers already given in this run. A discarded decision is often
  // re-asked with a byte-identical request once the page settles back.
  const answers = new Map<string, Decision>();
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

  let hung = false;
  let checkedFingerprint: string | undefined;
  let conditionMet = false;
  let refusedClaims = 0;
  // One signal for everything that should stop: the caller's cancellation or
  // the time budget. It is handed to every model request.
  const stop = new AbortController();
  const onCancel = () => stop.abort(new Error("cancelled"));
  if (options.signal?.aborted) onCancel();
  options.signal?.addEventListener("abort", onCancel, { once: true });
  const budgetTimer =
    options.deadlineAt === undefined
      ? undefined
      : setTimeout(
          () => stop.abort(new Error("time budget")),
          Math.max(0, options.deadlineAt - Date.now()),
        );
  const stopReason = () =>
    options.signal?.aborted
      ? "the run was cancelled"
      : "the time budget ran out";
  let idleWaits = 0;
  try {
    observation = await look();
    while (status === "ready") {
      if (stop.signal.aborted) {
        status = "blocked";
        reason = stopReason();
        break;
      }
      if (decisions.length >= MAX_DECISIONS) {
        status = "blocked";
        reason = `reached the limit of ${MAX_DECISIONS} decisions`;
        break;
      }
      if (!(await stillFresh(observation))) {
        observation = await look();
      }

      // The end condition is checked on every new page state, so the run
      // stops the moment it holds rather than when the classifier notices. It
      // comes before the empty-page rule: a finished page often has nothing
      // left to act on.
      if (options.isDone && checkedFingerprint !== observation.fingerprint) {
        checkedFingerprint = observation.fingerprint;
        if (await holds(observation)) {
          status = "done";
          reason = "the end condition is met";
          break;
        }
      }

      // A page with no controls gets no classifier call: asked about an
      // empty table, the classifier answered BLOCKED in 0.3 s on three real
      // sites that were still loading.
      const waitUntil = performance.now() + EMPTY_PAGE_WAIT_MS;
      while (!offersSomething(observation) && performance.now() < waitUntil) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        observation = await look();
      }
      if (!offersSomething(observation)) {
        status = "blocked";
        reason = "the page has nothing to act on";
        break;
      }

      const decision = await decide(
        observation,
        goal,
        history,
        answers,
        stop.signal,
      );
      decisions.push({ ...decision, elapsedMs: since() });
      usage.input_tokens += decision.usage.input_tokens;
      usage.output_tokens += decision.usage.output_tokens;

      if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
        // A terminal choice is only accepted against the page it was made on.
        if (!(await stillFresh(observation))) {
          observation = await look();
          continue;
        }
        // DONE is a claim. With an end condition to check, a claim the page
        // does not support is refused and recorded, so the classifier sees
        // that it was wrong; a second refusal ends the run. On Peek, the
        // classifier declared done with the calendar still open and no start
        // times on the page.
        if (decision.operation === "DONE" && options.isDone) {
          // A claim gets a fresh check. The one before this decision may have
          // run while the page was still settling, and a purely visual change
          // leaves the fingerprint as it was, so nothing else re-checks it.
          if (await holds(observation)) {
            status = "done";
            reason = "the end condition is met";
            break;
          }
          refusedClaims += 1;
          if (refusedClaims >= 2) {
            status = "blocked";
            reason =
              "the classifier claimed done, but the end condition is not met";
            break;
          }
          const refusal: HistoryEntry = {
            step: history.length + 1,
            action: "Declared the goal done, but the page does not show it yet",
            kind: "wait",
            choice: decision.choice,
            operation: decision.operation,
            target: decision.target,
            confidence: decision.confidence,
            probability: 0,
            text: null,
            latencyMs: decision.latencyMs,
            textLatencyMs: 0,
            pageChanged: false,
            url: observation.url,
            elapsedMs: since(),
            usage: decision.usage,
          };
          history.push(refusal);
          options.onStep?.(refusal);
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
        (candidate) => candidate.id === decision.choice,
      );
      if (!action)
        throw new Error(
          `Decision named an action this observation does not contain: ${decision.choice}`,
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
          if (!(await stillFresh(observation, action)))
            throw new StalePage("Page moved before text generation");
          const key = textKey(goal, action, observation, history);
          const cached = pendingText.get(key);
          if (cached !== undefined) {
            text = cached.value;
            textLatencyMs = cached.latencyMs;
          } else {
            const generated = await fieldText(
              {
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
              },
              stop.signal,
            );
            text = generated.value;
            textLatencyMs = generated.latencyMs;
            if (text === "") {
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
              observation = await look();
              continue;
            }
            usage.text_calls += 1;
            // Survives one stale retry, but only if the entire helper input is unchanged.
            pendingText.set(key, { value: text, latencyMs: textLatencyMs });
          }
        }
        await bounded(
          execute(context, observation, action, {
            text: text ?? undefined,
            uploadDir,
          }),
          limit,
        );
        pendingText.clear();
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        staleRetries += 1;
        if (staleRetries > MAX_STALE_RETRIES) {
          status = "blocked";
          reason = "the page kept changing under every attempted action";
          break;
        }
        // Input the page interrupted is recorded, not lost. A fill that had
        // already clicked the field and selected its text when the page
        // changed has touched the page; the classifier needs to see that,
        // and the field may now hold something other than what it chose.
        if (error.afterInput) {
          const interrupted: HistoryEntry = {
            step: history.length + 1,
            action: `Interrupted while entering text into ${action.label}: the page changed before typing`,
            kind: action.kind,
            choice: action.id,
            operation: decision.operation,
            target: decision.target,
            confidence: decision.confidence,
            probability: decision.probabilities[action.id] ?? 0,
            text: null,
            latencyMs: decision.latencyMs,
            textLatencyMs,
            pageChanged: true,
            url: observation.url,
            elapsedMs: since(),
            usage: decision.usage,
          };
          history.push(interrupted);
          options.onStep?.(interrupted);
        }
        observation = await look();
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

      await bounded(
        settle(
          activePage(context),
          action,
          action.ref ? before.markers[action.ref.frameId] : undefined,
        ),
        limit,
      );
      observation = await look();
      entry.pageChanged = observation.fingerprint !== before.fingerprint;

      // Results that load after the action. Peek fetches a date's start
      // times over the network once the date is clicked; the end condition
      // was checked before they arrived, and the next action reopened the
      // calendar over them. Waiting for the page to go quiet does not help:
      // it is often quiet right up to the moment the results land. So the
      // end condition gets a short, fixed window, re-checked each time the
      // page changes.
      // ponytail: a fixed window costs up to CONDITION_WAIT_MS on steps that
      // do not finish the subgoal; a network-idle signal would be tighter.
      if (options.isDone) {
        const until = performance.now() + CONDITION_WAIT_MS;
        let met = await holds(observation);
        checkedFingerprint = observation.fingerprint;
        while (!met && performance.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          observation = await look();
          if (observation.fingerprint === checkedFingerprint) continue;
          checkedFingerprint = observation.fingerprint;
          met = await holds(observation);
        }
        if (met) conditionMet = true;
        // Changes that landed during the window are progress too.
        entry.pageChanged = observation.fingerprint !== before.fingerprint;
      }
      entry.url = observation.url;
      entry.elapsedMs = since();
      options.onStep?.(entry);

      if (conditionMet) {
        status = "done";
        reason = "the end condition is met";
        break;
      }

      // Waiting is exempt from the no-progress rule, so it needs its own
      // bound: on Peek it waited 18 times over two minutes.
      if (action.kind === "wait")
        idleWaits = entry.pageChanged ? 0 : idleWaits + 1;
      else idleWaits = 0;
      if (idleWaits >= 3) {
        status = "blocked";
        reason = "it waited three times and the page did not change";
        break;
      }

      const recent = history.slice(-3);
      const stuck =
        recent.length === 3 &&
        recent.every((h) => h.pageChanged === false && h.kind !== "wait");
      if (stuck) reason = "three actions in a row changed nothing on the page";
      status = stuck ? "blocked" : "ready";
      if (!stuck && oscillating(history)) {
        status = "blocked";
        reason = "the run went back and forth without progress";
      }
    }
  } catch (error) {
    if (stop.signal.aborted) {
      status = "blocked";
      reason = stopReason();
    } else {
      if (!(error instanceof BrowserTimeout)) throw error;
      hung = true;
      status = "blocked";
      reason = "the browser stopped responding";
    }
  } finally {
    clearTimeout(budgetTimer);
    options.signal?.removeEventListener("abort", onCancel);
  }

  return {
    status: status === "done" ? "done" : "blocked",
    reason,
    goal,
    history,
    decisions,
    elapsedMs: since(),
    canvases: observation?.canvases ?? [],
    // Counted once here, not on every observation of the loop. A browser that
    // has stopped responding would only make this wait again.
    closedShadowHosts: hung
      ? 0
      : await bounded(closedShadowHosts(context), limit).catch(() => 0),
    frames: observation?.frames ?? [],
    tabs: observation?.tabs ?? [],
    usage,
  };
}

function textKey(
  goal: string,
  action: ObservedAction,
  observation: PageObservation,
  history: HistoryEntry[],
) {
  return JSON.stringify([
    goal,
    action.label,
    action.role,
    action.currentValue ?? action.value,
    action.group,
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
  options: RunOptions,
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
