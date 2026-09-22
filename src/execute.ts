/**
 * The executor. Takes one ObservedAction the model chose by index, re-resolves
 * it against the live page, and performs it with real input events. Never
 * trusts a stored coordinate or a model-supplied selector/path/key/script.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextOf, type BrowserTarget } from "./target.ts";
import type { BrowserContext, Frame, Page } from "playwright";
import { StalePage } from "./types.ts";
import type { NodeRef, ObservedAction, PageObservation } from "./types.ts";

// No default. A product must name the directory it allows, or an upload is
// refused: a fallback inside the source tree uploaded whatever happened to sit
// there, which the documentation denied.

const PRESS_KEY_ALLOWLIST = new Set([
  "Enter",
  "Escape",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
]);

// Which page is "active" per context, set by switch_tab. Not part of
// PageObservation because it is executor-side state the next observe() call needs.
const activePage = new WeakMap<BrowserContext, Page>();

export function getActivePage(context: BrowserContext): Page | undefined {
  const chosen = activePage.get(context);
  if (chosen && !chosen.isClosed()) return chosen;
  // Before any switch_tab there is no executor-side choice; the opener is the
  // active page, and a closed one must not linger.
  return context.pages().find((page) => !page.isClosed());
}

function requireRef(action: ObservedAction): NodeRef {
  if (!action.ref)
    throw new Error(`action ${action.id} (${action.kind}) has no node ref`);
  return action.ref;
}

/** Finds the live Playwright Frame that owns frameId, searching the active page first. */
async function locateFrame(
  context: BrowserContext,
  frameId: string
): Promise<{ page: Page; frame: Frame }> {
  const preferred = activePage.get(context);
  const pages = context.pages();
  const ordered = preferred
    ? [preferred, ...pages.filter((p) => p !== preferred)]
    : pages;
  for (const page of ordered) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      const fid = await frame
        .evaluate(
          () =>
            (window as unknown as { __jevFast?: { frameId: string } }).__jevFast
              ?.frameId
        )
        .catch(() => undefined);
      if (fid === frameId) return { page, frame };
    }
  }
  throw new StalePage(`frame ${frameId} not found in any open tab`);
}

/** Rule 1: check the frame's whole-document marker, then (if node given) the node's own guard. */
async function checkFreshness(
  observation: PageObservation,
  frame: Frame,
  frameId: string,
  node: number | undefined,
  guard: string,
  /** True once input has been dispatched, so the caller cannot replay. */
  afterInput = false
): Promise<void> {
  const expectedMarker = observation.markers[frameId];
  const liveMarker = await frame
    .evaluate(() =>
      (
        window as unknown as { __jevFast: { marker(): string } }
      ).__jevFast.marker()
    )
    .catch(() => undefined);
  if (liveMarker === undefined || liveMarker !== expectedMarker) {
    throw new StalePage(`frame ${frameId} marker changed`, afterInput);
  }
  // The decision was made from every frame in the tab, so every frame has to
  // still hold. Checked in parallel; there are rarely more than a handful.
  const others = Object.keys(observation.markers).filter(
    (id) => id !== frameId
  );
  const byId = new Map<string, Frame>();
  await Promise.all(
    frame
      .page()
      .frames()
      .map(async (candidate) => {
        const id = await candidate
          .evaluate(
            () =>
              (window as unknown as { __jevFast?: { frameId: string } })
                .__jevFast?.frameId
          )
          .catch(() => undefined);
        if (typeof id === "string") byId.set(id, candidate);
      })
  );
  // Another frame's content is not evidence about this one. Google Flights
  // carries an iframe that rewrites itself continuously, and comparing its
  // marker threw away 5 good decisions in two runs. A frame that has gone
  // away still counts: the decision was made from a tab that had it.
  const missing = others.find((id) => {
    const other = byId.get(id);
    return !other || other.isDetached();
  });
  if (missing !== undefined)
    throw new StalePage(
      `frame ${missing} is gone since the decision was made`
    );
  if (node === undefined) return;
  const liveGuard = await frame
    .evaluate(
      (n) =>
        (
          window as unknown as {
            __jevFast: { guard(n: number): string | null };
          }
        ).__jevFast.guard(n),
      node
    )
    .catch(() => null);
  if (liveGuard === null || liveGuard !== guard) {
    throw new StalePage(
      `node ${node} in frame ${frameId} guard mismatch`,
      afterInput
    );
  }
}

