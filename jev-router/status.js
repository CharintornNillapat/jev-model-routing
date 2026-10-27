#!/usr/bin/env node
// Prints router on/off plus this project's routing stats.
// Run from the project folder: stats live in <project>/.claude/jev-router-stats.json.
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const read = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
};
const state = read(path.join(ROOT, "state.json"), { enabled: false });
const config = read(path.join(ROOT, "config.json"), { modelLabel: {} });
const sizes = Object.keys(read(path.join(ROOT, "handlers.json"), {}));
const statsFile = path.join(process.cwd(), ".claude", "jev-router-stats.json");
const stats = read(statsFile, null);

console.log(`jev-router: ${state.enabled ? "ON" : "OFF"}`);
if (!stats) {
  console.log(`No stats yet for this project (${statsFile}).`);
  process.exit(0);
}

function show(title, t) {
  const c = t.counts || {};
  const s = t.skipped || {};
  const u = t.usage || {};
  console.log(`\n${title}`);
  for (const size of sizes) {
    const label = (config.modelLabel || {})[size] || "?";
    console.log(`  ${size.padEnd(9)} ${String(c[size] || 0).padStart(4)}  -> ${label}`);
  }
  console.log(`  ${"self".padEnd(9)} ${String(c.self || 0).padStart(4)}  -> handled by main agent (low confidence / no fit)`);
  console.log(`  ${"errors".padEnd(9)} ${String(c.errors || 0).padStart(4)}  -> Jev call failed/timed out, handled normally`);
  const skips = Object.entries(s).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
  if (skips.length) console.log(`  skipped:  ${skips.join(", ")}`);
  console.log(`  jev calls: ${t.calls || 0}   tokens in/out: ${u.input_tokens || 0}/${u.output_tokens || 0}`);
  const g = t.guard;
  if (g) console.log(`  context guard: ${g.checks} checks, warned /clear=${g.clear} /compact=${g.compact}   tokens in/out: ${g.input_tokens}/${g.output_tokens}`);
}

if (stats.session) show(`This session (${stats.session.id}, since ${stats.session.startedAt}):`, stats.session);
show("All time (this project):", stats);

const byTier = (stats.actual_execution_usage || {}).byTier || {};
if (Object.keys(byTier).length) {
  console.log("\nDelegated subagent spend (estimated):");
  for (const [tier, t] of Object.entries(byTier)) {
    console.log(`  ${tier.padEnd(13)} agents=${t.agents}  cost=$${t.estimated_cost_usd}  saved vs opus=$${t.saved_vs_opus_usd}`);
  }
}
const errs = (stats.lastErrors || []).slice(-3);
if (errs.length) {
  console.log("\nRecent Jev errors:");
  for (const e of errs) console.log(`  ${e.ts}  ${e.reason}`);
}
console.log(`\nLast updated: ${stats.updatedAt || "never"}`);
