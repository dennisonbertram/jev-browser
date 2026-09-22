# S7: Session state

Read `docs/specs/CONVENTIONS.md` first.

## Purpose

A production agent does not hold one process open for a whole task. A turn ends,
the process may end with it, and a later turn must continue against the same
browser. This subsystem carries the state that a later process needs.

## Files you may create or change

- `src/session-state.ts` (new)
- `tests/session-state.test.ts` (new)

Do not change `src/index.ts`.

## The contract

```ts
/** Everything a later process needs to continue against the same browser. */
export type SessionState = {
  /** Format version, so an old state is refused rather than misread. */
  version: 1;
  /** The endpoint to attach to. */
  cdpUrl: string;
  /** The url of the active page when the state was saved. */
  url: string;
  /** The observation fingerprint when the state was saved. */
  fingerprint: string;
  /** When it was saved, in milliseconds. */
  savedAt: number;
};

export function saveSessionState(
  session: BrowserSession,
  observation: PageObservation,
  now?: () => number
): SessionState;

/**
 * Attach to the browser the state names, and confirm it is still the page the
 * state was saved against.
 */
export function restoreSessionState(
  state: SessionState,
  options?: { maxAgeMs?: number; requireSameUrl?: boolean }
): Promise<{ session: BrowserSession; observation: PageObservation; changed: boolean }>;

/** True when the state is the right shape and version. */
export function isSessionState(value: unknown): value is SessionState;
```

## Rules

1. Element indexes are **not** part of the state. An index belongs to one
   observation and a later process must observe again. Carrying an index across
   processes would let a stale index act on a different element, which is the
   failure this library exists to prevent.
2. `restoreSessionState` observes the page again and returns the new observation.
   `changed` is true when the new fingerprint differs from the saved one.
3. A state older than `maxAgeMs` (default 15 minutes) is refused with a clear
   error. A stale state usually means the browser is gone.
4. With `requireSameUrl` true, a different url is refused. The default is false,
   because a page can navigate legitimately between turns.
5. A state that fails `isSessionState`, or carries a version this build does not
   know, is refused. Never guess at an unknown shape.
6. The state holds no secret, no cookie and no token. It holds an endpoint and
   two identifiers.

## The tests you must write, and they must pass

In `tests/session-state.test.ts`:

1. Save and restore against a live local browser: launch with a cdp port,
   observe `select.html`, save, restore, and assert the restored observation
   finds the `Ticket type` control.
2. `changed` is false when nothing moved, and true after the page navigates to a
   different fixture.
3. A state older than `maxAgeMs` is refused, and the message says so.
4. `requireSameUrl` true refuses a navigated page and false accepts it.
5. `isSessionState` rejects: null, a string, an object missing `cdpUrl`, and one
   with `version: 2`.
6. The saved state carries no element index: serialise it and assert it holds
   only the documented fields.
7. Restoring a state whose endpoint is gone rejects with an error that names the
   endpoint, and does so in under 20 seconds.

## Verification

```sh
npx vitest run tests/session-state.test.ts
npx tsc --noEmit
```

Both must pass. Write the tests first.
