/**
 * The indexed action space: turns a flat ObservedAction[] into the numbered
 * table a model is allowed to see (elements), the per-operation candidate
 * sets for the speculative target heads (targets), and the no-target
 * operations (controls). Pure, deterministic, no I/O.
 */
import type {
  NodeRef,
  ObservedAction,
  Operation,
  PageObservation,
} from "./types.js";

type SpaceOption = {
  index: string;
  label: string;
  value?: string;
  selected?: boolean;
};

export type SpaceElement = {
  index: string;
  label: string;
  role?: string;
  value?: string;
  currentValue?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  operations: Operation[];
  /** Native <select> options, present only when SELECT is one of `operations`. */
  options?: SpaceOption[];
};

export type ActionSpace = {
  elements: SpaceElement[];
  targets: Partial<Record<Operation, Record<string, ObservedAction>>>;
  controls: Partial<Record<Operation, ObservedAction>>;
};

const KIND_TO_OP: Partial<Record<ObservedAction["kind"], Operation>> = {
  click: "CLICK",
  fill: "TYPE_TEXT",
  select: "SELECT",
  press: "PRESS_KEY",
  upload: "UPLOAD_FILE",
};

function nodeKey(ref: NodeRef): string {
  return `${ref.frameId}#${ref.node}`;
}

type NodeEntry = {
  label: string;
  role?: string;
  value?: string;
  currentValue?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  opsOrder: Operation[];
  byOp: Map<Operation, ObservedAction[]>;
};

type ScrollGroup = { up?: ObservedAction; down?: ObservedAction };

/**
 * The numbered table for an observation.
 *
 * Takes the observation itself or just its actions. The action array alone was
 * the only accepted form, and callers kept passing the observation.
 */
export function actionSpace(
  source: PageObservation | ObservedAction[]
): ActionSpace {
  const actions = Array.isArray(source) ? source : source.actions;
  const nodeOrder: string[] = [];
  const nodes = new Map<string, NodeEntry>();
  const scrollOrder: string[] = [];
  const scrollers = new Map<string, ScrollGroup>();
  const switchTabActions: ObservedAction[] = [];
  let waitAction: ObservedAction | undefined;

  for (const action of actions) {
    const op = KIND_TO_OP[action.kind];
    if (op && action.ref) {
      const key = nodeKey(action.ref);
      let entry = nodes.get(key);
      if (!entry) {
        entry = {
          label: action.label,
          role: action.role,
          opsOrder: [],
          byOp: new Map(),
        };
        nodes.set(key, entry);
        nodeOrder.push(key);
      }
      if (entry.value === undefined && action.value !== undefined)
        entry.value = action.value;
      if (entry.currentValue === undefined && action.currentValue !== undefined)
        entry.currentValue = action.currentValue;
      if (entry.checked === undefined && action.checked !== undefined)
        entry.checked = action.checked;
      if (entry.selected === undefined && action.selected !== undefined)
        entry.selected = action.selected;
      if (entry.expanded === undefined && action.expanded !== undefined)
        entry.expanded = action.expanded;
      if (!entry.opsOrder.includes(op)) entry.opsOrder.push(op);
      const list = entry.byOp.get(op);
      if (list) list.push(action);
      else entry.byOp.set(op, [action]);
      continue;
    }
    if (action.kind === "scroll") {
      // The frame has to be in the key: every frame has a viewport, and a
      // shared key silently dropped one frame's scroll for another's.
      const key = action.container
        ? nodeKey(action.container)
        : `${action.ref?.frameId ?? "?"}:__viewport__`;
      let group = scrollers.get(key);
      if (!group) {
        group = {};
        scrollers.set(key, group);
        scrollOrder.push(key);
      }
      if ((action.delta ?? 0) < 0) group.up = action;
      else group.down = action;
      continue;
    }
    if (action.kind === "switch_tab") {
      switchTabActions.push(action);
      continue;
    }
    if (action.kind === "wait") {
      if (!waitAction) waitAction = action;
      continue;
    }
    // kind without a usable ref (click/fill/select/press/upload missing `ref`) is unreachable: skip.
  }

  const elements: SpaceElement[] = [];
  const targets: ActionSpace["targets"] = {};

  nodeOrder.forEach((key, i) => {
    const entry = nodes.get(key)!;
    const index = String(i + 1);
    const element: SpaceElement = {
      index,
      label: entry.label,
      role: entry.role,
      value: entry.value,
      currentValue: entry.currentValue,
      checked: entry.checked,
      selected: entry.selected,
      expanded: entry.expanded,
      operations: entry.opsOrder,
    };

    for (const op of entry.opsOrder) {
      const acts = entry.byOp.get(op)!;
      const targetMap = targets[op] ?? (targets[op] = {});
      if (op === "SELECT") {
        element.options = acts.map((act, n) => {
          const targetIndex = `${index}:${n + 1}`;
          targetMap[targetIndex] = act;
          return {
            index: targetIndex,
            label: act.label,
            value: act.optionValue,
            selected: act.selected,
          };
        });
        continue;
      }
      if (acts.length === 1) {
        targetMap[index] = acts[0]!;
      } else {
        acts.forEach((act, n) => {
          targetMap[`${index}:${n + 1}`] = act;
        });
      }
    }

    elements.push(element);
  });

  if (switchTabActions.length > 0) {
    const targetMap: Record<string, ObservedAction> = {};
    switchTabActions.forEach((act, i) => {
      targetMap[String(i + 1)] = act;
    });
    targets.SWITCH_TAB = targetMap;
  }

  const controls: ActionSpace["controls"] = {};
  if (waitAction) controls.WAIT = waitAction;

  if (scrollOrder.length <= 1) {
    const group =
      scrollOrder.length === 1 ? scrollers.get(scrollOrder[0]!)! : undefined;
    if (group?.up) controls.SCROLL_UP = group.up;
    if (group?.down) controls.SCROLL_DOWN = group.down;
  } else {
    // Nested-scrolling fix: more than one scroller means SCROLL_UP/DOWN need
    // their own target head over the scrollers instead of one global control.
    const up: Record<string, ObservedAction> = {};
    const down: Record<string, ObservedAction> = {};
    scrollOrder.forEach((key, i) => {
      const group = scrollers.get(key)!;
      const targetIndex = String(i + 1);
      if (group.up) up[targetIndex] = group.up;
      if (group.down) down[targetIndex] = group.down;
    });
    if (Object.keys(up).length > 0) targets.SCROLL_UP = up;
    if (Object.keys(down).length > 0) targets.SCROLL_DOWN = down;
  }

  return { elements, targets, controls };
}
