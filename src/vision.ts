// Vision and coordinates: the two capabilities that make a canvas-only
// control reachable -- take a picture, and click a point. The security rule
// holds here too: a caller passes an index into PageObservation.canvases and
// fractions of that region, never a page coordinate. The library re-resolves
// the region against the live page and converts the fraction to a point.
export type { Rect } from "./types.js";
import type { ElementHandle, Frame, Page } from "playwright";
import { StalePage } from "./types.js";
import type { NodeRef, PageObservation, Rect } from "./types.js";


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
    await element.scrollIntoViewIfNeeded();
    const before = await element.boundingBox();
    if (!before || !isUsableRect(before)) {
      throw new StalePage(`StalePage: canvas ${canvasIndex} is no longer visible`);
    }
    const rect = enclosingRect(before);
    // Element screenshots capture the composited page inside the element's
    // box, so content painted over the canvas is included in the picture.
    const image = await element.screenshot({ type: "png" });
    const after = await element.boundingBox();
    if (!after || !isUsableRect(after) || !sameRect(rect, enclosingRect(after))) {
      throw new StalePage(`StalePage: canvas ${canvasIndex} moved during capture`);
    }
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
    Object.is(x, -0) ||
    Object.is(y, -0) ||
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
    await element.scrollIntoViewIfNeeded();

    let rect = await element.boundingBox();
    if (!rect || !isUsableRect(rect)) {
      throw new StalePage(`StalePage: canvas ${canvasIndex} is no longer visible`);
    }

    let point = pointInRect(rect, x, y);
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= viewport.width ||
      point.y >= viewport.height
    ) {
      await page.evaluate(({ point }) => {
        window.scrollBy(
          point.x - window.innerWidth / 2,
          point.y - window.innerHeight / 2
        );
      }, { point });
      await element.scrollIntoViewIfNeeded();
      rect = await element.boundingBox();
      if (!rect || !isUsableRect(rect)) {
        throw new StalePage(`StalePage: canvas ${canvasIndex} is no longer visible`);
      }
      point = pointInRect(rect, x, y);
    }

    const hit = await element.evaluate(
      (canvas, coordinates) => {
        const hit = document.elementFromPoint(coordinates.x, coordinates.y);
        return hit === canvas || (!!hit && canvas.contains(hit));
      },
      point
    ).catch(() => false);
    if (!hit) {
      throw new StalePage(
        `StalePage: canvas ${canvasIndex} is covered or not at the point`
      );
    }

    await page.mouse.click(point.x, point.y);
  } finally {
    await element.dispose().catch(() => undefined);
  }
}

function pointInRect(rect: Rect, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(rect.x + rect.width - 1, rect.x + x * rect.width),
    y: Math.min(rect.y + rect.height - 1, rect.y + y * rect.height),
  };
}

function enclosingRect(rect: Rect): Rect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const right = Math.ceil(rect.x + rect.width);
  const bottom = Math.ceil(rect.y + rect.height);
  return { x, y, width: right - x, height: bottom - y };
}

function sameRect(a: Rect, b: Rect): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function isUsableRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 1 &&
    rect.height >= 1
  );
}

function canvasAt(observation: PageObservation, canvasIndex: number) {
  if (
    typeof canvasIndex !== "number" ||
    !Number.isInteger(canvasIndex) ||
    Object.is(canvasIndex, -0) ||
    canvasIndex < 0 ||
    canvasIndex >= observation.canvases.length
  ) {
    throw new RangeError(
      `canvasIndex ${canvasIndex} is not in the observation (${observation.canvases.length} canvases observed)`
    );
  }
  return observation.canvases[canvasIndex]!;
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
    throw new StalePage(`StalePage: canvas ${canvasIndex}'s frame is gone`);
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
    throw new StalePage(`StalePage: canvas ${canvasIndex} is gone from the page`);
  }
  return element;
}
