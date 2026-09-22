import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchLocal } from "../src/browser.ts";
import type { BrowserSession } from "../src/browser.ts";
import {
  isSessionState,
  restoreSessionState,
  saveSessionState,
} from "../src/session-state.ts";
import { observe } from "../src/observe.ts";
import type { Page } from "playwright";
import { start, stop } from "./fixtures/serve.ts";
import net from "node:net";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine a free port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

/** observe() takes the context that holds the page. */
async function observePage(page: Page) {
  return observe(page.context());
}

describe("session state", () => {
  let fixturePort: number;
  let fixtureServer: Awaited<ReturnType<typeof start>>["server"];
  let ownedSession: BrowserSession;

  beforeAll(async () => {
    const fixture = await start(0);
    fixturePort = fixture.port;
    fixtureServer = fixture.server;
    ownedSession = await launchLocal({ cdpPort: await freePort() });
    await ownedSession.page.goto(`http://127.0.0.1:${fixturePort}/select.html`);
  });

  afterAll(async () => {
    await ownedSession.close();
    await stop(fixtureServer);
  });

  it("saves and restores a live browser", async () => {
    const observation = await observePage(ownedSession.page);
    const state = saveSessionState(ownedSession, observation);
    const restored = await restoreSessionState(state);

    expect(JSON.stringify(restored.observation)).toContain("Ticket type");
    expect(restored.changed).toBe(false);
    await restored.session.close();
  });

  it("reports whether the observed page changed", async () => {
    await ownedSession.page.goto(
      `http://127.0.0.1:${fixturePort}/select.html`
    );
    const observation = await observePage(ownedSession.page);
    const state = saveSessionState(ownedSession, observation);

    const unchanged = await restoreSessionState(state);
    expect(unchanged.changed).toBe(false);
    await unchanged.session.close();

    await ownedSession.page.goto("about:blank");
    const changed = await restoreSessionState(state);
    expect(changed.changed).toBe(true);
    await changed.session.close();
  });

  it("refuses state older than maxAgeMs", async () => {
    const observation = await observePage(ownedSession.page);
    const state = saveSessionState(ownedSession, observation, () => 10_000);

    await expect(
      restoreSessionState(state, { maxAgeMs: 100 })
    ).rejects.toThrow("older than maxAgeMs");
  });

  it("enforces the URL only when requested", async () => {
    await ownedSession.page.goto(
      `http://127.0.0.1:${fixturePort}/select.html`
    );
    const observation = await observePage(ownedSession.page);
    const state = saveSessionState(ownedSession, observation);

    await ownedSession.page.goto("about:blank");

    await expect(
      restoreSessionState(state, { requireSameUrl: true })
    ).rejects.toThrow("URL");

    const restored = await restoreSessionState(state, {
      requireSameUrl: false,
    });
    expect(restored.changed).toBe(true);
    await restored.session.close();
  });

  it("rejects invalid and unknown state shapes", () => {
    expect(isSessionState(null)).toBe(false);
    expect(isSessionState("state")).toBe(false);
    expect(
      isSessionState({
        version: 1,
        url: "http://example.test",
        fingerprint: "fingerprint",
        savedAt: Date.now(),
      })
    ).toBe(false);
    expect(
      isSessionState({
        version: 2,
        cdpUrl: "http://127.0.0.1:1",
        url: "http://example.test",
        fingerprint: "fingerprint",
        savedAt: Date.now(),
      })
    ).toBe(false);
  });

  it("stores only the documented fields and no element index", async () => {
    const observation = await observePage(ownedSession.page);
    const state = saveSessionState(ownedSession, observation);

    expect(Object.keys(JSON.parse(JSON.stringify(state))).sort()).toEqual([
      "cdpUrl",
      "fingerprint",
      "savedAt",
      "url",
      "version",
    ]);
  });

  it("reports an unavailable endpoint promptly", async () => {
    const endpoint = "http://127.0.0.1:1";
    const state = {
      version: 1 as const,
      cdpUrl: endpoint,
      url: "http://example.test",
      fingerprint: "fingerprint",
      savedAt: Date.now(),
    };

    const started = Date.now();
    await expect(restoreSessionState(state)).rejects.toThrow(endpoint);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
