/**
 * S1: browser lifecycle. The library either starts its own browser or attaches
 * to one another system started; the rest of the library must not know the
 * difference. These tests prove the session contract, and especially rule 3:
 * an attached session must never close a browser this process did not start.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { attachOverCdp, launchLocal } from "../src/browser.ts";
import type { BrowserSession } from "../src/browser.ts";
import { start, stop } from "./fixtures/serve.ts";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";

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
    // A close that does nothing would leave the browser connected.
    expect(session.browser.isConnected()).toBe(false);
  });

  it("with cdpPort sets cdpUrl, and GET /json/version on that port answers", async () => {
    cdpSession = await launchLocal({ cdpPort: CDP_PORT });
    expect(cdpSession.cdpUrl).toMatch(/^ws:\/\//u);

    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { webSocketDebuggerUrl?: string };
    expect(body.webSocketDebuggerUrl).toBe(cdpSession.cdpUrl);
  });

  it("rejects in under 15 seconds when the CDP port is held by a hanging server", async () => {
    // A handler that never answers: without an AbortSignal bound to the
    // deadline the readiness poll would stall here forever.
    const hanging = createHttpServer(() => {});
    const sockets = new Set<Socket>();
    hanging.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      hanging.once("error", reject);
      hanging.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = hanging.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a TCP address");
      }
      // Chromium cannot own a port that is already taken, so the endpoint
      // answers (never) from our server and launchLocal must give up.
      const startedAt = Date.now();
      await expect(launchLocal({ cdpPort: address.port })).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        hanging.close(() => resolve());
      });
    }
  }, 20_000);
});

describe("attachOverCdp", () => {
  it("on the same endpoint gives a working page, and closing it leaves the owner's browser alive", async () => {
    expect(cdpSession, "the cdpPort test must have run first").toBeTruthy();

    // Prove the attachment reached the owner's browser: a unique url opened
    // in the owner must show up in the attached context's pages.
    const token = randomUUID();
    const probe = await cdpSession!.context.newPage();
    await probe.goto(`http://localhost:${PRIMARY}/select.html#${token}`, {
      waitUntil: "load",
    });
    try {
      const attached = await attachOverCdp(cdpSession!.cdpUrl!);
      try {
        expect(attached.owned).toBe(false);
        const urls = attached.context.pages().map((p) => p.url());
        expect(urls.some((u) => u.includes(token))).toBe(true);
        await attached.page.goto(`http://localhost:${PRIMARY}/select.html`, {
          waitUntil: "load",
        });
        await expect.poll(() => attached.page.title()).toBe("select");
      } finally {
        await attached.close();
      }

      // A close that does nothing would leave the attached connection open.
      expect(attached.browser.isConnected()).toBe(false);
      // Rule 3: the attached close disconnected only.
      expect(cdpSession!.browser.isConnected()).toBe(true);

      // The first session's page still loads a page, so the browser it
      // started was never closed.
      await cdpSession!.page.goto(`http://localhost:${PRIMARY}/canvas.html`, {
        waitUntil: "load",
      });
      await expect.poll(() => cdpSession!.page.title()).toBe("canvas");
    } finally {
      await probe.close().catch(() => {});
    }
  });

  it("rejects in under 20 seconds on a dead endpoint, naming the endpoint", async () => {
    const endpoint = "ws://127.0.0.1:1/devtools/browser/none";
    const startedAt = Date.now();
    await expect(attachOverCdp(endpoint)).rejects.toThrow(endpoint);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });

  it("times out when the endpoint accepts but never responds, naming the endpoint", async () => {
    // A blackhole: the TCP handshake succeeds so connect stalls instead of
    // refusing at once, proving the deadline bounds the whole attachment.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a TCP address");
      }
      const endpoint = `ws://127.0.0.1:${address.port}/devtools/browser/x`;
      const startedAt = Date.now();
      await expect(
        attachOverCdp(endpoint, { timeoutMs: 1500 })
      ).rejects.toThrow(endpoint);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 10_000);

  it("rejects when timeoutMs is 0", async () => {
    await expect(
      attachOverCdp("ws://127.0.0.1:1/devtools/browser/none", {
        timeoutMs: 0,
      })
    ).rejects.toThrow(/timeoutMs/u);
  });
});
