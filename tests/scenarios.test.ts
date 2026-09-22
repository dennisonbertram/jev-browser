/**
 * Ordinary web journeys, driven only through what the package exports.
 *
 * Every import below comes from the package root. Nothing reaches into a
 * module. If a journey cannot be written this way, the public surface has a
 * gap, and the gap is the finding.
 *
 * The journey itself never uses a CSS selector. A locator appears only to
 * assert the outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  actionSpace,
  createToolHost,
  execute,
  fillCredentials,
  observe,
  screenshotRedacted,
  settle,
  secretRegions,
  type ObservedAction,
  type PageObservation,
} from "../src/index.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** A page holding the given markup, plus its context. */
async function pageWith(html: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  await page.setContent(html);
  return { context, page };
}

/** The observed action with this label, for this kind. */
function byLabel(
  observation: PageObservation,
  kind: ObservedAction["kind"],
  label: string | RegExp
): ObservedAction {
  const match = observation.actions.find(
    (action) =>
      action.kind === kind &&
      (typeof label === "string" ? action.label === label : label.test(action.label))
  );
  if (!match) {
    const offered = observation.actions.map((a) => `${a.kind}:${a.label}`).join(" | ");
    throw new Error(`no ${kind} action named ${String(label)}. Offered: ${offered}`);
  }
  return match;
}

/** Observe, then act on one labelled control, then observe again. */
async function actOn(
  target: Page,
  kind: ObservedAction["kind"],
  label: string | RegExp,
  opts: { text?: string; uploadDir?: string } = {}
): Promise<PageObservation> {
  const observation = await observe(target);
  await execute(target, observation, byLabel(observation, kind, label), opts);
  await target.waitForTimeout(150);
  return observe(target);
}

describe("1. a consent banner covering the page", () => {
  it("hides the covered link, then follows it once the banner is gone", async () => {
    const { context, page } = await pageWith(`
      <main><a id="go" href="#done">Continue to the destination</a>
      <p id="result">not yet</p></main>
      <div id="banner" style="position:fixed;inset:0;background:#fff;z-index:9">
        <p>We use cookies</p><button id="ok">Accept cookies</button></div>
      <script>
        document.getElementById("ok").onclick = () => document.getElementById("banner").remove();
        document.getElementById("go").onclick = (e) => {
          e.preventDefault(); document.getElementById("result").textContent = "arrived";
        };
      </script>`);
    try {
      // The link is under the banner, so it is not a target at all. Offering
      // it and refusing it later costs the caller a turn on an action that
      // could never work.
      const covered = await observe(page);
      expect(covered.actions.map((a) => a.label)).not.toContain(
        "Continue to the destination"
      );
      expect(await page.locator("#result").textContent()).toBe("not yet");

      await actOn(page, "click", "Accept cookies");
      await actOn(page, "click", "Continue to the destination");
      await expect.poll(() => page.locator("#result").textContent()).toBe("arrived");
    } finally {
      await context.close();
    }
  });
});

describe("2. a three-step wizard", () => {
  it("carries state across steps, re-observing each time", async () => {
    const { context, page } = await pageWith(`
      <section id="s1"><label>Full name <input id="who"></label>
        <button id="n1">Next</button></section>
      <section id="s2" hidden><label>Plan
        <select id="plan"><option value="">Choose</option>
        <option value="std">Standard</option><option value="pro">Premium</option></select>
        </label><button id="n2">Next</button></section>
      <section id="s3" hidden><button id="submit">Submit</button></section>
      <p id="out">empty</p>
      <script>
        n1.onclick = () => { s1.hidden = true; s2.hidden = false; };
        n2.onclick = () => { s2.hidden = true; s3.hidden = false; };
        submit.onclick = () => { out.textContent = who.value + "/" + plan.value; };
      </script>`);
    try {
      await actOn(page, "fill", "Full name", { text: "Ada Lovelace" });
      await actOn(page, "click", "Next");
      await actOn(page, "select", /Premium/u);
      await actOn(page, "click", "Next");
      await actOn(page, "click", "Submit");
      await expect.poll(() => page.locator("#out").textContent()).toBe("Ada Lovelace/pro");
    } finally {
      await context.close();
    }
  });
});

