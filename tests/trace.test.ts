import { describe, expect, it } from "vitest";
import { createTracer, type TraceEvent } from "../src/trace";

function decide(at: number, ms: number): TraceEvent {
  return {
    type: "decide",
    at,
    ms,
    operation: "click",
    target: "#submit",
    confidence: 0.9,
    inputTokens: 10,
    outputTokens: 4,
  };
}

describe("createTracer", () => {
  it("returns events in the order they were emitted", () => {
    let time = 1000;
    const now = () => time++;
    const tracer = createTracer({ now });

    const first: TraceEvent = {
      type: "observe",
      at: now(),
      ms: 12,
      frames: 2,
      actions: 1,
      canvases: 0,
    };
    const second = decide(now(), 25);
    const third: TraceEvent = {
      type: "stop",
      at: now(),
      ms: 3,
      status: "done",
    };

    tracer.emit(first);
    tracer.emit(second);
    tracer.emit(third);

    expect(tracer.events()).toEqual([first, second, third]);
  });

  it("counts each event kind and token total across a mixed sequence", () => {
    let time = 2000;
    const now = () => time++;
    const tracer = createTracer({ now });

    tracer.emit({
      type: "observe",
      at: now(),
      ms: 10,
      frames: 1,
      actions: 2,
      canvases: 1,
    });
    tracer.emit({
      type: "decide",
      at: now(),
      ms: 100,
      operation: "fill",
      target: "#name",
      confidence: 0.8,
      inputTokens: 20,
      outputTokens: 7,
    });
    tracer.emit({
      type: "text",
      at: now(),
      ms: 5,
      field: "name",
      characters: 12,
    });
    tracer.emit({
      type: "act",
      at: now(),
      ms: 8,
      kind: "fill",
      label: "name",
      ok: true,
    });
    tracer.emit({
      type: "decide",
      at: now(),
      ms: 200,
      operation: "submit",
      target: null,
      confidence: 0.7,
      inputTokens: 11,
      outputTokens: 3,
    });
    tracer.emit({
      type: "stop",
      at: now(),
      ms: 2,
      status: "done",
    });

    expect(tracer.summary()).toMatchObject({
      decisions: 2,
      actions: 1,
      observations: 1,
      textCalls: 1,
      inputTokens: 31,
      outputTokens: 10,
    });
  });

  it("averages the two middle decision times for an even count", () => {
    let time = 3000;
    const now = () => time++;
    const tracer = createTracer({ now });

    for (const ms of [100, 200, 300, 400]) {
      tracer.emit(decide(now(), ms));
    }

    expect(tracer.summary().medianDecisionMs).toBe(250);
  });

  it("uses the middle decision time for an odd count and zero for none", () => {
    let time = 4000;
    const now = () => time++;
    const tracer = createTracer({ now });

    expect(tracer.summary().medianDecisionMs).toBe(0);

    for (const ms of [100, 200, 300]) {
      tracer.emit(decide(now(), ms));
    }

    expect(tracer.summary().medianDecisionMs).toBe(200);
  });

  it("swallows sink errors while recording the event", () => {
    const tracer = createTracer({
      sink: () => {
        throw new Error("sink failed");
      },
    });
    const event: TraceEvent = {
      type: "stop",
      at: 5000,
      ms: 1,
      status: "error",
      reason: "test",
    };

    expect(() => tracer.emit(event)).not.toThrow();
    expect(tracer.events()).toEqual([event]);
  });

  it("records text character counts without retaining the text", () => {
    const secret = "secret-value";
    const tracer = createTracer();

    tracer.emit({
      type: "text",
      at: 6000,
      ms: 4,
      field: "password",
      characters: secret.length,
    });

    expect(JSON.stringify(tracer.events())).not.toContain(secret);
    expect(tracer.events()[0]).toEqual({
      type: "text",
      at: 6000,
      ms: 4,
      field: "password",
      characters: 12,
    });
  });

  it("calculates total time from the first and last event timestamps", () => {
    let time = 7000;
    const now = () => time;
    const tracer = createTracer({ now });

    tracer.emit({
      type: "observe",
      at: now(),
      ms: 10,
      frames: 0,
      actions: 0,
      canvases: 0,
    });
    tracer.emit({
      type: "stop",
      at: 7350,
      ms: 2,
      status: "blocked",
    });

    expect(tracer.summary().totalMs).toBe(350);
  });
});
