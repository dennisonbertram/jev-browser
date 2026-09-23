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
      `<button onclick="document.title = 'clicked'">Continue</button>`
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
