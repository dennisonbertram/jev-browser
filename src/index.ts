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
export { run, runOnce } from "./run.js";
export type { HistoryEntry as RunStep, RunOptions, RunResult } from "./run.js";

// Observation, decision, execution
export { observe, fresh, settle, closedShadowHosts } from "./observe.js";
export { decide, fieldText } from "./decide.js";
export type { FieldTextContext } from "./decide.js";
export { execute, getActivePage } from "./execute.js";
export { actionSpace } from "./actions.js";
export type { ActionSpace, SpaceElement } from "./actions.js";

// The browser, local or remote
export { attachOverCdp, launchLocal } from "./browser.js";
export type {
  AttachOverCdpOptions,
  BrowserSession,
  LaunchLocalOptions,
} from "./browser.js";

// Pictures and coordinates
export { clickInCanvas, screenshotCanvas, screenshotPage } from "./vision.js";
export type { Shot } from "./vision.js";
export { screenshotRedacted, secretRegions } from "./redact.js";
export type { MaskTarget } from "./redact.js";

// Credentials
export { fillCredentials, findCredentialFields } from "./autofill.js";
export type { CredentialSource, FillOutcome } from "./autofill.js";

// Telemetry
export { createTracer } from "./trace.js";
export type { TraceEvent, Tracer } from "./trace.js";

// State across processes
export {
  isSessionState,
  restoreSessionState,
  saveSessionState,
} from "./session-state.js";
export type { SessionState } from "./session-state.js";

// The tool surface a product mounts
export { createToolHost } from "./tools.js";
export type {
  ToolDefinition,
  ToolHost,
  ToolHostOptions,
  ToolResult,
} from "./tools.js";

// A context, or any page inside one: every entry point takes either.
export type { BrowserTarget } from "./target.js";

// Shared types
export { StalePage } from "./types.js";
export type {
  Decision,
  FrameRef,
  FrameSnapshot,
  NodeRef,
  ObservedAction,
  Operation,
  PageObservation,
  Rect,
} from "./types.js";
