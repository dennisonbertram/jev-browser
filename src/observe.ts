// Turns a live Playwright browser into one merged PageObservation.
//
// Node/guard semantics: window.__jevFast.snapshot() is evaluated once per
// frame per observe() call. Between observe() calls (i.e. while an action is
// being resolved and executed) we never re-run it, so the node indices and
// guards a frame handed out stay valid until the next observe(). fresh()
// re-checks those same indices in place; it never re-snapshots.
import { contextOf, type BrowserTarget } from "./target.js";
import type { BrowserContext, Frame, Page } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getActivePage } from "./execute.js";
import type {
  FrameRef,
  FrameSnapshot,
  ObservedAction,
  PageObservation,
} from "./types.js";

// re-exported so verification scripts / callers don't need their own import

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(THIS_DIR, "snapshot-dom.js");

// Stable per-process frame ids. A Playwright Frame instance stays the same
// object for the life of the frame (same-document navigations included), so
// a WeakMap gives us cheap, stable ids without touching the page.
let frameCounter = 0;
const frameIds = new WeakMap<Frame, string>();
const framesById = new Map<string, Frame>();

function idFor(frame: Frame): string {
  let id = frameIds.get(frame);
  if (!id) {
    id = `f${frameCounter++}`;
    frameIds.set(frame, id);
  }
  framesById.set(id, frame);
  // The id map is strong, so without this every frame of every page ever
  // observed stays reachable for the life of the process.
  for (const [key, known] of framesById) {
    if (known.isDetached()) framesById.delete(key);
  }
  return id;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// Tracks every page (tab/popup) ever seen for a context, in discovery order.
const trackedPages = new WeakMap<BrowserContext, Page[]>();

function trackPages(context: BrowserContext): Page[] {
  let pages = trackedPages.get(context);
  if (!pages) {
    pages = [];
    trackedPages.set(context, pages);
    // window.open() etc. surface here; context.pages() alone can race a
    // popup that opened but hasn't been indexed by Playwright yet.
    context.on("page", (p) => {
      if (!pages!.includes(p)) pages!.push(p);
    });
  }
  for (const p of context.pages()) {
    if (!pages.includes(p)) pages.push(p);
  }
  return pages.filter((p) => !p.isClosed());
}

// Chromium reports document.visibilityState per tab, which is the real
// browser-focus signal (a freshly opened popup takes it from its opener).
async function pickActive(pages: Page[], chosen?: Page): Promise<Page> {
  // switch_tab is an action, so the executor's choice wins over visibility.
  if (chosen && !chosen.isClosed() && pages.includes(chosen)) return chosen;
  const first = pages[0];
  if (first === undefined) throw new Error("The context has no open page");
  if (pages.length === 1) return first;
  const visible = await Promise.all(
    pages.map((p) =>
      p
        .evaluate(() => document.visibilityState === "visible")
        .catch(() => false)
    )
  );
  const idx = visible.findIndex(Boolean);
  return pages[idx] ?? first;
}

/**
 * Counts closed shadow roots, which page script cannot see at all: a closed
 * root is unreachable from JS by design. Chrome exposes them over CDP — this
 * is how DevTools inspects them — so the honest count comes from there.
 * Limited to the active page's process tree; an out-of-process iframe would
 * need its own session, which the PoC does not open.
 */
async function countClosedShadowRoots(page: Page): Promise<number> {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const { root } = (await session.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as {
      root: unknown;
    };
    let count = 0;
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.shadowRootType === "closed") count += 1;
      for (const key of [
        "children",
        "shadowRoots",
        "contentDocument",
        "pseudoElements",
      ]) {
        const value = record[key];
        if (Array.isArray(value)) for (const child of value) walk(child);
        else if (value) walk(value);
      }
    };
    walk(root);
    return count;
  } catch {
    return 0;
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

/** A scroller's label is derived from its contents, which can be the whole list. */
function clampLabel(label: string): string {
  const single = label.replace(/\s+/gu, " ").trim();
  return single.length > 60
    ? `${single.slice(0, 57)}...`
    : single || "this region";
}

async function snapshotFrame(
  frame: Frame,
  frameId: string,
  src: string
): Promise<FrameSnapshot | null> {
  if (frame.isDetached()) return null;
  try {
    return await frame.evaluate(
      ({ src, fid }) => {
        (globalThis as unknown as { __jevFrameId: string }).__jevFrameId = fid;
        // The snapshot engine is authored as a plain script, not a module,
        // so it installs window.__jevFast as a side effect of running it.
        // eslint-disable-next-line no-eval
        (0, eval)(src);
        return (
          window as unknown as { __jevFast: { snapshot(): FrameSnapshot } }
        ).__jevFast.snapshot();
      },
      { src, fid: frameId }
    );
  } catch {
    // Frame detached, or navigated to a new document, mid-walk.
    return null;
  }
}

function fingerprint(
  frames: FrameRef[],
  markers: Record<string, string>,
  tabs: PageObservation["tabs"],
  scrollState: string[],
  valueStates: string[],
  text: string
): string {
  // The frame's URL and its marker, never the assigned frame id. An id is
  // local to this process: attaching to the same browser from another process
  // creates new frame objects with new ids, and an identical page would then
  // fingerprint differently. Session state depends on this being stable.
  const framePart = frames
    .map((f) => `${f.url}:${markers[f.frameId] ?? ""}`)
    .sort()
    .join("|");
  const tabPart = tabs
    .map((t) => `${t.index}:${t.url}`)
    .sort()
    .join(",");
  // Scroll position belongs here, not in the frame marker: it changes what is
  // reachable (so "did anything happen?" must see it) without invalidating the
  // node guards that outstanding decisions rely on.
  const scrollPart = [...scrollState].sort().join("|");
  // Field values are here and not in the marker: filling three fields is
  // progress, and the loop called it "stuck" until this was part of the
  // fingerprint.
  const valuePart = [...valueStates].sort().join("|");
  // Visible text is here and not in the marker, for the same reason: new
  // content is progress, but text changing elsewhere must not invalidate an
  // action on a control that has not moved.
  return createHash("sha1")
    .update(`${framePart}||${tabPart}||${scrollPart}||${valuePart}||${text}`)
    .digest("hex");
}

export async function observe(
  target: BrowserTarget,
  opts?: {
    screenshot?: boolean;
    /**
     * Count closed shadow roots. On by default. It is a diagnostic, not an
     * input to any decision, and it costs a full CDP DOM tree: 26 ms of a
     * 54 ms observation on a real page. A loop that observes every turn
     * should turn it off and count once at the end.
     */
    diagnostics?: boolean;
  }
): Promise<PageObservation> {
  const context = contextOf(target);
  const src = readFileSync(SNAPSHOT_PATH, "utf8");
  const pages = trackPages(context);
  const active = await pickActive(pages, getActivePage(context));
  const topOrigin = originOf(active.url());

  const frames: FrameRef[] = [];
  const actions: ObservedAction[] = [];
  const guards: Record<string, string> = {};
  const markers: Record<string, string> = {};
  const scrollState: string[] = [];
  const valueStates: string[] = [];
  const canvases: PageObservation["canvases"] = [];
  let closedShadowHosts = 0;
  const textParts: string[] = [];

  for (const frame of active.frames()) {
    if (frame.isDetached()) continue;

    let offset = { x: 0, y: 0 };
    if (frame !== active.mainFrame()) {
      // ElementHandle.boundingBox() is already top-document-relative even
      // for a doubly-nested cross-origin iframe (Playwright resolves it via
      // CDP, not page JS, so the same-origin restriction on window.frameElement
      // doesn't apply). This is a border-box position: an iframe with a
      // non-zero border/padding will be off by that amount.
      let box;
      try {
        const el = await frame.frameElement();
        box = await el.boundingBox();
      } catch {
        continue; // detached mid-walk
      }
      if (!box) continue;
      offset = { x: box.x, y: box.y };
    }

    const frameId = idFor(frame);
    const snap = await snapshotFrame(frame, frameId, src);
    if (!snap) continue;

    const crossOrigin = originOf(snap.url) !== topOrigin;
    frames.push({ frameId, url: snap.url, offset, crossOrigin });
    markers[frameId] = snap.marker;
    if (snap.text) textParts.push(snap.text);

    for (const a of snap.actions) {
      if (a.ref) a.ref = { frameId, node: a.ref.node };
      actions.push(a);
    }
    // types.ts gives guards the same `${node}` keying inside one frame's
    // FrameSnapshot; merged across frames that collides, so we namespace by
    // frame here. Flagged in the handoff since types.ts doesn't say.
    for (const [node, g] of Object.entries(snap.guards)) {
      guards[`${frameId}:${node}`] = g;
    }
    valueStates.push(`${snap.url}:${snap.valueState}`);
    scrollState.push(
      `${snap.url}:${snap.scrollers.map((entry) => `${entry.node ?? "v"}=${entry.top}`).join(",")}`
    );
    for (const scroller of snap.scrollers) {
      // One action per available direction, per container. A page with three
      // scrollers offers three distinct SCROLL_DOWN targets, which is what
      // makes "scroll the list, not the window" expressible at all.
      const container =
        scroller.node === undefined
          ? undefined
          : { frameId, node: scroller.node };
      // A frame's viewport has no node. Aim at the centre of THIS frame's
      // visible box, not the top page's: a 300x150 iframe otherwise got a
      // wheel dispatched far outside itself.
      const point = container
        ? undefined
        : {
            x: scroller.rect.x + scroller.rect.width / 2,
            y: scroller.rect.y + scroller.rect.height / 2,
          };
      // Half a viewport, not most of one: measured, a 0.8 step jumped past
      // the window where the target row was visible and the policy hunted
      // up and down around it.
      const step = Math.max(120, Math.round(scroller.rect.height * 0.5));
      // Without a position the policy cannot tell a first scroll from a tenth,
      // and it oscillates up and down forever. Measured: it did exactly that.
      const span = Math.max(1, scroller.scrollHeight - scroller.rect.height);
      const progress = Math.round((Math.min(scroller.top, span) / span) * 100);
      const where = container
        ? `${frameId}:${scroller.node}`
        : `${frameId}:viewport`;
      // The executor re-checks a container scroll against the node's own
      // guard, so the action must carry that guard, not an invented one.
      const scrollGuard = container
        ? (snap.guards[String(scroller.node)] ?? "")
        : `${frameId}:viewport`;
      if (scroller.canUp) {
        actions.push({
          id: `${where}:scroll_up`,
          kind: "scroll",
          label: `Scroll up in ${clampLabel(scroller.label)} (currently ${progress}% down)`,
          ref: { frameId, node: scroller.node ?? -1 },
          container,
          point,
          delta: -step,
          guard: scrollGuard,
        });
      }
      if (scroller.canDown) {
        actions.push({
          id: `${where}:scroll_down`,
          kind: "scroll",
          label: `Scroll down in ${clampLabel(scroller.label)} (currently ${progress}% down)`,
          ref: { frameId, node: scroller.node ?? -1 },
          container,
          point,
          delta: step,
          guard: scrollGuard,
        });
      }
    }
    for (const c of snap.canvases) {
      canvases.push({
        ref: { frameId, node: c.node },
        rect: {
          x: c.rect.x + offset.x,
          y: c.rect.y + offset.y,
          width: c.rect.width,
          height: c.rect.height,
        },
        label: c.label,
      });
    }
  }

  closedShadowHosts =
    opts?.diagnostics === false ? 0 : await countClosedShadowRoots(active);

  const orderedPages = [active, ...pages.filter((p) => p !== active)];
  const tabs = await Promise.all(
    orderedPages.map(async (p, index) => ({
      index,
      pageIndex: pages.indexOf(p),
      title: await p.title().catch(() => ""),
      url: p.url(),
      active: index === 0,
    }))
  );
  for (let i = 1; i < tabs.length; i++) {
    const tab = tabs[i];
    if (tab === undefined) continue;
    actions.push({
      id: `tab:${i}:switch_tab`,
      kind: "switch_tab",
      label: `Switch to tab ${i + 1}: ${tab.title || new URL(tab.url).pathname}`,
      tabIndex: i,
      guard: `tab:${i}:${tab.url}`,
    });
  }

  // Waiting is always an option. The classifier knew the WAIT operation and
  // the executor could carry it out, but nothing ever offered one, so a page
  // still loading its results left only the choice between clicking
  // something and giving up. It targets no element, so it needs no guard.
  actions.push({
    id: "wait",
    kind: "wait",
    label: "Wait for the page to finish updating",
    value: "1500",
    guard: "wait",
  });
  // Going back is offered when this site has a page to go back to, so a
  // wrong turn or a detail page can return to the results. The Navigation
  // API sees only this site's entries.
  // ponytail: no BACK across sites; a CDP navigation history would allow it.
  const canGoBack = await active
    .evaluate(
      () =>
        (globalThis as { navigation?: { canGoBack?: boolean } }).navigation
          ?.canGoBack === true
    )
    .catch(() => false);
  if (canGoBack)
    actions.push({
      id: "back",
      kind: "back",
      label: "Go back to the previous page",
      guard: "back",
    });

  const observation: PageObservation = {
    url: active.url(),
    title: await active.title().catch(() => ""),
    text: textParts.join("\n"),
    fingerprint: fingerprint(
      frames,
      markers,
      tabs,
      scrollState,
      valueStates,
      textParts.join("\n")
    ),
    frames,
    actions,
    guards,
    markers,
    canvases,
    closedShadowHosts,
    tabs,
  };

  if (opts?.screenshot) {
    const png = await active.screenshot({ type: "png" }).catch(() => null);
    if (png) observation.screenshot = png.toString("base64");
  }

  return observation;
}

export async function fresh(
  target: BrowserTarget,
  observation: PageObservation,
  action?: ObservedAction
): Promise<boolean> {
  const context = contextOf(target);
  try {
    // A tab appearing or closing changes what is possible, so a decision made
    // before it cannot be accepted after it -- including a DONE or BLOCKED.
    const live = context
      .pages()
      .filter((page) => !page.isClosed())
      .map((page) => page.url())
      .sort();
    const seen = observation.tabs.map((tab) => tab.url).sort();
    if (
      live.length !== seen.length ||
      live.some((url, index) => url !== seen[index])
    )
      return false;
    for (const f of observation.frames) {
      const frame = framesById.get(f.frameId);
      if (!frame || frame.isDetached()) return false;
      const marker = await frame
        .evaluate(
          () =>
            (
              window as unknown as { __jevFast?: { marker(): string } }
            ).__jevFast?.marker() ?? null
        )
        .catch(() => null);
      if (marker == null || marker !== observation.markers[f.frameId])
        return false;
    }
    if (action?.ref) {
      const frame = framesById.get(action.ref.frameId);
      if (!frame || frame.isDetached()) return false;
      const guard = await frame
        .evaluate(
          (node) =>
            (
              window as unknown as {
                __jevFast?: { guard(n: number): string | null };
              }
            ).__jevFast?.guard(node) ?? null,
          action.ref.node
        )
        .catch(() => null);
      if (!guard) return false;
      if (action.guard && guard !== action.guard) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until the page's freshness token stops changing.
 *
 * The token is the same one `fresh()` compares, so this waits for exactly the
 * thing that otherwise invalidates the next decision. An earlier version
 * waited two animation frames, about 32 ms, and a click on Google Flights
 * first toggles a class and only then starts the work: the real re-render
 * landed 107 to 209 ms later, and the decision taken in between was already
 * stale when it executed.
 *
 * `expected` is the token the decision was made from. A page whose token
 * never moves costs `reactMs`. One that never stops costs `capMs`. A page
 * that reacts and settles costs however long that takes.
 *
 * The body below declares no named functions on purpose. The bundler adds a
 * `__name` helper to those, the helper does not exist in the page, and the
 * resulting ReferenceError went into settle's catch: every version of this
 * wait returned in 6 ms without ever running.
 */
async function domQuiet(
  frame: Frame,
  expected: string | undefined,
  reactMs = 350,
  capMs = 900
): Promise<void> {
  await Promise.race([
    frame
      .evaluate(
        ([react, cap, before]) =>
          new Promise<void>((resolve) => {
            const jev = (
              window as unknown as { __jevFast?: { marker(): string } }
            ).__jevFast;
            if (!jev) return resolve();
            const started = performance.now();
            let last = jev.marker();
            let stable = 0;
            // The page often reacts while the action is still executing, so
            // by the time this starts the change has already happened.
            // Comparing against the marker the decision was made from sees
            // that, where comparing against the marker now does not: every
            // action on a simple page paid the whole no-reaction wait.
            let changed = typeof before === "string" && last !== before;
            const id = setInterval(() => {
              const waited = performance.now() - started;
              const now = jev.marker();
              if (now === last) stable += 1;
              else {
                stable = 0;
                changed = true;
                last = now;
              }
              if (
                (stable >= 2 && (changed || waited > react)) ||
                waited > cap
              ) {
                clearInterval(id);
                resolve();
              }
            }, 32);
          }),
        [reactMs, capMs, expected] as const
      )
      .catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, capMs + 100)),
  ]);
}

// Polls up to 200ms for options to appear under a combobox's aria-controls/
// aria-owns target. Returns null (not true/false) when the acted-on node
// isn't a combobox with a controlled listbox, so the caller falls back to
// the generic two-frame wait instead of burning the full 200ms.
async function pollComboboxOptions(
  frame: Frame,
  node: number
): Promise<boolean | null> {
  const deadline = Date.now() + 200;
  for (;;) {
    const state = await frame
      .evaluate((n) => {
        const reg = (
          window as unknown as { __jevFast?: { nodes: Map<number, Element> } }
        ).__jevFast;
        const el = reg?.nodes.get(n) as HTMLElement | undefined;
        if (!el) return "gone";
        const targetId =
          el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
        if (!targetId) return "not-combobox";
        const target = el.ownerDocument.getElementById(targetId);
        const opt = target?.querySelector(
          '[role="option"]'
        ) as HTMLElement | null;
        return opt && opt.offsetParent !== null ? "found" : "pending";
      }, node)
      .catch(() => "gone");
    if (state === "not-combobox") return null;
    if (state === "found") return true;
    if (Date.now() >= deadline) return state === "gone" ? null : true;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function settle(
  page: Page,
  action: ObservedAction,
  /** The acting frame's marker when the decision was made, if you have it. */
  expectedMarker?: string
): Promise<void> {
  // The node number belongs to the action's own frame's registry. Resolving it
  // against the top document watched an unrelated element, or the top window.
  const owner =
    (action.container?.frameId ?? action.ref?.frameId) === undefined
      ? page.mainFrame()
      : (framesById.get(
          (action.container?.frameId ?? action.ref?.frameId) as string
        ) ?? page.mainFrame());
  if (action.kind === "scroll") {
    // Wheel scrolling is asynchronous: it has usually not started when the
    // dispatch returns, and it keeps going after it does. Wait for movement,
    // then for the position to hold still. Without the first wait, every
    // other observation described the page before the scroll.
    await owner
      .evaluate(
        (node) =>
          new Promise<void>((resolve) => {
            const registry = (
              window as unknown as {
                __jevFast?: { nodes: Map<number, Element> };
              }
            ).__jevFast;
            const element = node >= 0 ? registry?.nodes.get(node) : undefined;
            const read = () =>
              element instanceof Element ? element.scrollTop : window.scrollY;
            const start = read();
            let last = start;
            let stable = 0;
            const deadline = performance.now() + 400;
            const tick = () => {
              const now = read();
              stable = now === last ? stable + 1 : 0;
              last = now;
              const moved = now !== start;
              if ((moved && stable >= 2) || performance.now() > deadline)
                resolve();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
        action.container?.node ?? -1
      )
      .catch(() => undefined);
    return;
  }

  // This runs after the action is already recorded, so any failure here
  // must be swallowed rather than surfaced.
  try {
    const frame =
      (action.ref && framesById.get(action.ref.frameId)) || page.mainFrame();
    if (frame.isDetached()) return;
    if (action.kind === "fill" && action.ref) {
      const waited = await pollComboboxOptions(frame, action.ref.node);
      if (waited !== null) return;
    }
    // A click can navigate or open something, so it is worth waiting for a
    // page that has not reacted yet. Typing into a plain field usually does
    // nothing until it is submitted, and the one reaction that matters, a
    // suggestion list, is already handled above.
    await domQuiet(frame, expectedMarker, action.kind === "fill" ? 150 : 350);
  } catch {
    // never throw out of settle()
  }
}

/**
 * How many closed shadow roots the active page holds.
 *
 * A closed root is unreachable by design, so this is the honest signal that
 * part of the page cannot be described. Call it once when a run ends, rather
 * than on every observation.
 */
export async function closedShadowHosts(target: BrowserTarget): Promise<number> {
  const page = getActivePage(contextOf(target));
  return page ? countClosedShadowRoots(page) : 0;
}
