import { contextOf, type BrowserTarget } from "./target.ts";
import type { BrowserContext } from "playwright";
import { execute } from "./execute.ts";
import type { NodeRef, PageObservation } from "./types.ts";

export type CredentialSource = {
  get: (
    kind: "username" | "password" | "otp",
    origin: string,
  ) => Promise<string | null>;
};

export type FillOutcome = {
  filled: ("username" | "password" | "otp")[];
  missing: ("username" | "password" | "otp")[];
  targets: NodeRef[];
};

type CredentialKind = "username" | "password" | "otp";
type UnknownRecord = Record<string, unknown>;

type FieldInfo = {
  type: string;
  autocomplete: string;
  name: string;
  elementId: string;
  origin: string;
};

type ActionEntry = {
  action: UnknownRecord;
  ref: NodeRef;
  index: number | null;
};

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : {};
}

function actionRef(action: unknown): NodeRef | null {
  const ref = record(action).ref;

  return ref !== null && typeof ref === "object" ? (ref as NodeRef) : null;
}

function isObservedAction(value: unknown): boolean {
  const item = record(value);
  return actionRef(item) !== null && typeof item.kind === "string";
}


function isFillAction(value: unknown): boolean {
  return record(value).kind === "fill" && actionRef(value) !== null;
}

async function frameFor(
  context: BrowserContext,
  frameId: string,
): Promise<{ frame: import("playwright").Frame } | null> {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;

    for (const frame of page.frames()) {
      const id = await frame
        .evaluate(
          () =>
            (window as unknown as { __jevFast?: { frameId: string } }).__jevFast
              ?.frameId,
        )
        .catch(() => undefined);

      if (id === frameId) return { frame };
    }
  }

  return null;
}

async function fieldInfo(
  context: BrowserContext,
  ref: NodeRef,
): Promise<FieldInfo | null> {
  const frameId = (ref as unknown as { frameId?: string }).frameId;
  const node = (ref as unknown as { node?: number }).node;

  if (typeof frameId !== "string" || typeof node !== "number") return null;

  const resolved = await frameFor(context, frameId);
  if (!resolved) return null;

  return resolved.frame
    .evaluate((nodeId) => {
      const registry = (
        window as unknown as {
          __jevFast?: { nodes?: Map<number, Element> };
        }
      ).__jevFast;

      const element = registry?.nodes?.get(nodeId) as
        | HTMLInputElement
        | undefined;

      if (!element) return null;

      return {
        type: (element.getAttribute("type") ?? "text").toLowerCase(),
        autocomplete: (
          element.getAttribute("autocomplete") ?? ""
        ).toLowerCase(),
        name: element.getAttribute("name") ?? "",
        elementId: element.id,
        origin: window.location.origin,
      };
    }, node)
    .catch(() => null);
}

function classify(info: FieldInfo): CredentialKind | null {
  const autocomplete = info.autocomplete;

  if (autocomplete === "username" || autocomplete === "email") {
    return "username";
  }

  if (
    autocomplete === "current-password" ||
    autocomplete === "new-password"
  ) {
    return "password";
  }

  if (autocomplete === "one-time-code") return "otp";

  if (info.type === "password") return "password";

  const names = [info.name, info.elementId].map((value) => value.toLowerCase());

  if (names.some((value) => /user|email/.test(value))) return "username";
  if (names.some((value) => /pass/.test(value))) return "password";
  if (names.some((value) => /otp|code/.test(value))) return "otp";

  return null;
}

export async function findCredentialFields(
  target: BrowserTarget,
  observation: PageObservation,
): Promise<{ kind: CredentialKind; ref: NodeRef }[]> {
  const context = contextOf(target);
  const fields: { kind: CredentialKind; ref: NodeRef }[] = [];
  // One entry per node: a node can carry more than one action.
  const seen = new Set<string>();

  for (const action of observation.actions) {
    if (action.kind !== "fill" || !action.ref) continue;
    const key = `${action.ref.frameId}:${action.ref.node}`;
    if (seen.has(key)) continue;

    const entry = { ref: action.ref };
    const info = await fieldInfo(context, entry.ref);
    const kind = info ? classify(info) : null;

    if (!kind) continue;
    seen.add(key);

    fields.push({ kind, ref: entry.ref });
  }

  return fields;
}


export async function fillCredentials(
  target: BrowserTarget,
  observation: PageObservation,
  source: CredentialSource,
): Promise<FillOutcome> {
  const context = contextOf(target);
  const fields = await findCredentialFields(context, observation);
  const outcome: FillOutcome = {
    filled: [],
    missing: [],
    targets: [],
  };

  for (const field of fields) {
    const info = await fieldInfo(context, field.ref);
    if (!info) throw new Error("Credential field unavailable");

    let value: string | null;
    try {
      value = await source.get(field.kind, info.origin);
    } catch {
      throw new Error(`Credential source failed for ${field.kind}`);
    }

    if (value === null) {
      outcome.missing.push(field.kind);
      continue;
    }

    // execute() takes the observed action and the text. It re-resolves the
    // node and re-validates it before any input, which is why the secret goes
    // through here and not through Playwright directly.
    const action = observation.actions.find(
      (entry) =>
        entry.kind === "fill" &&
        entry.ref?.frameId === field.ref.frameId &&
        entry.ref?.node === field.ref.node
    );
    if (!action) {
      throw new Error(`Credential field unavailable for ${field.kind}`);
    }

    try {
      await execute(context, observation, action, { text: value });
    } catch (error) {
      // The message is ours. An error from below could quote the typed value.
      throw new Error(
        `Credential fill failed for ${field.kind}: ${error instanceof Error ? error.constructor.name : "unknown error"}`
      );
    }

    outcome.filled.push(field.kind);
    outcome.targets.push(field.ref);
  }

  return outcome;
}
