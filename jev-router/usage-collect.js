#!/usr/bin/env node
// SubagentStop hook: records what the DELEGATED model actually consumed.
//
// The router hook (route.js) runs BEFORE any work happens, so it can only ever
// see Jev's own routing tokens. This one runs after a subagent finishes and
// reads the real numbers out of the subagent transcript.
//
// The SubagentStop stdin payload is not documented, so nothing here depends on
// a guessed field: we record the keys we actually saw (observed_payload_keys)
// and locate transcripts by whichever of transcript_path / session_id / cwd is
// present. Each agent's totals are RECOMPUTED from its transcript on every run
// and stored by agent id (agents from earlier sessions are kept), so repeated
// runs are idempotent and can never double-count.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

function hashPrompt(text) {
  return crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

// Stats are per-project (see route.js): resolved from the hook payload's cwd so
// a globally-installed hook still writes beside the project it ran for.
function statsPath(payload) {
  const base = (payload && payload.cwd) || process.cwd();
  // A cwd that does not resolve to a real directory means a malformed payload.
  try {
    if (!base || !fs.existsSync(base)) return null;
  } catch {
    return null;
  }
  return path.join(base, ".claude", "jev-router-stats.json");
}

// Anthropic API list prices, $ per 1M tokens, checked 2026-10. First match on
// the model id wins, so specific versions come before their family fallback.
// `read` is the cache-read price where it is not the usual 0.1x input. Cache
// writes bill at 1.25x input (5-minute TTL) or 2x (1-hour TTL).
// ponytail: Haiku 5.5's higher rate above 100K-token prompts is ignored.
const RATES = [
  { match: "fable", in: 10, out: 50, read: 0.25 },
  { match: "mythos", in: 10, out: 50, read: 0.25 },
  { match: "opus-5-5", in: 4, out: 20, read: 0.2 },
  { match: "opus", in: 5, out: 25 },
  { match: "sonnet-5", in: 2, out: 10 }, // Sonnet 5 and 5.5
  { match: "sonnet", in: 3, out: 15 },
  { match: "haiku-5-5", in: 0.1, out: 0.5 },
  { match: "haiku", in: 1, out: 5 },
];
const BASELINE_MODEL = "claude-opus-5-5";

function rateFor(model) {
  if (!model) return null;
  return RATES.find((r) => model.includes(r.match)) || null;
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// Find every subagents/ directory belonging to this project.
function findSubagentDirs(payload) {
  const dirs = [];
  const tp = payload && payload.transcript_path;
  if (tp) {
    // <...>/<session-id>.jsonl  ->  <...>/<session-id>/subagents
    const d = path.join(path.dirname(tp), path.basename(tp, ".jsonl"), "subagents");
    if (fs.existsSync(d)) dirs.push(d);
  }
  if (dirs.length) return dirs;

  // Fall back to locating by session id. Reconstructing the project slug from
  // cwd is unreliable (spaces and the drive letter get rewritten), so scan the
  // projects tree for a directory matching this session instead.
  const sid = payload && payload.session_id;
  if (!sid) return dirs; // no scope signal -> caller must not scan

  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let projects = [];
  try {
    projects = fs.readdirSync(base);
  } catch {
    return dirs;
  }
  for (const proj of projects) {
    const d = path.join(base, proj, sid, "subagents");
    if (fs.existsSync(d)) dirs.push(d);
  }
  return dirs;
}

// Sum a single subagent transcript, deduplicating by message id. The same
// message id appears on multiple streamed records; counting each would inflate.
function sumTranscript(file) {
  const totals = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation_1h_input_tokens: 0, // subset of the above, billed at 2x
    cache_read_input_tokens: 0,
    output_tokens: 0,
    models: {},
    messages: 0,
    promptId: null,
    firstTs: null,
  };
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return totals;
  }
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // A subagent transcript carries exactly one promptId: the user prompt that
    // spawned it. That is the join key back to the routing decision.
    if (rec && rec.promptId && !totals.promptId) totals.promptId = rec.promptId;
    if (rec && rec.timestamp && !totals.firstTs) totals.firstTs = rec.timestamp;
    const msg = rec && rec.message;
    if (!msg || !msg.usage || !msg.id) continue;
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    const u = msg.usage;
    totals.input_tokens += u.input_tokens || 0;
    totals.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    totals.cache_creation_1h_input_tokens += (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
    totals.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    totals.output_tokens += u.output_tokens || 0;
    totals.messages += 1;
    if (msg.model) totals.models[msg.model] = (totals.models[msg.model] || 0) + 1;
  }
  return totals;
}

