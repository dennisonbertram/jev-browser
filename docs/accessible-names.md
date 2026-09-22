# Accessible name: what's implemented, what's skipped

This is a pragmatic subset of the WAI-ARIA accname 1.2 algorithm, not a
conformant implementation. Priority order actually used, top wins:

| Rule                                                                                                                                             | Implemented      | Notes / what's skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aria-labelledby`                                                                                                                                | Yes              | Resolves each id in the same document, recurses into each referenced element's visible text (through open shadow roots / slots), joins with a space. Does not resolve ids across shadow-root boundaries (an id inside a shadow root is not queryable from `doc.getElementById`) — real sites don't do this, and jev-ultrafast doesn't either.                                                                                                                                                                                     |
| `aria-label`                                                                                                                                     | Yes              | Direct attribute read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Native labelling: `<label for>`, wrapping `<label>`, `.labels`, `<legend>`/`fieldset`, `<caption>`/`table`, `<optgroup label>`, `<th scope=row>` | Yes, best-effort | `<th scope=row>` lookup is a simplified same-row scan, not the full `headers`/`aria-owns` cell-association algorithm. A `<legend>` only applies to a control with no name of its own, so a `<button>Pay now</button>` inside `<fieldset><legend>Payment</legend>` is "Pay now", not "Payment" — it was the latter until a fixture caught it.                                                                                                                                                                                      |
| `value`/`placeholder` for inputs                                                                                                                 | Yes              | `value` only for `submit`/`button`/`reset`/`image` types (their rendered text); `placeholder` is the account-of-last-resort fallback, ranked below title/text-content, matching the spec's actual placement (placeholder is step 2H, after title).                                                                                                                                                                                                                                                                                |
| `alt` for images / image buttons                                                                                                                 | Yes              | Direct attribute.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `title`                                                                                                                                          | Yes              | Used when nothing else matched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Visible text content                                                                                                                             | Yes              | Recursive walk that pierces open shadow roots, resolves `<slot>` to `assignedNodes()`, and skips `aria-hidden="true"`, `display:none`, and `visibility:hidden` subtrees. Embedded-control substitution IS implemented for labels (`labelTextExcluding`): a `<label>` wrapping a control contributes its own text with the control's content removed and the control's `value` substituted. Added after a fixture showed a wrapping label naming a `<select>` "Ticket type Choose one General admission VIP Backstage (sold out)". |
| `aria-describedby`                                                                                                                               | Yes, separately  | Captured on request when cheap (same id-resolution helper as labelledby) but not exposed on every action — only computed, not wired into `ObservedAction` since the type has no field for it; kept for future use / debugging.                                                                                                                                                                                                                                                                                                    |
| Name capping/single-line                                                                                                                         | Yes              | Whitespace collapsed, capped at 200 chars with an ellipsis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Deliberately out of scope (spec parts not implemented)

- **`aria-owns` reparenting.** The accname spec (and the accessibility tree
  generally) lets `aria-owns` move an element's effective DOM position for
  name computation and tree structure. Not implemented — costs correctness
  only on the rare pattern of an owned-but-not-child node (e.g. some custom
  combobox popups appended to `<body>`). None of the fixtures need it.
- **Embedded-control substitution outside labels.** Implemented for `<label>`
  (see above), where it mattered in practice. Not implemented for the general
  case of a computed name that embeds a control somewhere other than a label.
- **CSS generated content (`::before`/`::after`) in the name.** Real
  screen readers include generated content text in some cases; we don't
  read computed pseudo-content. Costs correctness only for icon-font
  buttons that rely on `content: "Submit"` instead of real text — rare in
  practice and always has a fallback via `aria-label`/`title` on real sites.
- **Exact visitation/recursion-limit and self-reference guards from the
  formal algorithm** (e.g. an id that labels itself, or a labelledby cycle).
  We do a flat one-level id resolution with a bounded recursion in
  `visibleTextContent`, not the spec's formal "already visited" node set.
  Costs correctness only on adversarial/malformed markup, not real pages.
- **`role=presentation`/`none` suppressing name computation** for elements
  that would otherwise get an implicit name source. Not special-cased;
  costs correctness only when a site intentionally hides semantics this way
  while still expecting the DOM-visible text of a decorative wrapper to be
  ignored — a corner case, not exercised by the fixtures.

## What the gaps cost in practice

Most of what's skipped only matters for exotic or adversarial markup
(labelledby cycles, `aria-owns` reparenting, generated-content-only labels).
The fixtures in `FIXTURES.md` (`aria-labelledby`-only control and
`title`-only control in `keyboard.html`) are both covered by the
implemented chain. The one real practical gap is embedded-control
substitution, which occasionally makes a composite label read as slightly
redundant or oddly ordered rather than perfectly matching what a screen
reader announces — it never produces a wrong or missing name, just a less
polished one.
