# S8: Hardening

Read `docs/specs/CONVENTIONS.md` first.

## Purpose

A real page does things a fixture usually does not. It opens a dialog, it starts
a download, it navigates while an action is in flight. Each behaviour below gets
one regression test, so a later change cannot reintroduce the fault.

## Files you may create or change

- `src/hardening.ts` (new, only if code is needed)
- `tests/hardening.test.ts` (new)
- `tests/fixtures/dialog.html` (new)
- `tests/fixtures/download.html` (new)
- `tests/fixtures/slow-nav.html` (new)

Do not change `src/index.ts`, `src/observe.ts`, `src/execute.ts` or
`src/snapshot-dom.js`. If a fault can only be fixed in one of those files, write
the failing test, leave it skipped with a comment that names the file and the
reason, and report it.

## The fixtures

- `dialog.html`: a button `Confirm delete` whose click calls
  `window.confirm("Are you sure?")`, then writes the answer into `#result`.
- `download.html`: a link `Get the report` that downloads a small text file
  through a blob url, and a `#result` that records the click.
- `slow-nav.html`: a button `Go slowly` that waits 400 ms and then navigates to
  `select.html`.

## The behaviours to prove

1. **A dialog does not hang the loop.** A click that opens a confirm must not
   block for ever. Playwright auto-dismisses a dialog unless a handler is
   registered, so prove the observed behaviour: the click returns, the page
   records the dismissal, and a following observation still works.
2. **A download does not hang the loop.** A click that starts a download must
   return, and a following observation must still work.
3. **A navigation during an action is reported, not silently swallowed.** Click
   `Go slowly`, then observe: the new observation must describe `select.html`,
   and the fingerprint must differ from the one before the click.
4. **A stale action after navigation is refused.** Observe `slow-nav.html`, click
   to navigate, wait for the new page, then try to execute the **old** action.
   It must throw `StalePage` and must not act.
5. **An action on a detached frame is refused.** Observe an iframe fixture,
   remove the iframe from the page, then execute an action inside it. It must
   throw and must not act.
6. **A closed page is refused.** Close the page, then execute. It must throw a
   clear error rather than hang.

## Verification

```sh
npx vitest run tests/hardening.test.ts
npx tsc --noEmit
```

Both must pass. A skipped test is acceptable only with the comment that rule 1
of the file list requires.
