# jev-browser

jev-browser is a TypeScript library that lets a program operate a web browser:
it reads a page into a numbered table of its controls, decides which control to
use, and acts on it with real mouse and keyboard input.

The decision is made by a classifier, not a general-purpose LLM. The
classifier is [TypeSafe's Jev](https://docs.typesafe.ai), a hosted service that
answers a multiple-choice question in roughly 170 to 270 ms. The classifier
chooses one operation and one element. A small language model runs only to
write the text that goes into a field. This is why it is fast: in a head-to-head
run on the live yahoo.com, this library finished a task in **2.13 s** with 2
decisions, while an LLM tool-calling agent with the same goal and the same
browser took **8.20 s** and 4 decisions
([film](docs/jev-vs-production-worker.mp4)).

If you are building an agent that needs to click, type, scroll, and log in on
real web pages, and you care about speed, token cost, or keeping secrets out of
prompts, this library is the browser layer. If you need an agent that reasons
freely about novel tasks, writes its own actions, or works outside a browser,
this is not it.

## See it

![jev-browser beside an LLM tool-calling agent on yahoo.com](docs/jev-vs-production-worker.gif)

Both agents were given "Open the Finance section." on the live site, in the
same browser, one after the other. Each clip starts when its agent starts, so
the timer measures the task and not the page load.
[Full film](docs/jev-vs-production-worker.mp4).

## Why use it instead of an LLM tool-calling loop

A typical browser agent sends the page to an LLM at every step and lets the LLM
pick the next tool call. That works, but each decision costs a full model
round-trip and a large prompt. jev-browser replaces that per-step LLM decision
with a classifier that reads a compact numbered table of the page's controls.

Measured comparison: nine journeys, three repetitions each, all three agents in
the same browser with the same goals and the same success test. A journey
counts as done only when the page reaches its end state, which the harness
checks, not the agent.

| Agent | Tasks done | Median task | Tokens |
| --- | --- | ---: | ---: |
| This library, classifier decides | 25/27 | **1,289 ms** | 182k |
| A browser worker on an LLM tool-calling loop | 21/27 | 14,454 ms | 1.48M |
| This same engine, an LLM decides | 27/27 | 37,110 ms | 167k |

The third row is the control. It runs this library's engine and changes only
who picks the action. 1,289 ms against 37,110 ms is therefore the cost of the
decision, and not of the browser layer. The trade: the LLM-decides row finished
27/27 tasks against the classifier's 25/27, so you give up some success rate
for roughly 29x the speed, and 8x fewer tokens than the tool-calling loop.

Two more reasons, independent of speed:

- **Secrets stay out of prompts.** Password and one-time-code fields report a
  character count, never a value. Screenshots cover those fields during
  capture. A credential value never enters a prompt, a return value, a log, or
  an error.
- **The agent cannot invent an action.** A model returns an index into a table
  the library observed. It never returns a selector, a coordinate, a file
  path, a key name, or code. The library re-resolves and re-checks the element
  immediately before sending input; a stale decision is refused.

## Who it is for

- You are building an agent that must operate real web pages: forms, logins,
  file uploads, multi-tab flows, pages with shadow DOM or iframes.
- You already have an agent or model host and need a safe, fast browser tool
  layer for it.
- You care about keeping credentials and secrets out of model context.

It is not for you if:

- Your task needs open-ended reasoning at every step. The classifier decides
  from a fixed table; it declines some tasks it could finish (see Limits).
- You need to drive anything other than a Chromium browser.
- You cannot make network calls to the classifier and text-model endpoints.

## When to reach for it

Reach for it when a task is a known kind of web journey — fill this form, log
in, find and click this link, upload a file — and you want it done in about a
second with few tokens. Do not reach for it when the task is ambiguous, the
journey type is new each time, or the cost of a wrong action is high and you
need an LLM's judgment on every step. A `DONE` decision from the classifier is
an opinion; confirm the result from the page.

## Use it with an agent you already have

Give your model the seven tool definitions and route its calls through the
host:

```ts
import { createToolHost } from "@dennisonbertram/jev-browser";

const host = createToolHost({
  // A Playwright BrowserContext you own.
  context,
  // Optional. Without it, browser_login refuses. You hold the secrets; the
  // library asks for one by kind and by the origin of the frame that needs it.
  credentials: {
    get: async (kind, origin) => vault.read(kind, origin), // "username" | "password" | "otp"
  },
  // Optional. Without it, a file upload refuses. The library picks a file from
  // this directory; it never accepts a path from a model.
  uploadDir: "/var/app/uploads",
});

const tools = host.definitions();      // give these to your model
const out = await host.call("browser_observe", {});
```

An index into the last observation is the only way to name an element. No tool
takes a selector, an XPath, a coordinate, or code.

To drive a browser you already run instead of launching one:

```ts
import { attachOverCdp } from "jev-browser";

const session = await attachOverCdp(remote.cdp_ws_url);
// session.close() disconnects. It never closes a browser you own.
```

[docs/integration.md](docs/integration.md) covers all three patterns, remote
browsers, session state across processes, and telemetry.

## Try it in five minutes

Add it to a project:

```sh
npm install @dennisonbertram/jev-browser
npx playwright install chromium
```

Then give it a browser context and a goal:

```ts
import { chromium } from "playwright";
import { run } from "jev-browser";

const browser = await chromium.launch();
const context = await browser.newContext();
await (await context.newPage()).goto("https://example.com");

const result = await run(context, { goal: "Open the link named More information." });
console.log(result.status, result.reason, result.elapsedMs);
await browser.close();
```

To work on the library itself:

```sh
git clone https://github.com/dennisonbertram/jev-browser.git
cd jev-browser
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

Node 22 or newer. Chromium only: the library drives Chromium through
Playwright, locally or over the Chrome DevTools Protocol. Firefox and WebKit
are not supported. Pass `launchLocal({ headless: false })` to watch it work.

Two keys go in `.env`, and neither belongs in your repository.

`TYPESAFE_API_KEY` is the classifier, from <https://docs.typesafe.ai>. Every
task needs it.

`TEXT_MODEL_API_KEY` is a second, small model that writes the value for a
field. Only a task that types needs it. Any endpoint that speaks the OpenAI
chat-completions protocol works, so pick whichever you already pay for:

| Provider | `TEXT_MODEL_BASE_URL` | A model that fits |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-nano` |
| Cerebras | `https://api.cerebras.ai/v1` | `qwen-3.8-27b` |
| Your own gateway | `https://your-gateway/v1` | whatever it serves |

The job is small: turn a goal and a field label into one short string. A fast
cheap model is the right choice, and the library rejects a reply that is not a
single JSON object holding one key.

Then run one task:

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

## What it costs you

- **Two network services.** The classifier (`TYPESAFE_API_KEY`) makes a call
  per decision. Tasks that type text need a second model
  (`TEXT_MODEL_API_KEY`, any OpenAI-compatible endpoint). Both can fail.
- **Chromium.** Installed via `pnpm exec playwright install chromium`. The
  library drives it through Playwright.
- **Tokens.** 182k tokens across 27 runs in the benchmark above, versus 1.48M
  for the LLM tool-calling worker — but not zero.

## What the agent can see and do

The library reads the whole page, not one document:

- open shadow DOM, at any depth, and slotted content
- same-origin iframes and cross-origin iframes
- nested scroll containers, and not only the window
- native `select` elements, one action for each enabled option
- widgets that answer only to keys
- file inputs, from a directory the caller names
- pop-up tabs
- canvas regions, reported so a picture can read them

It counts closed shadow roots through the Chrome DevTools Protocol, because
page script cannot see inside one. It reports the count and does not guess.

The seven tools an agent calls:

| Tool | What it does |
| --- | --- |
| `browser_observe` | Return the numbered table of controls. |
| `browser_act` | Click the control at an index, or choose a select option. |
| `browser_type` | Type text into the field at an index. |
| `browser_login` | Fill the credential fields from your source. |
| `browser_screenshot` | Return PNG bytes with the secret fields covered. |
| `browser_scroll` | Scroll one region, up or down. |
| `browser_switch_tab` | Make another open tab active. |

## What the library guarantees

1. A model returns an index into a table the library observed. It never returns
   a selector, a coordinate, a file path, a key name, or code.
2. The library re-resolves that index and re-checks the element immediately
   before it sends input. A stale decision is refused.
3. A field that holds a secret never gives up its value. A password, a one-time
   code and a new password report a character count. The value cannot reach the
   table a model reads, the classifier request, or the run history.
4. `browser_screenshot` covers those fields during capture, so a picture
   holding a secret never exists. `screenshotPage` and `screenshotCanvas` do
   not redact; use them on a page you know to be safe.
5. A credential value never enters a prompt, a return value, a log, or an
   error. An error from your credential source is replaced, because the
   original can quote the value.
6. An attached session disconnects and never closes a browser you own.
7. Session state holds an endpoint, a url and a fingerprint. It holds no
   element index, no cookie and no secret. A url can carry a token, so treat it
   as sensitive.
8. Text typed through the tools may not hold a control character, because a
   newline is Enter and a tab moves focus.

## Performance

Measured on an Apple M4 Max, macOS 15.7, Node 24, Playwright 1.63, headless
Chromium. Each figure says how many runs it comes from. Reproduce them with
`pnpm run test` for correctness and the scripts in `examples/` for timing.

- **4 to 6 ms** to read a whole page, every frame, into a numbered table.
  Median of 12 runs for each page: 5 ms for a form, 4 ms through nested shadow
  DOM, 6 ms across a cross-origin iframe, 6 ms for a 10-control page.
- **266 ms** median for one decision from the live classifier, over 8 calls.
  Across 34 decisions in an earlier run: 170 ms warm, 379 ms for the first call
  of a run.
- **29 ms** median to act: re-resolve the element, re-validate it, dispatch
  real mouse and keyboard input.
- **1,289 ms** median for a whole task, over 27 runs across 9 journeys.
- **281 ms** to attach to a remote browser, **133 ms** to read a page on it.

Two benchmarks run against live pages. Both need a classifier key and a text
model; the figures below use Cerebras `gpt-oss-120b` at medium reasoning
effort.

```sh
npx tsx examples/journeys.ts 2   # seven journeys, four local and three public
npx tsx examples/flights.ts 5    # one hard journey on Google Flights
```

- **14 of 14** journeys pass, 2 repetitions each. Medians: Hacker News
  677 ms, select 654 ms, cross-origin iframe 1.5 s, shadow DOM 1.9 s,
  Wikipedia 2.3 s, MDN 2.6 s, nested scroll 4.2 s.
- **12 of 12** Google Flights runs reach the flight list, median
  **10.1 s**, range 8.5 to 14.6 s. Roughly half of that is waiting on the
  classifier, over about 22 calls. Each run is checked against the finished
  page, not against the agent's own `DONE`: the cities, the one-way setting,
  the date and visible flight options.

`jev-ultrafast` reports 7.073 s for this journey. Two cautions about that
comparison, both of which cut against reading too much into any single
figure. Their number is **one demonstration run**, which their README says
plainly; ours is the median of five. And repeated batches of five, on
identical code, have come out at 8.87 s and at 10.53 s, so batch-to-batch
spread here is about 18%. Five runs is too few to state a median: the 8.87 s
first published here was a lucky batch, and twelve runs put it at 10.1 s.
Our best single run is 8.45 s, still slower than their 7.073 s, so neither
caution rescues the result.

The task is theirs, near enough verbatim: "Find one-way flights from Zurich
to London on ... for one adult in economy", with the date moved forward
because theirs has passed. The timing boundary is theirs too, starting after
the first observation. The independent check now verifies the one-way
setting and the date as well as the cities and visible flights, matching
what theirs verifies.

Their run is 17 decisions at We are slower, and the whole difference is classifier time: we
make 22 calls where they make 17, and each of ours takes about 225 ms from
this machine. Our browser time, 3.5 s, is below the roughly 4 s their figures
imply. Both measurements start after the first observation.

Where the time goes, per action, measured: settle 230 ms, observe 28 ms,
classifier 225 ms, execute 24 ms. Ten actions and four text calls put the
floor at about 5.4 s with nothing wasted, so the target is not out of reach
in principle. The distance from 5.4 s to 10.1 s is decisions thrown away
because the page changed while the model was answering.

Nine separate attempts to recover them measured slower against a five-run
baseline, and are recorded here. Two of them were later re-tested against a
twelve-run baseline and kept, marked below: five runs could not tell them
apart from noise. The rest are not worth retrying.

| attempt | result |
|---|---|
| Re-use a discarded decision when the action table is unchanged | 1/5 verified |
| Drop the acting frame's marker check in `execute()` | 13.6 s, 4/5 |
| Compare only the acting frame's marker in `fresh()` | 10.4 s, decisions rose |
| Ask the classifier during the settle wait, keep the answer if the settled page matches | 10.0 s, 45% of answers usable |
| Focus the chosen node directly when the click did not | **kept**: 10.1 s vs 10.45 s, and 12/12 rather than 11/12 |
| Require a longer quiet window so fewer decisions go stale | 10.2 s, 4/5 |
| Abandon a classifier call once the page has moved, watching every frame | 11.9 s, 15 decisions |
| The same, watching one marker on one frame | 12.3 s, 14 decisions |
| Remember answers within a run, keyed by the exact request | **kept**, with the above |

The last three are the interesting failures, because they all worked as
intended and still lost. A longer quiet window cut decisions from 22 to 18.
Abandoning a call the moment the page moved cut them to 14, the fewest of
anything tried. In each case the cost of getting there exceeded the calls
saved: settling longer costs every action, and an abandoned call still burns
the time before it is abandoned and is then paid for again in full.

Payload size is not a lever either. Classifier latency is flat between 1,249
and 3,616 input tokens, at 161 ms to 210 ms, so trimming the table would not
make a call faster.

Nor is repetition. The classifier is effectively a function of its request:
asked the same thing six times it gave the same operation and target every
time, varying only confidence between 0.960 and 0.980. But a run repeats an
identical request only about three times, so remembering answers saves about
0.7 s in theory, and measured slower in practice. An earlier count of 47
repeats was an artefact of running several journeys in one process, where
they share their opening states. The first three relax what counts as a stale page, and each let the agent act
on a page that had moved on, which cost more actions than it saved calls. The
fourth cannot work in principle: the snapshot it asks from is taken during
the settle, so it predates the very change being waited for. The freshness
checks cost calls and earn them back.

Network is a smaller part of this than it first appears. The round trip to
the classifier from the machine these figures come from is **78 ms**, the
median of five samples, and a warm request on a kept-alive connection costs
79 ms. Our calls average 227 ms, so roughly 150 ms of each is the service
thinking, not the wire.

Normalising the network away does not close the gap, so it is worth stating
plainly rather than leaving as a get-out. Charging our 22 calls at the
178 ms `jev-ultrafast` reports per call:

| | calls | classifier | everything else | total |
|---|---|---|---|---|
| jev-ultrafast, reported | 17 | 3.03 s | 4.05 s | **7.07 s** |
| this library, measured | 22 | 5.00 s | 3.87 s | **8.87 s**, one batch of 5 |
| this library, at their per-call latency | 22 | 3.92 s | 3.87 s | **7.79 s** |

We are ahead on everything that is not the classifier, by 0.18 s. At equal
per-call latency we are still 0.71 s behind, and all of it is the five extra
calls. Matching them means cutting the wasted decisions, not the wire. This
assumes both use the same classifier service, which the per-call figures are
consistent with but which has not been confirmed.

## Limits and risks

- The classifier declines some tasks it could finish. In one journey it chose
  `BLOCKED` while a usable link was in its own table. The policy is sensitive
  to the words in the goal.
- The classifier finished 25/27 tasks in the 9-journey benchmark; the
  LLM-decides control finished 27/27. You trade some success rate for speed.
  On the seven journeys in `examples/journeys.ts` it now finishes all of
  them, and on Google Flights 12 of 12, but both are small samples.
- A task that types text needs a second model. Both it and the classifier are
  network calls, and both can fail.
- A `DONE` decision is an opinion. Confirm the result from the page.
- A page evaluation has no deadline of its own. A page that suspends animation
  frames can outlast `settle`.
- The test fixtures are local. They hold a login, but no consent banner, no
  single-page route change, and no bot detection. Behavior against those is
  unverified.

## Tests

```sh
pnpm run test    # 97 tests, real Chromium, local fixtures, no network
pnpm run types
```

## License

MIT. See LICENSE.

## Credit

This library reimplements the design of
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) by Browser Use,
in TypeScript. See NOTICE.
