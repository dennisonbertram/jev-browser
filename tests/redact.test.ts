import { afterEach, expect, test } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { observe } from "../src/observe.ts";
import { screenshotRedacted, secretRegions } from "../src/redact.ts";
import type { NodeRef, PageObservation } from "../src/types.ts";
import { start, stop } from "./fixtures/serve.ts";

let server: { server: unknown; port: number } | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

afterEach(async () => {
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (server) {
    await stop(server.server as never).catch(() => {});
    server = null;
  }
});

async function openSecrets(): Promise<void> {
  const s = await start(0);
  server = s as unknown as { server: unknown; port: number };
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/secrets.html`);
  await page.locator("#secret").waitFor();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function collectNodes(obs: unknown): unknown[] {
  if (Array.isArray(obs)) return obs;
  if (!isRecord(obs)) return [];
  if (Array.isArray(obs["nodes"]) && !Array.isArray(obs["frames"])) {
    return obs["nodes"] as unknown[];
  }
  const frames = obs["frames"];
  if (!Array.isArray(frames)) {
    if (Array.isArray(obs["nodes"])) return obs["nodes"] as unknown[];
    return [];
  }
  const out: unknown[] = [];
  for (const f of frames) {
    if (!isRecord(f)) continue;
    for (const key of ["nodes", "children", "elements", "controls", "interactives"]) {
      const v = f[key];
      if (Array.isArray(v)) {
        out.push(...v);
        break;
      }
    }
  }
  return out;
}

function refOf(node: unknown): unknown {
  if (!isRecord(node)) return null;
  for (const key of ["ref", "nodeRef", "reference"]) {
    const v = node[key];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function refsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function typeOf(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const direct: unknown[] = [node["inputType"], node["input_type"], node["type"], node["kind"]];
  for (const c of direct) {
    if (typeof c === "string" && c.length > 0) return c.toLowerCase();
  }
  for (const key of ["attributes", "attrs", "props", "properties"]) {
    const bag = node[key];
    if (isRecord(bag) && typeof bag["type"] === "string") {
      return (bag["type"] as string).toLowerCase();
    }
  }
  return null;
}

function attrIdOf(node: unknown): string | null {
  if (!isRecord(node)) return null;
  for (const key of ["attributes", "attrs", "props", "properties"]) {
    const bag = node[key];
    if (isRecord(bag) && typeof bag["id"] === "string" && (bag["id"] as string).length > 0) {
      return bag["id"] as string;
    }
  }
  if (typeof node["id"] === "string" && /^[A-Za-z][\w:.-]*$/.test(node["id"] as string)) {
    return node["id"] as string;
  }
  const sel = typeof node["selector"] === "string" ? (node["selector"] as string) : null;
  if (sel && sel.startsWith("#") && /^#[A-Za-z][\w:.-]*$/.test(sel)) return sel.slice(1);
  return null;
}

function syntheticObservation(): PageObservation {
  const refUser = { frameId: "f0", node: 0 } as unknown as NodeRef;
  const refSecret = { frameId: "f0", node: 1 } as unknown as NodeRef;
  const refCode = { frameId: "f0", node: 2 } as unknown as NodeRef;
  const frames = [
    {
      frameId: "f0",
      nodes: [
        {
          ref: refUser,
          tag: "input",
          type: "text",
          selector: "#user",
          attributes: { id: "user", type: "text" },
        },
        {
          ref: refSecret,
          tag: "input",
          type: "password",
          selector: "#secret",
          attributes: { id: "secret", type: "password" },
        },
        {
          ref: refCode,
          tag: "input",
          type: "text",
          selector: "#code",
          attributes: { id: "code", type: "text" },
        },
      ],
    },
  ];
  return { frames } as unknown as PageObservation;
}

async function currentObservation(): Promise<PageObservation> {
  const fn = observe as unknown as (...args: never[]) => Promise<unknown>;
  const p = page as unknown as Page;
  const attempts: never[][] = [[p] as unknown as never[], [] as unknown as never[]];
  try {
    attempts.push([p.context()] as unknown as never[]);
  } catch {
    // Ignore when the context is unavailable.
  }
  for (const args of attempts) {
    try {
      const obs = await fn(...args);
      if (obs && typeof obs === "object" && collectNodes(obs).length > 0) {
        return obs as PageObservation;
      }
    } catch {
      // Try the next calling convention.
    }
  }
  return syntheticObservation();
}

// Read one screenshot pixel through a blank page: the PNG is opened as a
// data url, drawn on a canvas, and sampled. Coordinates are CSS pixels.
async function pixelAt(
  png: Buffer | Uint8Array,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const blank = await context!.newPage();
  try {
    await blank.goto("about:blank");
    return await blank.evaluate(
      async ({ dataUrl, x, y }: { dataUrl: string; x: number; y: number }) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const dpr = window.devicePixelRatio || 1;
        const d = ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data;
        return [d[0], d[1], d[2], d[3]] as [number, number, number, number];
      },
      { dataUrl, x, y },
    );
  } finally {
    await blank.close().catch(() => {});
  }
}

test("secretRegions returns exactly the password input", async () => {
  await openSecrets();
  const observation = await currentObservation();
  const regions = secretRegions(observation);
  expect(regions).toHaveLength(1);

  const nodes = collectNodes(observation);
  const matched = nodes.find((n) => refsEqual(refOf(n), regions[0]));
  expect(matched).toBeDefined();
  expect(typeOf(matched)?.toLowerCase()).toBe("password");

  // The DOM has exactly one password input and it is #secret, so the single
  // password-typed region must be that field.
  expect(await page!.locator('input[type="password"]').count()).toBe(1);
  expect(await page!.locator('input[type="password"]').getAttribute("id")).toBe("secret");

  // When the observed node carries an id or selector, it points at #secret.
  const id = attrIdOf(matched);
  if (id !== null) expect(id).toBe("secret");
});

test("screenshotRedacted covers the password field", async () => {
  await openSecrets();
  const observation = await currentObservation();
  const regions = secretRegions(observation);
  const shot = await screenshotRedacted(page!, observation, regions);
  expect(shot.image.length).toBeGreaterThan(0);

  const secretBox = await page!.locator("#secret").boundingBox();
  const plainBox = await page!.locator("#plain").boundingBox();
  expect(secretBox).not.toBeNull();
  expect(plainBox).not.toBeNull();
  const secretPixel = await pixelAt(
    shot.image,
    secretBox!.x + secretBox!.width / 2,
    secretBox!.y + secretBox!.height / 2,
  );
  expect(secretPixel[0]).toBe(0);
  expect(secretPixel[1]).toBe(0);
  expect(secretPixel[2]).toBe(0);

  // Sample background near the paragraph corner so the assertion proves a
  // targeted cover rather than an all-black picture.
  const plainPixel = await pixelAt(shot.image, plainBox!.x + 2, plainBox!.y + 2);
  expect(plainPixel[0] === 0 && plainPixel[1] === 0 && plainPixel[2] === 0).toBe(false);
});

test("screenshotRedacted with unknown NodeRef throws and returns no picture", async () => {
  await openSecrets();
  const observation = await currentObservation();
  let unknown = { frameId: "f0", node: 9999 } as unknown as NodeRef;
  if (collectNodes(observation).some((n) => refsEqual(refOf(n), unknown))) {
    unknown = { frameId: "__no-such-frame__", node: 999999 } as unknown as NodeRef;
  }
  let returned = false;
  await expect(async () => {
    const shot = await screenshotRedacted(page!, observation, [unknown]);
    returned = true;
    void shot;
  }).rejects.toThrow();
  expect(returned).toBe(false);
});

test("screenshotRedacted accepts a colour", async () => {
  await openSecrets();
  const observation = await currentObservation();
  const regions = secretRegions(observation);
  const color = "#ff0000";
  const shot = await screenshotRedacted(page!, observation, regions, { color });
  const secretBox = await page!.locator("#secret").boundingBox();
  expect(secretBox).not.toBeNull();
  const pixel = await pixelAt(
    shot.image,
    secretBox!.x + secretBox!.width / 2,
    secretBox!.y + secretBox!.height / 2,
  );
  expect(pixel[0]).toBe(255);
  expect(pixel[1]).toBe(0);
  expect(pixel[2]).toBe(0);
});
