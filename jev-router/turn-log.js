#!/usr/bin/env node
// Stop hook: when a turn ends, appends one cost row (main session + every
// subagent it spawned) for the prompt that just ran. Together with the prompt
// rows route.js writes, that's the whole data set analyze.js needs, and it is
// kept in our own log so Claude Code's 30-day transcript cleanup can't take it.
//
// A prompt that spans several Stop events gets several rows; analyze.js keeps
// the last one. Prints nothing and never throws: it must not disturb a turn.

const fs = require("fs");
const path = require("path");
const { appendLog, short } = require("./experiment.js");
const { costOf, sumTranscript } = require("./usage-collect.js");

const TAIL = 8 * 1024 * 1024;
const round = (n) => Number(n.toFixed(6));
const top = (counts) => Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;

function readTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString("utf8"), truncated: size > len };
  } finally {
    fs.closeSync(fd);
  }
}

// Main-session totals for the LAST prompt in the transcript. Assistant records
// carry no promptId, so they belong to the most recent user record's prompt.
function lastPrompt({ text, truncated }) {
  let cur = null;
  let prompts = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // partial first line of the tail window
    }
    if (r.isSidechain) continue;
    if (r.type === "user" && r.promptId) {
      if (!cur || cur.promptId !== r.promptId) {
        prompts++;
        cur = { promptId: r.promptId, firstTs: r.timestamp || null, steps: 0, ctxSum: 0, peakCtx: 0, out: 0, toolErrors: 0, models: {}, seen: new Set() };
      }
      const c = r.message && r.message.content;
      if (Array.isArray(c) && c.some((b) => b.type === "tool_result" && b.is_error)) cur.toolErrors++;
      continue;
    }
    const m = r.type === "assistant" && r.message;
    if (!cur || !m || !m.usage || !m.id || cur.seen.has(m.id)) continue;
    cur.seen.add(m.id); // one message streams as several records; count it once
    const u = m.usage;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    cur.steps++;
    cur.ctxSum += ctx;
    cur.peakCtx = Math.max(cur.peakCtx, ctx);
    cur.out += u.output_tokens || 0;
    const t = (cur.models[m.model || "unknown"] = cur.models[m.model || "unknown"] || {
      input_tokens: 0, cache_creation_input_tokens: 0, cache_creation_1h_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, n: 0,
    });
    t.input_tokens += u.input_tokens || 0;
    t.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    t.cache_creation_1h_input_tokens += (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
    t.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    t.output_tokens += u.output_tokens || 0;
    t.n++;
  }
  if (cur) cur.partial = truncated && prompts === 1; // the prompt began before the window
  return cur;
}

// Every subagent transcript of this session that was spawned for `cur`.
function subagents(transcriptPath, cur) {
  const out = { n: 0, cost: 0, byModel: {} };
  const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return out;
  }
  const since = Date.parse(cur.firstTs) || 0;
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      if (fs.statSync(file).mtimeMs < since - 1000) continue; // finished before this prompt began
    } catch {
      continue;
    }
    const t = sumTranscript(file);
    if (!t.messages || t.promptId !== cur.promptId) continue;
    const model = top(t.models) || "unknown";
    const c = costOf(t, model) || 0;
    out.n++;
    out.cost += c;
    out.byModel[model] = round((out.byModel[model] || 0) + c);
  }
  return out;
}

function main() {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  const tp = payload.transcript_path;
  if (!payload.session_id || !tp) return;
  const cur = lastPrompt(readTail(tp));
  if (!cur) return;

  let mainCost = 0;
  let unpriced = false;
  for (const [model, t] of Object.entries(cur.models)) {
    const c = costOf(t, model);
    if (c === null) unpriced = true;
    else mainCost += c;
  }
  const agents = subagents(tp, cur);
  appendLog({
    t: "cost",
    ts: new Date().toISOString(),
    sessionId: payload.session_id,
    promptId: cur.promptId,
    project: short(payload.cwd),
    model: top(Object.fromEntries(Object.entries(cur.models).map(([k, v]) => [k, v.n]))),
    steps: cur.steps,
    ctxSum: cur.ctxSum,
    peakCtx: cur.peakCtx,
    out: cur.out,
    toolErrors: cur.toolErrors,
    main: round(mainCost),
    agents: agents.n,
    agentCost: round(agents.cost),
    agentModels: agents.byModel,
    partial: cur.partial,
    unpriced,
  });
}

if (require.main === module) {
  try {
    main();
  } catch {
    // never let this hook disturb a turn
  }
}

module.exports = { lastPrompt };
