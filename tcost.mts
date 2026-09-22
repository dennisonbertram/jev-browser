import { chromium } from "playwright";
import { observe } from "./src/index.ts";
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 1120, height: 780 } });
const p = await c.newPage();
await p.goto("https://www.google.com/travel/flights", { waitUntil: "load" });
await p.waitForTimeout(2500);
// Full observation, then the CDP diagnostic alone, timed separately.
const full: number[] = [], cdp: number[] = [];
for (let i = 0; i < 6; i++) {
  let t = performance.now(); await observe(c); full.push(performance.now() - t);
  t = performance.now();
  const s = await c.newCDPSession(p);
  await s.send("DOM.getDocument", { depth: -1, pierce: true });
  await s.detach();
  cdp.push(performance.now() - t);
}
const med = (a: number[]) => Math.round([...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]);
console.log(`observe median ${med(full)}ms   DOM.getDocument median ${med(cdp)}ms`);
await b.close();
