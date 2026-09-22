# S5: Telemetry

Read `docs/specs/CONVENTIONS.md` first.

## Purpose

An operator must be able to answer three questions after a task: what did the
agent do, how long did each step take, and why did it stop. The library emits
one structured event for each decision and each action. A secret never appears
in an event.

## Files you may create or change

- `src/trace.ts` (new)
- `tests/trace.test.ts` (new)

Do not change `src/index.ts`; the integrator adds the exports. Change no other
file.

## The contract

```ts
export type TraceEvent =
  | { type: "observe"; at: number; ms: number; frames: number; actions: number; canvases: number }
  | { type: "decide"; at: number; ms: number; operation: string; target: string | null; confidence: number; inputTokens: number; outputTokens: number }
  | { type: "text"; at: number; ms: number; field: string; characters: number }
  | { type: "act"; at: number; ms: number; kind: string; label: string; ok: boolean; reason?: string }
  | { type: "stop"; at: number; ms: number; status: "done" | "blocked" | "error"; reason?: string };

export type Tracer = {
  /** Record an event. Never throws, whatever the sink does. */
  emit: (event: TraceEvent) => void;
  /** Every event so far, in order. */
  events: () => TraceEvent[];
  /** Totals for a finished run. */
  summary: () => {
    decisions: number;
    actions: number;
    observations: number;
    textCalls: number;
    inputTokens: number;
    outputTokens: number;
    /** Median decision time in ms, 0 when there is none. */
    medianDecisionMs: number;
    totalMs: number;
  };
};

export function createTracer(options?: {
  /** Called for each event. An error here must not reach the caller. */
  sink?: (event: TraceEvent) => void;
  /** Wall-clock source, for tests. Defaults to Date.now. */
  now?: () => number;
}): Tracer;
```

## Rules

1. A `text` event records the **number of characters**, never the text. A field
   value can be a secret.
2. `emit` never throws. If the sink throws, swallow it. Telemetry must not break
   a task.
3. `medianDecisionMs` averages the two middle values for an even count. A median
   that takes the lower middle value understates the time.
4. Events keep their order. `at` is the wall-clock time, `ms` is the duration of
   that step.
5. The tracer holds no reference to a page, a browser, or an observation, so it
   cannot retain a whole DOM snapshot in memory.

## The tests you must write, and they must pass

In `tests/trace.test.ts`, with an injected `now` so times are exact:

1. Events come back in the order they were emitted.
2. `summary` counts each kind correctly across a mixed sequence.
3. `medianDecisionMs` with decision times 100, 200, 300, 400 is 250, which
   proves the even case averages.
4. `medianDecisionMs` with 100, 200, 300 is 200, and with none is 0.
5. A sink that throws does not make `emit` throw, and the event is still
   recorded.
6. A `text` event carries no text: build one for a field with a 12-character
   value and assert the serialised event does not contain that value.
7. `totalMs` is the last `at` minus the first `at`.

No browser is needed for this suite. Keep it pure and fast.

## Verification

```sh
npx vitest run tests/trace.test.ts
npx tsc --noEmit
```

Both must pass. Write the tests first.
