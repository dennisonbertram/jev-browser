# jev-browser

jev-browser is a TypeScript library that lets a program operate a web browser. It reads a page into a numbered table of its controls, decides which control to use, and acts on it with real mouse and keyboard input.

A classifier, not a general-purpose LLM, makes each decision. The classifier is [TypeSafe's Jev](https://docs.typesafe.ai), a hosted service that answers a multiple-choice question in roughly 170 to 270 ms. A small language model runs only to write the text that goes into a field.

## Result

Nine journeys, three repetitions each, all three agents in the same browser with the same goals and the same success test. A journey counts as done only when the page reaches its end state, which the harness checks, not the agent.

| Agent | Tasks done | Median task | Tokens |
| --- | --- | ---: | ---: |
| This library, classifier decides | 25/27 | **1,289 ms** | 182k |
| A browser worker on an LLM tool-calling loop | 21/27 | 14,454 ms | 1.48M |
| This same engine, an LLM decides | 27/27 | 37,110 ms | 167k |

The third row is the control: same engine, only the decision-maker changes. The cost is some success rate (25/27 against 27/27) in exchange for roughly 29x the speed, and about 8x fewer tokens than the tool-calling loop. The figures are also in [PROGRESS.md](PROGRESS.md).

On the live yahoo.com, with the goal "Open the Finance section.", this library finished in 2.13 s with 2 decisions. An LLM tool-calling agent with the same goal and browser took 8.20 s and 4 decisions ([film](docs/jev-vs-production-worker.mp4)).

**Status:** a working library, published as `@dennisonbertram/jev-browser` 0.1.0, with a local test suite and the benchmarks above. Known limits are listed below. Some subsystems in [PROGRESS.md](PROGRESS.md) are marked as still to do.

![jev-browser beside an LLM tool-calling agent on yahoo.com](docs/jev-vs-production-worker.gif)

## When to use it

Use it when the task is a known kind of web journey (fill a form, log in, find and click a link, upload a file) and you want it done in about a second with few tokens. It also suits agents that must keep credentials out of model context.

Do not use it when the task is open-ended, the journey is new each time, or a wrong action is costly enough that you need an LLM's judgment on every step. It drives Chromium only.

Two design properties:

- **Secrets stay out of prompts.** Password and one-time-code fields report a character count, never a value. Screenshots cover those fields during capture.
- **The agent cannot invent an action.** A model returns an index into a table the library observed. It never returns a selector, a coordinate, a file path, a key name, or code. The library re-checks the element immediately before sending input and refuses a stale decision.

## Run it

Requires Node 22 or newer.

```sh
npm install @dennisonbertram/jev-browser
npx playwright install chromium
```

Two keys go in `.env` (see `.env.example`). Neither belongs in your repository.

- `TYPESAFE_API_KEY` is the classifier, from <https://docs.typesafe.ai>. Every task needs it.
- `TEXT_MODEL_API_KEY` is a second, small model that writes the value for a field. Only a task that types needs it. Any endpoint that speaks the OpenAI chat-completions protocol works, set with `TEXT_MODEL_BASE_URL` and `TEXT_MODEL`:

| Provider | `TEXT_MODEL_BASE_URL` | A model that fits |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-nano` |
| Cerebras | `https://api.cerebras.ai/v1` | `qwen-3.8-27b` |
| Your own gateway | `https://your-gateway/v1` | whatever it serves |

Then give it a browser context and a goal:

```ts
import { chromium } from "playwright";
import { run } from "@dennisonbertram/jev-browser";

const browser = await chromium.launch();
const context = await browser.newContext();
await (await context.newPage()).goto("https://example.com");

const result = await run(context, { goal: "Open the link named More information." });
console.log(result.status, result.reason, result.elapsedMs);
await browser.close();
```

`runOnce(browser, url, { goal })` opens a fresh context for a single task. Pass `launchLocal({ headless: false })` to watch it work.

To work on the library itself:

```sh
git clone https://github.com/dennisonbertram/jev-browser.git
cd jev-browser
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
pnpm run test    # real Chromium, local fixtures, no network
pnpm run types
```

## Use it with an agent you already have

Give your model the seven tool definitions and route its calls through the host:

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

To drive a browser you already run instead of launching one:

```ts
import { attachOverCdp } from "@dennisonbertram/jev-browser";

const session = await attachOverCdp(remote.cdp_ws_url);
// session.close() disconnects. It never closes a browser you own.
```

| Tool | What it does |
| --- | --- |
| `browser_observe` | Return the numbered table of controls. |
| `browser_act` | Click the control at an index, or choose a select option. |
| `browser_type` | Type text into the field at an index. |
| `browser_login` | Fill the credential fields from your source. |
| `browser_screenshot` | Return PNG bytes with the secret fields covered. |
| `browser_scroll` | Scroll one region, up or down. |
| `browser_switch_tab` | Make another open tab active. |

[docs/integration.md](docs/integration.md) covers all three patterns, remote browsers, session state across processes, and telemetry.

## What it can see

The library reads the whole page, not one document: open shadow DOM at any depth, same-origin and cross-origin iframes, nested scroll containers, native `select` options, widgets that answer only to keys, file inputs from a directory the caller names, pop-up tabs, and canvas regions (reported so a picture can read them). It counts closed shadow roots through the Chrome DevTools Protocol and reports the count rather than guessing.

## Repo map

| Path | Contents |
| --- | --- |
| `src/` | The library: `observe`, `decide`, `execute`, `run`, `task`, `tools`, `redact`, `autofill`, and the other modules |
| `tests/` | Vitest suite and local fixtures |
| `examples/` | Runnable scripts: `live.ts`, `standalone.ts`, `journeys.ts`, `flights.ts` |
| `docs/` | [integration.md](docs/integration.md), [accessible-names.md](docs/accessible-names.md), and the per-subsystem specs in `docs/specs/` |
| `PROGRESS.md` | Subsystem status, the benchmark, and a log of review findings |
| `tools/implement.mjs` | The harness used to have a cheap model write code |

## Guarantees

1. A model returns an index into a table the library observed, never a selector, coordinate, file path, key name, or code.
2. The library re-resolves that index and re-checks the element immediately before it sends input. A stale decision is refused.
3. A field that holds a secret never gives up its value. A password, one-time code, or new password reports a character count. The value cannot reach the table a model reads, the classifier request, or the run history.
4. `browser_screenshot` covers those fields during capture. `screenshotPage` and `screenshotCanvas` do not redact; use them only on a page you know to be safe.
5. A credential value never enters a prompt, a return value, a log, or an error. An error from your credential source is replaced, because the original can quote the value.
6. An attached session disconnects and never closes a browser you own.
7. Session state holds an endpoint, a url and a fingerprint, and no element index, cookie or secret. A url can carry a token, so treat it as sensitive.
8. Text typed through the tools may not hold a control character, because a newline is Enter and a tab moves focus.

## Performance

Measured on an Apple M4 Max, macOS 15.7, Node 24, Playwright 1.63, headless Chromium. Each figure says how many runs it comes from. The timing scripts are in `examples/`.

- **4 to 6 ms** to read a whole page into a numbered table (median of 12 runs per page).
- **266 ms** median for one live classifier decision, over 8 calls. Across 34 decisions in an earlier run: 170 ms warm, 379 ms for the first call of a run.
- **29 ms** median to act: re-resolve the element, re-validate it, dispatch real input.
- **1,289 ms** median for a whole task, over 27 runs across 9 journeys.
- **281 ms** to attach to a remote browser, **133 ms** to read a page on it.

Two benchmarks run against live pages. Both need a classifier key and a text model; the figures use Cerebras `gpt-oss-120b` at medium reasoning effort.

```sh
npx tsx examples/journeys.ts 2   # seven journeys, four local and three public
npx tsx examples/flights.ts 5    # one hard journey on Google Flights
```

- **14 of 14** journeys pass, 2 repetitions each. Medians: Hacker News 677 ms, select 654 ms, cross-origin iframe 1.5 s, shadow DOM 1.9 s, Wikipedia 2.3 s, MDN 2.6 s, nested scroll 4.2 s.
- **12 of 12** Google Flights runs reach the flight list, median **10.1 s**, range 8.5 to 14.6 s, over about 22 classifier calls. Each run is checked against the finished page (cities, one-way setting, date, visible flight options), not against the agent's own `DONE`.

### Comparison with jev-ultrafast, a negative result

`jev-ultrafast` reports 7.073 s for the same Google Flights journey, in 17 decisions. This library is slower. Its median over twelve runs is 10.1 s, and its best single run is 8.45 s. Repeated batches of five runs on identical code gave 8.87 s and 10.53 s, so five runs is too few to state a median. The difference is classifier time: this library makes 22 calls to their 17, at about 225 ms each. Browser time (about 3.5 s) is below the roughly 4 s their figures imply. Even if the per-call latency were equal to theirs, this library would still be about 0.7 s behind, because of the five extra calls.

The extra calls are decisions thrown away because the page changed while the model was answering. About 5.4 s is the floor with nothing wasted. Ten attempts to recover the wasted decisions measured slower against a baseline, except two that were kept: focusing the chosen node directly when the click did not, and remembering classifier answers within a run. The rejected attempts were re-using a discarded decision, dropping or narrowing the freshness checks, asking the classifier during the settle wait, a longer quiet window, and abandoning a call once the page moved. They cut decisions but cost more time than they saved, because reading the page during a request raised each call's latency from about 200 ms to between 210 and 400 ms. Payload size is not a lever: latency is flat (161 to 210 ms) between 1,249 and 3,616 input tokens.

## Limits and risks

- The classifier declines some tasks it could finish. In one journey it chose `BLOCKED` while a usable link was in its own table. The policy is sensitive to the words in the goal.
- It finished 25/27 tasks in the 9-journey benchmark; the LLM-decides control finished 27/27. On the seven journeys in `examples/journeys.ts` it finishes all of them, and on Google Flights 12 of 12, but both are small samples.
- A task that types text needs a second model. Both it and the classifier are network calls, and both can fail.
- A `DONE` decision is an opinion. Confirm the result from the page.
- A page evaluation has no deadline of its own. A page that suspends animation frames can outlast `settle`.
- The test fixtures are local. They hold a login, but no consent banner, no single-page route change, and no bot detection. Behavior against those is unverified.
- Chromium only. Firefox and WebKit are not supported.

## License and credit

MIT. See LICENSE.

This library reimplements the design of [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) by Browser Use, in TypeScript. See NOTICE.
