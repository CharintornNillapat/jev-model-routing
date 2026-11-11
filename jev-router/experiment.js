// Shared by route.js, turn-log.js and analyze.js: where the append-only log
// lives, and which experiment arm a session belongs to.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "jev-router");
const logPath = () => path.join(dir(), "log.jsonl");

// Append-only and best-effort: no read-modify-write, so two hooks firing at once
// cannot lose each other's rows, and a failure never blocks a turn. Rows hold
// hashes and numbers only, never prompt text.
function appendLog(row) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(logPath(), JSON.stringify(row) + "\n");
  } catch {
    // logging must never break a turn
  }
}

const short = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

// Which switches are ON for this session. Deterministic in the session id, so
// every hook agrees on the arm with nothing stored. The two draws come from
// different bytes of the same hash, so the router and guard arms are independent.
// A "control" session still gets sized and logged; it just doesn't act on it.
function assignArm(sessionId, exp, now = Date.now()) {
  const allOn = { experiment: false, router: true, guard: true };
  if (!exp || !exp.enabled || !sessionId) return allOn;
  if (exp.endsAt && now >= Date.parse(exp.endsAt)) return allOn;
  const h = crypto.createHash("sha256").update(`${exp.salt || "jev"}:${sessionId}`).digest();
  const u = (i) => h.readUInt32BE(i) / 2 ** 32;
  return {
    experiment: true,
    router: u(0) >= (exp.routerControl ?? 0.5),
    guard: u(4) >= (exp.guardControl ?? 0.25),
  };
}

module.exports = { logPath, appendLog, assignArm, short };
