#!/usr/bin/env node
/**
 * A small implementer harness.
 *
 * A cheap model receives a specification and the current contents of the files
 * it may change. It must answer with each changed file in full. This script
 * writes those files, runs the verification command, and on failure sends the
 * output back for another round.
 *
 * The protocol is strict on purpose. An agentic CLI may narrate instead of
 * editing; here the only accepted answer is file content.
 *
 *   node tools/implement.mjs --spec docs/specs/S1-fix-1-attach-bounds.md \
 *     --files src/browser.ts,tests/browser.test.ts \
 *     --verify "npx vitest run tests/browser.test.ts" --rounds 4
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const specPath = flag("spec");
const files = (flag("files") ?? "").split(",").map((f) => f.trim()).filter(Boolean);
const verify = flag("verify", "npx vitest run");
const rounds = Number(flag("rounds", "3"));
const model = flag("model", process.env.IMPL_MODEL ?? "meta/muse-spark-1.3");
if (!specPath || files.length === 0) {
  console.error("Usage: --spec <file> --files a.ts,b.ts [--verify <cmd>] [--rounds N] [--model id]");
  process.exit(2);
}

const BASE = (process.env.IMPL_BASE_URL ?? "https://ai-gateway.vercel.sh/v1").replace(/\/+$/u, "");
const KEY = process.env.IMPL_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
if (!KEY) {
  console.error("Set IMPL_API_KEY or VERCEL_OIDC_TOKEN.");
  process.exit(2);
}

const spec = readFileSync(specPath, "utf8");
const conventions = existsSync("docs/specs/CONVENTIONS.md")
  ? readFileSync("docs/specs/CONVENTIONS.md", "utf8")
  : "";

// Keep a copy, so a round that makes things worse can be undone.
for (const file of files) if (existsSync(file)) copyFileSync(file, `${file}.impl-backup`);

const SYSTEM = [
  "You change source files to satisfy a specification.",
  "Answer with the complete new content of every file you change, and nothing else.",
  "Use this exact form for each file:",
  '<file path="relative/path.ts">',
  "...the entire file...",
  "</file>",
  "Rules: return the WHOLE file, never a fragment and never a diff.",
  "Change only the files you were given. Do not weaken or delete a test.",
  "Write no prose outside the file blocks.",
].join("\n");

const run = (command) => {
  try {
    return { ok: true, out: execSync(command, { encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

let failure = "";
for (let round = 1; round <= rounds; round += 1) {
  const current = files
    .map((file) => `<file path="${file}">\n${existsSync(file) ? readFileSync(file, "utf8") : "(does not exist yet)"}\n</file>`)
    .join("\n\n");
  const user = [
    conventions ? `# Conventions\n\n${conventions}` : "",
    `# Specification\n\n${spec}`,
    `# Current files\n\n${current}`,
    failure ? `# The previous attempt failed\n\nThe command \`${verify}\` reported:\n\n\`\`\`\n${failure.slice(-6000)}\n\`\`\`\nFix the cause.` : "",
  ].filter(Boolean).join("\n\n");

  process.stderr.write(`[round ${round}/${rounds}] asking ${model}...\n`);
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      max_tokens: 32000,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  const json = await response.json();
  if (!response.ok) {
    console.error(`gateway ${response.status}: ${JSON.stringify(json).slice(0, 400)}`);
    process.exit(1);
  }
  const text = json.choices?.[0]?.message?.content ?? "";
  const usage = json.usage ?? {};
  process.stderr.write(`[round ${round}] ${text.length} chars, tokens ${usage.prompt_tokens}/${usage.completion_tokens}, cost ${usage.cost ?? "?"}\n`);

  const blocks = [...text.matchAll(/<file path="([^"]+)">\n?([\s\S]*?)<\/file>/gu)];
  if (blocks.length === 0) {
    process.stderr.write(`[round ${round}] the answer held no file block; stopping\n`);
    process.stderr.write(`${text.slice(0, 500)}\n`);
    break;
  }
  for (const [, path, body] of blocks) {
    if (!files.includes(path)) {
      process.stderr.write(`[round ${round}] refused a file outside the list: ${path}\n`);
      continue;
    }
    writeFileSync(path, body.replace(/\n$/u, "") + "\n");
    process.stderr.write(`[round ${round}] wrote ${path}\n`);
  }

  const result = run(verify);
  if (result.ok) {
    const types = run("npx tsc --noEmit");
    if (types.ok) {
      process.stderr.write(`[round ${round}] verification passed\n`);
      process.stdout.write(result.out.slice(-1500));
      process.exit(0);
    }
    failure = `The tests passed but the typecheck failed:\n${types.out}`;
  } else {
    failure = result.out;
  }
  process.stderr.write(`[round ${round}] still failing; ${failure.split("\n").length} lines of output\n`);
}

process.stderr.write("rounds exhausted; files left as the last attempt wrote them, backups are at *.impl-backup\n");
process.exit(1);
