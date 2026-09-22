import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fillCredentials, findCredentialFields } from "../src/autofill.js";
import { observe } from "../src/observe.js";
import { start, stop } from "./fixtures/serve.js";

describe("credential autofill", () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: { server: Parameters<typeof stop>[0]; port: number };

  beforeEach(async () => {
    server = await start(0);
    browser = await chromium.launch();
    context = await browser.newContext();
  });

  afterEach(async () => {
    await context?.close();
    await browser?.close();
    if (server) await stop(server.server);
  });

  async function pageAndObservation() {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/login.html`);
    return { page, observation: await observe(context) };
  }

  it("finds and classifies username and password fields", async () => {
    const { observation } = await pageAndObservation();
    const fields = await findCredentialFields(context, observation);

    expect(fields).toHaveLength(2);
    expect(fields.map((field) => field.kind)).toEqual([
      "username",
      "password",
    ]);
  });

  it("fills both fields without returning either secret", async () => {
    const { page, observation } = await pageAndObservation();
    const username = "person@example.test";
    const password = "not-for-the-model";

    const outcome = await fillCredentials(context, observation, {
      get: async (kind) => (kind === "username" ? username : password),
    });

    expect(await page.locator("#u").inputValue()).toBe(username);
    expect(await page.locator("#p").inputValue()).toBe(password);
    expect(JSON.stringify(outcome)).not.toContain(password);
    expect(outcome.filled).toEqual(["username", "password"]);
  });

  it("reports a missing password and leaves it empty", async () => {
    const { page, observation } = await pageAndObservation();

    const outcome = await fillCredentials(context, observation, {
      get: async (kind) => (kind === "username" ? "person@example.test" : null),
    });

    expect(await page.locator("#u").inputValue()).toBe("person@example.test");
    expect(await page.locator("#p").inputValue()).toBe("");
    expect(outcome.missing).toEqual(["password"]);
  });

  it("passes the field frame origin to the source", async () => {
    const { observation } = await pageAndObservation();
    const origins: string[] = [];

    await fillCredentials(context, observation, {
      get: async (kind, origin) => {
        origins.push(origin);
        return kind === "username" ? "person@example.test" : "secret";
      },
    });

    expect(origins).toEqual([
      `http://127.0.0.1:${server.port}`,
      `http://127.0.0.1:${server.port}`,
    ]);
  });

  it("does not pass a source error, including its secret, through", async () => {
    const { observation } = await pageAndObservation();
    const password = "private-source-password";

    await expect(
      fillCredentials(context, observation, {
        get: async () => {
          throw new Error(`source failed with ${password}`);
        },
      }),
    ).rejects.toThrow();

    try {
      await fillCredentials(context, observation, {
        get: async () => {
          throw new Error(`source failed with ${password}`);
        },
      });
    } catch (error) {
      expect(String(error)).not.toContain(password);
    }
  });
});
