# Conventions for every subsystem

Read this file before you start a subsystem. Every spec depends on it.

## The test runner is vitest, not Playwright Test

This project uses Playwright as a **library**, and vitest as the **runner**.
`vitest`'s `expect` does not have the Playwright web-first matchers. These do
not exist here, and they fail the typecheck:

    toHaveTitle  toHaveText  toHaveCount  toHaveAttribute  toBeVisible
    toHaveValue  toBeEnabled  toBeChecked

Read the value yourself, and assert on the value. Use `expect.poll` when the
value needs time to appear.

```ts
// Wrong. The typecheck fails.
await expect(page).toHaveTitle("row-47");

// Right.
await expect.poll(() => page.title()).toBe("row-47");
await expect.poll(() => page.locator("#out").textContent()).toBe("found:Lisbon");
expect(await page.locator("#row").count()).toBe(3);
```

## Import Playwright from `playwright`

Import from `playwright`, never from `@playwright/test`. The package
`@playwright/test` is not a dependency of this project.

## Tests take a free port

Call `start(0)` from `tests/fixtures/serve.ts`. The function takes a free port
and returns it. Do not write a fixed port into a test. Two suites run at the
same time and a fixed port makes them collide.

## Finish means both commands pass

```sh
npx vitest run        # every test, not only yours
npx tsc --noEmit
```

Run both. Paste the real output. Do not report that a subsystem is complete
while either command fails. Do not delete or weaken a test to make it pass.

## Comments

Write a comment when the reason is not clear from the code: a guard against a
real race, or a browser behaviour you measured. Do not comment the obvious.
