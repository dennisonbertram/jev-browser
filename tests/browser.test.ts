/**
 * S1: browser lifecycle. The library either starts its own browser or attaches
 * to one another system started; the rest of the library must not know the
 * difference. These tests prove the session contract, and especially rule 3:
 * an attached session must never close a browser this process did not start.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachOverCdp, launchLocal } from "../src/browser.ts";
import type { BrowserSession } from "../src/browser.ts";
import { start, stop } from "./fixtures/serve.ts";

// Ephemeral ports: start(0) takes a free port, so this suite never collides
// with the other suites or with a stray local browser.
let PRIMARY = 0;
let CDP_PORT = 0;
let servers: Awaited<ReturnType<typeof start>>[] = [];

// The CDP-exposing session from the second test; the third test attaches to
// the same endpoint. Tests in a file run in order.
let cdpSession: BrowserSession | null = null;

beforeAll(async () => {
  const primary = await start(0);
  // The same trick picks a free port for the CDP endpoint: take an ephemeral
  // port, give the server back, and hand the number to Chromium.
  const probe = await start(0);
  PRIMARY = primary.port;
  CDP_PORT = probe.port;
  servers = [primary];
  await stop(probe.server);
}, 60_000);

afterAll(async () => {
  await cdpSession?.close();
  await Promise.all(servers.map((s) => stop(s.server)));
});

describe("launchLocal", () => {
  it("gives a page that loads a fixture, and close twice does not throw", async () => {
    const session = await launchLocal();
    try {
      expect(session.owned).toBe(true);
      expect(session.cdpUrl).toBeNull();
      await session.page.goto(`http://localhost:${PRIMARY}/shadow.html`, {
        waitUntil: "load",
      });
      await expect.poll(() => session.page.title()).toBe("shadow");
    } finally {
      await session.close();
    }
    // Rule 4: a second close does nothing and throws nothing.
    await session.close();
  });

  it("with cdpPort sets cdpUrl, and GET /json/version on that port answers", async () => {
    cdpSession = await launchLocal({ cdpPort: CDP_PORT });
    expect(cdpSession.cdpUrl).toMatch(/^ws:\/\//u);

    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { webSocketDebuggerUrl?: string };
    expect(body.webSocketDebuggerUrl).toBe(cdpSession.cdpUrl);
  });
});

describe("attachOverCdp", () => {
  it("on the same endpoint gives a working page, and closing it leaves the owner's browser alive", async () => {
    expect(cdpSession, "the cdpPort test must have run first").toBeTruthy();

    const attached = await attachOverCdp(cdpSession!.cdpUrl!);
    try {
      expect(attached.owned).toBe(false);
      await attached.page.goto(`http://localhost:${PRIMARY}/select.html`, {
        waitUntil: "load",
      });
      await expect.poll(() => attached.page.title()).toBe("select");
    } finally {
      await attached.close();
    }

    // Rule 3: the attached close disconnected only. The first session's page
    // still loads a page, so the browser it started was never closed.
    await cdpSession!.page.goto(`http://localhost:${PRIMARY}/canvas.html`, {
      waitUntil: "load",
    });
    await expect.poll(() => cdpSession!.page.title()).toBe("canvas");
  });

  it("rejects in under 20 seconds on a dead endpoint, naming the endpoint", async () => {
    const endpoint = "ws://127.0.0.1:1/devtools/browser/none";
    const startedAt = Date.now();
    await expect(attachOverCdp(endpoint)).rejects.toThrow(endpoint);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });
});
