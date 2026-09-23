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
