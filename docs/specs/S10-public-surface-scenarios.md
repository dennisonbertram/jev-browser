# S10: Scenarios against the public surface

Read `docs/specs/CONVENTIONS.md` first.

## Purpose

Prove that a newcomer can drive real web journeys using only what the package
exports. Every import in this suite comes from `../src/index.ts`, the package
root. If a scenario needs something that is not exported, that is a finding:
write it down rather than reaching into a module.

The scenarios are ordinary web patterns, not toys. Each one is a shape that
appears on real sites and that an agent has to survive.

## Files you may create or change

- `tests/fixtures/scenarios/*.html` (new fixtures)
- `tests/scenarios.test.ts` (new)

Change nothing else. Do not edit any file in `src/`.

## Rules

1. Import only from `../src/index.ts`. No deep imports.
2. No model calls. Drive the page through `observe`, `actionSpace`, `execute`,
   `createToolHost`, `fillCredentials`, `screenshotRedacted`, `saveSessionState`
   and the rest of the public API. The classifier is not under test here; the
   surface is.
3. Name an element only by what an observation gives you: a label, a role, or
   an index. Never a CSS selector. Playwright locators are allowed only to
   assert the outcome, never to perform the journey.
4. Every scenario asserts the page reached its end state.
5. Each fixture is self-contained, with no network use.

## The scenarios

| # | Fixture | The journey | Why it is hard |
| --- | --- | --- | --- |
| 1 | `consent.html` | Dismiss a cookie banner that covers the page, then click the link behind it | A covered element must not be clicked until the banner is gone |
| 2 | `wizard.html` | A three-step form: fill a name, go next, choose an option, go next, submit | State carries across steps; each step re-observes |
| 3 | `typeahead.html` | Type into a search field, wait for suggestions, choose the second one | Suggestions appear after a delay and replace themselves |
| 4 | `modal.html` | Open a dialog, fill the field inside it, confirm, and see the result | Content outside the dialog must not be reachable while it is open |
| 5 | `paging.html` | Move to page two of a table and open the row named `Order 24` | The row does not exist until the page changes |
| 6 | `lazy.html` | Press "Load more" twice, then open the item that appears | The list grows; earlier indexes must not go stale silently |
| 7 | `dependent.html` | Choose a country in one select, then a city in a second that repopulates | The second select's options change after the first is set |
| 8 | `upload-form.html` | Attach a file and submit the form | The upload directory is supplied by the caller |
| 9 | `newtab.html` | Open a link that makes a new tab, act in it, then return to the first | Two tabs, and the active one changes |
| 10 | `payment.html` | Fill a card field inside a cross-origin iframe and submit | The field is in another origin |
| 11 | `webcomponent.html` | Fill and submit a form inside a nested open shadow root | No selector can reach it from the top document |
| 12 | `datepicker.html` | Open a calendar with the keyboard and choose a day with arrow keys and Enter | The widget answers only to keys |
| 13 | `login-flow.html` | Log in with `fillCredentials`, then take a redacted screenshot | The password must be covered and must not appear in the observation |
| 14 | `slow.html` | Act on a control that appears 800 ms after load | The control is absent at first observation |
| 15 | `resume.html` | Fill a field, save the session state, restore it in a second session, and finish the form | State crosses a process boundary |

For the cross-origin scenario, serve the child from the second fixture server,
the way `tests/gaps.test.ts` does with `iframe-cross.html`.

For scenario 15, use `saveSessionState` and `restoreSessionState` with a
browser launched by `launchLocal({ cdpPort })`, as `tests/browser.test.ts` does.

## Verification

```sh
npx vitest run tests/scenarios.test.ts
npx tsc --noEmit
```

Both must pass. Write each fixture, then its scenario, and run as you go. If a
scenario cannot be written with the public API alone, leave it failing with a
comment that says exactly what is missing, and report it. Do not work around a
gap by importing a module directly.