// promptId -> { earliest timestamp, hashes of each user record } from the parent
// session transcript. Hashes (not text) are what the delegation marker is
// confirmed against, so no prompt content is stored or compared in the clear.
function indexPrompts(mainTranscript) {
  const idx = {};
  let lines;
  try {
    lines = fs.readFileSync(mainTranscript, "utf8").split("\n");
  } catch {
    return idx;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type !== "user" || !rec.promptId || rec.isSidechain) continue;
    const e = (idx[rec.promptId] = idx[rec.promptId] || { earliest: null, hashes: [] });
    if (rec.timestamp && (!e.earliest || rec.timestamp < e.earliest)) e.earliest = rec.timestamp;
    const c = rec.message && rec.message.content;
    let txt = "";
    if (typeof c === "string") txt = c;
    else if (Array.isArray(c)) txt = c.map((b) => b.text || "").join("");
    if (txt.trim()) e.hashes.push(hashPrompt(txt));
  }
  return idx;
}

// Confirm a candidate marker against the prompt's own text hashes. Returns null
// when the pairing is sound, or a rejection when the marker provably belongs to
// a different prompt -- which is what happens when a subagent was spawned
// outside the router, on the main agent's own initiative. Refusing to attribute
// beats corrupting the tier totals.
function confirmByHash(marker, p) {
  if (!marker.promptHash || !p || !p.hashes.length) return null;
  if (!p.hashes.includes(marker.promptHash)) {
    return { tier: null, tier_match: "hash_mismatch", rejected_tier: marker.tier };
  }
  return null;
}

function attributed(marker, match) {
  return {
    tier: marker.tier,
    tier_model: marker.model,
    tier_confidence: marker.confidence,
    tier_match: match,
  };
}

// Attribute one subagent to the tier that spawned it.
//
// The join is on promptId: the marker and the subagent transcript both name the
// prompt that caused the delegation, so the pairing is exact. Timestamps cannot
// do this job -- route.js writes its marker roughly a second AFTER the prompt is
// recorded, so a nearest-preceding-marker search either finds nothing or finds
// the previous turn's marker. The promptHash still gets the final say.
function matchTier(agent, prompts, delegations) {
  const p = agent.promptId ? prompts[agent.promptId] : null;
  if (!delegations.length) return { tier: null, tier_match: "unmatched" };

  if (agent.promptId) {
    const byId = delegations.filter((d) => d.promptId === agent.promptId);
    if (byId.length) {
      const marker = byId[byId.length - 1];
      const rejected = confirmByHash(marker, p);
      if (rejected) return rejected;
      return attributed(marker, marker.promptHash && p && p.hashes.length ? "confirmed" : "prompt_id");
    }
  }

  // Markers written before promptId was recorded still carry a promptHash, and
  // that hash is itself an exact key back to the prompt. Identical prompt text
  // in one session is the only ambiguity, broken by taking the marker nearest
  // in time to the prompt.
  if (p && p.hashes.length) {
    const byHash = delegations.filter((d) => !d.promptId && d.promptHash && p.hashes.includes(d.promptHash));
    if (byHash.length) {
      const anchor = p.earliest || agent.firstTs;
      const marker = byHash.reduce((a, b) => {
        if (!anchor || !a.ts) return b.ts ? b : a;
        if (!b.ts) return a;
        return Math.abs(Date.parse(b.ts) - Date.parse(anchor)) <
          Math.abs(Date.parse(a.ts) - Date.parse(anchor))
          ? b
          : a;
      });
      return attributed(marker, "hash_legacy");
    }
  }

  return { tier: null, tier_match: "unmatched" };
}

function costOf(t, model) {
  const r = rateFor(model);
  if (!r) return null;
  const read = r.read !== undefined ? r.read : r.in * 0.1;
  const write1h = t.cache_creation_1h_input_tokens || 0;
  const write5m = t.cache_creation_input_tokens - write1h;
  return (
    (t.input_tokens / 1e6) * r.in +
    (write5m / 1e6) * r.in * 1.25 +
    (write1h / 1e6) * r.in * 2 +
    (t.cache_read_input_tokens / 1e6) * read +
    (t.output_tokens / 1e6) * r.out
  );
}

const round = (n) => Number(n.toFixed(6));

