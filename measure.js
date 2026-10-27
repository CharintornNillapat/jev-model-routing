#!/usr/bin/env node
// Measures main-session context size and spend across all your Claude Code
// transcripts, to check whether the context guard changes anything.
//
//   node measure.js --since 2026-09-27 --until 2026-10-27 > baseline.json
//   node measure.js --since 2026-10-28
//
// Compare per-turn and per-message numbers, not totals: workload varies week to week.
// Claude Code deletes transcripts after 30 days by default, so save a baseline early.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { costOf } = require("./jev-router/usage-collect.js");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Date.parse(process.argv[i + 1]) : NaN;
};
const since = arg("--since") || 0;
const until = arg("--until") || Infinity;

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const root = path.join(configDir, "projects");
const m = { turns: 0, userMessages: 0, ctxSum: 0, over100k: 0, over150k: 0, cost: 0 };
const byType = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation_1h_input_tokens: 0 };

function scan(file) {
  const seen = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(r.timestamp);
    if (r.isSidechain || !(ts >= since && ts < until)) continue;
    if (r.type === "user" && !r.isMeta && typeof (r.message && r.message.content) === "string") m.userMessages++;
    const u = r.type === "assistant" && r.message && r.message.usage;
    if (!u || seen.has(r.message.id)) continue; // one API call is logged once per content block
    seen.add(r.message.id);
    const t = Object.assign({}, zero, u, {
      cache_creation_1h_input_tokens: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
    });
    const ctx = t.input_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens;
    const c = costOf(t, r.message.model);
    if (c === null) continue; // unknown model, e.g. <synthetic>
    m.turns++;
    m.ctxSum += ctx;
    if (ctx > 100000) m.over100k++;
    if (ctx > 150000) m.over150k++;
    m.cost += c;
    byType.input += costOf(Object.assign({}, zero, { input_tokens: t.input_tokens }), r.message.model);
    byType.output += costOf(Object.assign({}, zero, { output_tokens: t.output_tokens }), r.message.model);
    byType.cache_read += costOf(Object.assign({}, zero, { cache_read_input_tokens: t.cache_read_input_tokens }), r.message.model);
    byType.cache_write += costOf(
      Object.assign({}, zero, {
        cache_creation_input_tokens: t.cache_creation_input_tokens,
        cache_creation_1h_input_tokens: t.cache_creation_1h_input_tokens,
      }),
      r.message.model
    );
  }
}

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".jsonl") && !p.includes(`${path.sep}subagents${path.sep}`)) scan(p);
  }
})(root);

const pct = (n) => Math.round((100 * n) / (m.cost || 1));
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      since: since ? new Date(since).toISOString() : null,
      until: until !== Infinity ? new Date(until).toISOString() : null,
      turns: m.turns,
      userMessages: m.userMessages,
      avgContextTokens: Math.round(m.ctxSum / (m.turns || 1)),
      turnsOver100kPct: Math.round((100 * m.over100k) / (m.turns || 1)),
      turnsOver150kPct: Math.round((100 * m.over150k) / (m.turns || 1)),
      estCostUsd: Math.round(m.cost * 100) / 100,
      estCostPerUserMessageUsd: Math.round((m.cost / (m.userMessages || 1)) * 1000) / 1000,
      costSharePct: { input: pct(byType.input), output: pct(byType.output), cache_read: pct(byType.cache_read), cache_write: pct(byType.cache_write) },
    },
    null,
    2
  )
);
