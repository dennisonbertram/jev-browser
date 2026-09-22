/**
 * Browser lifecycle: the library either starts its own browser or attaches to
 * one another system started. A BrowserSession looks the same either way, so
 * the rest of the library never knows the difference.
 *
 * The one rule that matters: an attached session must never close a browser
 * this process did not start. Another system owns that browser; `close` on an
 * attached session disconnects only.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

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

export type LaunchLocalOptions = {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Expose a raw CDP endpoint on this port, and set cdpUrl. */
  cdpPort?: number;
};

export type AttachOverCdpOptions = {
  viewport?: { width: number; height: number };
  timeoutMs?: number;
};

const ATTACH_TIMEOUT_MS = 15_000;
const CDP_READY_TIMEOUT_MS = 10_000;
const CDP_POLL_MS = 100;

/** Polls the Chromium JSON endpoint until it answers with a debugger URL, or throws. */
async function readCdpUrl(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = (await response.json()) as {
          webSocketDebuggerUrl?: string;
        };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
        lastError = new Error(`${url} answered without webSocketDebuggerUrl`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_MS));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `CDP endpoint ${url} did not answer within ${CDP_READY_TIMEOUT_MS}ms${detail}`
  );
}

/** Idempotent close: the second call does nothing and throws nothing. */
function releaser(browser: Browser): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    // Playwright closes a browser this process launched, but only disconnects
    // from one it attached to over CDP. Rule 3 falls out of that: an attached
    // session never closes a browser another system owns.
    await browser.close();
  };
}

export async function launchLocal(
  options: LaunchLocalOptions = {}
): Promise<BrowserSession> {
  const args = options.cdpPort
    ? [`--remote-debugging-port=${options.cdpPort}`]
    : [];
  const browser = await chromium.launch({
    headless: options.headless ?? true,
    args,
  });

  let cdpUrl: string | null = null;
  if (options.cdpPort) {
    try {
      cdpUrl = await readCdpUrl(options.cdpPort);
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }

  const context = await browser.newContext({ viewport: options.viewport });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    cdpUrl,
    owned: true,
    close: releaser(browser),
  };
}

export async function attachOverCdp(
  cdpUrl: string,
  options: AttachOverCdpOptions = {}
): Promise<BrowserSession> {
  const timeoutMs = options.timeoutMs ?? ATTACH_TIMEOUT_MS;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Could not attach to CDP endpoint ${cdpUrl} within ${timeoutMs}ms${detail}`,
      { cause: error }
    );
  }

  // Take the first context and the first page that exist; create them only
  // when they are absent.
  const context =
    browser.contexts()[0] ??
    (await browser.newContext({ viewport: options.viewport }));
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    browser,
    context,
    page,
    cdpUrl,
    owned: false,
    close: releaser(browser),
  };
}
