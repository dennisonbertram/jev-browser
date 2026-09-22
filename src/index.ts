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
 */

export { runOnce } from "./run.ts";
export type { RunOptions, RunResult } from "./run.ts";

export { observe, fresh, settle } from "./observe.ts";
export { decide, fieldText } from "./decide.ts";
export type { HistoryEntry, FieldTextContext } from "./decide.ts";
export { execute, getActivePage } from "./execute.ts";
export { actionSpace } from "./actions.ts";
export type { ActionSpace, SpaceElement } from "./actions.ts";

export { StalePage } from "./types.ts";
export type {
  Decision,
  FrameRef,
  FrameSnapshot,
  NodeRef,
  ObservedAction,
  Operation,
  PageObservation,
} from "./types.ts";
