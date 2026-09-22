/**
 * The point of the PoC: every capability the upstream repo declares out of
 * scope, exercised through OUR engine (observe -> execute) against the
 * fixtures. No model calls here — this proves the gaps are closed, not that
 * Jev picks well. Model-driven runs live in live.ts.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UPLOAD_DIR = fileURLToPath(new URL("./uploads/", import.meta.url));
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { execute, getActivePage } from "../src/execute.ts";
import { fresh, observe, settle } from "../src/observe.ts";
import { start, stop } from "./fixtures/serve.ts";
import type { ObservedAction, PageObservation } from "../src/types.ts";

// Ephemeral ports: this suite must not collide with fixtures.test.ts, which
// uses the documented fixed pair.
let PRIMARY = 0;
let FOREIGN = 0;
let browser: Browser;
let servers: Awaited<ReturnType<typeof start>>[] = [];

beforeAll(async () => {
  servers = await Promise.all([start(0), start(0)]);
  PRIMARY = servers[0]!.port;
  FOREIGN = servers[1]!.port;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map((s) => stop(s.server)));
});

async function open(fixture: string) {
  const context = await browser.newContext({
    viewport: { width: 1120, height: 780 },
  });
  const page = await context.newPage();
  const foreign = `?foreign=${encodeURIComponent(`http://localhost:${FOREIGN}`)}`;
  await page.goto(`http://localhost:${PRIMARY}/${fixture}${foreign}`, {
    waitUntil: "load",
  });
  // iframe-cross.html sets its child src from the query string after load, so
  // the child frame does not exist yet at "load".
  await page.waitForLoadState("networkidle");
  return context;
}

/** Actions are matched by accessible name, so the test does not depend on id formatting. */
function find(
  observation: PageObservation,
  kind: ObservedAction["kind"],
  label: string | RegExp
) {
  const match = observation.actions.find(
    (action) =>
      action.kind === kind &&
      (typeof label === "string"
        ? action.label === label
        : label.test(action.label))
  );
  if (!match) {
    const offered = observation.actions
      .map((a) => `${a.kind}:${a.label}`)
      .join(" | ");
    throw new Error(
      `No ${kind} action named ${String(label)}. Offered: ${offered}`
    );
  }
  return match;
}

describe("shadow DOM", () => {
  it("reaches a nested open shadow root, and reports the closed one instead of guessing", async () => {
    const context = await open("shadow.html");
    try {
      const first = await observe(context);
      const email = find(first, "fill", "Email address");
      await execute(context, first, email, { text: "someone@example.com" });

      const second = await observe(context);
      await execute(
        context,
        second,
        find(second, "click", "Submit shadow form"),
        {}
      );

      const page = getActivePage(context)!;
      await expect
        .poll(() =>
          page.evaluate(
            () => document.querySelector("#shadow-result")?.textContent
          )
        )
        .toBe("submitted:someone@example.com");

      expect(first.closedShadowHosts).toBeGreaterThanOrEqual(1);
      expect(first.actions.some((a) => a.label === "Hidden button")).toBe(
        false
      );
    } finally {
      await context.close();
    }
  });
});

describe("iframes", () => {
  it("acts inside a same-origin iframe through an offset", async () => {
    const context = await open("iframe-same.html");
    try {
      const first = await observe(context);
      expect(first.frames.length).toBeGreaterThanOrEqual(2);
      await execute(context, first, find(first, "fill", "City"), {
        text: "Lisbon",
      });
      const second = await observe(context);
      await execute(context, second, find(second, "click", "Find"), {});
      const frame = getActivePage(context)!
        .frames()
        .find((candidate) =>
          candidate.url().includes("iframe-same-child.html")
        )!;
      await expect
        .poll(() => frame.locator("#out").textContent())
        .toBe("found:Lisbon");
    } finally {
      await context.close();
    }
  });

  it("acts inside a cross-origin iframe, which is the case raw-CDP ports fail on", async () => {
    const context = await open("iframe-cross.html");
    try {
      const first = await observe(context);
      const cross = first.frames.filter((frame) => frame.crossOrigin);
      expect(cross.length).toBeGreaterThanOrEqual(1);

      const promo = find(first, "fill", "Promo code");
      // The action carries its own frame, and the click point is mapped to
      // top-document coordinates; a wrong offset silently clicks the page body.
      expect(promo.ref?.frameId).toBe(cross[0]!.frameId);
      await execute(context, first, promo, { text: "PARTY10" });

      const second = await observe(context);
      await execute(context, second, find(second, "click", "Apply"), {});

      // Match by path: the parent's own URL now carries the foreign port in
      // its ?foreign= query, so a port-substring match finds the main frame.
      const child = getActivePage(context)!
        .frames()
        .find((frame) => frame.url().includes("iframe-cross-child.html"))!;
      await expect
        .poll(() => child.locator("#out").textContent())
        .toBe("applied:PARTY10");
    } finally {
      await context.close();
    }
  });
});

