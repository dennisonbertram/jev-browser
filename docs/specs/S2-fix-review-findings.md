# S2 fix: findings from the review

Read `docs/specs/CONVENTIONS.md` first.

A review found real defects in `src/vision.ts`, and showed that every test in
`tests/vision.test.ts` passes against broken behaviour. Fix both.

## Files you may change

- `src/vision.ts`
- `tests/vision.test.ts`
- `tests/fixtures/canvas-two.html` (new fixture)

Change no other file. Do not change `tests/fixtures/canvas.html`; other suites
depend on it.

## Defects in the code

1. **A fraction of 1 clicks outside the region.** The mapping sends fraction 1
   to `rect.x + rect.width`, which is the first pixel outside. Floating point
   makes it worse: with `x` 100 and `width` 200, the fraction
   0.9999999999999999 also produces 300. Map a fraction to a point that is
   always inside: clamp the result to at most `rect.x + rect.width - 1` and
   `rect.y + rect.height - 1`, and reject a region narrower than 1 pixel.

2. **Negative zero passes validation.** `Number.isFinite(-0)` is true and
   `-0 < 0` is false. Reject a fraction that is negative zero. Use
   `Object.is(value, -0)`.

3. **The region index is not validated as a number.** An array lookup accepts
   the string "0" and negative zero. Require `Number.isInteger(index)` and a
   value inside the range.

4. **A live bounding box does not mean the click lands on the canvas.** The code
   checks only that a box exists. A canvas can be clipped by a scroll
   container, or covered by another element. Before the click: scroll the point
   into view if it is outside the viewport, then read the element at that point
   and confirm it is the canvas or a descendant of it. If it is not, throw
   `StalePage` and do not click.

5. **The returned rectangle can disagree with the image.** Playwright rounds a
   screenshot crop out to whole pixels, so the image can be larger than the
   rectangle this function returns, and the box is measured before the capture
   scrolls. Return the rectangle that describes the image: take the enclosing
   whole-pixel rectangle of the live box, and measure the box again after the
   capture. If the two differ, the page moved: throw `StalePage`.

6. **The comment overpromises.** `screenshotCanvas` captures the composited page
   inside the element's box, so an element drawn over the canvas appears in the
   picture. Correct the comment. Do not claim isolation the browser does not
   give.

## The tests, which must fail against the old behaviour

Add `tests/fixtures/canvas-two.html` with **two** canvases of different sizes
and positions, each with its own click handler that writes a different result,
so a wrong index is visible.

1. Prove index selection: click inside canvas **1**, not canvas 0, and assert
   only canvas 1's result changed. Today a function that always used canvas 0
   would pass.
2. Prove the picture is the region: assert `screenshotCanvas` image dimensions
   equal the region size multiplied by the device pixel ratio, within 2 pixels.
   Today a whole-page picture would pass.
3. Prove `screenshotPage` returns a real picture: assert its dimensions match
   the viewport multiplied by the device pixel ratio, within 2 pixels.
4. Prove the edges stay inside: a fraction of exactly 1 for x and y must either
   throw or click the last pixel inside the region. Assert the page result is
   the one for that canvas, never the other canvas and never nothing.
5. Prove every rejection separately: `NaN`, `Infinity`, `-0`, `-0.1`, `1.5` for
   x, and the same set for y, and an index of `-0`, `"0"`, `1.5` and `99`.
   Each must throw, and the page must be unchanged after each.
6. Prove the hit check: cover a canvas with an absolutely positioned element,
   then assert `clickInCanvas` throws `StalePage` and the result is unchanged.

## Verification

```sh
npx vitest run
npx tsc --noEmit
```

Both must pass with zero failures and zero errors. Write the tests first and
watch them fail.
