#!/usr/bin/env node
// UserPromptSubmit hook: asks Jev how big a job the message is, then tells the
// main agent (via additionalContext) whether to delegate to a smaller/bigger
// model or handle it directly. Must never block a message for long or throw —
// any failure here should be invisible to the user, so everything is wrapped
// in one try/catch that falls back to "do nothing."

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The router itself is installed globally, so config and state live next to
// this script and are shared by every project.
const ROOT = __dirname;
const STATE_PATH = path.join(ROOT, "state.json");
const CONFIG_PATH = path.join(ROOT, "config.json");

// Stats, by contrast, are per-project: a single global tally would blend every
// repo on the machine together. Set from the hook payload's cwd once stdin has
// been read; process.cwd() is the fallback for the paths that run before that.
let PROJECT_CWD = null;

function statsPath() {
  const base = PROJECT_CWD || process.cwd();
  // A cwd that does not resolve to a real directory means a malformed payload.
  // Writing anyway would scaffold a phantom .claude tree at the drive root.
  try {
    if (!base || !fs.existsSync(base)) return null;
  } catch {
    return null;
  }
  return path.join(base, ".claude", "jev-router-stats.json");
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeStats(stats) {
  try {
    const p = statsPath();
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Write-then-rename: a half-written file would parse as garbage on the next
    // read, and loadStats would silently start every counter over from zero.
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    // stats are best-effort; never let a write failure affect routing
  }
}

function emptyCounts() {
  return { tiny: 0, everyday: 0, large: 0, self: 0, errors: 0 };
}

// Early-return reasons that used to vanish without a trace.
function emptySkips() {
  return { no_stdin: 0, short_prompt: 0, no_config: 0, system_message: 0, same_model: 0 };
}

function loadStats() {
  const s = readJson(statsPath(), null) || {};
  s.counts = Object.assign(emptyCounts(), s.counts);
  s.usage = Object.assign({ input_tokens: 0, output_tokens: 0 }, s.usage);
  s.skipped = Object.assign(emptySkips(), s.skipped);
  if (!s.actual_execution_usage) s.actual_execution_usage = {};
  if (!Array.isArray(s.delegations)) s.delegations = [];
  if (typeof s.calls !== "number") s.calls = 0;
  if (!s.session) s.session = null;
  return s;
}

// A new session_id starts a new segment. Lifetime totals keep accumulating;
// `session` is rewritten so per-session numbers are readable without diffing.
function ensureSession(stats, sessionId) {
  if (!sessionId) return null;
  if (!stats.session || stats.session.id !== sessionId) {
    stats.session = {
      id: sessionId,
      startedAt: new Date().toISOString(),
      counts: emptyCounts(),
      usage: { input_tokens: 0, output_tokens: 0 },
      calls: 0,
      skipped: emptySkips(),
    };
    try {
      const state = readJson(STATE_PATH, { enabled: true });
      state.sessionId = sessionId;
      state.sessionStartedAt = stats.session.startedAt;
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    } catch {
      // state stamping is best-effort
    }
  }
  return stats.session;
}

// `error` is null, or a short reason string for a failed Jev call.
function bumpStat(bucket, usage, error, sessionId) {
  const stats = loadStats();
  const sess = ensureSession(stats, sessionId);
  if (error) {
    // Keep the last few reasons: an error count with no cause can't be debugged.
    stats.lastErrors = (Array.isArray(stats.lastErrors) ? stats.lastErrors : [])
      .concat({ ts: new Date().toISOString(), reason: error })
      .slice(-10);
  }
  for (const t of sess ? [stats, sess] : [stats]) {
    t.calls = (t.calls || 0) + 1;
    if (error) {
      t.counts.errors = (t.counts.errors || 0) + 1;
    } else {
      t.counts[bucket] = (t.counts[bucket] || 0) + 1;
      if (usage) {
        t.usage.input_tokens = (t.usage.input_tokens || 0) + (usage.input_tokens || 0);
        t.usage.output_tokens = (t.usage.output_tokens || 0) + (usage.output_tokens || 0);
      }
    }
  }
  stats.updatedAt = new Date().toISOString();
  writeStats(stats);
}

// Records an early return instead of letting it bypass stats entirely.
// `calls` is deliberately not incremented: these are messages seen but not routed.
function bumpSkip(reason, sessionId) {
  const stats = loadStats();
  const sess = ensureSession(stats, sessionId);
  for (const t of sess ? [stats, sess] : [stats]) {
    t.skipped[reason] = (t.skipped[reason] || 0) + 1;
  }
  stats.updatedAt = new Date().toISOString();
  writeStats(stats);
}

// Pending-delegation marker. Written only when a delegation is actually
// instructed, so usage-collect.js can attribute the resulting subagent's tokens
// back to the tier that caused it. `promptId` is the join key; `promptHash`
// confirms it, and is a hash rather than the text so no prompt content is
// written to disk.
function markDelegation(entry) {
  const stats = loadStats();
  stats.delegations.push(entry);
  if (stats.delegations.length > 200) {
    stats.delegations = stats.delegations.slice(-200);
  }
  stats.updatedAt = new Date().toISOString();
  writeStats(stats);
}

function hashPrompt(text) {
  return crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

// Not everything arriving on UserPromptSubmit was typed by the user. Subagent
// hand-backs, background-task completions and system notifications enter the
// prompt stream exactly like a real message does. None of them contain work to
// route, so sizing one up spends a jev call and books a phantom "self" decision
// against the session.
const SYSTEM_MESSAGE_PATTERNS = [
  /^Another Claude session sent a message:/,
  /^<agent-message\b/,
  /^<task-notification>/,
  /^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/,
  /^\[Artifact comment sent to Claude\]/,
  /^<local-command-stdout>/,
  /^<command-name>/,
  /^Caveat: The messages below were generated by the user while running/,
];

// Anchored to the start of the message on purpose: a user who quotes a
// notification while asking about it is still making a real request, and that
// is not a hypothetical -- it is how this router got debugged in the first
// place. Leading system-reminder blocks are harness furniture, so look past
// them at what the message actually opens with.
function isSystemGenerated(text) {
  const t = text
    .replace(/^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/, "")
    .trim();
  return SYSTEM_MESSAGE_PATTERNS.some((re) => re.test(t));
}

// Returns [file, leadingArgs] for spawning jev without a shell, or null.
//
// Only absolute PATH entries are searched, and there is no bare "jev" fallback:
// hooks run with the project folder as cwd, a relative PATH entry would resolve
// inside it, and on Windows a bare name is looked up in cwd before PATH. Either
// way, a cloned repo containing its own jev.exe would run on every message.
//
// Windows: the npm shim is a .cmd, which cannot be spawned without a shell, so
// run the package's entry point (it sits next to the shim) with node directly.
// POSIX: the shim is a real executable; spawn its absolute path.
function resolveJev() {
  const win = process.platform === "win32";
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    try {
      if (win) {
        if (!fs.existsSync(path.join(dir, "jev.cmd")) && !fs.existsSync(path.join(dir, "jev"))) continue;
        const cli = path.join(dir, "node_modules", "jevctl", "dist", "cli.js");
        if (fs.existsSync(cli)) return [process.execPath, [cli]];
      } else {
        const shim = path.join(dir, "jev");
        if (fs.existsSync(shim)) return [shim, []];
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

function familyOf(model) {
  const m = /fable|mythos|opus|sonnet|haiku/.exec(String(model || "").toLowerCase());
  return m ? m[0] : null;
}

// The model the main session is running, so the router never tells Opus to
// hand a job to another Opus (a cold subagent doing the same work for the same
// price). The transcript's latest assistant turn is the truth and follows
// /model switches; before the first reply, fall back to the configured default.
// ponytail: ignores project-level settings.json "model"; add if that matters.
function mainModel(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"assistant"')) continue;
        try {
          const r = JSON.parse(lines[i]);
          const m = r.type === "assistant" && !r.isSidechain && r.message && r.message.model;
          if (m && m.startsWith("claude-")) return m;
        } catch {
          // partial first line of the tail window, or not a record
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // no transcript yet
  }
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return readJson(path.join(configDir, "settings.json"), {}).model || null;
}

// Sizing needs the ask, not a 100 KB paste. Sending only the head and tail
// keeps pasted documents and logs from being shipped to the API in full.
function trimForSizing(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  return `${text.slice(0, head)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(-(max - head))}`;
}

function errorReason(e) {
  const stderr = String((e && e.stderr) || "").trim().split("\n").pop();
  return [e && e.code, e && e.signal, stderr || (e && e.message)]
    .filter(Boolean)
    .join(" ")
    .slice(0, 200);
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function main() {
  const state = readJson(STATE_PATH, { enabled: false });
  if (!state.enabled) {
    // Router is off: zero-cost no-op, no jev call and no stats write at all.
    // A deliberate off-switch, not one of the silent bypasses.
    return;
  }

  let hookInput;
  try {
    const raw = fs.readFileSync(0, "utf8");
    hookInput = JSON.parse(raw);
  } catch {
    bumpSkip("no_stdin", null); // no session id is available this early
    return;
  }

  const sessionId = (hookInput && hookInput.session_id) || null;
  // Anchor stats to the project this prompt came from, not to wherever the
  // globally-installed hook happens to be executing.
  PROJECT_CWD = (hookInput && hookInput.cwd) || process.cwd();

  // The join key the collector uses to tie a subagent's tokens back to this
  // decision. Timestamps cannot do it: this hook writes its marker about a
  // second after the prompt it belongs to is already in the transcript.
  const promptId =
    (hookInput && (hookInput.prompt_id || hookInput.promptId || hookInput.promptID)) || null;

  const promptText = (hookInput && (hookInput.prompt_text || hookInput.prompt)) || "";
  if (!promptText || promptText.trim().length < 3) {
    bumpSkip("short_prompt", sessionId);
    return;
  }

  if (isSystemGenerated(promptText)) {
    bumpSkip("system_message", sessionId);
    return;
  }

  const config = readJson(CONFIG_PATH, null);
  if (!config) {
    bumpSkip("no_config", sessionId);
    return;
  }

  let result;
  try {
    const args = [
      "route",
      "--handlers-json",
      `@${path.join(ROOT, "handlers.json")}`,
      "--min-confidence",
      String(config.minConfidence || 0.6),
      "--timeout",
      String(Math.max(1000, (config.timeoutMs || 4000) - 500)),
      "--json",
    ];
    const opts = {
      input: trimForSizing(promptText, config.maxPromptChars || 4000),
      timeout: config.timeoutMs || 4000,
      encoding: "utf8",
      windowsHide: true,
    };
    // No shell anywhere: argv is passed as an array, so paths containing spaces
    // need no quoting. The user's message only ever travels via stdin.
    const jev = resolveJev();
    if (!jev) throw new Error("jev not found on PATH (npm install -g jevctl)");
    result = JSON.parse(execFileSync(jev[0], [...jev[1], ...args], opts));
  } catch (e) {
    // jev slow, erroring, offline, whatever -- proceed exactly as if the
    // router were not installed.
    bumpStat("self", null, errorReason(e), sessionId);
    return;
  }

  const bucket = result.handler; // "tiny" | "everyday" | "large" | "none"
  const confident = result.action === "auto";

  if (!confident || !bucket || bucket === "none") {
    // Low confidence, or Jev couldn't place it -> main agent handles it.
    bumpStat("self", result.usage, null, sessionId);
    return;
  }

  bumpStat(bucket, result.usage, null, sessionId);

  const model = config.modelBySize[bucket];
  if (!model) {
    // Size mapped to null: always handled by the main agent.
    return;
  }

  // Already running that model: delegating only adds a cold subagent.
  if (familyOf(model) && familyOf(model) === familyOf(mainModel(hookInput.transcript_path))) {
    bumpSkip("same_model", sessionId);
    return;
  }

  const label = (config.modelLabel && config.modelLabel[bucket]) || model;
  const agentType = config.subagentType || "general-purpose";
  const pct = Math.round((result.confidence || 0) * 100);

  markDelegation({
    ts: new Date().toISOString(),
    sessionId,
    promptId,
    tier: bucket,
    model,
    confidence: result.confidence || null,
    promptHash: hashPrompt(promptText),
  });

  output({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        `[jev-router] Jev sized this message as "${bucket}" (${pct}% confident). ` +
        `Per the user's model-router setup: delegate this message's actual work to the Agent tool ` +
        `with model: "${model}" (subagent_type: "${agentType}"), giving it whatever context from this ` +
        `conversation it needs to do the job (relevant file paths, prior decisions, exact request). ` +
        `Wait for its result and use that as your answer to the user. ` +
        `End the delegated agent's final answer with one line: "— done by ${label}". ` +
        `If, once you look at the actual message, it turns out to depend on conversation context ` +
        `a fresh subagent won't have, or delegating would clearly produce a worse answer, handle it ` +
        `yourself instead and skip delegation -- Jev only saw the raw text, you have the full picture.`,
    },
  });
}

try {
  main();
} catch {
  // Absolute last resort: never let this hook crash a user's turn.
}