// byModel and byTier are rebuilt from byAgent every run, so the totals always
// equal the sum of the agents listed and a re-scan can never double-count.
function aggregate(byAgent) {
  const byModel = {};
  const byTier = {};
  for (const a of Object.values(byAgent)) {
    const m = (byModel[a.model] = byModel[a.model] || {
      agents: 0,
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      total_input_tokens: 0,
      estimated_cost_usd: 0,
    });
    m.agents += 1;
    m.input_tokens += a.input_tokens;
    m.cache_creation_input_tokens += a.cache_creation_input_tokens;
    m.cache_read_input_tokens += a.cache_read_input_tokens;
    m.output_tokens += a.output_tokens;
    m.total_input_tokens += a.total_input_tokens;
    m.estimated_cost_usd = round(m.estimated_cost_usd + (a.estimated_cost_usd || 0));

    const tk = (byTier[a.tier || "unattributed"] = byTier[a.tier || "unattributed"] || {
      agents: 0,
      total_input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: 0,
      opus_baseline_cost_usd: 0,
      saved_vs_opus_usd: 0,
    });
    tk.agents += 1;
    tk.total_input_tokens += a.total_input_tokens;
    tk.output_tokens += a.output_tokens;
    tk.estimated_cost_usd = round(tk.estimated_cost_usd + (a.estimated_cost_usd || 0));
    tk.opus_baseline_cost_usd = round(tk.opus_baseline_cost_usd + (a.opus_baseline_cost_usd || 0));
    tk.saved_vs_opus_usd = round(tk.opus_baseline_cost_usd - tk.estimated_cost_usd);
  }
  return { byModel, byTier };
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8")) || {};
  } catch {
    // keep going: transcripts can still be found via cwd
  }

  const existing = readJson(statsPath(payload), {});
  const delegations = Array.isArray(existing.delegations) ? existing.delegations : [];
  // Agents from earlier sessions are kept, so the totals cover the project's
  // whole history instead of only whichever session finished last.
  const byAgent = Object.assign({}, (existing.actual_execution_usage || {}).byAgent);

  const dirs = findSubagentDirs(payload);
  if (!dirs.length) {
    // No transcript_path and no session_id: scope is indeterminate. Scanning
    // every project would pull in agents that belong elsewhere, so leave the
    // existing data untouched.
    return;
  }

  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    // dir is <...>/<session-id>/subagents, so the parent session transcript
    // sits alongside it as <session-id>.jsonl
    const prompts = indexPrompts(path.dirname(dir) + ".jsonl");
    for (const f of files) {
      const t = sumTranscript(path.join(dir, f));
      if (!t.messages) continue;
      const agentId = path.basename(f, ".jsonl").replace(/^agent-/, "");
      // The model that produced the most messages is the delegated one.
      const model =
        Object.keys(t.models).sort((a, b) => t.models[b] - t.models[a])[0] || "unknown";
      const cost = costOf(t, model);
      const base = costOf(t, BASELINE_MODEL);
      const attr = matchTier(t, prompts, delegations);
      byAgent[agentId] = {
        tier: attr.tier,
        tier_match: attr.tier_match,
        promptId: t.promptId,
        model,
        messages: t.messages,
        input_tokens: t.input_tokens,
        cache_creation_input_tokens: t.cache_creation_input_tokens,
        cache_creation_1h_input_tokens: t.cache_creation_1h_input_tokens,
        cache_read_input_tokens: t.cache_read_input_tokens,
        output_tokens: t.output_tokens,
        total_input_tokens:
          t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens,
        estimated_cost_usd: cost === null ? null : round(cost),
        opus_baseline_cost_usd: base === null ? null : round(base),
      };
    }
  }

  const { byModel, byTier } = aggregate(byAgent);
  const stats = readJson(statsPath(payload), {});
  stats.actual_execution_usage = {
    // Recorded so the real payload shape is discoverable from data, not docs.
    observed_payload_keys: Object.keys(payload).sort(),
    lastScanAt: new Date().toISOString(),
    scanned_sessions: dirs.length,
    baseline_model: BASELINE_MODEL,
    byTier,
    byModel,
    byAgent,
  };
  const p = statsPath(payload);
  if (!p) return;
  // Write-then-rename, like route.js: never leave a half-written stats file.
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    // best-effort, exactly like route.js; don't leave the tmp behind
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

try {
  main();
} catch {
  // never let a stats hook break a turn
}
