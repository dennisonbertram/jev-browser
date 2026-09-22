export type TraceEvent =
  | {
      type: "observe";
      at: number;
      ms: number;
      frames: number;
      actions: number;
      canvases: number;
    }
  | {
      type: "decide";
      at: number;
      ms: number;
      operation: string;
      target: string | null;
      confidence: number;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: "text";
      at: number;
      ms: number;
      field: string;
      characters: number;
    }
  | {
      type: "act";
      at: number;
      ms: number;
      kind: string;
      label: string;
      ok: boolean;
      reason?: string;
    }
  | {
      type: "stop";
      at: number;
      ms: number;
      status: "done" | "blocked" | "error";
      reason?: string;
    };

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

export function createTracer(
  options: {
    sink?: (event: TraceEvent) => void;
    now?: () => number;
  } = {},
): Tracer {
  const recorded: TraceEvent[] = [];

  const emit = (event: TraceEvent): void => {
    const copy = { ...event } as TraceEvent;
    recorded.push(copy);

    try {
      options.sink?.({ ...copy } as TraceEvent);
    } catch {
      // Telemetry failures must not affect the task being observed.
    }
  };

  const events = (): TraceEvent[] =>
    recorded.map((event) => ({ ...event }) as TraceEvent);

  const summary = (): ReturnType<Tracer["summary"]> => {
    let decisions = 0;
    let actions = 0;
    let observations = 0;
    let textCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const decisionTimes: number[] = [];

    for (const event of recorded) {
      switch (event.type) {
        case "observe":
          observations += 1;
          break;
        case "decide":
          decisions += 1;
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          decisionTimes.push(event.ms);
          break;
        case "text":
          textCalls += 1;
          break;
        case "act":
          actions += 1;
          break;
        case "stop":
          break;
      }
    }

    decisionTimes.sort((a, b) => a - b);

    let medianDecisionMs = 0;
    if (decisionTimes.length > 0) {
      const middle = Math.floor(decisionTimes.length / 2);
      const upper = decisionTimes[middle] as number;
      medianDecisionMs =
        decisionTimes.length % 2 === 0
          ? ((decisionTimes[middle - 1] as number) + upper) / 2
          : upper;
    }

    const first = recorded[0];
    const last = recorded[recorded.length - 1];

    return {
      decisions,
      actions,
      observations,
      textCalls,
      inputTokens,
      outputTokens,
      medianDecisionMs,
      totalMs: first && last ? last.at - first.at : 0,
    };
  };

  return { emit, events, summary };
}
