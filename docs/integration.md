# How to add this library to a product

This guide shows the three ways to mount the library. Each example is complete.
Read `README.md` first for what the library does.

## What you must supply

| You supply | Why |
| --- | --- |
| A Chromium browser, local or remote | The library drives a browser; it does not choose one for you. |
| `TYPESAFE_API_KEY` | The classifier that selects an operation and a target. |
| `TEXT_MODEL_API_KEY` and `TEXT_MODEL_BASE_URL` | Only for tasks that type text. Any OpenAI-compatible endpoint works. |
| A credential source | Only for tasks that log in. The library never holds a secret itself. |
| An upload directory | Only for tasks that attach a file. The library never accepts a path from a model. |

## Way 1: run one task

Use this when the product gives a goal and wants a result.

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

`result.status` is `done` or `blocked`. A `done` status is the classifier's
opinion. Confirm the outcome from the page.

## Way 2: mount the tools in an agent

Use this when your own agent decides what to do. The tool host publishes seven
tools with JSON Schemas. Give the definitions to your model, and route each call
back to `host.call`.

```ts
import { chromium } from "playwright";
import { createToolHost } from "jev-browser";

const browser = await chromium.launch();
const context = await browser.newContext();
await (await context.newPage()).goto("https://example.com/");

const host = createToolHost({
  context,
  // Optional. Without it, browser_login refuses.
  credentials: {
    get: async (kind, origin) => vault.read(kind, origin),
  },
  // Optional. Without it, a file upload refuses.
  uploadDir: "/var/app/uploads",
});

// Declare the tools to your model.
const tools = host.definitions().map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

// Route one call from your model.
const result = await host.call("browser_observe", {});
console.log(result.ok, result.text);
```

The model must call `browser_observe` before any tool that takes an index. An
index refers to the table that the last observation returned.

## Way 3: use the parts

Use this when you want your own loop.

```ts
import { observe, actionSpace, decide, execute } from "jev-browser";

const observation = await observe(context);
const space = actionSpace(observation.actions);
const decision = await decide(observation, "Choose the VIP ticket type.", []);
const action = observation.actions.find((entry) => entry.id === decision.choice);
if (action) await execute(context, observation, action, {});
```

## Attach to a browser the product already owns

Production usually runs a browser somewhere else. Attach to its Chrome DevTools
Protocol endpoint.

```ts
import { attachOverCdp } from "jev-browser";

const session = await attachOverCdp(remote.cdp_ws_url);
try {
  // Use session.context with any of the three ways above.
} finally {
  // This disconnects. It never closes a browser your product owns.
  await session.close();
}
```

## Continue a task in a later process

A turn can end before a task does. Save the state, and restore it later.

```ts
import { saveSessionState, restoreSessionState } from "jev-browser";

const state = saveSessionState(session, observation);
await store.put(taskId, state);

// In a later process:
const restored = await restoreSessionState(await store.get(taskId));
if (restored.changed) {
  // The page moved while the task was away. Observe and decide again.
}
```

The state holds an endpoint, a url and a fingerprint. It holds no element index,
because an index belongs to one observation. It holds no secret and no cookie.

## Telemetry

Pass a tracer to record each step.

```ts
import { createTracer, createToolHost } from "jev-browser";

const tracer = createTracer({ sink: (event) => log.info(event) });
const host = createToolHost({ context, tracer });
// ...
console.log(tracer.summary());
```

A `text` event records the number of characters, never the text, because a field
value can be a secret.

## Rules the library keeps, so your product does not have to

1. A model never returns a selector, a coordinate, a file path, a key name, or
   code. A model returns an index into a table the library observed.
2. The library resolves that index to a node, and checks the node again
   immediately before it sends input.
3. A screenshot covers the regions that hold secrets during capture. An
   unredacted picture never exists.
4. A credential value never enters a prompt, a return value, a log, or an error
   message.
5. An attached session never closes a browser your product owns.
