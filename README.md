# jev-browser

A browser agent that selects an action from a numbered table of the controls on
the page. It does not generate the action.

Most browser agents ask a language model to write the next step. This library
asks a classifier to make two choices: one operation, and one target element.
The choices are indexes into a table that the library built from the page. A
small language model runs only when the operation types text.

The result is a decision in approximately 170 ms, in place of a model turn of 8
to 20 seconds.

## The rule that makes this safe

A model never returns a selector, a coordinate, a file path, a key name, or
code. A model returns an index into a table of elements that this library
observed. The library resolves the index to an element. The library then checks
the element again, immediately before it sends the input.

## What the library supports

The library reads the complete page, not one document:

- open shadow DOM, at any depth, and slotted content
- same-origin iframes and cross-origin iframes
- nested scroll containers, and not only the window
- native `select` elements, with one action for each enabled option
- widgets that answer only to keys
- file inputs, from a directory that the caller supplies
- pop-up tabs
- canvas elements, which it reports but cannot read

The library counts closed shadow roots through the Chrome DevTools Protocol.
Page script cannot see a closed root. The library reports the count. It does not
guess the contents.

## Install

```sh
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

Set `TYPESAFE_API_KEY`. Set `TEXT_MODEL_API_KEY` if your tasks type text. The
text helper uses any endpoint that accepts the OpenAI chat-completions
protocol. Set the endpoint with `TEXT_MODEL_BASE_URL`.

## Use the library

```ts
import { chromium } from "playwright";
import { runOnce } from "jev-browser";

const browser = await chromium.launch();
const result = await runOnce(browser, "https://example.com/", {
  goal: "Open the link named Learn more.",
});
console.log(result.status, result.elapsedMs, result.history.length);
await browser.close();
```

`runOnce` opens a context, runs the loop, and closes the context. The result
gives the status, the elapsed time, each decision with its latency and
probability, and each action with the text that the helper generated.

## Run the tests

```sh
pnpm run test      # 22 tests, real Chromium, local fixtures, no network
pnpm run types
```

The tests start a fixture server on two ports. Two ports are necessary, because
one fixture must load a child document from a different origin.

## Measurements

The numbers below come from 81 runs in one browser, across nine journeys, with
three repetitions for each arm and journey. The Partyline repository holds the
benchmark.

| Arm | Success | Median time | Tokens |
| --- | --- | ---: | ---: |
| this library, the classifier decides | 25/27 | 1289 ms | 181,871 |
| a worker on browser-loop, a model decides | 21/27 | 14,454 ms | 1,483,107 |
| this library, a model decides | 27/27 | 37,110 ms | 166,639 |

The three arms used the same browser and the same success test. The difference
between the first and the third arm is the decision, and nothing else.

The library also drives a remote browser through the Chrome DevTools Protocol.
Measured against a Kernel browser: attach 419 ms, and one observation 211 ms.

## Limits

- The classifier declines some tasks that it can complete. In one journey it
  chose `BLOCKED` while a usable link was in its own table. The policy is
  sensitive to the words in the goal.
- The vendor reports token counts for the classifier. The vendor does not report
  a price. The cost for each task is therefore not known.
- A `DONE` decision is an opinion. Confirm the result from the page.
- The fixtures are local. They do not contain a login, a consent banner, a
  single-page application route change, or bot detection.

## Credit

This library reimplements the design of
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) by Browser Use, in
TypeScript. See NOTICE.
