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
  assert.deepStrictEqual(s.hooks.Stop[0], { hooks: [other] }, "other events untouched");
  assert.strictEqual(ours(s, "Stop", "turn-log.js").length, 1, "turn-log hook added next to the other Stop hook");
  assert.deepStrictEqual(s.hooks.UserPromptSubmit[0], { hooks: [other] }, "other hook kept");
  const route = ours(s, "UserPromptSubmit", "route.js");
  assert.strictEqual(route.length, 1, "stale entry replaced, not duplicated");
  assert.deepStrictEqual(route[0].args, [path.join(dir, "jev-router", "route.js")]);
  assert.strictEqual(ours(s, "SubagentStop", "usage-collect.js").length, 1);
  for (const f of ["route.js", "usage-collect.js", "turn-log.js", "experiment.js", "status.js", "config.json", "handlers.json", "state.json"]) {
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

  // Context guard: transcript parsing and the warning rules.
  const { guardWarning, readTranscript } = require("./jev-router/route.js");
  const tp = path.join(dir, "t.jsonl");
  const rec = (o) => JSON.stringify(o);
  fs.writeFileSync(
    tp,
    [
      rec({ type: "user", message: { content: "fix the login bug" } }),
      rec({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 5, cache_read_input_tokens: 100 } } }),
      rec({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }), // tool output, not typed
      rec({ type: "user", isMeta: true, message: { content: "meta" } }),
      rec({ type: "user", message: { content: "<task-notification>done</task-notification>" } }),
      rec({ type: "user", message: { content: [{ type: "text", text: "still broken on safari" }] } }),
      rec({ type: "assistant", isSidechain: true, message: { model: "claude-haiku-5-5", usage: { input_tokens: 9 } } }),
      rec({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 1, cache_read_input_tokens: 200000, cache_creation_input_tokens: 999 } } }),
      rec({ type: "user", message: { content: "now write the landing page" } }), // the current prompt
      "{ partial",
    ].join("\n")
  );
  const t = readTranscript(tp, "now write the landing page");
  assert.strictEqual(t.model, "claude-opus-5-5", "main model, not the subagent's");
  assert.strictEqual(t.ctx, 201000, "context = input + cache read + cache write of the latest main turn");
  assert.deepStrictEqual(t.recent, ["fix the login bug", "still broken on safari"], "typed messages only, current excluded");
  assert.strictEqual(readTranscript(path.join(dir, "missing.jsonl"), "x").ctx, 0, "no transcript is fine");

  const g = { clearAtTokens: 150000, compactAtTokens: 400000, newTaskMin: 0.8 };
  assert.strictEqual(guardWarning(100000, 0.99, g, 0), null, "small context: never warn");
  assert.strictEqual(guardWarning(200000, 0.9, g, 0).kind, "clear", "big context + new task");
  assert.strictEqual(guardWarning(200000, 0.3, g, 0), null, "big context, same task, under compact line");
  assert.strictEqual(guardWarning(200000, null, g, 0), null, "Jev unknown: no /clear guess");
  assert.strictEqual(guardWarning(450000, 0.3, g, 0).kind, "compact", "very big, same task");
  assert.strictEqual(guardWarning(480000, 0.3, g, 450000), null, "no repeat within 100K");
  assert.strictEqual(guardWarning(560000, 0.3, g, 450000).kind, "compact", "repeat after 100K more");
  assert.strictEqual(guardWarning(420000, 0.3, g, 700000).kind, "compact", "after /compact shrank it, warn again");


  // ---- Experiment: arms, turn cost rows, end-to-end route.js with a fake jev, analysis ----
  const { assignArm } = require("./jev-router/experiment.js");
  const exp = { enabled: true, routerControl: 0.5, guardControl: 0.25, salt: "t" };
  const N = 4000;
  let routerOff = 0;
  let guardOff = 0;
  let bothOff = 0;
  for (let i = 0; i < N; i++) {
    const a = assignArm("session-" + i, exp);
    assert.deepStrictEqual(a, assignArm("session-" + i, exp), "same session, same arm");
    if (!a.router) routerOff++;
    if (!a.guard) guardOff++;
    if (!a.router && !a.guard) bothOff++;
  }
  assert.ok(Math.abs(routerOff / N - 0.5) < 0.04, "router control share ~50%: " + routerOff / N);
  assert.ok(Math.abs(guardOff / N - 0.25) < 0.04, "guard control share ~25%: " + guardOff / N);
  assert.ok(Math.abs(bothOff / N - 0.125) < 0.03, "the two arms are independent: " + bothOff / N);
  const allOn = { experiment: false, router: true, guard: true };
  assert.deepStrictEqual(assignArm("x", { ...exp, enabled: false }), allOn, "switched off: everything on");
  assert.deepStrictEqual(assignArm("x", { ...exp, endsAt: "2020-01-01" }), allOn, "past endsAt: everything on");
  assert.deepStrictEqual(assignArm(null, exp), allOn, "no session id: everything on");
  assert.deepStrictEqual(assignArm("x", undefined), allOn, "no experiment config: everything on");

  // turn-log.js: one cost row for the last prompt, main session plus its own subagents only.
  const e = fs.mkdtempSync(path.join(os.tmpdir(), "jev exp test "));
  const now = new Date().toISOString();
  const tdir = path.join(e, "projects", "p");
  fs.mkdirSync(path.join(tdir, "s1", "subagents"), { recursive: true });
  const asst = (id, model, u, extra) => rec({ type: "assistant", timestamp: now, message: { id, model, usage: u }, ...extra });
  fs.writeFileSync(
    path.join(tdir, "s1.jsonl"),
    [
      rec({ type: "user", promptId: "P1", timestamp: now, message: { content: "first" } }),
      asst("m1", "claude-opus-5-5", { input_tokens: 5, output_tokens: 5 }),
      rec({ type: "user", promptId: "P2", timestamp: now, message: { content: "second" } }),
      asst("m2", "claude-opus-5-5", { input_tokens: 1000000, output_tokens: 100000 }),
      asst("m2", "claude-opus-5-5", { input_tokens: 1000000, output_tokens: 100000 }), // same message streamed twice
      asst("side", "claude-opus-5-5", { input_tokens: 9000000 }, { isSidechain: true }),
      rec({ type: "user", promptId: "P2", timestamp: now, message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] } }),
    ].join("\n")
  );
  const agentFile = (name, promptId) =>
    fs.writeFileSync(
      path.join(tdir, "s1", "subagents", name),
      rec({ promptId, timestamp: now, message: { id: name, model: "claude-haiku-5-5", usage: { input_tokens: 1000000 } } })
    );
  agentFile("agent-a.jsonl", "P2");
  agentFile("agent-b.jsonl", "P1"); // belongs to the earlier prompt
  const stop = spawnSync(process.execPath, [path.join(__dirname, "jev-router", "turn-log.js")], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: e },
    input: JSON.stringify({ session_id: "s1", transcript_path: path.join(tdir, "s1.jsonl"), cwd: e }),
    encoding: "utf8",
  });
  assert.strictEqual(stop.status, 0, stop.stderr);
  assert.strictEqual(stop.stdout, "", "a Stop hook prints nothing");
  const logRows = (d) =>
    fs.readFileSync(path.join(d, "jev-router", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const [cost] = logRows(e);
  assert.strictEqual(cost.promptId, "P2", "last prompt only");
  assert.strictEqual(cost.steps, 1, "a streamed message counts once, sidechain excluded");
  assert.strictEqual(cost.main, 6, "1M input at $4 + 100K output at $20");
  assert.strictEqual(cost.agents, 1, "only the subagent spawned for this prompt");
  assert.strictEqual(cost.agentCost, 0.1, "1M haiku input at $0.10");
  assert.strictEqual(cost.toolErrors, 1);
  assert.strictEqual(cost.partial, false);

  // route.js end to end with a stand-in jev: control sessions are sized and logged but not acted on.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "jev fake "));
  const answer =
    'const a=process.argv.slice(2);const u={input_tokens:1,output_tokens:1};' +
    'console.log(JSON.stringify(a[0]==="route"?{handler:"large",action:"auto",confidence:0.9,usage:u}:{answers:{new_task:{noul:0.95}},usage:u}));';
  if (process.platform === "win32") {
    fs.mkdirSync(path.join(fake, "node_modules", "jevctl", "dist"), { recursive: true });
    fs.writeFileSync(path.join(fake, "node_modules", "jevctl", "dist", "cli.js"), answer);
    fs.writeFileSync(path.join(fake, "jev.cmd"), "");
  } else {
    fs.writeFileSync(path.join(fake, "jev"), "#!/usr/bin/env node\n" + answer, { mode: 0o755 });
  }
  const bigTranscript = path.join(e, "big.jsonl");
  fs.writeFileSync(
    bigTranscript,
    [
      rec({ type: "user", message: { content: "fix the login bug" } }),
      rec({ type: "assistant", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 200000 } } }),
    ].join("\n")
  );
  const runRoute = (experiment) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev route test "));
    fs.mkdirSync(path.join(home, "jev-router"));
    for (const f of ["route.js", "experiment.js", "handlers.json", "state.json", "config.json"]) {
      fs.copyFileSync(path.join(__dirname, "jev-router", f), path.join(home, "jev-router", f));
    }
    const cfgPath = path.join(home, "jev-router", "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, "utf8")), experiment }));
    const r = spawnSync(process.execPath, [path.join(home, "jev-router", "route.js")], {
      env: { ...process.env, PATH: fake + path.delimiter + process.env.PATH, CLAUDE_CONFIG_DIR: home },
      input: JSON.stringify({
        session_id: "sess-1", cwd: home, prompt_id: "p-1", transcript_path: bigTranscript,
        prompt: "now rework the whole billing module and migrate the database",
      }),
      encoding: "utf8",
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const [row] = logRows(home);
    return { out: r.stdout ? JSON.parse(r.stdout) : {}, row };
  };
  const control = runRoute({ enabled: true, routerControl: 1, guardControl: 1, salt: "t" });
  assert.deepStrictEqual(control.out, {}, "control session: Claude is told nothing, the user is warned of nothing");
  assert.deepStrictEqual(control.row.arm, { router: false, guard: false });
  assert.strictEqual(control.row.skip, "control");
  assert.strictEqual(control.row.wouldModel, "opus", "what it would have delegated to is still logged");
  assert.strictEqual(control.row.guardWould, "clear", "the warning it would have shown is still logged");
  assert.strictEqual(control.row.guardShown, false);
  assert.ok(!control.row.delegated);
  const treated = runRoute({ enabled: true, routerControl: 0, guardControl: 0, salt: "t" });
  assert.ok(treated.out.hookSpecificOutput.additionalContext.includes('model: "opus"'), "treated session is told to delegate");
  assert.ok(treated.out.systemMessage.includes("/clear"), "treated session gets the warning");
  assert.strictEqual(treated.row.delegated, true);
  assert.strictEqual(treated.row.guardShown, true);
  const off = runRoute({ enabled: false });
  assert.strictEqual(off.row.experiment, false, "switch off: everything acts, and it says so in the log");
  assert.deepStrictEqual(off.row.arm, { router: true, guard: true });
  assert.ok(off.out.hookSpecificOutput && off.out.systemMessage);

  // analyze.js on a synthetic log where the router saves exactly $0.50 per message.
  const synth = [];
  for (let i = 0; i < 30; i++) {
    const arm = assignArm("syn-" + i, exp);
    for (let j = 0; j < 3; j++) {
      const k = { sessionId: "syn-" + i, promptId: "q" + j };
      synth.push({ t: "prompt", ts: now, ...k, experiment: true, arm: { router: arm.router, guard: arm.guard }, bucket: "large",
        ...(arm.router ? { delegated: true } : { skip: "control" }), guardWould: null, guardShown: false });
      synth.push({ t: "cost", ...k, main: arm.router ? 1 : 1.5, agentCost: 0, steps: 2, ctxSum: 1000, partial: false });
    }
  }
  const synthPath = path.join(e, "synth.jsonl");
  fs.writeFileSync(synthPath, synth.map(rec).join("\n"));
  const an = spawnSync(process.execPath, [path.join(__dirname, "analyze.js"), "--log", synthPath], { encoding: "utf8" });
  assert.strictEqual(an.status, 0, an.stderr);
  assert.ok(an.stdout.includes("control - treated: +$0.500"), "finds the planted $0.50 saving:\n" + an.stdout);
  for (const d of [e, fake]) fs.rmSync(d, { recursive: true, force: true });

  console.log("installer + context guard + experiment test: all checks passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