/** Rule 2+3: fresh frame-local hit point, converted to top-document coordinates via the frame's offset. */
/**
 * The iframe's position RIGHT NOW, not when the observation was taken. The
 * parent can scroll between the two, and a stale offset silently moves every
 * click inside that frame.
 */
async function currentOffset(frame: Frame): Promise<{ x: number; y: number }> {
  if (frame.parentFrame() === null) return { x: 0, y: 0 };
  const element = await frame.frameElement().catch(() => null);
  const box = element ? await element.boundingBox().catch(() => null) : null;
  await element?.dispose().catch(() => undefined);
  if (!box)
    throw new StalePage(
      `frame ${frame.url()} is no longer positioned in its parent`
    );
  return { x: box.x, y: box.y };
}

async function resolveHitPoint(
  observation: PageObservation,
  frame: Frame,
  frameId: string,
  node: number
): Promise<{
  local: { x: number; y: number };
  page: { x: number; y: number };
}> {
  const hit = await frame.evaluate(
    (n) =>
      (
        window as unknown as {
          __jevFast: { hit(n: number): { x: number; y: number } | null };
        }
      ).__jevFast.hit(n),
    node
  );
  if (!hit)
    throw new StalePage(
      `node ${node} in frame ${frameId} not hittable (covered, disabled, offscreen or gone)`
    );
  if (!observation.frames.some((f) => f.frameId === frameId)) {
    throw new StalePage(`frame ${frameId} missing from observation`);
  }
  const offset = await currentOffset(frame);
  return { local: hit, page: { x: hit.x + offset.x, y: hit.y + offset.y } };
}

/**
 * The hit test and the input dispatch are two separate round trips, and the
 * page can move between them (smooth scrolling does exactly this). Re-checking
 * under the cursor is what stops a decision about one row from clicking
 * another one that slid into its place.
 */
/** Does the node we chose actually hold focus, piercing open shadow roots? */
/**
 * Whether the node holds focus, waiting briefly for it to arrive.
 *
 * A click's focus is not always synchronous: a page can move focus in a
 * handler, or re-render the field and focus the replacement. Checking once
 * turned that into a stale page, which costs a whole re-decide. On Google
 * Flights that happened 4 times in a 10-action run.
 *
 * The check itself still matters and is unchanged. If another element really
 * has focus, this still says so, and nothing is typed.
 */
