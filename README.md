# jev-model-routing

A Claude Code add-on that sizes up every message you send and points Claude at a right-sized model for the job: **Haiku** for trivial tasks, **Sonnet** for everyday ones, **Opus** for large or risky ones. The sizing comes from TypeSafe's [Jev](https://docs.typesafe.ai) model and takes about half a second per message.

It's two Claude Code hooks plus a few small Node scripts. There are no npm dependencies besides the `jev` CLI.

```
you send a message
   │
   ▼  UserPromptSubmit hook → route.js → jev route  (~0.6 s, ~420 Jev tokens)
   │        "tiny" | "everyday" | "large" | unsure
   ▼
confident, mapped to a model, and not the model you're already running?
   ├─ no  → nothing happens; Claude answers normally
   └─ yes → Claude is told: "delegate this to a <haiku|sonnet|opus> subagent,
             end with '— done by <model>'; skip delegating if the message needs
             context a fresh subagent won't have"
   ▼
subagent finishes → SubagentStop hook → usage-collect.js
             records the subagent's real tokens and estimated cost per size
```

---

## Quick start

**You need:** Claude Code, Node.js 20.12 or newer, git (optional), and a TypeSafe API key from <https://console.typesafe.ai/settings/keys>.

```bash
# 1. Get the code (or on GitHub: Code → Download ZIP, then unzip)
git clone https://github.com/CharintornNillapat/jev-model-routing.git
cd jev-model-routing

# 2. Install the Jev CLI and store your key (it prompts with hidden input)
npm install -g jevctl
jev auth login

# 3. Install the router (copies files, registers the hooks, runs a live self-test)
node install.js
```

Then **restart Claude Code**, because hooks are loaded at startup. Type `/hooks` in a session to confirm both hooks are listed.

A successful install ends like this:

```text
Self-test (one real Jev call):
  ✓ sized as "tiny"; the hook would tell Claude to delegate to the tiny-size model
```

**Try it:** in any project, ask Claude something small, like `rename the variable foo to bar in utils.js`. The answer should end with **"— done by Haiku"**.

### Update

```bash
cd jev-model-routing && git pull && node install.js
```

This updates the scripts but keeps your own `config.json`, `handlers.json` and `state.json`.

### Uninstall

```bash
node install.js --uninstall
```

This removes only this router's two hooks (every other hook stays) and deletes `~/.claude/jev-router/`. Per-project stats files are left in place.

---

## Setting this up with an AI agent

Give your agent this prompt:

> Clone https://github.com/CharintornNillapat/jev-model-routing and set it up by following its README. Don't handle my API key: ask me to run `jev auth login` myself.

Rules for the agent:

