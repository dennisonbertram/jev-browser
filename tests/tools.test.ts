/**
 * The tool surface is what a product mounts, so these tests hold it to the
 * library's central rule: an index into the observed table is the only way to
 * name an element, and nothing else reaches the page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { createToolHost } from "../src/tools.js";
import { start, stop } from "./fixtures/serve.js";

let browser: Browser;
let servers: Awaited<ReturnType<typeof start>>[] = [];
let base = "";

beforeAll(async () => {
  const server = await start(0);
  servers = [server];
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const server of servers) await stop(server.server);
});

async function open(fixture: string) {
  const context = await browser.newContext({ viewport: { width: 1120, height: 780 } });
  const page = await context.newPage();
  await page.goto(`${base}/${fixture}`, { waitUntil: "load" });
  return { context, page };
}

/** The index the table gives a control whose label matches. */
function indexOf(table: string, pattern: RegExp): number {
  for (const line of table.split("\n")) {
    if (!pattern.test(line)) continue;
    const match = line.match(/^\s*\[(\d+)\]/u);
    if (match?.[1]) return Number(match[1]);
  }
  throw new Error(`No control matched ${String(pattern)} in:\n${table}`);
}

describe("definitions", () => {
  it("publishes all seven tools with a name, a description and a schema", async () => {
    const { context } = await open("select.html");
    try {
      const host = createToolHost({ context });
      const names = host.definitions().map((d) => d.name);
      expect(names).toEqual([
        "browser_observe",
        "browser_act",
        "browser_type",
        "browser_login",
        "browser_screenshot",
        "browser_scroll",
        "browser_switch_tab",
      ]);
      for (const definition of host.definitions()) {
        expect(definition.description.length).toBeGreaterThan(20);
        expect(typeof definition.parameters).toBe("object");
      }
    } finally {
      await context.close();
    }
  });
});

describe("observation", () => {
  it("returns accessible names, not element ids", async () => {
    const { context } = await open("select.html");
    try {
      const host = createToolHost({ context });
      const result = await host.call("browser_observe", {});
      expect(result.ok).toBe(true);
      // The fixture's ids are "guests" and "pay"; the names are these.
      expect(result.text).toContain("Ticket type");
      expect(result.text).toContain("Guest count");
      expect(result.text).toContain("Pay now");
    } finally {
      await context.close();
    }
  });
});

describe("acting by index", () => {
  it("clicks the control at an index", async () => {
    // canvas.html's link has a visible effect on click; the keyboard fixture's
    // combobox deliberately answers only to keys.
    const { context, page } = await open("canvas.html");
    try {
      const host = createToolHost({ context });
      const table = (await host.call("browser_observe", {})).text;
      const result = await host.call("browser_act", {
        index: indexOf(table, /Use the list instead/u),
      });
      expect(result.ok).toBe(true);
      await expect.poll(() => page.locator("#canvas-result").textContent()).toBe("list-used");
    } finally {
      await context.close();
    }
  });

  it("types caller text into the field at an index", async () => {
    const { context, page } = await open("select.html");
    try {
      const host = createToolHost({ context });
      const table = (await host.call("browser_observe", {})).text;
      const result = await host.call("browser_type", {
        index: indexOf(table, /Guest count/u),
        text: "four",
      });
      expect(result.ok).toBe(true);
      await expect.poll(() => page.locator("#guests").inputValue()).toBe("four");
    } finally {
      await context.close();
    }
  });

  it("refuses an index before any observation", async () => {
    const { context } = await open("select.html");
    try {
      const host = createToolHost({ context });
      const result = await host.call("browser_act", { index: 1 });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("browser_observe");
    } finally {
      await context.close();
    }
  });

  it("refuses an index the observation does not hold, and does not act", async () => {
    const { context, page } = await open("select.html");
    try {
      const host = createToolHost({ context });
      await host.call("browser_observe", {});
      const result = await host.call("browser_act", { index: 9999 });
      expect(result.ok).toBe(false);
      await expect.poll(() => page.locator("#select-result").textContent()).toBe("none");
    } finally {
      await context.close();
    }
  });
});

describe("the index rule", () => {
  it("refuses a selector, an xpath, a coordinate and code, on every tool", async () => {
    const { context } = await open("select.html");
    try {
      const host = createToolHost({ context });
      await host.call("browser_observe", {});
      const attempts = [
        { selector: "#go" },
        { xpath: "//button" },
        { x: 10, y: 20 },
        { script: "document.querySelector('#go').click()" },
        { index: 1, selector: "#go" },
      ];
      for (const definition of host.definitions()) {
        for (const args of attempts) {
          const result = await host.call(definition.name, args);
          expect(result.ok, `${definition.name} accepted ${JSON.stringify(args)}`).toBe(false);
        }
      }
    } finally {
      await context.close();
    }
  });

  it("refuses an unknown tool", async () => {
    const { context } = await open("select.html");
    try {
      const host = createToolHost({ context });
      const result = await host.call("browser_exec", { code: "1" });
      expect(result.ok).toBe(false);
    } finally {
      await context.close();
    }
  });
});

describe("credentials and pictures", () => {
  it("fills credentials and reports no value", async () => {
    const { context, page } = await open("login.html");
    try {
      const password = "correct-horse-battery";
      const host = createToolHost({
        context,
        credentials: {
          get: async (kind) =>
            kind === "username" ? "ada@example.test" : kind === "password" ? password : null,
        },
      });
      await host.call("browser_observe", {});
      const result = await host.call("browser_login", {});
      expect(result.ok).toBe(true);
      expect(result.text).not.toContain(password);
      expect(result.text).not.toContain("ada@example.test");
      await expect.poll(() => page.locator("#p").inputValue()).toBe(password);
    } finally {
      await context.close();
    }
  });

  it("returns a picture and cannot be asked to skip redaction", async () => {
    const { context } = await open("secrets.html");
    try {
      const host = createToolHost({ context });
      await host.call("browser_observe", {});
      const result = await host.call("browser_screenshot", {});
      expect(result.ok).toBe(true);
      // The schema takes no arguments, so redaction cannot be turned off.
      const definition = host.definitions().find((d) => d.name === "browser_screenshot");
      expect(Object.keys((definition?.parameters as { properties: object }).properties)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
