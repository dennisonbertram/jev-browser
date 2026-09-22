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
import { randomUUID } from "node:crypto";

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
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Bound this attempt to the time that remains so a stalled response
    // cannot hold startup past the deadline; the signal also bounds the
    // body read because it stays armed until the iteration finishes.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), remaining);
    let response: Response | undefined;
    try {
      response = await fetch(url, { signal: controller.signal });
      if (Date.now() >= deadline) {
        try {
          await response.body?.cancel();
        } catch {}
        break;
      }
      if (!response.ok) {
        // Drain or cancel a non-OK body so a foreign server cannot hold the
        // socket open into the next poll.
        try {
          await response.body?.cancel();
        } catch {}
        if (Date.now() >= deadline) break;
        lastError = new Error(`${url} answered with status ${response.status}`);
      } else {
        const body = (await response.json()) as {
          webSocketDebuggerUrl?: string;
        };
        if (Date.now() >= deadline) break;
        if (
          typeof body.webSocketDebuggerUrl === "string" &&
          body.webSocketDebuggerUrl.length > 0
        ) {
          return body.webSocketDebuggerUrl;
        }
        lastError = new Error(`${url} answered without webSocketDebuggerUrl`);
      }
    } catch (error) {
      lastError = error;
      if (response) {
        try {
          await response.body?.cancel();
        } catch {}
      }
      if (Date.now() >= deadline) break;
    } finally {
      clearTimeout(timeoutId);
    }
    if (Date.now() >= deadline) break;
    const sleepMs = Math.min(CDP_POLL_MS, deadline - Date.now());
    if (sleepMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `CDP endpoint ${url} did not answer within ${CDP_READY_TIMEOUT_MS}ms${detail}`
  );
}

/**
 * Proves the answering endpoint belongs to the browser this process launched.
 * A random token in a probe page must show up in /json/list; otherwise the
 * port is held by another browser.
 */
