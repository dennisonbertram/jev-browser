# S1 fix, part 3 of 3: correct close, and tests that catch a close that does nothing

Read `docs/specs/CONVENTIONS.md` first. Do only what is here.

## Files you may change

`src/browser.ts` and `tests/browser.test.ts`. No others.

## Two defects

1. `close` sets its flag before it awaits, so a second caller returns while
   shutdown is still running, and a rejection leaves the flag set so no retry is
   possible. Hold one promise. Every caller awaits that same promise. Clear the
   state when it rejects, so a retry can work.

2. When the remote context holds no pages, `attachOverCdp` creates one, and
   disconnecting leaves that tab behind. Record what this process created, the
   page and the context, and close only those on release. Never close a borrowed
   page. Never close the remote browser.

## Two tests to strengthen

The present close tests pass against a `close` that does nothing, because they
only require that no error is thrown. Assert the observable result.

1. After an owned session closes, `session.browser.isConnected()` is `false`.
2. After an attached session closes:
   - the attached `browser.isConnected()` is `false`;
   - the owner session's `browser.isConnected()` is still `true`.

The ownership test also never proves the attachment reached the owner's browser.
Attaching to any other browser passes it today. Prove identity: open a page in
the owner session at a unique url, then attach, and assert that the attached
context lists a page with that url.

## Verification

```sh
npx vitest run
npx tsc --noEmit
```

Both must pass with zero failures and zero errors. Strengthen each test first
and watch it fail against the current code.
