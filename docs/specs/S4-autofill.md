# S4: Credential autofill

Read `docs/specs/CONVENTIONS.md` first.

## Purpose

An agent must log in without a model ever seeing the password. The model decides
*that* a login is needed and *which* field is which. The library holds the
secret and types it. The secret never enters a prompt, a log, a trace, or a
screenshot.

## Files you may create or change

- `src/autofill.ts` (new)
- `tests/autofill.test.ts` (new)
- `tests/fixtures/login.html` (new fixture)
- `src/index.ts` (add the new exports only)

Change no other file.

## The fixture

`tests/fixtures/login.html`:

- `<input id="u" aria-label="Email" autocomplete="username">`
- `<input id="p" type="password" aria-label="Password" autocomplete="current-password">`
- `<button id="go">Sign in</button>`
- `<p id="result">signed out</p>`
- A script: on click of `#go`, set `#result` to `signed-in:<username value>`.
  Write the username only. Never write the password to the page, so a leak in a
  test is visible.

## The contract

```ts
/** The caller holds the secrets. The library asks for them by field kind. */
export type CredentialSource = {
  /** Return the value for one field, or null when there is none. */
  get: (kind: "username" | "password" | "otp", origin: string) => Promise<string | null>;
};

/** What a fill attempt did, with no secret inside it. */
export type FillOutcome = {
  filled: ("username" | "password" | "otp")[];
  /** Fields the page offered that the source had no value for. */
  missing: ("username" | "password" | "otp")[];
  /** Node references the library typed into. */
  targets: NodeRef[];
};

/**
 * Find the login fields in an observation and fill them from the source.
 * The origin of the page is passed to the source, so a source can refuse a
 * secret to the wrong site.
 */
export function fillCredentials(
  context: BrowserContext,
  observation: PageObservation,
  source: CredentialSource
): Promise<FillOutcome>;

/** The login fields this observation offers, classified. */
export function findCredentialFields(
  observation: PageObservation
): { kind: "username" | "password" | "otp"; ref: NodeRef }[];
```

## Rules

1. Classify a field by its own attributes, in this order: the `autocomplete`
   attribute first, then `type="password"`, then a `name` or `id` that matches
   `user`, `email`, `pass`, `otp`, or `code`. Record which rule matched.
2. The **origin** that goes to the source is the origin of the frame that holds
   the field, not the top page. A login form inside a third-party iframe belongs
   to that third party, and the source must be able to tell.
3. A secret must never appear in: a thrown error, a returned object, a console
   line, or a `FillOutcome`. Return the kind of the field, never the value.
4. Type the secret with the executor's own path, so the node is re-validated
   before input, exactly as any other fill.
5. When the source returns `null` for a field, record it in `missing`. Do not
   type an empty string.
6. After a fill, the password value must not be readable from the returned data
   or from any string this module produced.

## The tests you must write, and they must pass

In `tests/autofill.test.ts`, against `login.html`:

1. `findCredentialFields` finds the username field and the password field, and
   classifies each correctly.
2. `fillCredentials` with a source that returns both values fills both. Prove it
   from the page: `#u` holds the username, and `#p` holds the password. Read
   `#p` with `inputValue()`.
3. The `FillOutcome` contains neither value. Serialise the whole outcome with
   `JSON.stringify` and assert the password string does not appear in it.
4. A source that returns `null` for the password fills the username only, and
   reports `password` in `missing`. `#p` stays empty.
5. The source receives the origin of the page. Assert the exact origin string
   the fixture is served from.
6. A source that throws makes `fillCredentials` reject, and the error message
   does not contain the password. Pass a source whose `get` throws an error
   whose own message contains the password, and assert the rejection message
   does not carry it. This proves the library does not pass a source error
   through unfiltered.

## Verification

```sh
npx vitest run
npx tsc --noEmit
```

Both must pass with zero failures and zero errors. Write the tests first.