async function verifyCdpOwnership(
  port: number,
  browser: Browser
): Promise<void> {
  const token = randomUUID();
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`about:blank#${token}`);
    if (Date.now() >= deadline) {
      throw new Error(
        `CDP endpoint ${listUrl} verification exceeded ${CDP_READY_TIMEOUT_MS}ms`
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `CDP endpoint ${listUrl} verification exceeded ${CDP_READY_TIMEOUT_MS}ms`
      );
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), remaining);
    let response: Response | undefined;
    try {
      response = await fetch(listUrl, { signal: controller.signal });
      if (Date.now() >= deadline) {
        try {
          await response.body?.cancel();
        } catch {}
        throw new Error(
          `CDP endpoint ${listUrl} verification exceeded ${CDP_READY_TIMEOUT_MS}ms`
        );
      }
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {}
        throw new Error(
          `CDP endpoint ${listUrl} answered with status ${response.status}, expected probe token`
        );
      }
      const entries = (await response.json()) as Array<{ url?: unknown }>;
      if (Date.now() >= deadline) {
        throw new Error(
          `CDP endpoint ${listUrl} verification exceeded ${CDP_READY_TIMEOUT_MS}ms`
        );
      }
      const found =
        Array.isArray(entries) &&
        entries.some(
          (entry) =>
            typeof entry?.url === "string" &&
            (entry.url as string).includes(token)
        );
      if (!found) {
        throw new Error(
          `CDP endpoint ${listUrl} does not belong to this browser: probe token not found`
        );
      }
    } catch (error) {
      if (response && !response.ok) {
        // Already cancelled and wrapped above; rethrow as-is.
        throw error;
      }
      if (
        error instanceof Error &&
        /does not belong|exceeded|answered with status/u.test(error.message)
      ) {
        throw error;
      }
      if (response) {
        try {
          await response.body?.cancel();
        } catch {}
      }
      throw new Error(
        `CDP endpoint ${listUrl} verification failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Holds a single close promise so concurrent callers await the same shutdown.
 * On success the resolved promise is kept, so later calls do nothing. On
 * rejection the slot is cleared, so a retry can run the shutdown again.
 */
function idempotentCloser(run: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      try {
        await run();
      } catch (error) {
        pending = null;
        throw error;
      }
    })();
    return pending;
  };
}

/** Idempotent close for an owned browser: closes the browser this process started. */
function releaser(browser: Browser): () => Promise<void> {
  return idempotentCloser(() => browser.close());
}

/**
 * Idempotent close for an attached session: closes only the page and context
 * this process created, then disconnects. A borrowed page or context is left
 * alone, and the remote browser is never closed.
 */
function attachedReleaser(
  browser: Browser,
  context: BrowserContext,
  page: Page,
  createdContext: boolean,
  createdPage: boolean
): () => Promise<void> {
  return idempotentCloser(async () => {
    try {
      if (createdContext) {
        // Closing the created context also closes the created page inside it.
        await context.close();
      } else if (createdPage) {
        if (!page.isClosed()) await page.close();
      }
    } finally {
      // For a CDP-attached browser this disconnects only; the remote
      // browser stays alive. It must run even when cleanup above throws,
      // so a failed page close cannot leave the connection behind.
      await browser.close();
    }
  });
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
      await verifyCdpOwnership(options.cdpPort, browser);
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }

  try {
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
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function attachOverCdp(
  cdpUrl: string,
  options: AttachOverCdpOptions = {}
): Promise<BrowserSession> {
  const requestedTimeout = options.timeoutMs;
  if (
    requestedTimeout !== undefined &&
    (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0)
  ) {
    throw new Error(
      `Invalid timeoutMs ${String(requestedTimeout)} for CDP endpoint ${cdpUrl}: must be a finite number greater than 0`
    );
  }
  const timeoutMs = requestedTimeout ?? ATTACH_TIMEOUT_MS;

  let browser: Browser | undefined;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        // A stalled context/page setup already holds a connection, so
        // disconnect it here; the catch below closes again if needed.
        if (browser) void browser.close().catch(() => {});
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const work = (async () => {
      const connected = await chromium.connectOverCDP(cdpUrl, {
        timeout: timeoutMs,
      });
      browser = connected;
      if (timedOut) {
        // The deadline fired while connecting; the race already rejected, so
        // disconnect this late connection instead of leaking it.
        await connected.close().catch(() => {});
        throw new Error(`timed out after ${timeoutMs}ms`);
      }
      let context: BrowserContext;
      let createdContext = false;
      const existingContext = connected.contexts()[0];
      if (existingContext) {
        context = existingContext;
      } else {
        context = await connected.newContext({
          viewport: options.viewport,
        });
        createdContext = true;
      }
      if (timedOut) {
        if (createdContext) await context.close().catch(() => {});
        await connected.close().catch(() => {});
        throw new Error(`timed out after ${timeoutMs}ms`);
      }
      let page: Page;
      let createdPage = false;
      try {
        const existingPage = context.pages()[0];
        if (existingPage) {
          page = existingPage;
        } else {
          page = await context.newPage();
          createdPage = true;
        }
      } catch (error) {
        if (createdContext) await context.close().catch(() => {});
        throw error;
      }
      if (timedOut) {
        if (createdPage && !page.isClosed()) {
          await page.close().catch(() => {});
        }
        if (createdContext) await context.close().catch(() => {});
        await connected.close().catch(() => {});
        throw new Error(`timed out after ${timeoutMs}ms`);
      }
      return { connected, context, page, createdContext, createdPage };
    })();

    const { connected, context, page, createdContext, createdPage } =
      await Promise.race([work, timeoutPromise]);
    return {
      browser: connected,
      context,
      page,
      cdpUrl,
      owned: false,
      close: attachedReleaser(
        connected,
        context,
        page,
        createdContext,
        createdPage
      ),
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Could not attach to CDP endpoint ${cdpUrl} within ${timeoutMs}ms${detail}`,
      { cause: error }
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
