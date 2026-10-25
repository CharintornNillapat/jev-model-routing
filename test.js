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

  console.log("installer test: all checks passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