1. **Never ask for, print, log or commit the TypeSafe key.** The user runs `jev auth login` themselves. In Claude Code they can type `! jev auth login`.
2. Use `node install.js`. Don't hand-edit `settings.json`. The installer backs it up first (`settings.json.jev-router-<time>.bak`), merges instead of replacing, and refuses to touch a `settings.json` that isn't valid JSON.
3. Report the installer's self-test output word for word, including any `✗` lines.
4. Tell the user to restart Claude Code.
5. Ask which model the user normally runs. The router already skips delegating to the model the session is using, but they may want to change `modelBySize` (see [Tuning](#tuning)).
6. Mention that message text is sent to TypeSafe for sizing (see [Privacy](#privacy)).

---

## Daily use

| Task | How |
| --- | --- |
| Turn off / on | Set `"enabled"` in `~/.claude/jev-router/state.json` to `false` or `true`. Takes effect on the next message. When off, the hook makes no Jev call and writes nothing. |
| See stats | From a project folder: `node ~/.claude/jev-router/status.js` |
| Re-check the setup | `node install.js --test` (one real Jev call) |
| Stats file | `<project>/.claude/jev-router-stats.json`. Add it to `.gitignore` (see [Privacy](#privacy)). |

What the stats mean:

| Field | Meaning |
| --- | --- |
| `counts.tiny / everyday / large` | Messages Jev sized confidently |
| `counts.self` | Jev was unsure or nothing fit, so Claude handled it normally |
| `counts.errors` | The Jev call failed or timed out. The message was still handled normally. Reasons are in `lastErrors`. |
| `skipped.same_model` | Sized confidently but not delegated, because the session already runs that model |
| `skipped.system_message` | Not a typed message (subagent hand-backs, notifications), so no Jev call was made |
| `actual_execution_usage.byTier` | Real subagent tokens and estimated $ per size, across all sessions in the project |
| `…byAgent[*].tier_match` | How each subagent was linked to a decision: `confirmed` / `prompt_id` (by the router), `hash_mismatch` / `unmatched` (Claude spawned it on its own) |

---

## Configuration

All settings live in `~/.claude/jev-router/`. On Windows that's `C:\Users\<you>\.claude\jev-router\`, or `$CLAUDE_CONFIG_DIR/jev-router` if you set that variable.

**`handlers.json`**: the size descriptions. These are the **only** thing Jev sees when it decides, so this is where you tune the routing.

**`config.json`**:

| Key | Default | Meaning |
| --- | --- | --- |
| `minConfidence` | `0.75` | Below this, Jev's answer counts as unsure and Claude handles the message normally |
| `timeoutMs` | `4000` | Hard cap on the Jev call. Keep it below the hook timeout (6 s). |
| `maxPromptChars` | `4000` | Longer messages are sized from their first 3,000 and last 1,000 characters, so big pastes aren't sent in full |
| `subagentType` | `"general-purpose"` | The Claude Code agent type to delegate to |
| `modelBySize` | haiku / sonnet / opus | Model per size. Set a size to `null` to never delegate it. |
| `modelLabel` | Haiku / Sonnet / Opus | Text for the "— done by …" footer and status output |

### Tuning

- **A message got the wrong size?** Edit `handlers.json` and put the rule that tells the sizes apart into the description (for example, add "anything touching production or money" to `large`). Check the result with:
  `echo "your message" | jev route --handlers-json "@$HOME/.claude/jev-router/handlers.json"`
- **Too much delegation?** Raise `minConfidence` to `0.85`, or set `everyday` to `null`.
- **Already on Opus?** Nothing to do: the router sees the session's model and never sends Opus work to an Opus subagent.

---

## What to expect

These numbers were measured on a real setup and are worth knowing before you rely on the cost figures:

- **Delegation is a suggestion.** Claude decides whether to follow it, and usually declines when the message builds on earlier conversation. In about 600 messages of real use, roughly 1 in 10 delegation suggestions led to a subagent.
- **Small tasks save little.** A live test renamed a variable with and without delegating to Haiku. The whole session cost $0.263 delegated and $0.268 not delegated. The Haiku subagent was cheap ($0.007), but the main session's own startup and wrap-up cost about the same either way. Savings grow with how much work the subagent does: many file reads, searches and edits.
- **`saved_vs_opus_usd` is an upper bound.** It prices the subagent's tokens at Opus rates. It doesn't subtract the main agent's extra turn, or the subagent re-reading context that the main session already had cached.
- The Jev call itself costs about 420 input and 46 output tokens per routed message.

---

## How it works

**`route.js`** (UserPromptSubmit) does the following:

1. Skips system-generated messages and very short ones.
2. Trims long messages.
3. Pipes the message to `jev route` on stdin, with no shell.
4. If Jev is confident, adds the delegation note as `additionalContext`.
5. Works out the session's model from the transcript's latest reply. Before the first reply it falls back to `ANTHROPIC_MODEL` or `settings.json` `"model"`. A message sized for the model already in use isn't delegated.
6. **Fails open.** Any error (offline, timeout, missing key) means the hook prints nothing and Claude behaves as if the router weren't installed. Each error is counted and its reason saved in `lastErrors`.

**`usage-collect.js`** (SubagentStop) reads subagent transcripts, totals their tokens (counting each message once), and prices them with the rate table at the top of the file. It links each subagent to its routing decision by prompt ID, confirmed with a hash of the prompt. Results are kept per agent across sessions, so totals cover the project's whole history.

**`install.js`** copies the files and adds the hooks in exec form (`"command": "node", "args": [path]`), so paths with spaces need no quoting. It never removes hooks it didn't add.

### Privacy

- Message text (trimmed to `maxPromptChars`) **is sent to TypeSafe's API** for sizing. Turn the router off (`state.json`) when you're working with anything that shouldn't leave your machine.
- Nothing is written to disk except a 16-character SHA-256 prefix of each delegated prompt, used for matching. For short, guessable prompts that prefix can be reversed by guessing, so keep `.claude/jev-router-stats.json` out of git.

### Security notes

- The `jev` CLI is found only through **absolute** `PATH` entries, and there's no fallback to a bare `jev` name. Hooks run inside your project folder, so this stops a cloned repository's own `jev.exe` from being run on every message.
- The prompt goes through stdin and every argument is passed as an array, so nothing is ever interpreted by a shell.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No *"jev-router: sizing up message…"* status line | Restart Claude Code. Check `/hooks`. Run `node install.js` again. |
| `errors` keeps rising | Run `node install.js --test`. It shows the last error. For `401`, run `jev auth login` again. If `jev` works in a terminal but not in hooks, add `"env": {"TYPESAFE_API_KEY": "..."}` to `~/.claude/settings.json`, and never commit that file. |
| `jev not found on PATH` in `lastErrors` | `npm install -g jevctl`. Claude Code needs to inherit the PATH that contains it. |
| Everything lands in `self` | The size descriptions don't fit your messages, or `minConfidence` is too high. Test with the `jev route` command under [Tuning](#tuning). |
| Delegation note appears but Claude doesn't delegate | That's expected sometimes (see [What to expect](#what-to-expect)) |
| Your Claude Code rejects the `args` hook field | An older version. Update Claude Code, or change each hook to `"command": "node \"/full/path/to/route.js\""`. |

---

## Files

```
install.js            install / update / --test / --uninstall
test.js               offline installer check: node test.js
jev-router/
  route.js            UserPromptSubmit hook: sizes the message, suggests delegation
  usage-collect.js    SubagentStop hook: real subagent tokens and estimated cost
  status.js           prints this project's stats
  config.json         thresholds and model per size (kept on update)
  handlers.json       size descriptions Jev decides from (kept on update)
  state.json          on/off switch (kept on update)
```

Optional extra: the [jev Claude Code plugin](https://github.com/Nasrallah-AL/jev-cli) (`claude plugin marketplace add Nasrallah-AL/jev-cli`, then `claude plugin install jev@jev-cli`) adds `/jev:*` commands for fact-checking, prompt-injection screening and more. The router doesn't need it.
