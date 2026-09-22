/**
 * Regression tests for what a real page does and a fixture usually does not: a
 * dialog, a download, a navigation while an action is in flight, and acting
 * against state that has since gone away.
 *
 * Each test states the behaviour it locks down, so a later change cannot
 * reintroduce the fault quietly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { observe, settle } from "../src/observe.js";
import { execute, getActivePage } from "../src/execute.js";
import { StalePage } from "../src/types.js";
import { start, stop } from "./fixtures/serve.js";

let browser: Browser;
let server: Awaited<ReturnType<typeof start>>;
let base = "";

beforeAll(async () => {
  server = await start(0);
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stop(server.server);
});

async function open(fixture: string) {
  const context = await browser.newContext({ viewport: { width: 1120, height: 780 } });
  const page = await context.newPage();
  await page.goto(`${base}/${fixture}`, { waitUntil: "load" });
  return { context, page };
}

const byLabel = (actions: Awaited<ReturnType<typeof observe>>["actions"], label: string) => {
  const found = actions.find((action) => action.label === label);
  if (!found) throw new Error(`no action labelled "${label}" among: ${actions.map((a) => a.label).join(" | ")}`);
  return found;
};

describe("hardening", () => {
  it("a dialog does not hang the loop, and the page records the dismissal", async () => {
    const { context, page } = await open("dialog.html");
    try {
      const first = await observe(context);
      const click = byLabel(first.actions, "Confirm delete");

      // Playwright dismisses a dialog when no handler is registered. The point
      // is that execute returns rather than waiting for a human.
      await execute(context, first, click, {});
      await expect.poll(() => page.locator("#result").textContent()).toBe("false");

      // The engine still works afterwards.
      const second = await observe(context);
      expect(second.actions.length).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it("a download does not hang the loop", async () => {
    const { context, page } = await open("download.html");
    try {
      const first = await observe(context);
      const link = byLabel(first.actions, "Get the report");

      const download = page.waitForEvent("download").catch(() => null);
      await execute(context, first, link, {});
      await download;

      await expect.poll(() => page.locator("#result").textContent()).toBe("downloaded");
      const second = await observe(context);
      expect(second.actions.length).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it("a navigation during an action is reported, not swallowed", async () => {
    const { context, page } = await open("slow-nav.html");
    try {
      const before = await observe(context);
      const go = byLabel(before.actions, "Go slowly");
      await execute(context, before, go, {});
      await page.waitForURL(/select\.html$/u, { timeout: 15_000 });

      const after = await observe(context);
      expect(after.url).toContain("select.html");
      expect(after.fingerprint).not.toBe(before.fingerprint);
    } finally {
      await context.close();
    }
  });

  it("an action from before a navigation is refused", async () => {
    const { context, page } = await open("slow-nav.html");
    try {
      const before = await observe(context);
      const go = byLabel(before.actions, "Go slowly");
      await execute(context, before, go, {});
      await page.waitForURL(/select\.html$/u, { timeout: 15_000 });

      // The old action names a node that no longer exists. Acting on it would
      // be acting on whatever now occupies that index.
      await expect(execute(context, before, go, {})).rejects.toThrow();
    } finally {
      await context.close();
    }
  });

  it("an action inside a removed iframe is refused", async () => {
    const { context, page } = await open("iframe-same.html");
    try {
      const observation = await observe(context);
      const city = observation.actions.find(
        (action) => action.kind === "fill" && action.label === "City"
      );
      expect(city, "the fixture must offer the City field").toBeTruthy();

      await page.evaluate(() => document.querySelector("iframe")?.remove());

      await expect(
        execute(context, observation, city!, { text: "Lisbon" })
      ).rejects.toThrow();
    } finally {
      await context.close();
    }
  });

  it("an action on a closed page is refused rather than left hanging", async () => {
    const { context, page } = await open("select.html");
    try {
      const observation = await observe(context);
      const pay = byLabel(observation.actions, "Pay now");
      await page.close();

      await expect(execute(context, observation, pay, {})).rejects.toThrow();
    } finally {
      await context.close();
    }
  });

  it("settle returns even when nothing happens", async () => {
    const { context } = await open("select.html");
    try {
      const observation = await observe(context);
      const pay = byLabel(observation.actions, "Pay now");
      const page = getActivePage(context)!;
      const started = Date.now();
      await settle(page, pay);
      // The bounded wait must not become an unbounded one.
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await context.close();
    }
  });
});
