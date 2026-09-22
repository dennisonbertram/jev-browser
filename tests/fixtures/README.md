# Gap fixtures

One fixture per capability jev-ultrafast declares out of scope. Each is served
by `poc/jev/fixtures/serve.ts` on two ports so cross-origin is real: **8791**
(primary) and **8792** (foreign origin). Labels below are exact; tests and the
snapshot engine both depend on them.

| File                 | Gap                                                      | Must be reachable                                                                                | Success state                                                                              |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `shadow.html`        | open shadow DOM, nested 2 deep, closed root              | input `Email address` (host 1, open root), button `Submit shadow form` (nested open root)        | `#shadow-result` text becomes `submitted:<email>`                                          |
| `shadow.html`        | closed shadow DOM                                        | button `Hidden button` is **not** reachable                                                      | snapshot reports `closedShadowHosts >= 1`                                                  |
| `iframe-same.html`   | same-origin iframe, 40px offset                          | input `City`, button `Find` inside the iframe                                                    | child sets its own `#out` to `found:<city>`                                                |
| `iframe-cross.html`  | cross-origin iframe (child served from :8792)            | input `Promo code`, button `Apply`                                                               | child `#out` becomes `applied:<code>`                                                      |
| `nested-scroll.html` | nested scrolling; window itself does not scroll          | link `Row 47`, only after scrolling the inner container                                          | `document.title` becomes `row-47`                                                          |
| `upload.html`        | file upload                                              | file input `Attach flyer`                                                                        | `#upload-result` text becomes the chosen file's name                                       |
| `popup.html`         | pop-up tab                                               | button `Open ticket window`, then button `Confirm booking` in the new tab                        | popup `document.title` becomes `CONFIRMED`                                                 |
| `canvas.html`        | canvas                                                   | canvas drawing a `Pick date` control with no DOM node; a real link `Use the list instead` exists | snapshot lists the canvas in `canvases` and still offers the DOM link                      |
| `select.html`        | native `<select>`, wrapping `<label>`, `aria-labelledby` | select `Ticket type` and its enabled options; input `Guest count`; button `Pay now`              | `#select-result` text becomes `tier:vip`; the disabled `Backstage` option is never offered |
| `keyboard.html`      | arbitrary keyboard widget                                | `div[role=combobox]` `Choose a plan`; options appear only after `ArrowDown`                      | `#plan-result` text becomes `Option B` after ArrowDown, ArrowDown, Enter                   |

Rules for the fixtures: no external network, no build step, plain HTML plus
inline script, accessible names supplied the way real sites supply them
(`aria-label`, `aria-labelledby`, `<label for>`, wrapping `<label>`, and one
`title`-only control in `keyboard.html` so the accname fallback chain is
exercised).
