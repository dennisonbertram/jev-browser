# jev-browser

A browser agent that picks its next action from a numbered table of the page's
controls. It does not write the action. A classifier chooses one operation and
one element; a small language model runs only to write field text.

## Side by side on yahoo.com

![jev-browser against a production worker on yahoo.com](docs/jev-vs-production-worker.gif)

Both agents received the goal "Open the Finance section." on the same site, in
the same browser, run back to back. jev-browser finished in **2.13 s** with 2
decisions. The production worker finished in **8.20 s** with 4 decisions. The
film is [docs/jev-vs-production-worker.mp4](docs/jev-vs-production-worker.mp4),
and each clip starts when its agent starts, after the page has loaded.

## Measured on this machine

- **4 to 6 ms** to read a whole page, every frame, into a numbered table.
  Median of 12 runs for each page: 5 ms for a form, 4 ms through nested shadow
  DOM, 6 ms across a cross-origin iframe, 6 ms for a 10-control page.
- **266 ms** median for one decision from the live classifier, over 8 calls.
  Across 34 decisions in an earlier run: 170 ms warm, 379 ms for the first call
  of a run.
- **29 ms** median to act: re-resolve the element, re-validate it, dispatch real
  mouse and keyboard input.
- **1,289 ms** median for a whole task, over 27 runs across 9 journeys.
- **281 ms** to attach to a remote browser, **133 ms** to read a page on it.

Against the same nine journeys in the same browser, a production worker that
uses an LLM tool-calling loop took **14,454 ms** median and 1.48M tokens, at
21/27 tasks completed. This library took **1,289 ms** and 182k tokens, at 25/27.
A third arm, this same engine with the LLM deciding instead of the classifier,
took **37,110 ms**. The engine is identical in that comparison, so the
difference is the decision.

## What it does

The library reads the whole page, not one document:

- open shadow DOM, at any depth, and slotted content
- same-origin iframes and cross-origin iframes
- nested scroll containers, and not only the window
- native `select` elements, one action for each enabled option
- widgets that answer only to keys
- file inputs, from a directory the caller names
- pop-up tabs
- canvas regions, reported so a picture can read them

It counts closed shadow roots through the Chrome DevTools Protocol, because page
script cannot see inside one. It reports the count and does not guess.

## The seven tools an agent calls

| Tool | What it does |
| --- | --- |
| `browser_observe` | Return the numbered table of controls. |
| `browser_act` | Click the control at an index, or choose a select option. |
| `browser_type` | Type text into the field at an index. |
| `browser_login` | Fill the credential fields from your source. |
| `browser_screenshot` | Return PNG bytes with the secret fields covered. |
| `browser_scroll` | Scroll one region, up or down. |
| `browser_switch_tab` | Make another open tab active. |

An index into the last observation is the only way to name an element. No tool
takes a selector, an XPath, a coordinate, or code.

## Install

```sh
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

Set `TYPESAFE_API_KEY`. Set `TEXT_MODEL_API_KEY` for tasks that type text; any
OpenAI-compatible endpoint works, named by `TEXT_MODEL_BASE_URL`.

## Run one task

```ts
import { chromium } from "playwright";
import { runOnce } from "jev-browser";

const browser = await chromium.launch();
const result = await runOnce(browser, "https://example.com/", {
  goal: "Open the link named Learn more.",
});
console.log(result.status, result.elapsedMs);
await browser.close();
```

## Mount the tools in your agent

```ts
import { createToolHost } from "jev-browser";

const host = createToolHost({ context, credentials, uploadDir });
const tools = host.definitions();      // give these to your model
const out = await host.call("browser_observe", {});
```

## Attach to a browser you already run

```ts
import { attachOverCdp } from "jev-browser";

const session = await attachOverCdp(remote.cdp_ws_url);
// session.close() disconnects. It never closes a browser you own.
```

[docs/integration.md](docs/integration.md) covers all three patterns, remote
browsers, session state across processes, and telemetry.

## What the library guarantees

1. A model returns an index into a table the library observed. It never returns
   a selector, a coordinate, a file path, a key name, or code.
2. The library re-resolves that index and re-checks the element immediately
   before it sends input. A stale decision is refused.
3. A field that holds a secret never gives up its value. A password, a one-time
   code and a new password report a character count. The value cannot reach the
   table a model reads, the classifier request, or the run history.
4. `browser_screenshot` covers those fields during capture, so a picture holding
   a secret never exists. `screenshotPage` and `screenshotCanvas` do not redact;
   use them on a page you know to be safe.
5. A credential value never enters a prompt, a return value, a log, or an error.
   An error from your credential source is replaced, because the original can
   quote the value.
6. An attached session disconnects and never closes a browser you own.
7. Session state holds an endpoint, a url and a fingerprint. It holds no element
   index, no cookie and no secret. A url can carry a token, so treat it as
   sensitive.
8. Text typed through the tools may not hold a control character, because a
   newline is Enter and a tab moves focus.

## Tests

```sh
pnpm run test    # 79 tests, real Chromium, local fixtures, no network
pnpm run types
```

## Limits

- The classifier declines some tasks it could finish. In one journey it chose
  `BLOCKED` while a usable link was in its own table. The policy is sensitive to
  the words in the goal.
- A task that types text needs a second model. Both it and the classifier are
  network calls, and both can fail.
- A `DONE` decision is an opinion. Confirm the result from the page.
- A page evaluation has no deadline of its own. A page that suspends animation
  frames can outlast `settle`.
- The fixtures are local. They hold a login, but no consent banner, no
  single-page route change, and no bot detection.

## Credit

This library reimplements the design of
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) by Browser Use, in
TypeScript. See NOTICE.
