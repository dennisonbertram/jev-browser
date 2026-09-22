/**
 * A picture must not carry a secret out of the process. The cover is applied by
 * the browser during capture, so an unredacted picture never exists in memory
 * to be logged by accident.
 *
 * This module works from the real observation: a sensitive field is one the
 * snapshot marked, and a region is resolved through the in-page registry that
 * the observation built. An earlier version searched for collections a real
 * observation does not have, so it found nothing and captured the secret.
 */
import { randomUUID } from "node:crypto";
import type { Frame, Locator, Page } from "playwright";
import { StalePage, type NodeRef, type PageObservation, type Rect } from "./types.ts";
import type { Shot } from "./vision.ts";

/** A region to cover, named by an observed node. */
export type MaskTarget = NodeRef;

/** Opaque black. A transparent colour would cover nothing. */
const DEFAULT_COLOR = "#000000";

/** Every observed field that holds a secret by its own nature. */
export function secretRegions(observation: PageObservation): NodeRef[] {
  const refs: NodeRef[] = [];
  const seen = new Set<string>();
  for (const action of observation.actions) {
    if (!action.sensitive || !action.ref) continue;
    const key = `${action.ref.frameId}:${action.ref.node}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(action.ref);
  }
  return refs;
}

/** The frame that carries a given frame id, from the page's own frame list. */
async function frameFor(page: Page, frameId: string): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const id = await frame
      .evaluate(() => (window as unknown as { __jevFast?: { frameId: string } }).__jevFast?.frameId)
      .catch(() => undefined);
    if (id === frameId) return frame;
  }
  return null;
}

/**
 * Playwright masks by locator, so an observed node needs a selector. The
 * library writes a unique attribute on the node itself and locates that. The
 * selector is generated here and never comes from a model.
 */
async function markNode(frame: Frame, node: number, token: string): Promise<Locator | null> {
  const marked = await frame
    .evaluate(
      ({ n, attribute }) => {
        const registry = (window as unknown as { __jevFast: { nodes: Map<number, Element> } })
          .__jevFast;
        const element = registry.nodes.get(n);
        if (!element) return false;
        element.setAttribute(attribute, "1");
        return true;
      },
      { n: node, attribute: token }
    )
    .catch(() => false);
  return marked ? frame.locator(`[${token}]`) : null;
}

async function unmark(frame: Frame, token: string): Promise<void> {
  await frame
    .evaluate((attribute) => {
      for (const element of document.querySelectorAll(`[${attribute}]`)) {
        element.removeAttribute(attribute);
      }
    }, token)
    .catch(() => undefined);
}

/**
 * Take a picture with each named region covered. An unknown reference throws:
 * returning an unredacted picture would be the dangerous answer.
 */
export async function screenshotRedacted(
  page: Page,
  observation: PageObservation,
  masks: MaskTarget[],
  options: { color?: string } = {}
): Promise<Shot> {
  const color = options.color ?? DEFAULT_COLOR;
  if (/transparent|rgba?\([^)]*,\s*0(\.0+)?\s*\)/iu.test(color)) {
    throw new Error("A transparent mask colour would cover nothing.");
  }

  const locators: Locator[] = [];
  const marked: { frame: Frame; token: string }[] = [];
  try {
    for (const mask of masks) {
      const known = observation.actions.some(
        (action) => action.ref?.frameId === mask.frameId && action.ref?.node === mask.node
      );
      if (!known) {
        throw new Error(
          `Unknown node reference ${mask.frameId}:${mask.node}. A picture was not taken.`
        );
      }
      const frame = await frameFor(page, mask.frameId);
      if (!frame) throw new StalePage(`Frame ${mask.frameId} is gone. A picture was not taken.`);
      const token = `data-jev-mask-${randomUUID().slice(0, 8)}`;
      const locator = await markNode(frame, mask.node, token);
      if (!locator) {
        throw new StalePage(`Node ${mask.node} is gone. A picture was not taken.`);
      }
      marked.push({ frame, token });
      locators.push(locator);
    }

    const image = await page.screenshot({ mask: locators, maskColor: color });
    const viewport = page.viewportSize();
    let scale = 1;
    try {
      const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
      if (typeof dpr === "number" && dpr > 0 && Number.isFinite(dpr)) scale = dpr;
    } catch {
      scale = 1;
    }
    const rect: Rect = {
      x: 0,
      y: 0,
      width: viewport?.width ?? 0,
      height: viewport?.height ?? 0,
    };
    return { image, rect, scale };
  } finally {
    for (const entry of marked) await unmark(entry.frame, entry.token);
  }
}
