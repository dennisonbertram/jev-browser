/**
 * Step 3 of the whole-task design: the surfaces a task moves through, and
 * the lifecycle of the frames and tabs it acts in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { attachOverCdp, execute, observe } from "../src/index.js";

const PORT = 9471;
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    args: [`--remote-debugging-port=${PORT}`],
  });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

describe("a second attachment to the same browser", () => {
  it("acts in a page the first attachment already observed", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<button onclick="document.title = 'clicked'">Continue</button>`,
    );

    // The first attachment installs the engine in the page.
    const first = await attachOverCdp(`http://127.0.0.1:${PORT}`);
    await observe(first.context);
    await first.close();

    // A second attachment, as when a new worker picks up the browser.
    const second = await attachOverCdp(`http://127.0.0.1:${PORT}`);
    const observation = await observe(second.context);
    const button = observation.actions.find((a) => a.label === "Continue")!;
    await execute(second.context, observation, button);
    await second.close();

    expect(await page.title()).toBe("clicked");
    await page.close();
  }, 60_000);
});

describe("a drawer covering the page", () => {
  it("offers only the drawer's controls while it is open, and the page's once it closes", async () => {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 760 },
    });
    await page.setContent(`
      <main style="height:3000px"><button>Choose options</button><a href="#r">Reviews</a></main>
      <div id="drawer" role="dialog" aria-modal="true" aria-label="Purchase options"
        style="position:fixed;right:0;top:0;width:400px;height:100vh;background:#fff">
        <div style="height:60vh;overflow:auto"><div style="height:1500px"><button>Size M</button></div></div>
        <button>Add to cart</button>
        <button aria-label="Close" onclick="document.getElementById('drawer').remove()">x</button>
      </div>`);

    const open = (await observe(page)).actions.map((a) => a.label);
    await page.click("[aria-label=Close]");
    const closed = (await observe(page)).actions.map((a) => a.label);
    await page.close();

    expect(open).toContain("Add to cart");
    expect(open).toContain("Size M");
    expect(open).not.toContain("Choose options");
    expect(open).not.toContain("Reviews");
    expect(closed).toContain("Choose options");
  }, 30_000);

  it("offers only a modal <dialog>'s controls while it is open", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button>Behind</button>
      <dialog id="d"><button>Accept</button></dialog>
      <script>document.getElementById('d').showModal()</script>`);

    const labels = (await observe(page)).actions.map((a) => a.label);
    await page.close();

    expect(labels).toContain("Accept");
    expect(labels).not.toContain("Behind");
  }, 30_000);
});

describe("a closed drawer left in the page", () => {
  it("does not hide the page when the modal is off screen or transparent", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button>Checkout</button>
      <div role="dialog" aria-modal="true" style="position:fixed;left:-2000px;top:0;width:300px;height:300px"><button>Off</button></div>
      <div role="dialog" aria-modal="true" style="position:fixed;top:0;width:300px;height:300px;opacity:0;pointer-events:none"><button>Faded</button></div>`);

    const labels = (await observe(page)).actions.map((a) => a.label);
    await page.close();

    expect(labels).toContain("Checkout");
  }, 30_000);
});

describe("an iframe replaced by a new one", () => {
  it("refuses the old frame's action, then acts in the new frame", async () => {
    const page = await browser.newPage();
    const frame = `<iframe srcdoc="<button onclick='parent.document.title = &quot;clicked&quot;'>Pay</button>"></iframe>`;
    await page.setContent(`<div id="slot">${frame}</div>`);
    await page.waitForFunction(() =>
      document
        .querySelector("iframe")
        ?.contentDocument?.querySelector("button"),
    );

    const before = await observe(page);
    const oldPay = before.actions.find((a) => a.label === "Pay")!;
    await page.evaluate((html) => {
      document.getElementById("slot")!.innerHTML = html;
    }, frame);
    await page.waitForFunction(() =>
      document
        .querySelector("iframe")
        ?.contentDocument?.querySelector("button"),
    );

    await expect(execute(page, before, oldPay)).rejects.toThrow();
    const after = await observe(page);
    await execute(
      page,
      after,
      after.actions.find((a) => a.label === "Pay")!,
    );
    const title = await page.title();
    await page.close();

    expect(title).toBe("clicked");
  }, 30_000);
});

describe("going back", () => {
  it("offers BACK only when there is a page to go back to, and goes there", async () => {
    const page = await browser.newPage();
    await page.route("http://shop.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/item")
          ? "<title>Item</title><button>Buy</button>"
          : "<title>Results</title><a href='/item'>Item</a>",
      }),
    );
    await page.goto("http://shop.test/results");
    const first = await observe(page);
    await page.goto("http://shop.test/item");
    const second = await observe(page);
    const back = second.actions.find((a) => a.kind === "back");

    expect(first.actions.some((a) => a.kind === "back")).toBe(false);
    expect(back).toBeDefined();
    await execute(page, second, back!);
    await expect.poll(() => page.title()).toBe("Results");
    await page.close();
  }, 30_000);
});

describe("a modal, as the review found it", () => {
  const drawer = (extra = "") => `
    <main style="height:3000px"><button>Choose options</button>
      <div style="height:200px;overflow:auto"><div style="height:900px">long</div></div></main>
    <div role="dialog" aria-modal="true" aria-label="Purchase options"
      style="position:fixed;right:0;top:0;width:400px;height:100vh;background:#fff">
      <div style="height:60vh;overflow:auto"><div style="height:1500px"><button>Size M</button></div></div>
      <button>Add to cart</button>${extra}
    </div>`;

  it("offers no scrolling or key press behind it", async () => {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 760 },
    });
    await page.setContent(drawer());
    await page.focus("text=Choose options");
    const actions = (await observe(page)).actions;
    await page.close();

    expect(actions.filter((a) => a.kind === "press")).toEqual([]);
    expect(actions.filter((a) => a.kind === "scroll").length).toBe(1);
  }, 30_000);

  it("ignores a modal that an ancestor makes invisible", async () => {
    const page = await browser.newPage();
    await page.setContent(`<button>Checkout</button>
      <div style="opacity:0;pointer-events:none"><div role="dialog" aria-modal="true"
        style="position:fixed;top:0;width:300px;height:300px"><button>Hidden</button></div></div>`);
    const labels = (await observe(page)).actions.map((a) => a.label);
    await page.close();

    expect(labels).toContain("Checkout");
  }, 30_000);

  it("takes the modal that is visibly on top, not the last in the page", async () => {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    await page.setContent(`
      <div role="dialog" aria-modal="true" style="position:fixed;inset:0;z-index:10;background:#fff"><button>Confirm A</button></div>
      <div role="dialog" aria-modal="true" style="position:fixed;left:300px;top:250px;width:200px;height:100px;z-index:1"><button>Confirm B</button></div>`);
    const labels = (await observe(page)).actions.map((a) => a.label);
    await page.close();

    expect(labels).toContain("Confirm A");
  }, 30_000);

  it("offers the options of a list the modal controls, even when rendered outside it", async () => {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 760 },
    });
    await page.setContent(`${drawer(`<input role="combobox" aria-label="Colour" aria-controls="colours" aria-expanded="true">`)}
      <div id="colours" role="listbox" style="position:fixed;right:40px;top:300px;width:200px;z-index:5;background:#eee">
        <div role="option">Blue</div></div>`);
    const labels = (await observe(page)).actions.map((a) => a.label);
    await page.close();

    expect(labels).toContain("Blue");
  }, 30_000);
});

describe("frame names across processes", () => {
  it("names frames differently in two processes", async () => {
    const { vi } = await import("vitest");
    const page = await browser.newPage();
    await page.setContent("<button>Go</button>");
    // Two fresh copies of the module stand in for two processes.
    vi.resetModules();
    const first = await import("../src/observe.js");
    vi.resetModules();
    const second = await import("../src/observe.js");
    const one = await first.observe(page);
    const two = await second.observe(page);
    await page.close();

    expect(one.frames[0]!.frameId).not.toBe(two.frames[0]!.frameId);
  }, 30_000);
});

describe("going back, as the review found it", () => {
  const route = (page: import("playwright").Page) =>
    page.route("http://shop.test/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<title>${new URL(r.request().url()).pathname.slice(1)}</title><a href="/next">Next</a>`,
      }),
    );

  it("refuses to go back when the tab it observed has closed", async () => {
    const context = await browser.newContext();
    const checkout = await context.newPage();
    const other = await context.newPage();
    await route(checkout);
    await route(other);
    await other.goto("http://shop.test/home");
    await other.goto("http://shop.test/elsewhere");
    await checkout.goto("http://shop.test/cart");
    await checkout.goto("http://shop.test/checkout");
    await checkout.bringToFront();
    const observation = await observe(context);
    const back = observation.actions.find((a) => a.kind === "back")!;
    await checkout.close();

    await expect(execute(context, observation, back)).rejects.toThrow();
    expect(await other.title()).toBe("elsewhere");
    await context.close();
  }, 30_000);
});
