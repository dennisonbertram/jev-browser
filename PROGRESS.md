# Progress

Status of the work to take this from a proof of concept to a library that can
replace a production browser worker. Update it as each subsystem lands.

## Method

Each subsystem follows the same loop:

1. The plan names the behaviour and the test that proves it.
2. An outside implementer writes the failing test first, then the code, and
   runs the suite until it passes.
3. Codex Astra reviews the result. Every finding is re-read in the code before
   it is accepted or rejected.
4. The suite, the typecheck and the review all pass before the next subsystem
   starts.

## Baseline, measured

From the benchmark in the Partyline repo (81 runs, one browser, nine journeys):

| Arm | Success | Median | Tokens | Cost per successful run |
| --- | --- | ---: | ---: | ---: |
| this engine, Jev deciding | 25/27 | 1289 ms | 181,871 | not reported by the vendor |
| a production worker on browser-loop | 21/27 | 14,454 ms | 1,483,107 | $0.00207 |
| this engine, an LLM deciding | 27/27 | 37,110 ms | 166,639 | $0.00090 |

Two facts shape the plan. The engine drives a remote CDP browser unchanged
(measured against a Kernel browser: attach 419 ms, observe 211 ms). And the
decision, not the browser layer, is what makes a task fast.

## Subsystems

| # | Subsystem | Why it is needed | State |
| --- | --- | --- | --- |
| S0 | Extraction, public API, CI | usable outside one repo | done |
| S1 | Browser lifecycle | launch locally, attach to a remote CDP browser, dispose cleanly | done, reviewed, fixed |
| S2 | Vision and coordinates | a control drawn on a canvas has no DOM node | done, review pending |
| S3 | Screenshot redaction | an image must not carry a secret out of the process | in progress |
| S4 | Credential autofill | log in without a model ever seeing a secret | to do |
| S5 | Telemetry | per-decision timings and outcomes, redacted | to do |
| S6 | Agent tool surface | mount the library in any agent framework | to do |
| S7 | Session state | carry element references across processes | to do |
| S8 | Hardening | dialogs, downloads, retries, each with a regression test | to do |
| S9 | Documentation | plain English, accurate, with an integration guide | to do |

## Log

- Extracted from the Partyline proof of concept. The engine imports only
  Playwright; no application code came with it.
- The text helper now speaks to any OpenAI-compatible endpoint, set by
  `TEXT_MODEL_BASE_URL`. It was wired to one vendor's gateway.

- S1 passed a review that found nine defects, four of them serious: the
  attachment escaped its own timeout, a launch failure leaked the browser, the
  readiness poll could not be cancelled, `cdpUrl` could name another browser,
  and `close` reported success before it finished. The tests also passed against
  a `close` that did nothing. All are fixed, in three parts, each with a test
  that fails when the behaviour breaks.
- Two agentic command-line implementers proved unreliable: one fails to
  authenticate, and the other prints the code it would write instead of writing
  it, then truncates. `tools/implement.mjs` replaced them. A cheap model must
  answer with whole files in a strict form, and the harness writes them, runs the
  verification, and feeds a failure back. One round costs about $0.06.
