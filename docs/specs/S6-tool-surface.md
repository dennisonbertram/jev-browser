# S6: The agent tool surface

Read `docs/specs/CONVENTIONS.md` first.

## Purpose

An agent framework must be able to mount this library without knowing anything
about it. This subsystem publishes the tools an agent can call, in the shape
every framework expects: a name, a description, a JSON Schema, and one function
that runs a call.

This is the drop-in surface. A product mounts these tools and the agent can
drive a browser.

## Files you may create or change

- `src/tools.ts` (new)
- `tests/tools.test.ts` (new)

Do not change `src/index.ts`; the integrator adds the exports.

## The contract

```ts
/** One tool an agent may call. */
export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
};

/** What a call returns to the agent. */
export type ToolResult = {
  /** Text for the model. Never a secret, never a raw DOM dump. */
  text: string;
  /** True when the call did what it said. */
  ok: boolean;
};

export type ToolHost = {
  definitions: () => ToolDefinition[];
  /** Run one call by name. Unknown name, or bad arguments, returns ok: false. */
  call: (name: string, args: unknown) => Promise<ToolResult>;
};

export function createToolHost(options: {
  context: BrowserContext;
  /** Optional, for credential fills. */
  credentials?: CredentialSource;
  /** Optional, for telemetry. */
  tracer?: Tracer;
  /** Directory for uploads. Absent means uploads are refused. */
  uploadDir?: string;
}): ToolHost;
```

## The tools to publish

| Name | What it does |
| --- | --- |
| `browser_observe` | Return the numbered table of controls, as text. |
| `browser_act` | Perform one action by its index in the table. |
| `browser_type` | Type a caller-supplied string into an indexed field. |
| `browser_login` | Fill the credential fields from the source. |
| `browser_screenshot` | Return a redacted picture. |
| `browser_scroll` | Scroll a named scroll region. |
| `browser_switch_tab` | Make another tab active. |

## Rules

1. An index is the only way to name an element. No tool accepts a selector, an
   XPath, a coordinate, or JavaScript. This is the library's central rule and the
   tool surface is where a caller would most easily break it.
2. Every tool validates its arguments against its own schema before it acts. Bad
   arguments return `ok: false` with a short reason. They never throw.
3. `browser_observe` must be called before any tool that takes an index. An
   index with no observation returns `ok: false`.
4. An index that is not in the current observation returns `ok: false`. It never
   acts on a different element.
5. `browser_screenshot` always redacts the regions that hold secrets by nature.
   It has no option to skip redaction.
6. `browser_login` reports only which kinds were filled. It never returns a
   value.
7. A tool result is short. Cap the observation text so a page cannot flood a
   model's context; state the cap in the description.

## The tests you must write, and they must pass

In `tests/tools.test.ts`, against the fixtures:

1. `definitions` returns all seven tools, each with a name, a description, and a
   `parameters` object.
2. `browser_observe` on `select.html` returns text that contains the label
   `Ticket type`.
3. `browser_act` with a valid index clicks. Prove it from the page.
4. `browser_act` before any observation returns `ok: false`.
5. `browser_act` with an index of 9999 returns `ok: false`, and the page is
   unchanged.
6. Every tool rejects a selector-shaped argument: pass `{ selector: "#go" }` and
   assert `ok: false`.
7. `browser_login` on `login.html` fills both fields, and the result text
   contains neither value.
8. `browser_screenshot` on `secrets.html` returns a picture, and the password
   field's pixels are black.
9. `browser_type` types a caller string into an indexed field.
10. Unknown tool name returns `ok: false`.

## Verification

```sh
npx vitest run
npx tsc --noEmit
```

Both must pass with zero failures and zero errors. Write the tests first.
