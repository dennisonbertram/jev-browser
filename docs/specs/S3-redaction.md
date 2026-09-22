# S3: Screenshot redaction

Read `docs/specs/CONVENTIONS.md` first.

## Purpose

A picture of a page can carry a secret out of the process. A password field, a
one-time code, or a card number can appear in a screenshot that then travels to
a model, a log file, or an operator's screen. This subsystem covers those
regions before the picture exists.

The rule is that the redaction happens **during capture**, not afterwards. A
picture that contains the secret must never exist in memory, because an
unredacted picture can be logged by accident.

## Files you may create or change

- `src/redact.ts` (new)
- `tests/redact.test.ts` (new)
- `tests/fixtures/secrets.html` (new fixture)
- `src/index.ts` (add the new exports only)

Change no other file.

## The fixture

`tests/fixtures/secrets.html` holds, in this order:

1. `<input id="user" aria-label="Username" value="ada">`
2. `<input id="secret" type="password" aria-label="Password" value="hunter2">`
3. `<input id="code" aria-label="One time code" value="123456">`
4. `<p id="plain">visible text</p>`

Give each input `width: 200px; height: 40px; display: block;` so a region is
easy to measure.

## The contract

```ts
/** A region of the page to cover, named by an observed node. */
export type MaskTarget = NodeRef;

/**
 * Take a picture with each named region covered. The cover is applied by the
 * browser during capture, so an unredacted picture never exists.
 */
export function screenshotRedacted(
  page: Page,
  observation: PageObservation,
  masks: MaskTarget[],
  options?: { color?: string }
): Promise<Shot>;

/**
 * Every observed node that holds a secret by its own nature: an input of type
 * password. The caller adds anything else it knows to be sensitive.
 */
export function secretRegions(observation: PageObservation): NodeRef[];
```

`Shot` comes from `src/vision.ts`. Reuse it; do not define a second one.

## Rules

1. Use Playwright's own masking: `page.screenshot({ mask: [...], maskColor })`.
   Do not take a picture and paint over it afterwards.
2. The default colour is opaque black, `#000000`.
3. A `NodeRef` that is not in the observation makes the call throw. It must not
   quietly take an unredacted picture. This is the dangerous failure, so it
   fails loudly.
4. `secretRegions` finds an input whose type is `password`. It must not guess
   from a name or a label, because a guess would be wrong in both directions.
5. Never write a secret to a log, an error message, or the returned object.

## The tests you must write, and they must pass

In `tests/redact.test.ts`, against `secrets.html`:

1. `secretRegions` returns exactly one region, and it is the password input.
2. `screenshotRedacted` covers the password field. Prove it by reading the
   pixels: open the PNG in a blank page as a data url, draw it on a canvas, and
   read the colour at the centre of the field's rect. Every channel of that
   pixel must be 0. Read a pixel over `#plain` as well, and show that it is not
   black, so the test proves a targeted cover and not a black picture.
3. `screenshotRedacted` with an unknown `NodeRef` throws, and no picture is
   returned.
4. `screenshotRedacted` accepts a colour, and the covered pixel matches it.

## Verification

```sh
npx vitest run
npx tsc --noEmit
```

Both must pass with zero failures and zero errors. Write the tests first.