describe("3. a typeahead whose suggestions arrive late", () => {
  it("waits for the list, then chooses the second suggestion", async () => {
    const { context, page } = await pageWith(`
      <label>City <input id="q" aria-label="City"></label>
      <ul id="list"></ul><p id="out">none</p>
      <script>
        q.addEventListener("input", () => {
          list.innerHTML = "";
          setTimeout(() => {
            for (const name of ["Lisbon", "Lisburn", "Liskeard"]) {
              const li = document.createElement("li");
              const b = document.createElement("button");
              b.textContent = name;
              b.onclick = () => { out.textContent = "chose:" + name; };
              li.append(b); list.append(li);
            }
          }, 300);
        });
      </script>`);
    try {
      await actOn(page, "fill", "City", { text: "Lis" });
      // The suggestions do not exist yet; observing again after they land is
      // the whole point.
      await page.waitForTimeout(450);
      await actOn(page, "click", "Lisburn");
      await expect.poll(() => page.locator("#out").textContent()).toBe("chose:Lisburn");
    } finally {
      await context.close();
    }
  });
});

describe("4. a modal dialog", () => {
  it("completes the form inside it", async () => {
    const { context, page } = await pageWith(`
      <button id="opener">Edit profile</button><p id="out">closed</p>
      <div id="modal" hidden style="position:fixed;inset:20% 25%;background:#eee;padding:20px">
        <label>Display name <input id="dn"></label>
        <button id="save">Save changes</button></div>
      <script>
        const $ = (id) => document.getElementById(id);
        $("opener").onclick = () => { $("modal").hidden = false; };
        $("save").onclick = () => {
          $("out").textContent = "saved:" + $("dn").value; $("modal").hidden = true;
        };
      </script>`);
    try {
      await actOn(page, "click", "Edit profile");
      await actOn(page, "fill", "Display name", { text: "ada" });
      await actOn(page, "click", "Save changes");
      await expect.poll(() => page.locator("#out").textContent()).toBe("saved:ada");
    } finally {
      await context.close();
    }
  });
});

describe("5. a paginated table", () => {
  it("opens a row that does not exist until the page changes", async () => {
    const { context, page } = await pageWith(`
      <table><tbody id="rows"></tbody></table>
      <button id="next">Next page</button><p id="out">none</p>
      <script>
        let page1 = true;
        function draw() {
          rows.innerHTML = "";
          const start = page1 ? 1 : 21;
          for (let i = start; i < start + 20; i++) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            const b = document.createElement("button");
            b.textContent = "Order " + i;
            b.onclick = () => { out.textContent = "opened:Order " + i; };
            td.append(b); tr.append(td); rows.append(tr);
          }
        }
        next.onclick = () => { page1 = false; draw(); };
        draw();
      </script>`);
    try {
      const first = await observe(page);
      expect(first.actions.some((a) => a.label === "Order 24")).toBe(false);
      await actOn(page, "click", "Next page");
      await actOn(page, "click", "Order 24");
      await expect.poll(() => page.locator("#out").textContent()).toBe("opened:Order 24");
    } finally {
      await context.close();
    }
  });
});

describe("6. a list that grows", () => {
  it("loads more twice, then opens the new item", async () => {
    const { context, page } = await pageWith(`
      <ul id="items"></ul><button id="more">Load more</button><p id="out">none</p>
      <script>
        let n = 0;
        function add() {
          for (let i = 0; i < 5; i++) {
            n++;
            const li = document.createElement("li");
            const b = document.createElement("button");
            const mine = n;
            b.textContent = "Item " + mine;
            b.onclick = () => { out.textContent = "opened:Item " + mine; };
            li.append(b); items.append(li);
          }
        }
        more.onclick = add; add();
      </script>`);
    try {
      await actOn(page, "click", "Load more");
      const grown = await actOn(page, "click", "Load more");
      // Indexes shifted as the list grew; the table is re-read each time.
      expect(grown.actions.some((a) => a.label === "Item 15")).toBe(true);
      await actOn(page, "click", "Item 13");
      await expect.poll(() => page.locator("#out").textContent()).toBe("opened:Item 13");
    } finally {
      await context.close();
    }
  });
});

