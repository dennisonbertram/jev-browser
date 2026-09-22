import type { Locator, Page } from "playwright";
import type { NodeRef, PageObservation } from "./types.ts";
import type { Shot } from "./vision.ts";

/** A region of the page to cover, named by an observed node. */
export type MaskTarget = NodeRef;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function sameRef(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function frameObjects(observation: unknown): Record<string, unknown>[] {
  if (!isRecord(observation)) {
    if (Array.isArray(observation)) return [];
    return [];
  }
  const out: Record<string, unknown>[] = [];
  const frames = observation["frames"];
  if (Array.isArray(frames)) {
    for (const f of frames) {
      if (isRecord(f)) out.push(f);
    }
    return out;
  }
  // Tolerate alternate containers without guessing secrets from them.
  for (const key of ["tabs", "pages"]) {
    const v = observation[key];
    if (Array.isArray(v)) {
      for (const entry of v) {
        if (!isRecord(entry)) continue;
        const inner = entry["frames"];
        if (Array.isArray(inner)) {
          for (const f of inner) if (isRecord(f)) out.push(f);
        } else {
          out.push(entry);
        }
      }
      if (out.length > 0) return out;
    }
  }
  const direct = observation["nodes"];
  if (Array.isArray(direct)) return [observation as Record<string, unknown>];
  return out;
}

function nodesOfFrame(frame: Record<string, unknown>): unknown[] {
  for (const key of ["nodes", "children", "elements", "controls", "interactives"]) {
    const v = frame[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function allNodes(observation: unknown): unknown[] {
  if (Array.isArray(observation)) return observation;
  if (!isRecord(observation)) return [];
  const direct = observation["nodes"];
  if (Array.isArray(direct) && !Array.isArray(observation["frames"])) return direct;
  const out: unknown[] = [];
  for (const f of frameObjects(observation)) out.push(...nodesOfFrame(f));
  return out;
}

function refOfNode(node: unknown): NodeRef | null {
  if (!isRecord(node)) return null;
  for (const key of ["ref", "nodeRef", "reference"]) {
    const v = node[key];
    if (v !== null && v !== undefined && (typeof v === "object" || typeof v === "number" || typeof v === "string")) {
      return v as NodeRef;
    }
  }
  return null;
}

function typeOfNode(node: unknown): string | null {
  if (!isRecord(node)) return null;
  // Only type-like fields mark a secret. Name, label, id and placeholder
  // are never consulted here.
  const direct: unknown[] = [
    node["inputType"],
    node["input_type"],
    node["type"],
    node["kind"],
    node["controlType"],
  ];
  for (const c of direct) {
    if (typeof c === "string" && c.length > 0) return c.toLowerCase();
  }
  for (const key of ["attributes", "attrs", "props", "properties"]) {
    const bag = node[key];
    if (isRecord(bag)) {
      const t = bag["type"];
      if (typeof t === "string" && t.length > 0) return t.toLowerCase();
    }
  }
  for (const key of ["outerHTML", "html", "markup"]) {
    const v = node[key];
    if (typeof v === "string") {
      const m = v.match(/type\s*=\s*["']?([A-Za-z]+)["']?/);
      if (m && m[1]) return m[1].toLowerCase();
    }
  }
  return null;
}

function findNode(observation: PageObservation, ref: NodeRef): unknown | null {
  for (const node of allNodes(observation as unknown)) {
    const r = refOfNode(node);
    if (r !== null && sameRef(r, ref)) return node;
  }
  return null;
}

function locatorForNode(page: Page, node: unknown): Locator {
  const n = (isRecord(node) ? node : {}) as Record<string, unknown>;
  const asString = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  const directSelector =
    asString(n["selector"]) ?? asString(n["css"]) ?? asString(n["cssSelector"]);
  if (directSelector) return page.locator(directSelector);

  const xpath = asString(n["xpath"]);
  if (xpath) {
    if (xpath.startsWith("xpath=")) return page.locator(xpath);
    return page.locator(`xpath=${xpath}`);
  }

  const selectors = n["selectors"];
  if (Array.isArray(selectors)) {
    for (const s of selectors) {
      if (typeof s === "string" && s.length > 0) return page.locator(s);
      if (isRecord(s)) {
        const inner = asString(s["selector"]) ?? asString(s["css"]) ?? asString(s["xpath"]);
        if (inner) {
          if (inner.startsWith("xpath=") || (s["xpath"] !== undefined && inner === s["xpath"])) {
            return page.locator(inner.startsWith("xpath=") ? inner : `xpath=${inner}`);
          }
          return page.locator(inner);
        }
      }
    }
  }

  let attrId: string | null = null;
  for (const key of ["attributes", "attrs", "props", "properties"]) {
    const bag = n[key];
    if (isRecord(bag)) {
      const id = asString(bag["id"]);
      if (id) {
        attrId = id;
        break;
      }
    }
  }
  if (!attrId && typeof n["id"] === "string" && /^[A-Za-z][\w:.-]*$/.test(n["id"])) {
    attrId = n["id"];
  }
  if (attrId) return page.locator(`#${attrId}`);

  const role = asString(n["role"]);
  const name = asString(n["name"]) ?? asString(n["label"]) ?? asString(n["ariaLabel"]) ?? asString(n["accessibleName"]);
  if (role && name) {
    try {
      return page.getByRole(role as "textbox", { name });
    } catch {
      // Fall through to type-based locators below.
    }
  }
  const ariaLabel = asString(n["ariaLabel"]);
  if (ariaLabel) {
    try {
      return page.getByRole("textbox", { name: ariaLabel });
    } catch {
      // Fall through.
    }
  }

  const t = typeOfNode(node);
  if (t === "password") return page.locator('input[type="password"]');
  if (t) {
    const tag = asString(n["tag"]) ?? asString(n["tagName"]) ?? asString(n["nodeName"]);
    if (tag && tag.toLowerCase() === "input") return page.locator(`input[type="${t}"]`);
  }

  for (const key of ["outerHTML", "html"]) {
    const v = n[key];
    if (typeof v === "string") {
      const m = v.match(/id\s*=\s*["']([^"']+)["']/i);
      if (m && m[1]) return page.locator(`#${m[1]}`);
    }
  }

  // The node is known but carries no usable selector. Failing loudly is
  // safer than capturing an unredacted picture.
  throw new Error("screenshotRedacted: unknown node reference");
}

/**
 * Take a picture with each named region covered. The cover is applied by the
 * browser during capture, so an unredacted picture never exists.
 */
export async function screenshotRedacted(
  page: Page,
  observation: PageObservation,
  masks: MaskTarget[],
  options?: { color?: string },
): Promise<Shot> {
  const color = options?.color ?? "#000000";
  // Resolve and validate every mask before capture so an unknown ref never
  // yields a picture. Playwright applies `mask` during capture, which is the
  // rule: no unredacted pixels are ever produced.
  const locators: Locator[] = [];
  for (const mask of masks) {
    const node = findNode(observation, mask);
    if (node === null) throw new Error("screenshotRedacted: unknown node reference");
    locators.push(locatorForNode(page, node));
  }
  const buffer = await page.screenshot({ mask: locators, maskColor: color });
  const viewport = page.viewportSize();
  let scale = 1;
  try {
    const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
    if (typeof dpr === "number" && dpr > 0 && Number.isFinite(dpr)) scale = dpr;
  } catch {
    // Keep the default scale when the page cannot be queried.
  }
  const rect = {
    x: 0,
    y: 0,
    width: viewport?.width ?? 0,
    height: viewport?.height ?? 0,
  } as unknown as import("./vision.ts").Rect;
  return { image: buffer, rect, scale } as unknown as Shot;
}

/**
 * Every observed node that holds a secret by its own nature: an input of type
 * password. The caller adds anything else it knows to be sensitive.
 */
export function secretRegions(observation: PageObservation): NodeRef[] {
  const out: NodeRef[] = [];
  const nodes = allNodes(observation as unknown);
  nodes.forEach((node, index) => {
    // Only the type attribute marks a secret. Never consult name, label,
    // id, or placeholder, which would misfire in both directions.
    if (typeOfNode(node) !== "password") return;
    const ref = refOfNode(node);
    if (ref !== null) {
      out.push(ref);
      return;
    }
    // A password node without an explicit ref still names a region: use its
    // position in its frame. screenshotRedacted validates the same way.
    const frames = frameObjects(observation as unknown);
    if (frames.length > 0) {
      const frameId = isRecord(frames[0]) ? frames[0]["frameId"] : undefined;
      out.push({ frameId, node: index } as unknown as NodeRef);
    }
  });
  return out;
}
