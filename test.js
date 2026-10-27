#!/usr/bin/env node
// Offline check of the installer: runs install.js against a throwaway
// CLAUDE_CONFIG_DIR and asserts it merges, updates and removes hooks without
// touching anyone else's. No Jev calls.   Run: node test.js

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev router test "));
const settingsPath = path.join(dir, "settings.json");
const run = (...args) =>
  spawnSync(process.execPath, [path.join(__dirname, "install.js"), ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    encoding: "utf8",
  });
const read = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const ours = (s, ev, script) =>
  (s.hooks[ev] || []).flatMap((g) => g.hooks).filter((h) => JSON.stringify(h).includes(script));

try {
  // Someone else's hooks, plus a stale jev-router entry in the old shell-string form.
  const other = { type: "command", command: "echo hi" };
  fs.writeFileSync(
    settingsPath,
    "\uFEFF" +
      JSON.stringify({
        model: "opus",
        hooks: {
          UserPromptSubmit: [
            { hooks: [other] },
            { hooks: [{ type: "command", command: 'node "C:\\old\\.claude\\jev-router\\route.js"' }] },
          ],
          Stop: [{ hooks: [other] }],
        },
      })
  );

  let r = run("--no-test");
  assert.strictEqual(r.status, 0, r.stderr);
  let s = read();
  assert.strictEqual(s.model, "opus", "unrelated settings kept");
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [other] }], "other events untouched");
  assert.deepStrictEqual(s.hooks.UserPromptSubmit[0], { hooks: [other] }, "other hook kept");
  const route = ours(s, "UserPromptSubmit", "route.js");
  assert.strictEqual(route.length, 1, "stale entry replaced, not duplicated");
  assert.deepStrictEqual(route[0].args, [path.join(dir, "jev-router", "route.js")]);
  assert.strictEqual(ours(s, "SubagentStop", "usage-collect.js").length, 1);
  for (const f of ["route.js", "usage-collect.js", "status.js", "config.json", "handlers.json", "state.json"]) {
    assert.ok(fs.existsSync(path.join(dir, "jev-router", f)), `${f} installed`);
  }
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith(".bak")), "settings backed up");

  // Re-running is a no-op for settings and keeps the user's own config edits.
  const cfg = path.join(dir, "jev-router", "config.json");
  fs.writeFileSync(cfg, '{"minConfidence": 0.9}');
  const snapshot = fs.readFileSync(settingsPath, "utf8");
  r = run("--no-test");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), snapshot, "idempotent");
  assert.strictEqual(fs.readFileSync(cfg, "utf8"), '{"minConfidence": 0.9}', "config.json kept");

  // Uninstall removes only ours.
  r = run("--uninstall");
  assert.strictEqual(r.status, 0, r.stderr);
  s = read();
  assert.deepStrictEqual(s.hooks, { UserPromptSubmit: [{ hooks: [other] }], Stop: [{ hooks: [other] }] });
  assert.ok(!fs.existsSync(path.join(dir, "jev-router")), "router folder removed");

  // Broken settings.json: refuse, change nothing.
  fs.writeFileSync(settingsPath, "{ not json");
  r = run("--no-test");
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), "{ not json");

  // Context guard: transcript parsing and the warning rules.
  const { guardWarning, readTranscript } = require("./jev-router/route.js");
  const tp = path.join(dir, "t.jsonl");
  const rec = (o) => JSON.stringify(o);
  fs.writeFileSync(
    tp,
    [
      rec({ type: "user", message: { content: "fix the login bug" } }),
      rec({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 5, cache_read_input_tokens: 100 } } }),
      rec({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }), // tool output, not typed
      rec({ type: "user", isMeta: true, message: { content: "meta" } }),
      rec({ type: "user", message: { content: "<task-notification>done</task-notification>" } }),
      rec({ type: "user", message: { content: [{ type: "text", text: "still broken on safari" }] } }),
      rec({ type: "assistant", isSidechain: true, message: { model: "claude-haiku-5-5", usage: { input_tokens: 9 } } }),
      rec({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 1, cache_read_input_tokens: 200000, cache_creation_input_tokens: 999 } } }),
      rec({ type: "user", message: { content: "now write the landing page" } }), // the current prompt
      "{ partial",
    ].join("\n")
  );
  const t = readTranscript(tp, "now write the landing page");
  assert.strictEqual(t.model, "claude-opus-5-5", "main model, not the subagent's");
  assert.strictEqual(t.ctx, 201000, "context = input + cache read + cache write of the latest main turn");
  assert.deepStrictEqual(t.recent, ["fix the login bug", "still broken on safari"], "typed messages only, current excluded");
  assert.strictEqual(readTranscript(path.join(dir, "missing.jsonl"), "x").ctx, 0, "no transcript is fine");

  const g = { clearAtTokens: 150000, compactAtTokens: 400000, newTaskMin: 0.8 };
  assert.strictEqual(guardWarning(100000, 0.99, g, 0), null, "small context: never warn");
  assert.strictEqual(guardWarning(200000, 0.9, g, 0).kind, "clear", "big context + new task");
  assert.strictEqual(guardWarning(200000, 0.3, g, 0), null, "big context, same task, under compact line");
  assert.strictEqual(guardWarning(200000, null, g, 0), null, "Jev unknown: no /clear guess");
  assert.strictEqual(guardWarning(450000, 0.3, g, 0).kind, "compact", "very big, same task");
  assert.strictEqual(guardWarning(480000, 0.3, g, 450000), null, "no repeat within 100K");
  assert.strictEqual(guardWarning(560000, 0.3, g, 450000).kind, "compact", "repeat after 100K more");
  assert.strictEqual(guardWarning(420000, 0.3, g, 700000).kind, "compact", "after /compact shrank it, warn again");

  console.log("installer + context guard test: all checks passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
