/**
 * The tool surface an agent framework mounts.
 *
 * Every tool goes through this library's own engine: `observe` reads every
 * frame of the active tab, `actionSpace` numbers the controls, and `execute`
 * re-resolves and re-validates a node before it sends input. A tool must never
 * reach the page another way, or it loses shadow DOM, iframes, nested scroll
 * containers, accessible names and canvas reporting.
 *
 * The library's rule holds at this boundary, which is where a caller could most
 * easily break it: an index into the observed table is the only way to name an
 * element. No tool accepts a selector, an XPath, a coordinate, or code.
 */
import type { BrowserContext } from "playwright";
import { actionSpace, type ActionSpace } from "./actions.js";
import { contextOf, type BrowserTarget } from "./target.js";
import { fillCredentials, type CredentialSource } from "./autofill.js";
import { execute, getActivePage } from "./execute.js";
import { observe } from "./observe.js";
import { screenshotRedacted, secretRegions } from "./redact.js";
import type { Tracer } from "./trace.js";
import type { ObservedAction, Operation, PageObservation } from "./types.js";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolResult = {
  text: string;
  ok: boolean;
  /** PNG bytes, for a tool that returns a picture. */
  image?: Buffer;
};

export type ToolHost = {
  definitions: () => ToolDefinition[];
  call: (name: string, args: unknown) => Promise<ToolResult>;
};

export type ToolHostOptions = {
  /** A context, or any page inside one. */
  context: BrowserTarget;
  credentials?: CredentialSource;
  tracer?: Tracer;
  uploadDir?: string;
};

/** A page can hold more text than a model should ever receive. */
const MAX_OBSERVATION_CHARACTERS = 12_000;

const NO_ARGS = { type: "object", additionalProperties: false, properties: {} };

const DEFINITIONS: ToolDefinition[] = [
  {
    name: "browser_observe",
    description:
      "Return the numbered table of the controls on the page. Call this before any tool that takes an index. The text is capped at 12000 characters.",
    parameters: NO_ARGS,
  },
  {
    name: "browser_act",
    description:
      "Click the control at an index from the latest observation, or choose a native select option with option_index.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["index"],
      properties: {
        index: { type: "integer", minimum: 1 },
        option_index: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    name: "browser_type",
    description: "Type text into the field at an index from the latest observation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["index", "text"],
      properties: {
        index: { type: "integer", minimum: 1 },
        text: { type: "string", maxLength: 2000 },
      },
    },
  },
  {
    name: "browser_login",
    description:
      "Fill the credential fields on the page from the configured source. Reports which kinds were filled, never a value.",
    parameters: NO_ARGS,
  },
  {
    name: "browser_screenshot",
    description:
      "Return a picture of the page with the regions that hold secrets covered. Redaction cannot be disabled.",
    parameters: NO_ARGS,
  },
  {
    name: "browser_scroll",
    description:
      "Scroll one region. Give the index of a scroll entry from the latest observation and a direction.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["index", "direction"],
      properties: {
        index: { type: "integer", minimum: 1 },
        direction: { type: "string", enum: ["up", "down"] },
      },
    },
  },
  {
    name: "browser_switch_tab",
    description: "Make another open tab active. Give its index from the latest observation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["index"],
      properties: { index: { type: "integer", minimum: 1 } },
    },
  },
];

