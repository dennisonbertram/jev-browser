# S1 fix, part 1 of 3: bound the attachment, stop the launch leak

Read `docs/specs/CONVENTIONS.md` first. Do only what is here. Parts 2 and 3
cover other defects; leave them alone.

## Files you may change

`src/browser.ts` and `tests/browser.test.ts`. No others.

## Three defects

1. In `attachOverCdp`, the timeout covers `connectOverCDP` only. The context and
   page setup that follows is outside the timeout and outside the `try`. A stall
   there waits without a limit. A failure there leaks the connection and returns
   no session. Put the connect, the context and the page inside one deadline and
   one `try`. On any failure, disconnect the browser, then throw one error that
   names the endpoint.

2. `timeoutMs: 0` reaches Playwright, which reads 0 as "no timeout". Reject a
   `timeoutMs` that is not a finite number greater than 0. Throw before you
   touch the network.

3. In `launchLocal`, `browser.newContext()` and `context.newPage()` are outside
   the cleanup guard. If either rejects, Chromium keeps running and the caller
   gets nothing. Close the browser on either failure, then rethrow.

## One new test

Add a test that proves the attachment timeout works. A refused port is not
enough, because it rejects at once and passes even with no timeout.

- Start a TCP server with `node:net`. In the connection handler, do nothing:
  accept the socket and never write to it.
- Call `attachOverCdp("ws://127.0.0.1:<port>/devtools/browser/x", { timeoutMs: 1500 })`.
- The call must reject in under 5 seconds.
- The message must contain the endpoint.
- Close the server at the end of the test.

Also add a test that `attachOverCdp(url, { timeoutMs: 0 })` rejects.

## Verification

```sh
npx vitest run
npx tsc --noEmit
```

Both must pass with zero failures and zero errors. Write the new tests first and
watch them fail.
