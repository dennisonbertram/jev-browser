# S1 fix, part 2 of 3: bound the readiness poll, tie cdpUrl to our browser

Read `docs/specs/CONVENTIONS.md` first. Do only what is here.

## Files you may change

`src/browser.ts` and `tests/browser.test.ts`. No others.

## Two defects

1. `readCdpUrl` calls `fetch` with no cancellation and reads the body with no
   limit, so one stalled response holds startup past the ten-second deadline.
   It also accepts a success that arrives after the deadline. Give each `fetch`
   an `AbortSignal` for the time that remains. Check the deadline again after
   every await. Consume or cancel the body of a response that is not OK.

2. The poll trusts whatever answers `127.0.0.1:<port>`. Another browser can hold
   that port, so `cdpUrl` can name a different browser from `session.browser`.
   Prove the endpoint belongs to the browser this process launched:
   - open a page through Playwright at `about:blank#<random token>`;
   - read `http://127.0.0.1:<port>/json/list`;
   - confirm an entry whose url contains that token;
   - close the probe page;
   - if the token is absent, close the browser and throw.

## One new test

Prove the readiness poll cannot hang. Start an HTTP server with `node:http`
whose handler never answers. Call `launchLocal({ cdpPort: <that port> })`.
Chromium cannot own a port that is already taken, so the call must reject, and
it must reject in under 15 seconds. Close the server at the end.

## Verification

```sh
npx vitest run
npx tsc --noEmit
```

Both must pass with zero failures and zero errors. Write the new test first and
watch it fail.
