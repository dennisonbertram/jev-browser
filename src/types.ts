/**
 * Shared contracts for the Jev PoC. This file is owned by the integrator.
 * Workers must not edit it; if a contract is wrong, report it instead.
 *
 * Invariant that every layer preserves: a model never emits a selector, a
 * coordinate, a file path, a key name or JavaScript. It emits an index into a
 * table of nodes this code observed, and the executor re-resolves that node.
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** A frame in the observed tree. `offset` converts frame-local to top-document coordinates. */
export type FrameRef = {
  frameId: string;
  url: string;
  offset: { x: number; y: number };
  crossOrigin: boolean;
};

/** Identity of an observed element: which frame, and which index in that frame's node registry. */
export type NodeRef = { frameId: string; node: number };

export type Operation =
  | "CLICK"
  | "TYPE_TEXT"
  | "SELECT"
  | "PRESS_KEY"
  | "UPLOAD_FILE"
  | "SCROLL_UP"
  | "SCROLL_DOWN"
  | "SWITCH_TAB"
  | "WAIT"
  | "DONE"
  | "BLOCKED";

type ActionKind =
  | "click"
  | "fill"
  | "select"
  | "press"
  | "upload"
  | "scroll"
  | "switch_tab"
  | "wait";

/** One executable action, always derived by code from an observed node. */
export type ObservedAction = {
  /** Unique within one observation, e.g. "f0:12:click". */
  id: string;
  kind: ActionKind;
  /** Accessible name. Select options append " → <option label>". */
  label: string;
  ref?: NodeRef;
  role?: string;
  value?: string;
  currentValue?: string;
  /** The name of the enclosing dialog or named group, when it adds to the label. */
  group?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  /** Native <select> option value for kind "select". */
  optionValue?: string;
  /** Wheel delta in CSS px for kind "scroll"; negative scrolls up. */
  delta?: number;
  /** Scroll container for kind "scroll"; undefined means the frame's viewport. */
  container?: NodeRef;
  /** Frame-local point to aim a wheel at, for a scroller with no node of its own. */
  point?: { x: number; y: number };
  /** Allowlisted key for kind "press". Never model-supplied text. */
  key?:
    | "Enter"
    | "Escape"
    | "Tab"
    | "ArrowUp"
    | "ArrowDown"
    | "ArrowLeft"
    | "ArrowRight"
    | "Backspace";
  /** Index into PageObservation.tabs for kind "switch_tab". */
  tabIndex?: number;
  /**
   * True when the field holds a secret by its own nature: a password input, or
   * an autocomplete of current-password, new-password or one-time-code. Its
   * value is never copied into the action.
   */
  sensitive?: boolean;
  /** Opaque node-identity + nearby-context hash, re-checked immediately before execution. */
  guard: string;
};

/** What snapshot-dom.js returns for one frame. Coordinates are frame-local. */
export type FrameSnapshot = {
  url: string;
  title: string;
  /** Visible text only, offscreen content excluded, capped by the engine. */
  text: string;
  /** Changes when the document identity changes (URL + DOM shape). */
  pageKey: string;
  /** Cheap whole-frame freshness token. DOM shape and state attributes only. */
  marker: string;
  /**
   * Hash of every observed control's value/checked/selected. Part of the
   * change fingerprint, deliberately NOT part of the marker: typing into a
   * field must register as progress without invalidating node guards.
   */
  valueState: string;
  actions: ObservedAction[];
  /** guard by `${node}` for every registered node. */
  guards: Record<string, string>;
  /** Regions the DOM cannot describe; the loop may escalate these to vision. */
  canvases: { node: number; rect: Rect; label: string }[];
  /** Honest reporting: how many elements were unreachable behind closed shadow roots. */
  closedShadowHosts: number;
  /** Scrollable regions, including the frame viewport (container omitted). */
  scrollers: {
    node?: number;
    rect: Rect;
    label: string;
    canUp: boolean;
    canDown: boolean;
    top: number;
    scrollHeight: number;
  }[];
};

/** One merged observation across every frame and tab. */
export type PageObservation = {
  url: string;
  title: string;
  text: string;
  /** Sorted, stable across frames. Used for staleness checks. */
  fingerprint: string;
  frames: FrameRef[];
  /** Merged, with NodeRef.frameId set and rects in top-document coordinates. */
  actions: ObservedAction[];
  guards: Record<string, string>;
  markers: Record<string, string>;
  canvases: { ref: NodeRef; rect: Rect; label: string }[];
  closedShadowHosts: number;
  /**
   * Index 0 is the active tab. `pageIndex` is the tab's position in the
   * browser context, which is a different order: identifying a tab by URL
   * alone picks the wrong one when two tabs share a URL.
   */
  tabs: {
    index: number;
    pageIndex: number;
    title: string;
    url: string;
    active: boolean;
  }[];
  screenshot?: string;
};

export type Decision = {
  /** ObservedAction.id, or "DONE"/"BLOCKED". */
  choice: string;
  operation: Operation;
  target: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number };
};

/** Thrown when an observation no longer describes the live page. Never a failure of the agent. */
export class StalePage extends Error {
  /**
   * Whether input had already been dispatched when this was thrown.
   *
   * A fill clicks the field and presses select-all before it re-checks the
   * page, so a failure there has already changed it. The caller must not
   * replay such an action from a cached decision; it has to look again.
   */
  readonly afterInput: boolean;

  constructor(message: string, afterInput = false) {
    super(message);
    this.afterInput = afterInput;
  }
}