describe("nested scrolling", () => {
  it("scrolls the inner container, not the window, and only then offers the row", async () => {
    const context = await open("nested-scroll.html");
    try {
      let observation = await observe(context);
      // The row is out of the scroller's view, so it must not be offered yet.
      expect(observation.actions.some((a) => a.label === "Row 47")).toBe(false);
      expect(observation.actions.some((a) => a.kind === "scroll")).toBe(true);

      for (let attempt = 0; attempt < 25; attempt += 1) {
        const row = observation.actions.find(
          (a) => a.kind === "click" && a.label === "Row 47"
        );
        if (row) {
          await execute(context, observation, row, {});
          break;
        }
        const down = observation.actions.find(
          (a) => a.kind === "scroll" && (a.delta ?? 0) > 0
        );
        expect(
          down,
          "a downward scroll must be offered while the row is out of view"
        ).toBeTruthy();
        await execute(context, observation, down!, {});
        await settle(getActivePage(context)!, down!);
        observation = await observe(context);
      }

      const page = getActivePage(context)!;
      await expect.poll(() => page.title()).toBe("row-47");
      // The window itself never scrolled; the container did.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      await context.close();
    }
  });
});

describe("file upload", () => {
  it("uploads a file the code chose from its own directory", async () => {
    const context = await open("upload.html");
    try {
      const observation = await observe(context);
      const input = find(observation, "upload", "Attach flyer");
      await execute(context, observation, input, { uploadDir: UPLOAD_DIR });
      const page = getActivePage(context)!;
      const expected = readdirSync(UPLOAD_DIR)[0];
      await expect
        .poll(() => page.locator("#upload-result").textContent())
        .toBe(expected);
    } finally {
      await context.close();
    }
  });
});

describe("pop-up tabs", () => {
  it("sees the new tab, switches to it as an action, and acts in it", async () => {
    const context = await open("popup.html");
    try {
      const first = await observe(context);
      await execute(
        context,
        first,
        find(first, "click", "Open ticket window"),
        {}
      );

      // The loop always settles after an action; a popup does not exist the
      // instant the click returns.
      await settle(
        getActivePage(context)!,
        find(first, "click", "Open ticket window")
      );
      const second = await observe(context);
      expect(second.tabs.length).toBe(2);
      const switchTab = find(second, "switch_tab", /.+/u);
      await execute(context, second, switchTab, {});

      const third = await observe(context);
      await execute(
        context,
        third,
        find(third, "click", "Confirm booking"),
        {}
      );
      const popup = context.pages().at(-1)!;
      await expect.poll(() => popup.title()).toBe("CONFIRMED");
    } finally {
      await context.close();
    }
  });
});

describe("canvas", () => {
  it("reports the canvas region rather than pretending to read it, and still offers the DOM path", async () => {
    const context = await open("canvas.html");
    try {
      const observation = await observe(context);
      expect(observation.canvases.length).toBeGreaterThanOrEqual(1);
      expect(
        observation.canvases.some((c) => /pick date/iu.test(c.label))
      ).toBe(true);
      expect(observation.canvases[0]!.rect.width).toBeGreaterThan(0);
      find(observation, "click", "Use the list instead");
    } finally {
      await context.close();
    }
  });
});

