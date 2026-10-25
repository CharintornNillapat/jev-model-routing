#!/usr/bin/env node
// Installs the Jev model router into Claude Code.
//
//   node install.js              install or update, then run a live self-test
//   node install.js --test       only run the self-test
//   node install.js --uninstall  remove the hooks and ~/.claude/jev-router
//   node install.js --no-test    install without the self-test
//
// Honors CLAUDE_CONFIG_DIR (Claude Code's own override for ~/.claude).

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const DEST = path.join(CLAUDE_DIR, "jev-router");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const SRC = path.join(__dirname, "jev-router");

const SCRIPTS = ["route.js", "usage-collect.js", "status.js"]; // always updated
const USER_FILES = ["config.json", "handlers.json", "state.json"]; // kept if present

const HOOKS = [
  { event: "UserPromptSubmit", script: "route.js", timeout: 6, statusMessage: "jev-router: sizing up message..." },
  { event: "SubagentStop", script: "usage-collect.js", timeout: 10, statusMessage: "jev-router: recording execution tokens..." },
];

const say = (msg = "") => console.log(msg);

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, "");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${SETTINGS} is not valid JSON (${e.message}). Fix it first; nothing was changed.`);
  }
}

function writeSettings(settings) {
  if (fs.existsSync(SETTINGS)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bak = `${SETTINGS}.jev-router-${stamp}.bak`;
    fs.copyFileSync(SETTINGS, bak);
    say(`  backed up settings.json -> ${path.basename(bak)}`);
  }
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

// A hook is ours if its command line mentions jev-router/<script>, in either
// the exec form ("command" + "args") or a single shell-string "command".
function isOurs(hook, script) {
  const line = [hook && hook.command, ...((hook && hook.args) || [])].join(" ").replace(/\\+/g, "/");
  return line.includes(`jev-router/${script}`);
}

function hookFor(h) {
  return {
    type: "command",
    command: "node",
    // Exec form: no shell, so a path with spaces needs no quoting.
    args: [path.join(DEST, h.script)],
    timeout: h.timeout,
    statusMessage: h.statusMessage,
  };
}

// Adds our two hooks, or refreshes them in place. Every other hook is left
// exactly as it was. Returns true if anything changed.
function mergeHooks(settings) {
  const before = JSON.stringify(settings);
  settings.hooks = settings.hooks || {};
  for (const h of HOOKS) {
    const groups = (settings.hooks[h.event] = settings.hooks[h.event] || []);
    let placed = false;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      g.hooks = g.hooks.flatMap((x) => {
        if (!isOurs(x, h.script)) return [x];
        if (placed) return []; // drop duplicates
        placed = true;
        return [hookFor(h)];
      });
    }
    if (!placed) groups.push({ hooks: [hookFor(h)] });
  }
  pruneEmpty(settings);
  return JSON.stringify(settings) !== before;
}

function removeHooks(settings) {
  const before = JSON.stringify(settings);
  for (const h of HOOKS) {
    for (const g of (settings.hooks && settings.hooks[h.event]) || []) {
      if (Array.isArray(g.hooks)) g.hooks = g.hooks.filter((x) => !isOurs(x, h.script));
    }
  }
  pruneEmpty(settings);
  return JSON.stringify(settings) !== before;
}

function pruneEmpty(settings) {
  if (!settings.hooks) return;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = settings.hooks[ev];
    if (!Array.isArray(groups)) continue;
    settings.hooks[ev] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

function copyFiles() {
  fs.mkdirSync(DEST, { recursive: true });
  for (const f of SCRIPTS) {
    fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
    say(`  wrote ${f}`);
  }
  for (const f of USER_FILES) {
    const to = path.join(DEST, f);
    if (fs.existsSync(to)) {
      say(`  kept your ${f}`);
    } else {
      fs.copyFileSync(path.join(SRC, f), to);
      say(`  wrote ${f}`);
    }
  }
}

function jevVersion() {
  // A constant command string, so the shell is safe here; it lets Windows find jev.cmd.
  const r = spawnSync("jev --version", { shell: true, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function checkPrereqs() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 20 || (maj === 20 && min < 12)) {
    say(`! Node ${process.versions.node} found; jevctl needs 20.12 or newer.`);
  }
  const v = jevVersion();
  if (!v) {
    say("! The jev CLI was not found. Install it, then add your key:");
    say("    npm install -g jevctl");
    say("    jev auth login");
    return false;
  }
  say(`  jev ${v} found`);
  return true;
}

// Runs the installed route.js exactly the way Claude Code does, against a
// throwaway project folder, and checks that Jev sized the message.
function selfTest() {
  say("\nSelf-test (one real Jev call):");
  if (!fs.existsSync(path.join(DEST, "route.js"))) fail(`Not installed in ${DEST}. Run: node install.js`);
  const state = JSON.parse(fs.readFileSync(path.join(DEST, "state.json"), "utf8"));
  if (!state.enabled) {
    say(`  router is OFF ("enabled": false in ${path.join(DEST, "state.json")}); skipping`);
    return true;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-router-test-"));
  try {
    // No session_id: keeps the test from stamping state.json.
    const payload = { cwd: tmp, prompt: "rename the variable foo to bar in utils.js" };
    const r = spawnSync(process.execPath, [path.join(DEST, "route.js")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 15000,
    });
    let stats = {};
    try {
      stats = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "jev-router-stats.json"), "utf8"));
    } catch {
      // checked below
    }
    const c = stats.counts || {};
    const s = stats.skipped || {};
    if (c.errors) {
      const why = ((stats.lastErrors || []).pop() || {}).reason || "unknown";
      say(`  ✗ the Jev call failed: ${why}`);
      say("    Check the key with: jev auth status   (or set TYPESAFE_API_KEY)");
      return false;
    }
    if (!c.tiny) {
      say(`  ✗ expected "tiny", got ${JSON.stringify(c)}. Did handlers.json change?`);
      return false;
    }
    if (r.stdout.includes("[jev-router]")) {
      say('  ✓ sized as "tiny"; the hook would tell Claude to delegate to the tiny-size model');
    } else if (s.same_model) {
      say('  ✓ sized as "tiny"; no delegation because your main model is already that model');
    } else {
      say(`  ✗ sized as "tiny" but the hook printed nothing: ${r.stderr || "(no stderr)"}`);
      return false;
    }
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function install(runTest) {
  say(`Installing jev-router into ${DEST}`);
  const jevOk = checkPrereqs();
  copyFiles();
  const settings = readSettings();
  if (mergeHooks(settings)) {
    writeSettings(settings);
    say(`  registered hooks in ${SETTINGS}`);
  } else {
    say("  hooks already registered");
  }
  const ok = runTest && jevOk ? selfTest() : true;
  say("\nNext: restart Claude Code (hooks load at startup), then run /hooks to see both hooks.");
  say(`Stats: node "${path.join(DEST, "status.js")}"   (run from a project folder)`);
  if (!ok) process.exit(1);
}

function uninstall() {
  const settings = readSettings();
  if (removeHooks(settings)) {
    writeSettings(settings);
    say(`Removed the jev-router hooks from ${SETTINGS}`);
  } else {
    say("No jev-router hooks were registered");
  }
  if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true });
    say(`Deleted ${DEST}`);
  }
  say("Per-project stats (<project>/.claude/jev-router-stats.json) were left in place.");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--uninstall")) uninstall();
  else if (args.includes("--test")) process.exit(selfTest() ? 0 : 1);
  else install(!args.includes("--no-test"));
}

module.exports = { mergeHooks, removeHooks, isOurs };
