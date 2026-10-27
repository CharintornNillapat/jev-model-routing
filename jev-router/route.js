#!/usr/bin/env node
// UserPromptSubmit hook: asks Jev how big a job the message is, then tells the
// main agent (via additionalContext) whether to delegate to a smaller/bigger
// model or handle it directly. Must never block a message for long or throw —
// any failure here should be invisible to the user, so everything is wrapped
// in one try/catch that falls back to "do nothing."

const { execFile } = require("child_process");
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
  const p = statsPath();
  if (!p) return;
  // Write-then-rename: a half-written file would parse as garbage on the next
  // read, and loadStats would silently start every counter over from zero.
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    // Stats are best-effort. On Windows the rename can hit EPERM while an
    // antivirus/indexer holds the file; drop the tmp so they don't pile up.
    try {
      fs.unlinkSync(tmp);
    } catch {}
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
    // Session info lives here only. Never write state.json: a torn write there
    // reads back as { enabled: false } and silently turns the router off.
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
  /^\[Request interrupted by user/,
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

function userText(r) {
  if (r.type !== "user" || r.isSidechain || r.isMeta || !r.message) return null;
  const c = r.message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some((b) => b.type === "tool_result")) return null;
  return c.filter((b) => b.type === "text").map((b) => b.text).join("\n") || null;
}