describe("7. dependent selects", () => {
  it("repopulates the second select after the first changes", async () => {
    const { context, page } = await pageWith(`
      <label>Country <select id="c"><option value="">Choose</option>
        <option value="pt">Portugal</option><option value="ie">Ireland</option></select></label>
      <label>City <select id="city"><option value="">Choose a country first</option></select></label>
      <p id="out">none</p>
      <script>
        const byCountry = { pt: ["Lisbon", "Porto"], ie: ["Dublin", "Cork"] };
        c.onchange = () => {
          city.innerHTML = "";
          for (const name of byCountry[c.value] ?? []) {
            const o = document.createElement("option");
            o.value = name.toLowerCase(); o.textContent = name; city.append(o);
          }
        };
        city.onchange = () => { out.textContent = "city:" + city.value; };
      </script>`);
    try {
      await actOn(page, "select", /Portugal/u);
      const after = await observe(page);
      // The second select's options exist only now.
      expect(after.actions.some((a) => /Porto/u.test(a.label))).toBe(true);
      await actOn(page, "select", /Porto/u);
      await expect.poll(() => page.locator("#out").textContent()).toBe("city:porto");
    } finally {
      await context.close();
    }
  });
});

describe("8. a control that appears late", () => {
  it("finds it on a second observation", async () => {
    const { context, page } = await pageWith(`
      <p id="out">waiting</p>
      <script>
        setTimeout(() => {
          const b = document.createElement("button");
          b.textContent = "Ready now";
          b.onclick = () => { out.textContent = "clicked"; };
          document.body.append(b);
        }, 800);
      </script>`);
    try {
      const early = await observe(page);
      expect(early.actions.some((a) => a.label === "Ready now")).toBe(false);
      await page.waitForTimeout(900);
      await actOn(page, "click", "Ready now");
      await expect.poll(() => page.locator("#out").textContent()).toBe("clicked");
    } finally {
      await context.close();
    }
  });
});

describe("9. a web component", () => {
  it("fills and submits a form inside a nested open shadow root", async () => {
    const { context, page } = await pageWith(`
      <div id="host"></div><p id="out">none</p>
      <script>
        const outer = document.getElementById("host").attachShadow({ mode: "open" });
        outer.innerHTML = "<div id='inner'></div>";
        const inner = outer.querySelector("#inner").attachShadow({ mode: "open" });
        inner.innerHTML =
          "<label>Email address <input id='e'></label><button id='s'>Send invite</button>";
        inner.querySelector("#s").onclick = () => {
          document.getElementById("out").textContent = "sent:" + inner.querySelector("#e").value;
        };
      </script>`);
    try {
      await actOn(page, "fill", "Email address", { text: "ada@example.test" });
      await actOn(page, "click", "Send invite");
      await expect.poll(() => page.locator("#out").textContent()).toBe("sent:ada@example.test");
    } finally {
      await context.close();
    }
  });
});

describe("10. a keyboard-only widget", () => {
  it("opens a calendar with a key and chooses a day", async () => {
    const { context, page } = await pageWith(`
      <div id="cal" role="combobox" aria-label="Choose a day" tabindex="0"
           style="border:1px solid #888;width:180px;min-height:26px;padding:4px">pick a day</div>
      <ul id="days" hidden><li role="option">1 March</li><li role="option">2 March</li></ul>
      <p id="out">no day</p>
      <script>
        let i = -1;
        cal.addEventListener("keydown", (e) => {
          if (e.key === "ArrowDown") { days.hidden = false; i = Math.min(i + 1, 1); e.preventDefault(); }
          if (e.key === "Enter" && i >= 0) { out.textContent = "day:" + days.children[i].textContent; }
        });
      </script>`);
    try {
      await actOn(page, "click", "Choose a day");
      await actOn(page, "press", /ArrowDown/u);
      await actOn(page, "press", /ArrowDown/u);
      await actOn(page, "press", /Enter/u);
      await expect.poll(() => page.locator("#out").textContent()).toBe("day:2 March");
    } finally {
      await context.close();
    }
  });
});

