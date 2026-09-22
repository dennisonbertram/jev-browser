// S2: vision and coordinates. A canvas has no DOM nodes inside it, so the
// only way in is a picture plus a click at a fraction of the region. The
// model names an index into PageObservation.canvases and a 0..1 fraction;
// it never produces a page coordinate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { getActivePage } from "../src/execute.ts";
import { observe } from "../src/observe.ts";
import {
  clickInCanvas,
  screenshotCanvas,
  screenshotPage,
} from "../src/vision.ts";
import { start, stop } from "./fixtures/serve.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let PRIMARY = 0;
let browser: Browser;
let server: Awaited<ReturnType<typeof start>> | undefined;

beforeAll(async () => {
  server = await start(0);
  PRIMARY = server.port;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server) await stop(server.server);
});

async function open(path = "canvas-two.html"): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1120, height: 780 },
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PRIMARY}/${path}`, {
    waitUntil: "load",
  });
  return context;
}

function pngSize(image: Buffer): { width: number; height: number } {
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
  };
}

describe("vision", () => {
  it("selects the requested canvas index", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      await clickInCanvas(page, observation, 1, 0.5, 0.5);
      await expect.poll(() => page.locator("#canvas-one-result").textContent()).toBe("one");
      expect(await page.locator("#canvas-zero-result").textContent()).toBe("zero untouched");
    } finally {
      await context.close();
    }
  });

  it("screenshotCanvas is the region and screenshotPage is the viewport", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      const region = await screenshotCanvas(page, observation, 1);
      const whole = await screenshotPage(page);
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      const box = await page.locator("#canvas-one").boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(pngSize(region.image).width - box!.width * dpr)).toBeLessThanOrEqual(2);
      expect(Math.abs(pngSize(region.image).height - box!.height * dpr)).toBeLessThanOrEqual(2);
      expect(Math.abs(pngSize(whole.image).width - 1120 * dpr)).toBeLessThanOrEqual(2);
      expect(Math.abs(pngSize(whole.image).height - 780 * dpr)).toBeLessThanOrEqual(2);
    } finally {
      await context.close();
    }
  });

  it("fraction one remains inside the selected canvas", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      await clickInCanvas(page, observation, 1, 1, 1);
      await expect.poll(() => page.locator("#canvas-one-result").textContent()).toBe("one");
      expect(await page.locator("#canvas-zero-result").textContent()).toBe("zero untouched");
    } finally {
      await context.close();
    }
  });

  it("rejects every invalid fraction without changing the page", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      for (const value of [NaN, Infinity, -0, -0.1, 1.5]) {
        await expect(clickInCanvas(page, observation, 0, value, 0.5)).rejects.toThrow();
        await expect(clickInCanvas(page, observation, 0, 0.5, value)).rejects.toThrow();
        expect(await page.locator("#canvas-zero-result").textContent()).toBe("zero untouched");
        expect(await page.locator("#canvas-one-result").textContent()).toBe("one untouched");
      }
    } finally {
      await context.close();
    }
  });

  it("rejects every invalid index without changing the page", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      for (const index of [-0, "0", 1.5, 99] as unknown[]) {
        await expect(
          clickInCanvas(page, observation, index as number, 0.5, 0.5)
        ).rejects.toThrow();
        expect(await page.locator("#canvas-zero-result").textContent()).toBe("zero untouched");
        expect(await page.locator("#canvas-one-result").textContent()).toBe("one untouched");
      }
    } finally {
      await context.close();
    }
  });

  it("rejects a covered canvas without clicking it", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      await page.evaluate(() => {
        const cover = document.createElement("div");
        cover.id = "cover";
        cover.style.cssText =
          "position:absolute;left:400px;top:180px;width:300px;height:120px;z-index:10;background:red";
        document.body.appendChild(cover);
      });
      await expect(clickInCanvas(page, observation, 1, 0.5, 0.5)).rejects.toThrow("StalePage");
      expect(await page.locator("#canvas-one-result").textContent()).toBe("one untouched");
    } finally {
      await context.close();
    }
  });
});
