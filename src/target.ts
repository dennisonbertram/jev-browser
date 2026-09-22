/**
 * A browser target a public function accepts.
 *
 * Every entry point takes a BrowserContext, because the library reads every
 * tab. Three independent people writing against this library passed a Page
 * instead, so the signature was the problem, not the callers. A Page is now
 * accepted everywhere and resolved to the context that holds it.
 */
import type { BrowserContext, Page } from "playwright";

/** A context, or any page inside one. */
export type BrowserTarget = BrowserContext | Page;

const isPage = (target: BrowserTarget): target is Page =>
  typeof (target as Page).context === "function";

/** The context that holds this target. */
export function contextOf(target: BrowserTarget): BrowserContext {
  return isPage(target) ? target.context() : target;
}
