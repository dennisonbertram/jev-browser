/**
 * jev-browser: a browser agent that chooses an action from an indexed table of
 * the page's controls instead of generating one.
 *
 * The loop has four parts. `observe` reads every frame of the active tab and
 * returns one numbered table of controls. `decide` asks a classifier for one
 * operation and one target index. `fieldText` writes field text, and runs only
 * when the operation types text. `execute` re-resolves the chosen node and
 * dispatches real input.
 *
 * One rule holds everywhere: a model never returns a selector, a coordinate, a
 * file path, a key name, or code. It returns an index into a table this library
 * observed. The library resolves that index and checks it again before acting.
 *
 * This file is the whole public surface. Keep it complete and ordered.
 */

// The loop
export { run, runOnce } from "./run.ts";
export type { HistoryEntry as RunStep, RunOptions, RunResult } from "./run.ts";

// Observation, decision, execution
export { observe, fresh, settle, closedShadowHosts } from "./observe.ts";
export { decide, fieldText } from "./decide.ts";
export type { FieldTextContext } from "./decide.ts";
export { execute, getActivePage } from "./execute.ts";
export { actionSpace } from "./actions.ts";
export type { ActionSpace, SpaceElement } from "./actions.ts";

// The browser, local or remote
export { attachOverCdp, launchLocal } from "./browser.ts";
export type {
  AttachOverCdpOptions,
  BrowserSession,
  LaunchLocalOptions,
} from "./browser.ts";

// Pictures and coordinates
export { clickInCanvas, screenshotCanvas, screenshotPage } from "./vision.ts";
export type { Shot } from "./vision.ts";
export { screenshotRedacted, secretRegions } from "./redact.ts";
export type { MaskTarget } from "./redact.ts";

// Credentials
export { fillCredentials, findCredentialFields } from "./autofill.ts";
export type { CredentialSource, FillOutcome } from "./autofill.ts";

// Telemetry
export { createTracer } from "./trace.ts";
export type { TraceEvent, Tracer } from "./trace.ts";

// State across processes
export {
  isSessionState,
  restoreSessionState,
  saveSessionState,
} from "./session-state.ts";
export type { SessionState } from "./session-state.ts";

// The tool surface a product mounts
export { createToolHost } from "./tools.ts";
export type {
  ToolDefinition,
  ToolHost,
  ToolHostOptions,
  ToolResult,
} from "./tools.ts";

// A context, or any page inside one: every entry point takes either.
export type { BrowserTarget } from "./target.ts";

// Shared types
export { StalePage } from "./types.ts";
export type {
  Decision,
  FrameRef,
  FrameSnapshot,
  NodeRef,
  ObservedAction,
  Operation,
  PageObservation,
  Rect,
} from "./types.ts";
