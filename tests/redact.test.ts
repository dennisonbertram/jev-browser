/**
 * Redaction tests against REAL observations.
 *
 * An earlier version of this file built observation-shaped objects by hand.
 * They matched what the redactor expected rather than what `observe` produces,
 * so the suite passed while a live screenshot captured the secret. Every test
 * here goes through `observe`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { observe } from "../src/observe.ts";
import { screenshotRedacted, secretRegions } from "../src/redact.ts";
import { start, stop } from "./fixtures/serve.ts";

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

async function open() {
  const context = await browser.newContext({ viewport: { width: 800, height: 400 } });
  const page = await context.newPage();
  await page.goto(`${base}/secrets.html`, { waitUntil: "load" });
  return { context, page };
}

/** The colour of one pixel of a PNG, read through a canvas in the browser. */
async function pixelAt(
  context: BrowserContext,
  image: Buffer,
  x: number,
  y: number
): Promise<number[]> {
  const reader = await context.newPage();
  try {
    await reader.setContent(`<img id="i" src="data:image/png;base64,${image.toString("base64")}">`);
    return await reader.evaluate(
      async ({ px, py }) => {
        const img = document.getElementById("i") as HTMLImageElement;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const ratio = img.naturalWidth / window.outerWidth || 1;
        void ratio;
        return Array.from(ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data);
      },
      { px: x, py: y }
    );
  } finally {
    await reader.close();
  }
}

describe("redaction", () => {
  it("finds exactly the fields that hold a secret by their nature", async () => {
    const { context, page } = await open();
    try {
      await page.fill("#secret", "hunter2");
      const observation = await observe(context);
      const regions = secretRegions(observation);

      expect(regions).toHaveLength(1);
      const action = observation.actions.find(
        (entry) => entry.ref?.node === regions[0]?.node && entry.ref?.frameId === regions[0]?.frameId
      );
      expect(action?.label).toBe("Password");
      expect(action?.sensitive).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("never carries the secret in the observation itself", async () => {
    const { context, page } = await open();
    try {
      await page.fill("#secret", "hunter2-unique");
      const observation = await observe(context);
      expect(JSON.stringify(observation)).not.toContain("hunter2-unique");
      // The length still shows, so "the field has something in it" is knowable.
      const action = observation.actions.find((entry) => entry.sensitive);
      expect(action?.currentValue).toContain("14 characters");
    } finally {
      await context.close();
    }
  });

  it("covers the secret field and leaves ordinary content visible", async () => {
    const { context, page } = await open();
    try {
      await page.fill("#secret", "hunter2");
      const observation = await observe(context);
      const shot = await screenshotRedacted(page, observation, secretRegions(observation));

      const secretBox = await page.locator("#secret").boundingBox();
      const plainBox = await page.locator("#plain").boundingBox();
      expect(secretBox).not.toBeNull();
      expect(plainBox).not.toBeNull();

      const covered = await pixelAt(
        context,
        shot.image,
        secretBox!.x + secretBox!.width / 2,
        secretBox!.y + secretBox!.height / 2
      );
      expect(covered.slice(0, 3)).toEqual([0, 0, 0]);

      const visible = await pixelAt(context, shot.image, plainBox!.x + 2, plainBox!.y + 2);
      // A whole black picture would also pass the first assertion.
      expect(visible[0] === 0 && visible[1] === 0 && visible[2] === 0).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("refuses an unknown node reference and takes no picture", async () => {
    const { context } = await open();
    try {
      const observation = await observe(context);
      await expect(
        screenshotRedacted(page(context), observation, [{ frameId: "f0", node: 9999 }])
      ).rejects.toThrow(/unknown node reference/iu);
    } finally {
      await context.close();
    }
  });

  it("refuses a transparent mask colour", async () => {
    const { context, page: p } = await open();
    try {
      const observation = await observe(context);
      await expect(
        screenshotRedacted(p, observation, secretRegions(observation), { color: "transparent" })
      ).rejects.toThrow(/transparent/iu);
    } finally {
      await context.close();
    }
  });

  it("accepts an opaque colour and uses it", async () => {
    const { context, page } = await open();
    try {
      await page.fill("#secret", "hunter2");
      const observation = await observe(context);
      const shot = await screenshotRedacted(page, observation, secretRegions(observation), {
        color: "#ff0000",
      });
      const box = await page.locator("#secret").boundingBox();
      const pixel = await pixelAt(context, shot.image, box!.x + box!.width / 2, box!.y + box!.height / 2);
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(60);
      expect(pixel[2]).toBeLessThan(60);
    } finally {
      await context.close();
    }
  });
});

/** The first open page of a context. */
function page(context: BrowserContext): Page {
  const first = context.pages()[0];
  if (!first) throw new Error("the context has no page");
  return first;
}