// One pass over the transcript tail for three things:
// - model: what the main session runs, so the router never tells Opus to hand
//   a job to another Opus. The latest assistant turn follows /model switches;
//   before the first reply, fall back to the configured default.
// - ctx: tokens the last main-session turn sent. Every tool step re-reads this
//   much, which is where most of the spend goes in long sessions.
// - recent: the user's last few typed messages, for the new-task check.
// ponytail: 2 MB tail; in a session of huge tool outputs, older user messages
// fall outside it and the guard just sees fewer of them.
function readTranscript(transcriptPath, currentPrompt) {
  const out = { model: null, ctx: 0, recent: [] };
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      const current = (currentPrompt || "").trim();
      for (let i = lines.length - 1; i >= 0 && (!out.model || out.recent.length < 3); i--) {
        let r;
        try {
          r = JSON.parse(lines[i]);
        } catch {
          continue; // partial first line of the tail window
        }
        const m = r.type === "assistant" && !r.isSidechain && r.message && r.message.model;
        if (m && m.startsWith("claude-") && !out.model) {
          out.model = m;
          const u = r.message.usage || {};
          out.ctx =
            (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
        const t = out.recent.length < 3 && userText(r);
        if (t && t.trim() !== current && !isSystemGenerated(t)) out.recent.unshift(t.trim());
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // no transcript yet
  }
  if (!out.model) {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    out.model = process.env.ANTHROPIC_MODEL || readJson(path.join(configDir, "settings.json"), {}).model || null;
  }
  return out;
}

const GUARD_DEFAULTS = { clearAtTokens: 150000, compactAtTokens: 400000, newTaskMin: 0.8 };

// What to tell the user about context size, or null. Pure, so test.js can pin it.
// pNew: Jev's probability that this message starts a new task (null if unknown).
// warnedAt: context size at the last /compact nudge this session, to avoid
// repeating it on every message; it nags again after another 100K of growth.
function guardWarning(ctx, pNew, g, warnedAt) {
  const k = `${Math.round(ctx / 1000)}K`;
  if (ctx >= g.clearAtTokens && pNew !== null && pNew >= g.newTaskMin) {
    return {
      kind: "clear",
      text:
        `[jev-router] Context is ${k} tokens and this looks like a new task (${Math.round(pNew * 100)}%). ` +
        `Every step Claude takes re-reads all of it. Press Esc, run /clear, and send the message again.`,
    };
  }
  const w = ctx < (warnedAt || 0) ? 0 : warnedAt || 0; // context shrank: /compact ran
  if (ctx >= g.compactAtTokens && ctx >= w + 100000) {
    return {
      kind: "compact",
      text: `[jev-router] Context is ${k} tokens. Every step Claude takes re-reads all of it; /compact would shrink it.`,
    };
  }
  return null;
}

const NEW_TASK_QUESTION =
  "new_task=Is the NEW message a separate task from the earlier messages, one that would not need " +
  'the earlier conversation to be done well? Follow-ups, corrections, approvals like "go ahead" ' +
  "and questions about the earlier work are NOT new tasks.";

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

// Async so the sizing and new-task calls run side by side: back to back they
// could outlast the 6 s hook timeout.
function runJev(args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const jev = resolveJev();
    if (!jev) return reject(new Error("jev not found on PATH (npm install -g jevctl)"));
    // No shell anywhere: argv is passed as an array, so paths containing spaces
    // need no quoting. The user's message only ever travels via stdin.
    const child = execFile(
      jev[0],
      [...jev[1], ...args],
      { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (e, stdout, stderr) => {
        if (e) return reject(Object.assign(e, { stderr }));
        try {
          resolve(JSON.parse(stdout));
        } catch (pe) {
          reject(pe);
        }
      }
    );
    child.stdin.on("error", () => {}); // jev exited before reading stdin; the callback reports it
    child.stdin.end(input);
  });
}

// Size the message and return the delegation instruction for Claude, or null.
async function sizeUp(promptText, config, transcript, sessionId, promptId) {
  let result;
  try {
    const timeoutMs = config.timeoutMs || 4000;
    result = await runJev(
      [
        "route",
        "--handlers-json",
        `@${path.join(ROOT, "handlers.json")}`,
        "--min-confidence",
        String(config.minConfidence || 0.6),
        "--timeout",
        String(Math.max(1000, timeoutMs - 500)),
        "--json",
      ],
      trimForSizing(promptText, config.maxPromptChars || 4000),
      timeoutMs
    );
  } catch (e) {
    // jev slow, erroring, offline, whatever -- proceed exactly as if the
    // router were not installed.
    bumpStat("self", null, errorReason(e), sessionId);
    return null;
  }

  const bucket = result.handler; // "tiny" | "everyday" | "large" | "none"
  const confident = result.action === "auto";

  if (!confident || !bucket || bucket === "none") {
    // Low confidence, or Jev couldn't place it -> main agent handles it.
    bumpStat("self", result.usage, null, sessionId);
    return null;
  }

  bumpStat(bucket, result.usage, null, sessionId);

  const model = config.modelBySize[bucket];
  if (!model) return null; // size mapped to null: always handled by the main agent

  // Already running that model: delegating only adds a cold subagent.
  if (familyOf(model) && familyOf(model) === familyOf(transcript.model)) {
    bumpSkip("same_model", sessionId);
    return null;
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

  return (
    `[jev-router] Jev sized this message as "${bucket}" (${pct}% confident). ` +
    `Per the user's model-router setup: delegate this message's actual work to the Agent tool ` +
    `with model: "${model}" (subagent_type: "${agentType}"), giving it whatever context from this ` +
    `conversation it needs to do the job (relevant file paths, prior decisions, exact request). ` +
    `Wait for its result and use that as your answer to the user. ` +
    `End the delegated agent's final answer with one line: "— done by ${label}". ` +
    `If, once you look at the actual message, it turns out to depend on conversation context ` +
    `a fresh subagent won't have, or delegating would clearly produce a worse answer, handle it ` +
    `yourself instead and skip delegation -- Jev only saw the raw text, you have the full picture.`
  );
}

// Context guard: when the session is already big, warn the user (not Claude)
// if this message starts a new task, so they can /clear before every step
// re-reads hundreds of thousands of stale tokens. Returns the warning or null.
async function contextWarning(promptText, config, transcript, sessionId) {
  if (config.contextGuard === null) return null; // turned off
  const g = Object.assign({}, GUARD_DEFAULTS, config.contextGuard);
  if (transcript.ctx < g.clearAtTokens) return null; // small session: no Jev call at all

  let pNew = null;
  let usage = null;
  if (transcript.recent.length) {
    const state =
      "Earlier messages from the user:\n" +
      transcript.recent.map((m) => `- ${trimForSizing(m, 500)}`).join("\n") +
      `\n\nNEW message:\n${trimForSizing(promptText, 1000)}`;
    try {
      const r = await runJev(["ask", "-", "--noul", NEW_TASK_QUESTION, "--json"], state, config.timeoutMs || 4000);
      pNew = r.answers.new_task.noul;
      usage = r.usage;
    } catch (e) {
      const stats = loadStats();
      stats.lastErrors = (Array.isArray(stats.lastErrors) ? stats.lastErrors : [])
        .concat({ ts: new Date().toISOString(), reason: `guard: ${errorReason(e)}` })
        .slice(-10);
      writeStats(stats);
    }
  }

  const stats = loadStats();
  const sess = ensureSession(stats, sessionId);
  const warning = guardWarning(transcript.ctx, pNew, g, sess && sess.guardWarnedAt);
  for (const t of sess ? [stats, sess] : [stats]) {
    t.guard = Object.assign({ checks: 0, clear: 0, compact: 0, input_tokens: 0, output_tokens: 0 }, t.guard);
    t.guard.checks++;
    if (warning) t.guard[warning.kind]++;
    if (usage) {
      t.guard.input_tokens += usage.input_tokens || 0;
      t.guard.output_tokens += usage.output_tokens || 0;
    }
  }
  if (sess && warning && warning.kind === "compact") sess.guardWarnedAt = transcript.ctx;
  stats.updatedAt = new Date().toISOString();
  writeStats(stats);
  return warning && warning.text;
}

async function main() {
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

  const transcript = readTranscript(hookInput.transcript_path, promptText);
  const [context, warning] = await Promise.all([
    sizeUp(promptText, config, transcript, sessionId, promptId).catch(() => null),
    contextWarning(promptText, config, transcript, sessionId).catch(() => null),
  ]);

  const out = {};
  if (warning) out.systemMessage = warning; // shown to the user, not to Claude
  if (context) out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: context };
  if (Object.keys(out).length) output(out);
}

if (require.main === module) {
  // Absolute last resort: never let this hook crash a user's turn.
  main().catch(() => {});
}

module.exports = { guardWarning, readTranscript };
