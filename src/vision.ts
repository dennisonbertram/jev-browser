// Vision and coordinates: the two capabilities that make a canvas-only
// control reachable -- take a picture, and click a point. The security rule
// holds here too: a caller passes an index into PageObservation.canvases and
// fractions of that region, never a page coordinate. The library re-resolves
// the region against the live page and converts the fraction to a point.
import type { ElementHandle, Frame, Page } from "playwright";
import { StalePage } from "./types.ts";
import type { NodeRef, PageObservation } from "./types.ts";

export type Rect = { x: number; y: number; width: number; height: number };

/** A picture of the page, or of one region of it. */
export type Shot = {
  /** PNG bytes. */
  image: Buffer;
  /** The region the picture covers, in top-document coordinates. */
  rect: Rect;
  /** The device pixel ratio the picture was taken at. */
  scale: number;
};

/** Take a picture of the whole visible page. */
export async function screenshotPage(page: Page): Promise<Shot> {
  const image = await page.screenshot({ type: "png" });
  const { width, height, scale } = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scale: window.devicePixelRatio,
  }));
  return { image, rect: { x: 0, y: 0, width, height }, scale };
}

/**
 * Take a picture of one observed canvas region. The caller gives the index of
 * a region in PageObservation.canvases, never a coordinate.
 */
export async function screenshotCanvas(
  page: Page,
  observation: PageObservation,
  canvasIndex: number
): Promise<Shot> {
  const entry = canvasAt(observation, canvasIndex);
  const element = await resolveCanvas(page, entry.ref, canvasIndex);
  try {
    // Element screenshot covers the element's own box and nothing else, and
    // scrolls it into view first, so an offscreen region still comes back.
    await element.scrollIntoViewIfNeeded();
    const rect = await element.boundingBox();
    if (!rect) {
      throw new StalePage(`canvas ${canvasIndex} is no longer visible`);
    }
    const image = await element.screenshot({ type: "png" });
    const scale = await page.evaluate(() => window.devicePixelRatio);
    return { image, rect, scale };
  } finally {
    await element.dispose().catch(() => undefined);
  }
}

/**
 * Click a point inside an observed canvas region. `x` and `y` are fractions of
 * that region, from 0 to 1, so a model that saw the picture can name a place
 * in it without ever producing a page coordinate.
 */
export async function clickInCanvas(
  page: Page,
  observation: PageObservation,
  canvasIndex: number,
  x: number,
  y: number
): Promise<void> {
  const entry = canvasAt(observation, canvasIndex);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    throw new RangeError(
      `x and y are fractions of the region from 0 to 1; got (${x}, ${y})`
    );
  }
  const element = await resolveCanvas(page, entry.ref, canvasIndex);
  try {
    // Re-read the live position: the stored rect is from observation time and
    // the page may have scrolled since. boundingBox() is viewport-relative in
    // top-document coordinates, which is what page.mouse clicks in.
    const rect = await element.boundingBox();
    if (!rect) {
      throw new StalePage(`canvas ${canvasIndex} is no longer visible`);
    }
    await page.mouse.click(rect.x + x * rect.width, rect.y + y * rect.height);
  } finally {
    await element.dispose().catch(() => undefined);
  }
}

function canvasAt(observation: PageObservation, canvasIndex: number) {
  const entry = observation.canvases[canvasIndex];
  if (!entry) {
    throw new RangeError(
      `canvasIndex ${canvasIndex} is not in the observation (${observation.canvases.length} canvases observed)`
    );
  }
  return entry;
}

/**
 * Re-resolve an observed canvas node against the live page. The frame id and
 * node index only exist inside a document the snapshot engine ran in, so a
 * navigated or reloaded page resolves to nothing and the caller throws
 * StalePage rather than clicking wherever the old rect happened to land.
 */
async function resolveCanvas(
  page: Page,
  ref: NodeRef,
  canvasIndex: number
): Promise<ElementHandle> {
  let frame: Frame | null = null;
  for (const candidate of page.frames()) {
    if (candidate.isDetached()) continue;
    const id = await candidate
      .evaluate(
        () =>
          (window as unknown as { __jevFrameId?: string }).__jevFrameId ?? null
      )
      .catch(() => null);
    if (id === ref.frameId) {
      frame = candidate;
      break;
    }
  }
  if (!frame) {
    throw new StalePage(`canvas ${canvasIndex}'s frame is gone`);
  }
  const handle = await frame
    .evaluateHandle(
      (node: number) =>
        (
          window as unknown as {
            __jevFast?: { nodes: Map<number, Element> };
          }
        ).__jevFast?.nodes.get(node) ?? null,
      ref.node
    )
    .catch(() => null);
  const element = handle?.asElement() ?? null;
  if (!element) {
    await handle?.dispose().catch(() => undefined);
    throw new StalePage(`canvas ${canvasIndex} is gone from the page`);
  }
  return element;
}
