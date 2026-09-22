/**
 * A standalone task, outside any product.
 *
 * This file imports the library the way any other project would, launches its
 * own browser, and drives a page with the tool surface. It proves the library
 * needs nothing from the repository it came from.
 *
 *   npx tsx examples/standalone.ts            # against a local fixture
 *   npx tsx examples/standalone.ts <url>      # against any page
 */
import { createToolHost, launchLocal } from "../src/index.ts";
import { start, stop } from "../tests/fixtures/serve.ts";

const target = process.argv[2];
const fixtures = target ? null : await start(0);
const url = target ?? `http://127.0.0.1:${fixtures!.port}/select.html`;

const session = await launchLocal({ headless: true });
try {
  await session.page.goto(url, { waitUntil: "load" });

  const host = createToolHost({ context: session.context });
  console.log(`tools: ${host.definitions().map((d) => d.name).join(", ")}\n`);

  const table = await host.call("browser_observe", {});
  console.log(table.text.split("\n").slice(0, 12).join("\n"));

  // Name an element only by its index in the table above.
  const line = table.text.split("\n").find((entry) => /\(.*CLICK.*\)/u.test(entry));
  const index = Number(line?.match(/\[(\d+)\]/u)?.[1] ?? 0);
  if (index > 0) {
    const acted = await host.call("browser_act", { index });
    console.log(`\nbrowser_act on index ${index}: ok=${acted.ok} ${acted.text}`);
  }

  const refused = await host.call("browser_act", { selector: "#pay" });
  console.log(`a selector is refused: ok=${refused.ok} ${refused.text}`);
} finally {
  await session.close();
  if (fixtures) await stop(fixtures.server);
}