describe("native select", () => {
  // No fixture covered a native <select> until an Astra review pointed out
  // that every select action carried the option's guard while the executor
  // re-checks the <select>'s, making all of them silently unexecutable.
  it("chooses an option, skips the disabled one, and names controls by label and aria-labelledby", async () => {
    const context = await open("select.html");
    try {
      const observation = await observe(context);
      const vip = find(observation, "select", "Ticket type → VIP");
      expect(observation.actions.some((a) => /Backstage/u.test(a.label))).toBe(
        false
      );

      // The two accessible-name mechanisms FIXTURES.md promised but no fixture
      // exercised, plus a named button that must not inherit its legend.
      find(observation, "fill", "Guest count");
      find(observation, "click", "Pay now");

      await execute(context, observation, vip, {});
      const page = getActivePage(context)!;
      await expect
        .poll(() => page.locator("#select-result").textContent())
        .toBe("tier:vip");
    } finally {
      await context.close();
    }
  });
});

describe("open shadow roots and freshness", () => {
  // The frame marker used element count and text length, neither of which
  // crosses a shadow boundary, so a mutation inside an open shadow root left
  // every outstanding decision looking fresh.
  it("notices a mutation confined to an open shadow root", async () => {
    const context = await open("shadow.html");
    try {
      const observation = await observe(context);
      const page = getActivePage(context)!;
      await page.evaluate(() => {
        const host = document.getElementById("host-open");
        host?.shadowRoot?.append(document.createElement("hr"));
      });
      expect(await fresh(context, observation)).toBe(false);
    } finally {
      await context.close();
    }
  });
});

describe("arbitrary keyboard widget", () => {
  it("drives a combobox that only responds to keys", async () => {
    const context = await open("keyboard.html");
    try {
      let observation = await observe(context);
      const combobox = find(observation, "click", "Choose a plan");
      await execute(context, observation, combobox, {});

      for (const key of ["ArrowDown", "ArrowDown", "Enter"] as const) {
        observation = await observe(context);
        const press = observation.actions.find(
          (a) => a.kind === "press" && a.key === key
        );
        expect(press, `a ${key} press must be offered`).toBeTruthy();
        await execute(context, observation, press!, {});
      }

      const page = getActivePage(context)!;
      await expect
        .poll(() => page.locator("#plan-result").textContent())
        .toBe("Option B");
    } finally {
      await context.close();
    }
  });
});

describe("the security invariant", () => {
  it("refuses a covered target instead of clicking through the overlay", async () => {
    const context = await open("shadow.html");
    try {
      const observation = await observe(context);
      const email = find(observation, "fill", "Email address");
      const page = getActivePage(context)!;
      // Cover the field using an element that is ALREADY in the document, by
      // changing style only. Adding a node would change the frame marker and
      // freshness would reject the action before the hit test ran -- which is
      // how this test used to pass without exercising hit testing at all.
      await page.evaluate(() => {
        const cover = document.getElementById("shadow-result");
        if (!cover) throw new Error("fixture changed: #shadow-result is gone");
        cover.setAttribute(
          "style",
          "position:fixed;inset:0;background:#000;z-index:99999"
        );
      });
      // The marker must be unchanged, or this proves nothing about hit testing.
      expect(await fresh(context, observation)).toBe(true);
      await expect(
        execute(context, observation, email, { text: "x@example.com" })
      ).rejects.toThrow(/not hittable|moved out from under the cursor/u);
    } finally {
      await context.close();
    }
  });

  it("stops retrying a stale action instead of re-dispatching its input forever", async () => {
    const context = await open("shadow.html");
    try {
      const observation = await observe(context);
      const email = find(observation, "fill", "Email address");
      const page = getActivePage(context)!;
      // Make every attempt go stale after the click but before typing, by
      // moving focus away. Without a retry bound the loop re-clicked this
      // field 60 times with nothing recorded in history.
      await page.evaluate(() => {
        const host = document.getElementById("host-open");
        const input = host?.shadowRoot?.querySelector("input");
        input?.addEventListener("focus", () =>
          (document.activeElement as HTMLElement | null)?.blur()
        );
      });
      await expect(
        execute(context, observation, email, { text: "x@example.com" })
      ).rejects.toThrow(/did not take focus/u);
    } finally {
      await context.close();
    }
  });
});