async function holdsFocus(frame: Frame, node: number): Promise<boolean> {
  const deadline = Date.now() + 150;
  for (;;) {
    if (await holdsFocusNow(frame, node)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function holdsFocusNow(frame: Frame, node: number): Promise<boolean> {
  return frame
    .evaluate((n) => {
      const registry = (
        window as unknown as { __jevFast: { nodes: Map<number, Element> } }
      ).__jevFast;
      const target = registry.nodes.get(n);
      if (!target) return false;
      let active: Element | null = document.activeElement;
      while (active) {
        if (active === target) return true;
        const root = active.shadowRoot;
        if (!root || root.activeElement === null) break;
        active = root.activeElement;
      }
      return false;
    }, node)
    .catch(() => false);
}

async function assertStillUnderCursor(
  frame: Frame,
  node: number,
  point: { x: number; y: number }
): Promise<void> {
  // Re-run the registry's own hit test rather than elementFromPoint here: the
  // registry pierces shadow roots, where a plain elementFromPoint returns the
  // host. If the point moved, the page shifted between the hit test and the
  // dispatch, which is what this guard exists to catch.
  const now = await frame
    .evaluate(
      (n) =>
        (
          window as unknown as {
            __jevFast: { hit(n: number): { x: number; y: number } | null };
          }
        ).__jevFast.hit(n),
      node
    )
    .catch(() => null);
  if (!now || Math.abs(now.x - point.x) > 2 || Math.abs(now.y - point.y) > 2) {
    throw new StalePage(
      `node ${node} moved out from under the cursor before the click`
    );
  }
}

async function dispatchClick(
  page: Page,
  point: { x: number; y: number }
): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
}

function clampWaitMs(value: string | undefined): number {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 500;
  return Math.min(parsed, 2000);
}

/**
 * Picks the upload file from the directory listing only, never from model output.
 * Resolves the directory and the chosen file to their realpaths and re-checks
 * containment after resolution, so a symlink placed inside the directory cannot
 * point a "successful" upload at a file outside it.
 */
async function pickUploadFile(dir: string): Promise<string> {
  let base: string;
  try {
    base = await fs.realpath(dir);
  } catch {
    throw new Error(`upload directory not found: ${dir}`);
  }
  const entries = await fs.readdir(base, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  if (files.length === 0)
    throw new Error(`no files available to upload in ${base}`);
  const chosen = path.join(base, files[0]!);
  const real = await fs.realpath(chosen);
  if (real !== chosen && !real.startsWith(base + path.sep)) {
    throw new Error(`upload target escapes upload directory: ${real}`);
  }
  return real;
}

export async function execute(
  target: BrowserTarget,
  observation: PageObservation,
  action: ObservedAction,
  opts: { text?: string; uploadDir?: string } = {}
): Promise<{ executed: string }> {
  const context = contextOf(target);
  // The action must be one this observation offered. Without this check a
  // caller could build an action by hand, keeping valid frame evidence while
  // changing the key, the delta or the scroll point.
  if (!observation.actions.some((candidate) => candidate === action || candidate.id === action.id)) {
    throw new Error(
      `Action ${action.id} is not part of this observation. Observe again and choose from the result.`
    );
  }
  switch (action.kind) {
    case "click": {
      const ref = requireRef(action);
      const { page, frame } = await locateFrame(context, ref.frameId);
      await checkFreshness(
        observation,
        frame,
        ref.frameId,
        ref.node,
        action.guard
      );
      const point = await resolveHitPoint(
        observation,
        frame,
        ref.frameId,
        ref.node
      );
      await page.mouse.move(point.page.x, point.page.y);
      await assertStillUnderCursor(frame, ref.node, point.local);
      await dispatchClick(page, point.page);
      return { executed: action.id };
    }

    case "fill": {
      if (!opts.text)
        throw new Error(
          `fill action ${action.id} requires opts.text; the text helper must run first`
        );
      const ref = requireRef(action);
      const { page, frame } = await locateFrame(context, ref.frameId);
      await checkFreshness(
        observation,
        frame,
        ref.frameId,
        ref.node,
        action.guard
      );
      const point = await resolveHitPoint(
        observation,
        frame,
        ref.frameId,
        ref.node
      );
      await page.mouse.move(point.page.x, point.page.y);
      await assertStillUnderCursor(frame, ref.node, point.local);
      await dispatchClick(page, point.page);
      // Confirm our click actually focused the field before typing: a focus
      // handler can move focus without touching the marker or the guard, and
      // then select-all-and-overwrite lands in someone else's input.
      if (!(await holdsFocus(frame, ref.node))) {
        throw new StalePage(
          `node ${ref.node} did not take focus; nothing typed`
        );
      }
      const selectAllKey =
        process.platform === "darwin" ? "Meta+a" : "Control+a";
      await page.keyboard.press(selectAllKey);
      // Text generation took real time; re-check before typing so a page that
      // changed underneath the async fill call is caught, not typed into.
      // The click and the select-all above have already landed, so a failure
      // from here on is marked: the caller must not replay this action.
      await checkFreshness(
        observation,
        frame,
        ref.frameId,
        ref.node,
        action.guard,
        true
      );
      await page.keyboard.type(opts.text);
      return { executed: action.id };
    }

    case "select": {
      const ref = requireRef(action);
      if (action.optionValue === undefined)
        throw new Error(`select action ${action.id} missing optionValue`);
      const { frame } = await locateFrame(context, ref.frameId);
      await checkFreshness(
        observation,
        frame,
        ref.frameId,
        ref.node,
        action.guard
      );
      try {
        await frame.evaluate(
          ({ node, optionValue }) => {
            const registry = (
              window as unknown as {
                __jevFast: { nodes: Map<number, Element> };
              }
            ).__jevFast;
            const el = registry.nodes.get(node);
            if (!el || el.tagName !== "SELECT")
              throw new Error("target is not a <select>");
            const select = el as HTMLSelectElement;
            const match = Array.from(select.options).find(
              (o) => o.value === optionValue
            );
            if (!match) throw new Error("option not present");
            if (match.disabled) throw new Error("option disabled");
            const group = match.closest("optgroup");
            if (group?.disabled) throw new Error("optgroup disabled");
            select.value = optionValue;
            select.dispatchEvent(new Event("input", { bubbles: true }));
            select.dispatchEvent(new Event("change", { bubbles: true }));
          },
          { node: ref.node, optionValue: action.optionValue }
        );
      } catch (err) {
        // An exception mid-mutation leaves the select's state unknown. That is
        // a bug to stop on, not staleness to retry: never rethrow as StalePage here.
        throw new Error(
          `select mutation failed for ${action.id}: ${(err as Error).message}`
        );
      }
      return { executed: action.id };
    }

    case "press": {
      const ref = requireRef(action);
      const key = action.key;
      if (!key || !PRESS_KEY_ALLOWLIST.has(key)) {
        throw new Error(
          `press action ${action.id} has a disallowed key: ${String(key)}`
        );
      }
      const { page, frame } = await locateFrame(context, ref.frameId);
      await checkFreshness(
        observation,
        frame,
        ref.frameId,
        ref.node,
        action.guard
      );
      const hit = await frame.evaluate(
        (n) =>
          (
            window as unknown as {
              __jevFast: { hit(n: number): { x: number; y: number } | null };
            }
          ).__jevFast.hit(n),
        ref.node
      );
      if (!hit)
        throw new StalePage(
          `node ${ref.node} in frame ${ref.frameId} not hittable`
        );
      await frame.evaluate((n) => {
        const registry = (
          window as unknown as { __jevFast: { nodes: Map<number, Element> } }
        ).__jevFast;
        const el = registry.nodes.get(n) as
          | (Element & { focus?: () => void })
          | undefined;
        el?.focus?.();
      }, ref.node);
      // A focus handler can move focus elsewhere without touching the marker
      // or the guard; Enter would then operate a different control.
      if (!(await holdsFocus(frame, ref.node))) {
        throw new StalePage(`node ${ref.node} did not take focus; no key sent`);
      }
      await page.keyboard.press(key);
      return { executed: action.id };
    }

    case "upload": {
      const ref = requireRef(action);
      const { frame } = await locateFrame(context, ref.frameId);
      await checkFreshness(
        observation,
        frame,
        ref.frameId,
        ref.node,
        action.guard
      );
      if (!opts.uploadDir) {
        throw new Error(
          "An upload needs an uploadDir. The library never chooses a directory for you."
        );
      }
      const dir = path.resolve(opts.uploadDir);
      const filePath = await pickUploadFile(dir);
      const handle = await frame.evaluateHandle(
        (n) =>
          (
            window as unknown as { __jevFast: { nodes: Map<number, Element> } }
          ).__jevFast.nodes.get(n),
        ref.node
      );
      const el = handle.asElement();
      if (!el)
        throw new StalePage(
          `node ${ref.node} in frame ${ref.frameId} not present for upload`
        );
      await el.setInputFiles(filePath);
      return { executed: action.id };
    }

    case "scroll": {
      const target = action.container ?? action.ref;
      if (!target)
        throw new Error(`scroll action ${action.id} has no frame reference`);
      const { page, frame } = await locateFrame(context, target.frameId);
      const nodeForGuard = action.container ? action.container.node : undefined;
      await checkFreshness(
        observation,
        frame,
        target.frameId,
        nodeForGuard,
        action.guard
      );
      const frameRef = observation.frames.find(
        (f) => f.frameId === target.frameId
      );
      if (!frameRef)
        throw new StalePage(`frame ${target.frameId} missing from observation`);
      const delta = action.delta ?? 120;
      let point: { x: number; y: number };
      if (action.container) {
        const rect = await frame.evaluate(
          (n) =>
            (
              window as unknown as {
                __jevFast: {
                  rect(n: number): {
                    x: number;
                    y: number;
                    width: number;
                    height: number;
                  } | null;
                };
              }
            ).__jevFast.rect(n),
          action.container.node
        );
        if (!rect)
          throw new StalePage(
            `scroll container ${action.container.node} not present`
          );
        const containerOffset = await currentOffset(frame);
        point = {
          x: containerOffset.x + rect.x + rect.width / 2,
          y: containerOffset.y + rect.y + rect.height / 2,
        };
      } else if (action.point) {
        const offset = await currentOffset(frame);
        point = { x: offset.x + action.point.x, y: offset.y + action.point.y };
      } else {
        const viewport = page.viewportSize();
        point = {
          x: frameRef.offset.x + (viewport?.width ?? 800) / 2,
          y: frameRef.offset.y + (viewport?.height ?? 600) / 2,
        };
      }
      // Chromium drops a wheel when the cursor's scroll target is not yet
      // latched, which is the case for the first wheel at a new position.
      // Measured: move+wheel scrolls nothing, the next wheel works. Rather
      // than sleep and hope, confirm the scroll moved and dispatch once more
      // if it did not, so one scroll action always means one scroll.
      const readTop = async () =>
        frame
          .evaluate((n) => {
            const registry = (
              window as unknown as {
                __jevFast: { nodes: Map<number, Element> };
              }
            ).__jevFast;
            const element = n >= 0 ? registry.nodes.get(n) : undefined;
            return element instanceof Element
              ? element.scrollTop
              : window.scrollY;
          }, action.container?.node ?? -1)
          .catch(() => null);

      const waitForMovement = async (from: number) =>
        frame
          .evaluate(
            ({ n, start }) =>
              new Promise<boolean>((resolve) => {
                const registry = (
                  window as unknown as {
                    __jevFast: { nodes: Map<number, Element> };
                  }
                ).__jevFast;
                const element = n >= 0 ? registry.nodes.get(n) : undefined;
                const read = () =>
                  element instanceof Element
                    ? element.scrollTop
                    : window.scrollY;
                const deadline = performance.now() + 150;
                const tick = () => {
                  if (read() !== start) resolve(true);
                  else if (performance.now() > deadline) resolve(false);
                  else requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
              }),
            { n: action.container?.node ?? -1, start: from }
          )
          .catch(() => true);

      const before = await readTop();
      await page.mouse.move(point.x, point.y);
      // Measured (dbg-wheel): move+wheel scrolls nothing, move+50ms+wheel
      // works, and so does a second move. Chromium resolves the cursor's
      // scroll target asynchronously after the move. 50ms buys determinism
      // on every scroll; the retry below covers the rest.
      await page.waitForTimeout(50);
      await page.mouse.wheel(0, delta);
      // The wheel is asynchronous, so "did it move?" needs a bounded wait, not
      // an immediate read: reading too early makes every scroll double.
      if (before !== null && !(await waitForMovement(before))) {
        await page.mouse.wheel(0, delta);
      }
      return { executed: action.id };
    }

    case "switch_tab": {
      if (action.tabIndex === undefined)
        throw new Error(`switch_tab action ${action.id} missing tabIndex`);
      // tabIndex indexes the OBSERVATION's tab order (active first), which is
      // not the context's creation order; resolving by url keeps them aligned.
      const wanted = observation.tabs[action.tabIndex];
      if (!wanted)
        throw new StalePage(
          `tab ${action.tabIndex} is not in this observation`
        );
      // The observation records each tab's position in context.pages(), so a
      // tab is identified by position and URL rather than by URL alone: two
      // tabs on the same URL are not interchangeable.
      const target = context.pages()[wanted.pageIndex];
      if (target && (target.isClosed() || target.url() !== wanted.url)) {
        throw new StalePage(
          `tab ${action.tabIndex} is not the tab that was observed`
        );
      }
      if (!target)
        throw new StalePage(`tab ${action.tabIndex} no longer exists`);
      await target.bringToFront();
      activePage.set(context, target);
      return { executed: action.id };
    }

    case "wait": {
      const ms = clampWaitMs(action.value);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { executed: action.id };
    }

    default: {
      const exhaustive: never = action.kind;
      throw new Error(`unknown action kind ${String(exhaustive)}`);
    }
  }
}
