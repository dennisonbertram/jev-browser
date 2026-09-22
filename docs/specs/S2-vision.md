# S2: Vision and coordinates

Read `docs/specs/CONVENTIONS.md` first.

## Purpose

Some controls have no DOM node. A date picker drawn on a canvas is the common
case. The library reports a canvas in `PageObservation.canvases`, but it cannot
act on one. This subsystem adds the two capabilities that make such a control
reachable: take a picture, and click a point.

The security rule does not change. A model never returns a coordinate. A model
returns an index into the table of canvas regions that the library observed.
The library converts that index to a point.

## Files you may create or change

- `src/vision.ts` (new)
- `tests/vision.test.ts` (new)
- `src/index.ts` (add the new exports only)

Change no other file. Do not change `src/observe.ts`, `src/execute.ts` or
`src/snapshot-dom.js`.

## The contract

```ts
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
export function screenshotPage(page: Page): Promise<Shot>;

/**
 * Take a picture of one observed canvas region. The caller gives the index of
 * a region in PageObservation.canvases, never a coordinate.
 */
export function screenshotCanvas(
  page: Page,
  observation: PageObservation,
  canvasIndex: number
): Promise<Shot>;

/**
 * Click a point inside an observed canvas region. `x` and `y` are fractions of
 * that region, from 0 to 1, so a model that saw the picture can name a place
 * in it without ever producing a page coordinate.
 */
export function clickInCanvas(
  page: Page,
  observation: PageObservation,
  canvasIndex: number,
  x: number,
  y: number
): Promise<void>;
```

## Rules

1. Reject `canvasIndex` that is not in `observation.canvases`. Throw, and do
   not touch the page.
2. Reject `x` or `y` outside 0 to 1, and reject a value that is not finite.
   Throw, and do not touch the page.
3. Re-read the region's position from the page immediately before the click.
   The stored rect is from observation time and the page can scroll. If the
   region is gone, throw `StalePage` from `src/types.ts`.
4. Dispatch a real mouse event through `page.mouse`, not `element.click()`.
5. `screenshotCanvas` must cover the region and nothing else.

## The tests you must write, and they must pass

In `tests/vision.test.ts`, with the fixture `canvas.html`:

1. `screenshotPage` returns PNG bytes. Check the 8-byte PNG signature, and
   check `rect.width` is greater than 0.
2. `screenshotCanvas` on the observed canvas returns a picture whose `rect`
   matches the canvas element's own bounding box, within 2 pixels.
3. `clickInCanvas` at the centre of the drawn button sets `#canvas-result` to
   `date-picked`. The drawn button occupies x 10 to 70 and y 40 to 64 of a
   canvas 200 wide and 80 high, so a fraction of about 0.2, 0.65 lands inside
   it. Compute the fraction; do not write a page coordinate.
4. `clickInCanvas` with `canvasIndex` 99 throws, and `#canvas-result` still
   reads `no date`.
5. `clickInCanvas` with `x` of 1.5 throws, and `#canvas-result` still reads
   `no date`.

## Verification

```sh
npx vitest run          # every test in the project
npx tsc --noEmit
```

Write the tests first. See them fail. Then write `src/vision.ts`.