describe("11. a login, then a picture", () => {
  it("fills credentials and covers the password in the screenshot", async () => {
    const { context, page } = await pageWith(`
      <style>input{display:block;width:260px;height:38px}</style>
      <label>Email <input id="u" autocomplete="username"></label>
      <label>Password <input id="p" type="password" autocomplete="current-password"></label>
      <p id="plain">ordinary text</p>`);
    try {
      const secret = "correct-horse-battery";
      const observation = await observe(page);
      const outcome = await fillCredentials(page, observation, {
        get: async (kind) =>
          kind === "username" ? "ada@example.test" : kind === "password" ? secret : null,
      });
      expect(outcome.filled).toContain("password");
      expect(JSON.stringify(outcome)).not.toContain(secret);
      expect(await page.locator("#p").inputValue()).toBe(secret);

      const after = await observe(page);
      expect(JSON.stringify(after)).not.toContain(secret);
      const shot = await screenshotRedacted(page, after, secretRegions(after));
      expect(shot.image.length).toBeGreaterThan(1000);
    } finally {
      await context.close();
    }
  });
});

describe("12. the tool surface on a real journey", () => {
  it("drives a form by index alone and refuses a selector", async () => {
    const { context, page } = await pageWith(`
      <label>Quantity <input id="q" aria-label="Quantity"></label>
      <button id="buy">Place order</button><p id="out">none</p>
      <script>buy.onclick = () => { out.textContent = "ordered:" + q.value; };</script>`);
    try {
      const host = createToolHost({ context: page });
      const table = await host.call("browser_observe", {});
      const indexOf = (pattern: RegExp) => {
        for (const line of table.text.split("\n")) {
          if (pattern.test(line)) return Number(line.match(/\[(\d+)\]/u)?.[1] ?? 0);
        }
        throw new Error(`no control matching ${String(pattern)} in:\n${table.text}`);
      };
      expect((await host.call("browser_type", { index: indexOf(/Quantity/u), text: "3" })).ok).toBe(true);
      await host.call("browser_observe", {});
      expect((await host.call("browser_act", { index: indexOf(/Place order/u) })).ok).toBe(true);
      await expect.poll(() => page.locator("#out").textContent()).toBe("ordered:3");

      const refused = await host.call("browser_act", { selector: "#buy" });
      expect(refused.ok).toBe(false);
    } finally {
      await context.close();
    }
  });
});

describe("13. a checkbox and radio form", () => {
  it("reads current state and changes it", async () => {
    const { context, page } = await pageWith(`
      <label><input type="checkbox" id="terms"> Accept the terms</label>
      <label><input type="radio" name="ship" id="fast"> Express delivery</label>
      <button id="go">Confirm</button><p id="out">none</p>
      <script>go.onclick = () => { out.textContent = "terms:" + terms.checked + ",fast:" + fast.checked; };</script>`);
    try {
      const before = await observe(page);
      const terms = byLabel(before, "click", "Accept the terms");
      expect(terms.checked).toBe(false);
      await actOn(page, "click", "Accept the terms");
      await actOn(page, "click", "Express delivery");
      await actOn(page, "click", "Confirm");
      await expect.poll(() => page.locator("#out").textContent()).toBe("terms:true,fast:true");
    } finally {
      await context.close();
    }
  });
});

describe("14. a disabled control that becomes usable", () => {
  it("does not offer it while disabled, and acts once it is enabled", async () => {
    const { context, page } = await pageWith(`
      <label>Coupon <input id="c" aria-label="Coupon"></label>
      <button id="apply" disabled>Apply coupon</button><p id="out">none</p>
      <script>
        c.oninput = () => { apply.disabled = c.value.length < 3; };
        apply.onclick = () => { out.textContent = "applied:" + c.value; };
      </script>`);
    try {
      await actOn(page, "fill", "Coupon", { text: "SAVE10" });
      await actOn(page, "click", "Apply coupon");
      await expect.poll(() => page.locator("#out").textContent()).toBe("applied:SAVE10");
    } finally {
      await context.close();
    }
  });
});