const ok = (text: string): ToolResult => ({ ok: true, text });
const no = (text: string): ToolResult => ({ ok: false, text });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Arguments must match the schema exactly: an extra key is a refusal. */
function checkArgs(
  definition: ToolDefinition,
  args: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; why: string } {
  const value = args === undefined || args === null ? {} : args;
  if (!isObject(value)) return { ok: false, why: "arguments must be an object" };
  const schema = definition.parameters as {
    properties?: Record<string, { type?: string; enum?: string[]; minimum?: number; maxLength?: number }>;
    required?: string[];
  };
  const allowed = Object.keys(schema.properties ?? {});
  for (const key of Object.keys(value)) {
    // A selector, an xpath or a coordinate would arrive as an unexpected key.
    if (!allowed.includes(key)) return { ok: false, why: `unexpected argument "${key}"` };
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) return { ok: false, why: `missing argument "${key}"` };
  }
  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (!(key in value)) continue;
    const given = value[key];
    if (rule.type === "integer" && (!Number.isInteger(given) || Object.is(given, -0))) {
      return { ok: false, why: `"${key}" must be an integer` };
    }
    if (rule.type === "integer" && typeof rule.minimum === "number" && (given as number) < rule.minimum) {
      return { ok: false, why: `"${key}" must be at least ${rule.minimum}` };
    }
    if (rule.type === "string" && typeof given !== "string") {
      return { ok: false, why: `"${key}" must be a string` };
    }
    if (rule.enum && !rule.enum.includes(given as string)) {
      return { ok: false, why: `"${key}" must be one of ${rule.enum.join(", ")}` };
    }
    if (typeof rule.maxLength === "number" && typeof given === "string" && given.length > rule.maxLength) {
      return { ok: false, why: `"${key}" is longer than ${rule.maxLength} characters` };
    }
  }
  return { ok: true, value };
}

/** The numbered table a model reads, built from the observed accessible names. */
function renderTable(space: ActionSpace, observation: PageObservation): string {
  const lines: string[] = [];
  for (const element of space.elements) {
    const isSelect = element.operations.includes("SELECT");
    // A select's own label carries the first option after an arrow; the field
    // is the part before it, and "option" is the option's role, not the field's.
    const label = isSelect ? (element.label.split(" → ")[0] ?? element.label) : element.label;
    const role = isSelect && element.role === "option" ? "combobox" : element.role;
    const parts = [`[${element.index}]`, role ?? "", label];
    const value = element.currentValue ?? element.value;
    if (value) parts.push(`· ${value}`);
    parts.push(`(${element.operations.join(", ")})`);
    lines.push(parts.filter(Boolean).join(" "));
    for (const option of element.options ?? []) {
      const optionLabel = option.label.split(" → ").at(-1) ?? option.label;
      lines.push(`    [${option.index}] option ${optionLabel}`);
    }
  }
  const tabs = observation.tabs
    .map((tab) => `[tab ${tab.index + 1}] ${tab.title || tab.url}${tab.active ? " (active)" : ""}`)
    .join("\n");
  const canvases = observation.canvases.length
    ? `\n${observation.canvases.length} canvas region(s) carry no DOM node; a picture is needed to read them.`
    : "";
  const text = `${lines.join("\n")}\n\n${tabs}${canvases}`;
  return text.length > MAX_OBSERVATION_CHARACTERS
    ? `${text.slice(0, MAX_OBSERVATION_CHARACTERS)}\n[truncated]`
    : text;
}

