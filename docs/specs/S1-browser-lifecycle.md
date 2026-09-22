# S1: Browser lifecycle

## Purpose

The library must start its own browser, or attach to a browser that another
system started. Production runs remote browsers. A test run uses a local
browser. The rest of the library must not know the difference.

## Files you may create or change

- `src/browser.ts` (new)
- `tests/browser.test.ts` (new)
- `src/index.ts` (add the new exports only; change nothing else)

Change no other file.

## The contract

```ts
export type BrowserSession = {
  /** The Playwright browser. */
  browser: Browser;
  /** The context that holds the active page. */
  context: BrowserContext;
  /** The active page. */
  page: Page;
  /** The raw CDP endpoint, when one is available. */
  cdpUrl: string | null;
  /** True when this process started the browser. */
  owned: boolean;
  /** Release the session. Safe to call more than one time. */
  close: () => Promise<void>;
};

export function launchLocal(options?: {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Expose a raw CDP endpoint on this port, and set cdpUrl. */
  cdpPort?: number;
}): Promise<BrowserSession>;

export function attachOverCdp(
  cdpUrl: string,
  options?: { viewport?: { width: number; height: number }; timeoutMs?: number }
): Promise<BrowserSession>;
```

## Rules

1. `launchLocal` starts Chromium with Playwright. When the caller gives
   `cdpPort`, add `--remote-debugging-port=<port>`, then read
   `http://127.0.0.1:<port>/json/version` until it answers, and put
   `webSocketDebuggerUrl` in `cdpUrl`. Stop after 10 seconds and throw a clear
   error.
2. `attachOverCdp` connects with `chromium.connectOverCDP`. It uses the first
   context and the first page that exist. It creates them only when they are
   absent.
3. `close` on an owned session closes the browser. `close` on an attached
   session disconnects only. **An attached session must never close a browser
   that this process did not start.** Another system owns that browser.
4. `close` is idempotent. A second call does nothing and throws nothing.
5. `attachOverCdp` fails in `timeoutMs` (default 15000) with a message that
   names the endpoint. It must not wait without a limit.

## The tests you must write, and they must pass

In `tests/browser.test.ts`:

1. `launchLocal` gives a page that loads a fixture, and `close` twice does not
   throw.
2. `launchLocal({ cdpPort })` sets `cdpUrl`, and `GET /json/version` on that
   port answers.
3. `attachOverCdp` on that same endpoint gives a working page. After the
   attached session closes, the **first** session's page still loads a page.
   This proves rule 3.
4. `attachOverCdp("ws://127.0.0.1:1/devtools/browser/none")` rejects in under
   20 seconds with an error that contains the endpoint.

Use the fixture server in `tests/fixtures/serve.ts`, the way
`tests/gaps.test.ts` uses it. Pick ports with `start(0)`, which takes a free
port, so the tests do not collide.

## Verification

Both commands must pass, and you must paste the real output:

```sh
npx vitest run tests/browser.test.ts
npx tsc --noEmit
```

Write the tests first. Run them and see them fail. Then write `src/browser.ts`
until they pass. Do not weaken a test to make it pass.