describe("15. a scrolling panel", () => {
  it("scrolls the panel, not the window, to reach a row", async () => {
    const { context, page } = await pageWith(`
      <style>html,body{margin:0;height:100%;overflow:hidden}
        #panel{height:260px;width:320px;overflow-y:auto;border:1px solid #999}
        #panel a{display:block;padding:10px}</style>
      <div id="panel"></div><p id="out">none</p>
      <script>
        for (let i = 1; i <= 60; i++) {
          const a = document.createElement("a");
          a.href = "#"; a.textContent = "Row " + i;
          a.onclick = (e) => { e.preventDefault(); out.textContent = "row:" + i; };
          panel.append(a);
        }
      </script>`);
    try {
      let observation = await observe(page);
      expect(observation.actions.some((a) => a.label === "Row 40")).toBe(false);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const row = observation.actions.find((a) => a.kind === "click" && a.label === "Row 40");
        if (row) {
          await execute(page, observation, row);
          break;
        }
        const down = observation.actions.find((a) => a.kind === "scroll" && (a.delta ?? 0) > 0);
        expect(down, "a downward scroll must be offered").toBeTruthy();
        await execute(page, observation, down!);
        await page.waitForTimeout(120);
        observation = await observe(page);
      }
      await expect.poll(() => page.locator("#out").textContent()).toBe("row:40");
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      await context.close();
    }
  });
});

describe("a collapsed panel", () => {
  it("keeps its fields out of the action table, but not a file input", async () => {
    const { context, page } = await pageWith(`
      <input aria-label="Where from?">
      <div style="height:0;overflow:clip">
        <input aria-label="Where else?">
        <button>Add airport</button>
      </div>
      <div style="visibility:hidden"><button>Ghost</button></div>
      <label>Photo <input type="file" style="width:0;height:0"></label>
    `);
    const labels = (await observe(context)).actions.map((a) => a.label);
    await context.close();

    expect(labels).toContain("Where from?");
    expect(labels).toContain("Photo");
    expect(labels).not.toContain("Where else?");
    expect(labels).not.toContain("Add airport");
    expect(labels).not.toContain("Ghost");
  });
});

describe("settling after an action", () => {
  it("waits for work the click starts later, not just for the click", async () => {
    // A click that toggles a class at once and rebuilds the page 200 ms
    // later. Anything that waits only for the immediate change returns
    // before the rebuild, and the next observation describes a page that
    // never existed for the person.
    const { context, page } = await pageWith(`
      <button id="go">Start</button><div id="panel"></div>
      <script>
        document.getElementById("go").onclick = () => {
          document.body.classList.add("busy");
          setTimeout(() => {
            document.getElementById("panel").innerHTML =
              '<label>City <input id="city"></label>';
          }, 200);
        };
      </script>`);
    try {
      const before = await observe(page);
      const go = byLabel(before, "click", "Start");
      await execute(page, before, go);
      await settle(page, go);
      const after = await observe(page);
      expect(after.actions.map((a) => a.label)).toContain("City");
    } finally {
      await context.close();
    }
  });
});

describe("icon buttons with no accessible name", () => {
  it("are named from the hints their markup carries, never from noise", async () => {
    // Peek's next-month arrow is exactly this: an SVG inside a button, no
    // text and no aria-label, so a classifier could not choose it.
    const icon = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="m8 4 8 8-8 8"/></svg>';
    const { context, page } = await pageWith(`
      <button data-integration="next-month">${icon}</button>
      <button title="Close dialog">${icon}</button>
      <button data-testid="cartIncrement">${icon}</button>
      <button id="a9f3c2e17b40">${icon}</button>
    `);
    const labels = (await observe(context)).actions
      .filter((a) => a.kind === "click")
      .map((a) => a.label);
    await context.close();

    expect(labels).toContain("next month");
    expect(labels).toContain("Close dialog");
    expect(labels).toContain("cart increment");
    // A generated identifier says nothing; it must not pose as a name.
    expect(labels.some((label) => /a9f3c2e17b40/.test(label))).toBe(false);
  });
});