export function createToolHost(rawOptions: ToolHostOptions): ToolHost {
  const options = { ...rawOptions, context: contextOf(rawOptions.context) };
  // The latest observation. An index means nothing without it.
  let observation: PageObservation | null = null;
  let space: ActionSpace | null = null;

  const needObservation = () =>
    observation && space ? null : no("Call browser_observe before using an index.");

  /** Find the action for an index, for one operation. */
  const actionFor = (index: number, wanted: Operation[]): ObservedAction | null => {
    if (!space) return null;
    for (const operation of wanted) {
      const candidates = space.targets[operation];
      const found = candidates?.[String(index)];
      if (found) return found;
    }
    return null;
  };

  const refresh = async (): Promise<ToolResult> => {
    const next = await observe(options.context);
    observation = next;
    space = actionSpace(next.actions);
    options.tracer?.emit({
      type: "observe",
      at: Date.now(),
      ms: 0,
      frames: next.frames.length,
      actions: next.actions.length,
      canvases: next.canvases.length,
    });
    return ok(renderTable(space, next));
  };

  const call = async (name: string, args: unknown): Promise<ToolResult> => {
    const definition = DEFINITIONS.find((entry) => entry.name === name);
    if (!definition) return no(`Unknown tool "${name}".`);
    const checked = checkArgs(definition, args);
    if (!checked.ok) return no(`Invalid arguments: ${checked.why}`);
    const input = checked.value;

    try {
      switch (name) {
        case "browser_observe":
          return await refresh();

        case "browser_act": {
          const missing = needObservation();
          if (missing) return missing;
          const index = input.index as number;
          const optionIndex = input.option_index as number | undefined;
          const key = optionIndex === undefined ? String(index) : `${index}:${optionIndex}`;
          const action =
            space?.targets.SELECT?.[key] ??
            actionFor(index, ["CLICK", "UPLOAD_FILE", "PRESS_KEY"]);
          if (!action) {
            const selectable = space?.elements.find(
              (element) => element.index === String(index) && element.operations.includes("SELECT")
            );
            if (selectable) {
              return no(
                `Index ${index} is a select. Give option_index as well, for example one of: ${(selectable.options ?? [])
                  .map((option) => option.index)
                  .join(", ")}.`
              );
            }
            return no(`No control has index ${index} in the latest observation.`);
          }
          const startedAct = Date.now();
          await execute(options.context, observation!, action, { uploadDir: options.uploadDir });
          options.tracer?.emit({
            type: "act",
            at: startedAct,
            ms: Date.now() - startedAct,
            kind: action.kind,
            label: action.label,
            ok: true,
          });
          return ok(`Did ${action.kind} on ${action.label}.`);
        }

        case "browser_type": {
          const missing = needObservation();
          if (missing) return missing;
          const index = input.index as number;
          const text = input.text as string;
          // A newline or a tab becomes Enter or Tab when typed, which submits a
          // form or moves focus. Text is a field value here, never a key.
          if (/[\u0000-\u001f\u007f]/u.test(text)) {
            return no("Text may not contain a control character. Use browser_act for a key.");
          }
          const action = actionFor(index, ["TYPE_TEXT"]);
          if (!action) return no(`No text field has index ${index} in the latest observation.`);
          const startedType = Date.now();
          await execute(options.context, observation!, action, { text });
          options.tracer?.emit({
            type: "text",
            at: startedType,
            ms: Date.now() - startedType,
            field: action.label,
            characters: text.length,
          });
          return ok(`Typed into ${action.label}.`);
        }

        case "browser_login": {
          const missing = needObservation();
          if (missing) return missing;
          if (!options.credentials) return no("No credential source is configured.");
          const outcome = await fillCredentials(options.context, observation!, options.credentials);
          // Kinds only. A value never leaves the library.
          return ok(
            `Filled: ${outcome.filled.join(", ") || "nothing"}. Missing: ${outcome.missing.join(", ") || "nothing"}.`
          );
        }

        case "browser_screenshot": {
          const missing = needObservation();
          if (missing) return missing;
          const page = getActivePage(options.context);
          if (!page) return no("There is no active page.");
          const regions = secretRegions(observation!);
          const shot = await screenshotRedacted(page, observation!, regions);
          return {
            ok: true,
            text: `Picture of ${shot.rect.width}x${shot.rect.height} at scale ${shot.scale}. ${regions.length} secret region(s) covered.`,
            image: shot.image,
          };
        }

        case "browser_scroll": {
          const missing = needObservation();
          if (missing) return missing;
          const index = input.index as number;
          const direction = input.direction as "up" | "down";
          const operation: Operation = direction === "up" ? "SCROLL_UP" : "SCROLL_DOWN";
          const action = space?.targets[operation]?.[String(index)] ?? space?.controls[operation];
          if (!action) return no(`No scroll region has index ${index} for ${direction}.`);
          await execute(options.context, observation!, action, {});
          return ok(`Scrolled ${direction} in ${action.label}.`);
        }

        case "browser_switch_tab": {
          const missing = needObservation();
          if (missing) return missing;
          const index = input.index as number;
          const action = space?.targets.SWITCH_TAB?.[String(index)];
          if (!action) return no(`No tab has index ${index} in the latest observation.`);
          await execute(options.context, observation!, action, {});
          return ok(`Switched to ${action.label}.`);
        }

        default:
          return no(`Unknown tool "${name}".`);
      }
    } catch (error) {
      // A tool reports a refusal. It does not throw into the agent's loop.
      return no(`${name} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  return { definitions: () => DEFINITIONS.map((d) => ({ ...d })), call };
}
