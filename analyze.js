#!/usr/bin/env node
// Compares control and treated sessions from the experiment log
// (~/.claude/jev-router/log.jsonl, written by route.js and turn-log.js).
//
//   node analyze.js [--since 2026-11-12] [--log path/to/log.jsonl]
//
// Sessions are randomized, so the unit that gets resampled is the session, not
// the message: messages inside one session share a context and are not independent.

const fs = require("fs");
const { logPath } = require("./jev-router/experiment.js");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const file = arg("--log") || logPath();
const since = arg("--since") ? Date.parse(arg("--since")) : 0;

const prompts = new Map(); // first prompt row wins
const costs = new Map(); // last cost row wins: a prompt can span several Stop events
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  const key = `${r.sessionId}|${r.promptId}`;
  if (r.t === "prompt" && !prompts.has(key) && Date.parse(r.ts) >= since) prompts.set(key, r);
  if (r.t === "cost") costs.set(key, r);
}

const rows = [];
for (const [key, p] of prompts) {
  const c = costs.get(key);
  if (!c) continue;
  rows.push({
    p,
    session: p.sessionId,
    cost: c.main + c.agentCost,
    steps: c.steps,
    ctxPerStep: c.steps ? c.ctxSum / c.steps : 0,
    partial: c.partial,
  });
}
const exp = rows.filter((r) => r.p.experiment && !r.partial);

// Deterministic resampling, so two runs on the same log print the same numbers.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const bySession = (rs, f) => {
  const m = new Map();
  for (const r of rs) {
    const g = m.get(r.session) || { sum: 0, n: 0 };
    g.sum += f(r);
    g.n++;
    m.set(r.session, g);
  }
  return [...m.values()];
};

// 95% interval for (mean of `b` - mean of `a`) by resampling whole sessions.
function diffCI(a, b, f) {
  const A = bySession(a, f);
  const B = bySession(b, f);
  if (A.length < 2 || B.length < 2) return null;
  const rand = rng(12345);
  const draw = (G) => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < G.length; i++) {
      const g = G[Math.floor(rand() * G.length)];
      s += g.sum;
      n += g.n;
    }
    return s / n;
  };
  const d = [];
  for (let i = 0; i < 2000; i++) d.push(draw(B) - draw(A));
  d.sort((x, y) => x - y);
  return [d[Math.floor(0.025 * d.length)], d[Math.floor(0.975 * d.length)]];
}

const $ = (x) => (Number.isNaN(x) ? "  n/a" : `$${x.toFixed(3)}`);
const sgn = (x) => (x >= 0 ? "+" : "-") + $(Math.abs(x));

// `treated` = the switch was on, `control` = it was off. A negative difference
// (control - treated) means the switch saved money.
function compare(label, treated, control, f = (r) => r.cost) {
  const n = (rs) => `n=${String(rs.length).padStart(4)} (${new Set(rs.map((r) => r.session)).size} sessions)`;
  const ci = diffCI(treated, control, f);
  console.log(`  ${label}`);
  console.log(`    treated  ${n(treated)}  mean ${$(mean(treated.map(f)))}  median ${$(median(treated.map(f)))}`);
  console.log(`    control  ${n(control)}  mean ${$(mean(control.map(f)))}  median ${$(median(control.map(f)))}`);
  const d = mean(control.map(f)) - mean(treated.map(f));
  console.log(`    control - treated: ${Number.isNaN(d) ? "n/a" : sgn(d)}   95% interval ${ci ? `[${sgn(ci[0])}, ${sgn(ci[1])}]` : "n/a (need 2+ sessions per arm)"}`);
}

const split = (rs, k) => [rs.filter((r) => r.p.arm[k]), rs.filter((r) => !r.p.arm[k])];

console.log(`Log: ${file}`);
console.log(`Prompts logged ${prompts.size}; with a cost row ${rows.length}; in randomized sessions ${exp.length}`);
for (const k of ["router", "guard"]) {
  const [t, c] = split(exp, k);
  console.log(`Sessions with ${k} on: ${new Set(t.map((r) => r.session)).size}, off: ${new Set(c.map((r) => r.session)).size}`);
}

console.log("\nROUTER  (control = Claude is never told to delegate)");
{
  const [t, c] = split(exp, "router");
  compare("all messages (intent to treat)", t, c);
  // Only messages the router would have delegated can differ between arms; the
  // rest is the same work done the same way, which only adds noise.
  const elig = exp.filter((r) => r.p.skip === "control" || r.p.delegated);
  for (const b of ["tiny", "everyday", "large"]) {
    const [te, ce] = split(elig.filter((r) => r.p.bucket === b), "router");
    if (te.length + ce.length) compare(`messages sized "${b}" that would be delegated`, te, ce);
  }
}

console.log("\nGUARD  (control = no /clear warning shown)");
{
  const [t, c] = split(exp, "guard");
  compare("all messages: cost", t, c);
  compare("all messages: context tokens per step", t, c, (r) => r.ctxPerStep);
  // Effects show up in later messages (after /clear), so the cost comparison
  // above covers every message, not just the ones that got a warning.
  const shown = exp.filter((r) => r.p.guardShown).length;
  const would = exp.filter((r) => r.p.guardWould).length;
  console.log(`  warnings: shown ${shown}, would have fired in ${would} messages (shown + suppressed)`);
}

console.log("\nNotes: costs are estimates from the rate table in usage-collect.js, not billing.");
console.log("Delegation is a suggestion Claude can decline, so the router figures measure the offer, not the outcome.");
console.log("Quality is not measured here: cheaper only counts if the work was as good.");
