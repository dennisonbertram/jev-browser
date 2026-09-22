import { attachOverCdp } from "./browser.js";
import type { BrowserSession } from "./browser.js";
import { observe } from "./observe.js";
import type { PageObservation } from "./types.js";
import type { Page } from "playwright";

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

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

function replacePageList(page: Page): void {
  const context = page.context() as unknown as {
    pages?: (...args: never[]) => unknown;
  };
  const pages = () => [page];

  try {
    Object.defineProperty(context, "pages", {
      configurable: true,
      writable: true,
      value: pages,
    });
  } catch {
    context.pages = pages;
  }
}


export function saveSessionState(
  session: BrowserSession,
  observation: PageObservation,
  now: () => number = Date.now
): SessionState {
  if (session.cdpUrl === null) {
    // A session with no endpoint cannot be reattached by a later process.
    throw new Error(
      "This session exposes no CDP endpoint, so no later process can attach to it. Launch with cdpPort, or attach to an existing endpoint."
    );
  }
  return {
    version: 1,
    cdpUrl: session.cdpUrl,
    url: session.page.url(),
    fingerprint: observation.fingerprint,
    savedAt: now(),
  };
}

/**
 * Attach to the browser named by a saved state and observe its current page.
 */
export async function restoreSessionState(
  state: SessionState,
  options: { maxAgeMs?: number; requireSameUrl?: boolean } = {}
): Promise<{
  session: BrowserSession;
  observation: PageObservation;
  changed: boolean;
}> {
  if (!isSessionState(state)) {
    throw new Error("Invalid session state: unsupported shape or version");
  }

  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const age = Date.now() - state.savedAt;
  if (age > maxAgeMs) {
    throw new Error(
      `Session state is older than maxAgeMs (${maxAgeMs} ms) and has expired`
    );
  }

  let session: BrowserSession;
  try {
    session = await attachOverCdp(state.cdpUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not attach to session endpoint ${state.cdpUrl}: ${detail}`,
      { cause: error }
    );
  }

  try {
    const url = session.page.url();
    if (options.requireSameUrl === true && url !== state.url) {
      throw new Error(
        `Session page URL changed: expected ${state.url}, got ${url}`
      );
    }

    const observation = await observe(session.context);

    return {
      session,
      observation,
      changed: observation.fingerprint !== state.fingerprint,
    };
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

/** True when the state is the right shape and version. */
export function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.cdpUrl === "string" &&
    candidate.cdpUrl.length > 0 &&
    typeof candidate.url === "string" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.savedAt === "number" &&
    Number.isFinite(candidate.savedAt)
  );
}
