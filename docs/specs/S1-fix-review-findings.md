# S1 fix: findings from the review

Read `docs/specs/CONVENTIONS.md` first.

A review of `src/browser.ts` and `tests/browser.test.ts` found real defects. Each
one below was confirmed by reading the code. Fix all of them, and strengthen the
tests so that they fail when the behaviour breaks.

## Files you may change

- `src/browser.ts`
- `tests/browser.test.ts`

Change no other file.

## Defects in `src/browser.ts`

1. **Attachment setup escapes the timeout and the cleanup.** `connectOverCDP`
   has the timeout, but the context and page setup that follows does not, and it
   sits outside the `try`. A stall there hangs without a limit, and a failure
   leaks the connection and returns no session. Put the whole attachment inside
   one deadline and one `try`. On any failure, disconnect the browser, then
   throw an error that names the endpoint.

2. **`timeoutMs: 0` removes the limit.** Playwright treats 0 as "no timeout".
   Reject a `timeoutMs` that is not a finite number greater than 0.

3. **Local setup failures leak the browser.** `browser.newContext()` and
   `context.newPage()` sit outside the cleanup guard. If either rejects,
   Chromium stays alive and the caller gets no handle. Close the browser on
   either failure.

4. **The readiness poll has no cancellation.** `fetch` runs with no signal, and
   the body is read with no limit, so one stalled response can hold startup past
   the ten-second deadline. Worse, a success that arrives after the deadline is
   still accepted. Give each `fetch` an `AbortSignal` for the time that remains,
   check the deadline again after every await, and consume or cancel the body of
   a response that is not OK.

5. **`cdpUrl` can name a different browser.** The code polls
   `127.0.0.1:<port>` and trusts the answer. Another browser can hold that port.
   Prove the endpoint belongs to the browser this process launched: create a
   page through Playwright at a unique URL such as `about:blank#<random>`, then
   read `http://127.0.0.1:<port>/json/list` and confirm that URL is present. If
   it is absent, close the browser and throw. Close that probe page afterwards.

6. **`close` reports success too early, and blocks a retry.** The flag is set
   before the await, so a second caller returns while shutdown is still running.
   A rejection also leaves the flag set, so no retry is possible. Hold one
   promise, let every caller await the same one, and clear the state if it
   rejects so a retry can work.

7. **An attached session can leave a tab behind.** When the remote context has
   no pages, `attachOverCdp` creates one, and disconnecting does not remove it.
   Record whether this process created that page or that context, and close only
   what this process created. Never close a borrowed page, and never close the
   remote browser.

## Defects in `tests/browser.test.ts`

8. **The close tests pass against a `close` that does nothing.** They only
   require that no error is thrown. Assert the observable result instead:
   - after an owned session closes, `session.browser.isConnected()` is `false`;
   - after an attached session closes, the attached `browser.isConnected()` is
     `false` **and** the owner session's `browser.isConnected()` is still
     `true`.

9. **The ownership test never proves the attachment reached the owner's
   browser.** Attaching to any other browser would pass it. Prove identity:
   open a page in the owner session at a unique URL, then attach, and assert
   that the attached context lists a page with that URL.

10. **The timeout test never reaches a timeout.** A refused port rejects at
    once, so the test passes even with no timeout at all. Add a test that
    listens on a TCP port, accepts the connection, and sends nothing. Attach to
    it with `timeoutMs` of 1500. The call must reject in under 5 seconds, and
    the message must contain the endpoint. Close the listener afterwards.

11. **A stalled readiness endpoint is never tested.** Add a test that starts an
    HTTP server that accepts the request and never answers, then calls
    `launchLocal` with `cdpPort` set to that port. Chromium cannot own that
    port, so expect a rejection, and assert it happens in under 15 seconds.
    Assert as well that no Chromium process is left behind: the rejection path
    must close the browser.

## Verification

```sh
npx vitest run          # every test in the project
npx tsc --noEmit
```

Both must pass with zero failures and zero errors. Do not weaken a test to make
it pass. Write each new or strengthened test first, see it fail against the
current code, then fix the code.
