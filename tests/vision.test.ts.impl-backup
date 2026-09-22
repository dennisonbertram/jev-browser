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

async function open(): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1120, height: 780 },
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PRIMARY}/canvas.html`, {
    waitUntil: "load",
  });
  return context;
}

describe("vision", () => {
  it("screenshotPage returns PNG bytes covering the visible page", async () => {
    const context = await open();
    try {
      const page = getActivePage(context)!;
      const shot = await screenshotPage(page);
      expect(Array.from(shot.image.subarray(0, 8))).toEqual(PNG_SIGNATURE);
      expect(shot.rect.width).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it("screenshotCanvas covers the observed canvas region and nothing else", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      expect(observation.canvases.length).toBeGreaterThanOrEqual(1);
      const page = getActivePage(context)!;
      const shot = await screenshotCanvas(page, observation, 0);
      expect(Array.from(shot.image.subarray(0, 8))).toEqual(PNG_SIGNATURE);
      const box = await page.evaluate(() => {
        const el = document.getElementById("picker");
        if (!el) throw new Error("fixture changed: #picker is gone");
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      for (const key of ["x", "y", "width", "height"] as const) {
        expect(
          Math.abs(shot.rect[key] - box[key]),
          `rect.${key} must match the canvas bounding box within 2px`
        ).toBeLessThanOrEqual(2);
      }
    } finally {
      await context.close();
    }
  });

  it("clickInCanvas reaches the drawn button through a fraction of the region", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      // The drawn button occupies x 10..70, y 40..64 of a 200x80 canvas;
      // its centre as a fraction of the region:
      const fx = (10 + 70) / 2 / 200;
      const fy = (40 + 64) / 2 / 80;
      await clickInCanvas(page, observation, 0, fx, fy);
      await expect
        .poll(() => page.locator("#canvas-result").textContent())
        .toBe("date-picked");
    } finally {
      await context.close();
    }
  });

  it("clickInCanvas rejects a canvasIndex the observation does not have", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      await expect(
        clickInCanvas(page, observation, 99, 0.2, 0.65)
      ).rejects.toThrow();
      await expect
        .poll(() => page.locator("#canvas-result").textContent())
        .toBe("no date");
    } finally {
      await context.close();
    }
  });

  it("clickInCanvas rejects a fraction outside 0 to 1", async () => {
    const context = await open();
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      await expect(
        clickInCanvas(page, observation, 0, 1.5, 0.65)
      ).rejects.toThrow();
      await expect
        .poll(() => page.locator("#canvas-result").textContent())
        .toBe("no date");
    } finally {
      await context.close();
    }
  });
});
