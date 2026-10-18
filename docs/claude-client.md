# The Claude client

How the Claude Max backend finds, checks and runs the Claude client the person installed.
The backend's design is `docs/architecture.md` §16.1; the sign-in rules are below, and the renewal and model probes are `docs/claude-renew-probe.md` and `docs/claude-model-probe.md`.

## Notes

`claudeEnvFor` leaves `CLAUDE_CONFIG_DIR` unset: setting it at all, even to `~/.claude`, selects a differently named Keychain item rather than the machine's default login (CD-1=B, captain, 2026-09-10).

`runClaude` uses piped stdin, stdout and stderr, with no terminal or PTY.
For sign-in, `claudeAuth.ts` lets the client open the browser.
The app does not open that page again on its own; the person can, and can paste a code the page shows or cancel, and a second sign-in adopts a login the first one already saved.
When that sign-in ends with no reason, the person is told Claude failed, and to run /login in the Claude Code CLI, whose saved login the first mate then uses.

Never let a test or probe start a real Claude sign-in.
The sign-in leg of `claudeLoginProbe.test.ts` is opt-in with `INFINITARY_CLAUDE_LOGIN_PROBE=1` and stubs the platform opener even then; no test asks a person to authorize a sign-in.

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Every `@anthropic-ai/*` import stays behind `src/core/claude/`, the same fence Pi has (Biome `noRestrictedImports`).
  The Claude client is the one the person INSTALLED (F14, captain lock 2026-09-20: "assume / require the user has already installed claude code cli"): the app ships no copy and downloads none - `electron-builder.yml` `files` excludes the SDK's platform packages (one ~300 MB binary each), `tests/release-contract.test.ts` pins the exclusion and `scripts/verify-app.sh` fails a bundle that carries one.
  `resolveClaudeExecutable` (`src/core/claude/claudeCli.ts`) finds the installed client at the installers' known homes (`~/.local/bin/claude` first, the native installer's symlink that survives its own updates), then on `PATH`, then through one bounded login-shell lookup (`primeClaudeExecutable`) - never through the SDK's copy in `node_modules`.
  `checkClaudeClient` reads `claude --version` and holds it to the SDK's co-released client version, read off the SDK's own `manifest.json`; a missing or too-old client is stamped on the account's health as `client_missing` / `client_outdated` with the one sentence the row and the chip show (`src/shared/claudeClient.ts`) - the credential is still never a sign-out, but the account serves no model and a spawn refuses.
  `INFINITARY_CLAUDE_CLI` overrides the path (a missing override path is "no client", never a fallback); `tests/e2e/launch.ts` gives EVERY e2e run `tests/e2e/mockClaudeClient.ts` unless the spec names its own, so a developer's real client is never spawned by a test.
  A spec that asks for `claudeTurns` gets the stub's turn mode: a session that runs turns goes to the SDK's own co-released client from `node_modules`, boxed into the run's throwaway HOME with a dummy key and the mock provider's address (`docs/e2e-contracts.md` "Claude turns").
  That copy is the test harness's, never the app's.
  `verify.yml` installs today's native client and runs `claudeToolSurface.test.ts` against it; on a runner with no client that test lets the SDK spawn its own copy.
  **The client TRUNCATES a tool description at 2,048 characters and drops every nested parameter description**.
  It also transliterates non-ASCII in one.
  `CLAUDE_TOOL_DESCRIPTION_CAP` and `claudeToolSurface.test.ts` are the guard - every app description under the cap (the census reads the first mate's live set through `claudeToolsOf`: `FIRSTMATE_TOOLS` in `src/core/session/tools.ts` names 23, and the seat also serves `emote`, so the live set is 24, beside every crewmate tool), and what the real client sends equal to the source, captured against a local stub with a dummy key, for a crewmate's server and for the first mate's set on the same in-process server shape - so a rule that must reach a Claude crewmate or the first mate on Claude lives in the description or a TOP-LEVEL parameter, never only a nested one.
  Since contract v4.13 (W1 S2) the first mate's capture holds every parameter description the source declares to the served request, so a rule left only in a nested description fails it: `spawn_crewmate`'s `shape` and `start_after` rules ride each group's own description under the field's name, and `constraints[]`' ride the array's.
  Since contract v4.59 no app tool describes a nested parameter at all: `emit_card`'s nested words were a restatement for Pi, and the test names where each nested field's rule is served instead - `CARD_MECHANICS` or the top-level `actions` description.
  A fixed choice is one string with an `enum` (`stringEnum`), which `zodOf` reads as the same closed set.
  A two-member union with null carries that same typed value as nullable, preserving its validation on both runtimes.
  The 2,048-character cap is on a TOOL description only: a top-level parameter description arrives whole (`spawn_crewmate`'s `shape` group, 2,545 characters, is served byte for byte, and the capture holds it), so a group's rules are never trimmed to fit a cap that does not apply to them.
  The crewmate's fixed instructions, for each runtime and kind of work, are measured in `tests/crewmate-fixed-context.test.ts`, which names each tool's headroom when a description would meet the cap.
  Two more things that binary taught us the expensive way (captain dogfood, packaged build, 2026-09-01):
  - **Never spawn a path inside app.asar.**
    `child_process.spawn` cannot execute one (only `execFile` is asar-aware), and Electron's asar shim answers `fs.existsSync` for it - so the obvious check passes and the spawn fails ENOTDIR.
    `resolveClaudeExecutable` (`src/core/claude/claudeCli.ts`) still maps an in-archive override to the `app.asar.unpacked` copy and returns only a file really on disk, though no client ships in the archive any more; the trees `asarUnpack` names now are koffi's native addons, said out loud instead of leaning on smart-unpack, and `tests/release-contract.test.ts` pins them.
    Any future vendored binary needs the same treatment.
  - **The machine's default Claude login is the authority on whether it is signed in, not the client probe.**
    Every way a spawned third-party binary can fail looks identical to `loggedIn: false`, and the vault turns that into a red badge, a sign-in card AND the removal of every one of the provider's models from the routing pool (`availableModelsByAccount` gates non-Pi backends on `connected === true`).
    So `ClaudeAuthBackend.status` falls back to `readClaudeCredentialEvidence` (`claudeQuota.ts` - file parse in `~/.claude`, else a host Keychain ATTRIBUTE probe of the bare `Claude Code-credentials` item that never spends the one macOS ask): only an absent credential or a lapsed *refresh* token is a sign-out.
    A file that cannot be read is not absent, and a lapsed file does not hide a present Keychain item.
    A client that answers signed in is a login, including over that lapsed file.
    Connect asks the client before it treats a lookup miss as a sign-out, on the store lease it already holds, and reads the store again after the wait.
    An expired access token is renewable, and an unreadable store is `unknown`, never a sign-out.
- **A crewmate's tools come from one spec (primitives P7, contract v4.12).**
  Every app-owned crewmate tool - `emit_card`, `close_card`, `file_followup`, `note_progress`, `report`, `reply`, `tasks`, `lint_panel`, `capture_panel`, `open_change`, `check_change`, `read_workflow`, `download_artifact`, `github_read` and `github_write` - is ONE entry (name, description, typebox parameters, run) in `CREWMATE_TOOLS` (`src/core/pi/crewmateTaskTools.ts`; the entry type and the rest of the runtime-neutral spec are `src/core/session/tools.ts`).
  The crewmate preset (`crewmateSessionSpec`) binds the entries to the crewmate's callbacks, and each session generates its own tools from the bound list: Pi's with `piToolsOf` (`src/core/pi/toolSpec.ts`), Claude's tool server with `claudeToolServer` (`src/core/claude/claudeTaskTools.ts`), which turns the same JSON Schema into zod and REFUSES a parameter kind it cannot carry rather than serving a looser schema.
  Claude passes an optional give-up signal to `ToolRun` only when the SDK handler's `extra.signal` aborts with the typed MCP `RequestTimeout` code.
  Ordinary home-stopped Claude turns and Pi turn cancellations do not withdraw a pending request; it can still receive its real answer.
  A conversation on a work computer scopes the give-up signal to the invocation and combines it with its own callback deadline.
  Background completion-refusal records run outside that invocation's scope, so a cancelled card still leaves its refusal on the home.
  There are no hand-written Claude twins any more, so a rule reaches both runtimes in one edit and the self-source map lists the same set (`crewmateTools`).
  A tool is served only when the crewmate's delegate hands the callback it runs on.
  `prepare_change` shares this spec: on a paired computer, `inf:work:prepare-change` transfers inspected media to the home behind `CHANGE_PRESENTATIONS_SINCE` (`docs/forge.md`, "Saved change stories").
  The task's browser is no tool: the client's own shell carries the task's command, `infinitary-browser-axi`, in its environment (`docs/axi-commands.md`).
  `crewmateTaskTools.test.ts` holds both runtimes to the spec by what they serve and do, and shows that a new entry reaches both and the pin; `claudeToolSurface.test.ts` still captures what the real client sends.
  The transport rules above still bind every entry: the description under the cap, ASCII only, and a rule a Claude crewmate must see in the description or a top-level parameter's description.
  The first mate's live set is on the same spec: `FIRSTMATE_TOOLS` names 23, the seat also serves `emote`, and `claudeToolsOf` generates a Claude seat's set from the very list the Pi seat is served (the Claude seat below serves exactly that list).
- **A Claude outcome is read from typed fields, never from words (W1 S3).**
  The normalizer (`src/core/claude/claudeEvents.ts`) collects each turn's typed signals - the turn's own (main-thread) assistant message's `error` (`SDKAssistantMessageError`; a subagent's is not the turn's), the latest pushed rate-limit `status` and `resetsAt`, and the result's `subtype`, `is_error` and `api_error_status` - and `classifyClaudeSignal` (`src/shared/authFailure.ts`) turns them into `ok`, an ordinary failed turn, or a cut-off with its class (`docs/quota.md` "Typed cut-offs").
  An `error_*` result (`error_max_turns`, `error_during_execution`, ...) is a failed turn in the session's own words (its `errors`), never a clean one - except the cut a steer or an interrupt makes: a result whose typed `terminal_reason` is `aborted_streaming` / `aborted_tools` with no API error behind it is not a failure, and while the host's own interrupt is in flight a failure with no cut-off class settles as that interrupt.
  The failed turn is a `turn_failed` carrying `cutOff` when there is one, and so is a failed continuation, ahead of its `continuation_ended`.
  `CLAUDE_CONTROL_PROFILE` declares `failureSignals: "typed"`, so the supervisor reads a Claude failure by its class alone and never runs `isAuthFailureMessage` over its words; a failure with no class, or a client that exits, is never a sign-in.
  The pushed `resetsAt` is epoch SECONDS on the wire and ms everywhere past the normalizer.
  Every session runs with `strictMcpConfig: true`, and so does the model-catalog run (`listClaudeModels`), so only the app's own tool server mounts: the person's claude.ai connectors, plugins and project `.mcp.json` never reach a crewmate.
  The feed line for a Claude failure is picked by its class too (`docs/quota.md` "Typed cut-offs").
- **No session reads or writes the person's Claude notes (FI3-795).**
  The client's auto memory keeps notes per project in the person's Claude folder, under `projects/<the working copy's main checkout>/memory/` with `MEMORY.md` as their index.
  Left on, it serves that index to every session started there, and on the installed 2.1.288 the coding preset also tells the model where the folder is and to write more.
  `settingSources: []` does not reach it: on the installed 2.1.288 and the SDK's 2.1.234, a boxed crewmate, seat and question were each served a planted index.
  On 2.1.288 every crewmate worktree of a project uses its main checkout's folder, so Claude crewmates read and added to one shared set of notes in the person's Claude folder that no Pi crewmate ever saw.
  So every session the app opens sets the client's documented switch, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`CLAUDE_SESSION_ENV` in `src/core/claude/session.ts`), over any value the host's shell has.
  The app keeps no notes of its own in their place: what a project's agents should know lives in its committed instructions (`AGENTS.md`), which every crewmate reads whatever its runtime.
  The switch leaves the person's existing notes on disk untouched.
  `claudeAutoMemory.integration.test.ts` holds it on the client the product would run, with a control that serves the planted index once the switch is taken out.
- **One Claude session, three presets (the session contract, `docs/architecture.md` §2).**
  `createClaudeSessionFactory` (`src/core/claude/session.ts`) is the one Claude implementation of the session contract (`src/core/session/`), and every role opens it through its own preset: the seat's rolling spec (`seatSessionSpec`), the crewmate's rolling spec with the coding built-ins (`crewmateSessionSpec`), and the question's one-shot (`questionSessionSpec`).
  The factory never sees a role name; what differs is only what the spec carries.
  The three bullets below are those three presets.
- **The first mate seat on Claude (W1 S6; live since the flip, S12, `docs/architecture.md` rev-9).**
  `createClaudeSessionFactory` (`src/core/claude/session.ts`) serves the seat preset's rolling spec (`seatSessionSpec`) behind the seat seam (`docs/architecture.md` §2); the composition root injects it beside Pi's (`src/core/services.ts`), with the machine's default config dir, the host's ticker and the account's quota readings, and the spec's record dir names the app's transcript store under `userData/firstmate/claude/`.
  A Claude account seats the first mate once the captain picks a Claude model, or when Claude is the only subscription that can answer.
  `tests/e2e/claude-seat.spec.ts` (a captain turn answered with a card, a spawn, a mid-turn steer, the picker) and `claude-seat-cutoff.spec.ts` (a 401, a 429 with its reset and a 403 organisation refusal, each on its own card with the words kept; "Try Claude again"; a new sign-in) run it end to end on the SDK's own client against the mock provider (`tests/e2e/claudeSeat.ts`).
  It stands on the crewmate's core (`claudeQueryCore.ts`: the input queue, the user message, the pump that normalizes and routes each result) and its options are the rolling branch of one pinned function, `claudeSessionOptions`, read off the spec: the default login and nothing ambient (`claudeEnvFor`), `settingSources: []`, the prompt as `[buildFirstmateSystemPrompt(), SYSTEM_PROMPT_DYNAMIC_BOUNDARY, instructions]`, `tools: []` with the live set of 25 always-loaded on the app's server and `strictMcpConfig`, `bypassPermissions`, partial messages, `effort: "low"`, `maxTurns: 40` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192` from the seat's request bounds, the binding's model, `resume` or the minted `sessionId`, `--replay-user-messages`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`CLAUDE_SESSION_ENV`, above), `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` and `MAX_MCP_OUTPUT_TOKENS=100000` (`CLAUDE_SEAT_ENV`, below).
  The seat session keeps these rules, held by `claudeFirstmateSession.integration.test.ts`:
  - **A steer rides `priority: "next"`.**
    Pushed while a tool runs, `next` folds the message into the running turn after the tool's result and the exchange ends in one result - Pi's steer.
    `now` aborts the tool in flight (the model reads an error for it) and answers in a second turn; `later` waits for the turn to end.
    The integration test measures all three on every run and pins the choice.
    The measurement uses three turns on one rolling client and one uninterrupted output consumer, waiting for idle between them; cold starts are not the priority behavior being measured.
    Each named case owns its API server.
    The shared seat box owns every session it opens, registered tool gates and transcript watchers, and raw-query drains: `seatBoxesFlushed` aborts abandoned work, disposes sessions, advances their existing client-hygiene clock, awaits exits and consumers, then flushes sidecars and removes scratch homes and client folders before the next case.
    A real-client regression abandons an inference and a held tool at that boundary and checks that their requests, leases and homes are gone.
    `INFINITARY_CLAUDE_SEAT_EVIDENCE=1 pnpm exec vitest run src/core/claude/claudeFirstmateSession.integration.test.ts` prints credential-free request and transcript evidence for output caps, priority and cleanup.
  - **A prompt settles when the client says it is idle** (`session_state_changed: idle`, emitted once every queued turn is done, which the environment variable turns on), not on a result: a steer answered in a turn of its own still settles the prompt once.
    A client that never reports its state settles on the result that follows the last acknowledged message.
  - **Every pushed message carries a uuid**, and the client acknowledges each by it (`isReplay`) as a turn takes it in.
    A steer that no turn took in (it arrived while nothing ran, or the client exited first) goes back through `takeUndeliveredSteers`.
  - **Effort per turn** is `applyFlagSettings({effortLevel})` before the prompt; it reaches the very next request, mid-turn included.
    A mid-turn instruction change is refused.
    A resumed client serves the system prompt it recorded when the session started (its `prompt_snapshot`, measured on the installed 2.1.283), not the one it is handed, so a seat never resumes on a changed prompt array: at every reattach - an idle-boundary `serveInstructions` and an open with `resume` - the session compares the array it would serve (the prompt, instructions and tool shas) with the contract its client started under (the newest `contract` stamp in `<id>.served.jsonl` before its first `served` one), and when they differ and the client has recorded the session it starts a new session under a new id with the new array rather than resuming.
    It says so once (`takeRenewal`), and the first mate carries it as a seat move (`docs/architecture.md` §16): a `seat renewed` ledger row naming what changed, the `seat-moved` wake with the bounded digest of the turns the new session has not seen, on the turn about to be served, and a feed line.
    Unchanged instructions keep resuming the same id, and the app's copy of the old session stays.
    The client records each tool's description there too (measured on the installed 2.1.295): on resume a tool the session had keeps its recorded words, a tool it lacked arrives as it is now, and a tool gone is gone.
    Both roles' stamps name each tool's own sha (the seat's `firstmateContractStamp`, a crewmate's below), so a session also starts over when a tool it had is described differently, and an update that only rewords a first mate tool moves the seat as a changed prompt does.
    A seat started before its stamp named each tool has only the whole tool surface's sha to compare, and starts over when that moved.
    The seat's tools are described the same at every open of one build (nothing a description or schema says depends on the app's state), so a relaunch of the same build resumes.
    A recorded session with no contract stamped before its first prompt started under one nothing vouches for, and starts over too.
    The integration test holds all four on the installed client (the SDK's own on a machine without one): the reopen, the unchanged resume, the change found at open, and a reworded tool found at open.
  - **Tool names** arrive as `mcp__infinitary__<name>`; the seat reports the bare name, as the Pi seat does.
  - **The runaway bounds ride the one clock**, kept by the one watcher both backends share (`src/core/session/bounds.ts`, its own `session-bounds` registration): the 300-second per-inference bound (restarted at every request - the session says `request_started` at each `message_start` - and at the last tool's end, stopped while a tool runs) and the 20-minute turn backstop cut the turn with `abort(failure)`, which interrupts the client and fails the turn with the bound's sentence.
    Once the interrupted result lands, both clocks start again: a steer the client still holds is answered in a turn of its own under its own bounds, and a bound that fires on that turn is reported as the first was.
    The session's own `claude-sessions` registration keeps the client's hygiene: a client that does not answer that interrupt within a tick is stopped and the turn fails anyway, as is a client still running a tick after its input ended.
    The output cap (measured on 2.1.234 and 2.1.283): the client serves it as every request's `max_tokens` with the model's thinking inside it (adaptive on Fable, Opus and Sonnet; a budget one below the cap on Haiku 4.5), and asks an answer that runs past it to carry on three times before it fails the turn with a typed `max_output_tokens` error, which the seat reports as "Answer kept running past the 8192-token limit" rather than the client's own words (`docs/firstmate-runaway-hardening.md`).
  - **Quota and usage**: a pushed plan reading goes to `onRateLimit(accountId, reading)`, the factory's one quota wiring for every role; each result's usage is its delta over that client's running total (a reattached client counts from zero again), recorded by the agent under `taskId: "firstmate"`.
    `checkClaudeClient` runs at the seat's create and again at every client attach inside it, before that client's store lease is taken, so a client removed between turns fails the turn with its sentence.
  - **The lease** (`acquireSessionLease`) is per client: each attach takes it (waiting out a sign-in in progress) before the client is spawned, and it is handed back when that client has EXITED - not when a dispose returns, because the client writes the last of its transcript as it exits and can refresh its login until then.
    A dispose or a detach ends the client's input and lets it exit on its own; a client still running a tick later is stopped.
    Between clients nothing is leased, so the status probe and a delegated renewal are not stood down for nothing.
    An attach can outlive its prompt (the bounds give up on a prompt whose attach still waits behind a sign-in), so after each wait it checks that its prompt is still the open one and spawns nothing otherwise - no orphaned client holds the store behind a later attach, a detach or a dispose.
    Each new client also starts the normalizer over: its usage counts from zero, and nothing the last client pushed classifies its first turn.
    `detach()` (on the session contract) ends the client at an idle boundary - after the open prompt settles, never mid-turn - and resolves once the store is free; the next prompt reattaches and resumes.
    The agent calls it while the seat is paused on a cut-off, and before a sign-in or sign-out rewrites the bound account's store (`AccountVault`'s `holdSeat` → `FirstmateAgent.holdSeatFor`, which also keeps the seat off that account until the rewrite ends; `docs/architecture.md` §16.8).
    `closed()` resolves once a disposed seat's client has exited.
  - **The record.**
    The client writes its transcript on its own schedule (at `idle` its file can still be empty; the rest lands a moment later, and on exit).
    The session copies it into the app's store (`SessionRecordStore`, `src/core/storage/sessionRecordStore.ts`; the seat's is `userData/firstmate/claude/<id>.jsonl`, byte for byte, never spliced when the client's file stops extending the copy) at every boundary where it can grow: idle, reattach, exit, each host tick while its client is attached, and a copy order's refresh from the home (`docs/helper.md`, "The record's copy").
    A pass reads only what the copy gained (the tail it compares is read in place), and the copy's parsed entries are kept and extended rather than re-read at each turn.
    Beside it, `<id>.served.jsonl` stamps the contract (version, prompt, instructions, tools shas) and each prompt's acknowledged uuids (`docs/provenance-capture.md`).
    A resume reads the client's own transcript; an id it has none for (a crash before the first turn, or the client's 30-day sweep) starts fresh under a new id, and the app's copy of the old session stays.
    The Settings purge removes that copy with the rest of the first mate's transcripts (`docs/task-retention.md`); the client's own file is not the app's to delete.
  - **Not the SDK's session store.**
    `Options.sessionStore` (`@alpha`) mirrors fine, but resuming from it makes the SDK itself read the person's Claude credential (`security find-generic-password` on the default Keychain item, or `.credentials.json`), write it into a temporary config dir without its refresh token, and run the client there - the app never reads a provider token, and a client without its refresh token cannot renew mid-session.
    So the seat takes the plan's fallback, the copy above.
    (The SDK also drops every mirror frame from a client whose config dir differs from its own idea of it, silently.)
  - **The dynamic boundary** reaches a non-first-party base URL as literal text (`...prompt\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n\ninstructions`, measured against the stub with both a key and a subscription token); whether the first-party API splits it there is unmeasured.
  - **What the client adds to the seat.**
    Beside the app's prompt, tools and the captain's words, the client adds attachments of its own, recorded in its transcript and served to the model.
    One documented switch reaches part of it: `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` (the vendor's environment-variable reference: "disable attachment processing") turns off the client's per-turn extras, and the seat sets it (`CLAUDE_SEAT_ENV`).
    That keeps out `silent_turn_reminder` ("The user hasn't heard from you in a while ...", served into a run of tool calls without a word) and `total_tokens_reminder` (a token countdown after every request); the first mate's turn ends with brief output by contract and the captain hears it only through the app, so neither is the seat's to receive.
    Queued steers still arrive.
    A crewmate's coding session keeps the extras.
    What no documented switch removes is served once at the start of every client attachment, and is the accepted exposure:
    - `environment`: the seat's working directory (the app's first mate home, under the person's user folder, so it names their account on the machine), whether it is a git repository or worktree, the platform, the shell and the OS version.
    - `session_context`: the signed-in Claude account's email address, with the client's instruction to use it only to identify the person.
    - `model`: the served model's name, id and knowledge cutoff.
    - `date`: today's date.
    - `prompt_snapshot`: the client's own record of the system prompt it served, which is the app's.

    Accepted because each goes only to Anthropic, the provider the person signed in to, which already holds all of it from the login and the request itself; none of it is a credential; and none of it asks the first mate to do anything.
    The switches that would remove it cannot be used: `--bare` (`CLAUDE_CODE_SIMPLE`) is the documented mode that trims them, but it never reads the OAuth login, and the app serves only the person's own login (F14).
    `excludeDynamicSections` moves the working directory rather than removing it and applies only to the preset prompt, which the seat does not use.
    `claudeToolSurface.test.ts` holds the set on the client the product runs (`verify.yml` points it at today's native install): the seat's session on the boxed client, with a made-up account email and a quiet run of tool calls, may carry only the attachment types above, `environment` only the fields above and `session_context` only the email, so a client that adds one fails there instead of reaching the first mate unseen.
  - **Hermetic runs** box the SDK's co-released client with the e2e stub's turn mode and `credential: "subscription"` (a dummy subscription token, with which the client pushes plan readings a key never gets) against a local stub of the Messages API (`tests/helpers/anthropicDialect.ts`): a 401 classifies `signed_out`, a 429 with `rejected` unified headers `no_headroom` with its reset (the client pushes the `rejected` reading before it reports the error), a 403 organisation refusal (`oauth_org_not_allowed`) `refused`.
    `claudeFirstmateSeat.live.test.ts` runs the same seat on the machine's own login, only with `INFINITARY_CLAUDE_SEAT_LIVE=1`, never in CI, and never starts a sign-in.
- **The crewmate on Claude (the session contract's step 5).**
  A crewmate's coding session is the seat's rolling session with the coding built-ins (`src/core/claude/session.ts`; there is no second Claude coding path): the client's own `claude_code` preset with the crewmate's instructions appended, every one of the client's own tools beside the app's tool server, and the effort `claudeCodingReasoning` opens at.
  A recognized Opus, Sonnet, Fable or Haiku 5.5 model is served a coding rung (`effort` on the query); legacy Haiku and an unknown model omit `effort` and keep the client's own, and a coding session does not serve `thinking`.
  Its Agent tool offers the client's own agents and any an administrator put in the machine's managed Claude folder, never the person's own: `settingSources: []` reads no definition from `~/.claude/agents`, the working copy's `.claude/agents` or a folder above it (`claudeCrewAgents.integration.test.ts`).
  It carries its working copy's own instructions and skills, the same ones a Pi crewmate is served (`src/core/session/projectResources.ts`, FI3-789), without turning the client's project settings source on: that source also applies the project's `.claude/settings.json` (its hooks, permission rules - a switch there can turn the session's permission bypass off, and no app-supplied layer turns it back on - environment, credential helpers and output style) and every instruction file in the folders above the working copy, the person's own `~/.claude/CLAUDE.md` and `~/.claude/skills` among them when the working copy sits under their home.
  So each attach reads the working copy's AGENTS.md (or its CLAUDE.md where it has none) into the appended prompt, framed as Pi frames its own, and stages its `.claude/skills` and `.agents/skills` folders as a local plugin named `project` in the session's record dir (`claudeProjectResources.ts`): a manifest and one link per skill folder, which the client lists as `project:<skill>` and loads with its Skill tool.
  Every coding session passes the client's attribution setting with empty text, `settings: { attribution: { commit: "", pr: "" } }` (`CLAUDE_CODING_SETTINGS`), so the client never tells the model to end a commit message with a `Co-Authored-By` trailer or a pull request description with a "Generated with Claude Code" line (the captain, 2026-10-15: "disable commit and PR author attribution for all claude crewmates in infinitary (it's a claude setting)").
  It rides the client's flag settings layer, which `settingSources: []` leaves on, so the person's own Claude settings stay unread.
  `claudeAttribution.integration.test.ts` holds it on the client the product would run, with a control that serves both lines once the setting is taken out.
  With a plugin staged the same settings also carry `disableAllHooks: true`, so a hook a skill declares never runs.
  With Global instructions and skills on, each attach also reads this Mac's global instructions and stages its personal skills as a second local plugin named `personal`; project names win, settings sources stay empty, hooks stay disabled and strict MCP stays on (`docs/personal-resources.md`).
  The client resumes a session on the prompt it recorded at its start, so a project instruction file changed mid-task reaches a Claude crewmate's next fresh session, while the skills are staged afresh at every attach.
  A reopened crewmate with changed personal resource digests or opt-in renews its conversation through the existing renewal seam, keeping the old record, so it never resumes with stale personal instructions.
  So does a crewmate reopened by a build whose crewmate prompt, or the description of a tool it had, changed, and one recorded before crewmates were stamped, so it never runs this build's tools under an earlier build's words; a tool its task only gained or lost resumes, since the client serves the set it is handed (`claudeCrewContract.integration.test.ts`).
  The supervisor notes the move on the task's timeline and records the new conversation at once.
  Why, the task's key, where the earlier transcript is saved and the brief its first turn served are a once-named wake on the task's lane (`conversation-restart`, rendered by `renderWake` from `crewmateRestartText`).
  The turn that brings the crewmate back serves that wake first, so the reason rides the same message, and a quit before that turn ends clean still delivers it.
  A conversation that could not be reopened at all is carried the same way.
  A conversation on a computer that runs work is carried the same way whether the home opens it there or reopens it after that computer restarted (`docs/helper.md`, "That computer restarts").
  `claudeProjectResources.integration.test.ts` holds this on the SDK's own client, boxed, with a working copy under the box's HOME.
  It shares every rule above - the `next` steer that folds after the tool in flight, the idle settle, uuid acknowledgements and `takeUndeliveredSteers`, the lease per client attach (nothing is leased before the first prompt), the resume that starts fresh under a new id when the client has no transcript for the old one, and bare tool names.
  Its record is the app's copy too, in its task's `crewmates/<taskId>/sessions/` beside a Pi crewmate's file, with a sidecar of served stamps and the crewmate's contract (the session contract's step 6): the prompt exactly as served, the tool surface and each tool's own sha (`crewmateContractStamp`).
  Its client stays attached between prompts, so the tail the client writes after a turn's `idle` is copied on the host's next tick rather than at an exit.
  What only a coding session meets, held by `claudeSession.integration.test.ts`: a command the model started in the background finishes after the prompt's turn, and the client then runs a turn of its own, announced by the same `running` and `idle` a prompt's turn has.
  The session reports that turn as `continuation_started` and `continuation_ended` from those two signals alone, never from guessing at activity; a steer sent meanwhile joins it, and a continuation the provider failed is a `turn_failed` like a prompt's.
  The supervisor re-parks a steer no turn took in on either backend (`docs/inbox.md`).
  A turn's tokens and cost arrive only in its `result`, and an interrupted turn's `result` lands after `abort()` returns (the interrupt's round trip is all it awaits).
  So every teardown that lets go of a crewmate mid-turn - a close (`closeTask`: an answered card, a confirmed discard, a parent retiring its reviewer), an escalation, the retention purge, the quit - hands the session to a usage-only listener (`CrewSupervisor.releaseSession`) until `closed()`, and the cut turn lands in `usage_events` once; the task's own subscriber is gone, so the closed task's state and feed are untouched.
  The quit waits at most `QUIT_SETTLE_MS` (2 s) for those turns; The close/quit integration fixture waits for the foreground command's own ready marker, not `tool_start`: that announcement can precede the request's trailing usage events, and interrupting there can produce a zero-usage result before the command ran.
  The fixture holds those trailing events until the announcement, then completes the request and waits for the marker before cutting the turn.
  A crash, or a client that does not answer, still loses that turn's usage.
- **The model that answers (FI3-967).**
  A rolling session asks every attachment for one model: the spec's, else the model a resumed session ran on before the client swapped it, else the first one the client reported.
  It reports the model the client says answers (`modelRef`, and so a card's model chip): the `init` message's model, and Claude Code's `model_refusal_fallback` notice when the model it asked for refused a reply and the client answered on another for the rest of the session.
  A notice with `scope: local` is a subagent's or side question's answer alone and moves nothing; one with no scope comes from an older client and means the session's.
  The client's own marks (`[1m]`, a dated snapshot) name the same model (`canonicalClaudeModelId`).
  Each change reaches the owner as the owner-only `model_served`, with the notice's original model and the provider's category (`cyber`).
  The supervisor writes the model onto the task record whenever it is not the one the record names (`CrewSupervisor.recordServedModel`), so the merge card's fact strip, the crew's labels and the task's own fact strip name the model doing the work, and a note on the timeline and the feed says what moved it; the routing ledger keeps the router's decision.
  A reattach asks for the model the session was asked for, never the one the client swapped in.
  So does a resume that names no model: the client (2.1.289) restores a resumed session's last model and keeps a fallback it finds in the transcript, so the session reads the first session-wide fallback in the app's copy and asks for its original model.
  The client books a fallback's retry under the model that answered it, so that turn's usage has a row per model (`docs/usage.md`).
  The app leaves the client's fallback as the client ships it: it passes no fallback model and does not set `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`.
- **The kind classifier on Claude (W1 S10).**
  `createClaudeSessionFactory` (`src/core/claude/session.ts`) is Claude's `SessionFactory` on the one session contract (`src/core/session/`), and for the question it serves the one-shot shape: the question's session (`questionSessionSpec`), the adapted decision model's session for a Claude-served model (`docs/decision-models.md`).
  A machine with only Claude signed in classifies work on it.
  Since the contract's step 3 it also serves the rolling shape, the seat's (above), and since step 5 the crewmate's coding session on that same rolling shape (above); a one-shot spec that asks for the coding built-ins is refused.
  It stands on the same core and makes ONE query, its options one pinned function read off the spec (`claudeSessionOptions`): the default login and nothing ambient (`claudeEnvFor`), `settingSources: []` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, the question's instruction as the only system prompt the app supplies (the client adds its identity line and a date reminder), `tools: []` and `strictMcpConfig`, `maxTurns: 1` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS=64` from the question's request bounds, `effort: "low"` from its thinking level, `thinking: { type: "disabled" }` because an output cap at or under Anthropic's 1,024-token thinking floor leaves no room for it (the pinned client drops `effort` for Haiku 4.5 and would otherwise serve it a 31,999-token thinking budget), `persistSession: false` (no transcript), partial messages, the bound model.
  The client is spawned only when the question is asked, after `checkClaudeClient` at create and the account's shared store lease, which it holds until the client has exited.
  The one result settles the question - its closing words, its usage, or a `turn_failed` with the typed class, which the adapter records on the account - and ends the client's input.
  An answer the output cap cut short is read off the first request - its typed `max_tokens` stop rides the streamed `message_delta` - and the client stopped, because `maxTurns` does not stop the client's own output-limit recovery, which re-asks within milliseconds up to three times; the one re-ask already sent is dropped unanswered.
  `abort()` gives the question up at once and stops the client; the SDK's close takes about 2 s to end it, and the lease comes back then.
  For Haiku 5.5, the real clients 2.1.234, 2.1.290 and 2.1.293 honor the 64-token cap and low effort, omitting the thinking field rather than sending `disabled`; this bounds the request, not a promise that the model can disable its own thinking.
  `claudeClassifierSession.integration.test.ts` runs it on the boxed client against a local stub API, beneath the real kind question: a cold spawn plus one turn answers in 0.6 to 1.4 s, well inside the adapter's 15 s wall clock, serves Haiku, Sonnet and Opus `max_tokens` 64 with no thinking, reads a cut-short answer with one re-ask dropped, and leaves no transcript.
  A cancel and a 401 or 403 refusal on that client are the session contract's question cases below, and `decisionKindClassifier.test.ts` owns how a cut-off reaches the account.
  The same file runs `pnpm score:kinds --provider anthropic-claude` on that boxed client.
  The session contract's shared suite (`tests/helpers/sessionContract.ts`) runs the question's cases on Claude twice, scripted (`claudeSession.contract.test.ts`) and on the same boxed client (`claudeSession.contract.integration.test.ts`), and on real Pi against the same stub API (`pi/piSession.contract.test.ts`), with identical assertions.

## Complete task reads through the tool-result cap

Claude Code 2.1.299 defaults to a 25,000-token MCP output cap, overridable by a positive `MAX_MCP_OUTPUT_TOKENS` or the client’s positive finite `mcp_tool` configuration.
Its text estimate is `Math.round(text.length / 4)`; estimates at or below half the cap bypass token counting, while larger results go through the client’s token counter before it decides whether to substitute a saved-file notice.
The default unconditional acceptance band therefore holds 50,000 text characters, not 100,000: the full token cap is not a safe character conversion.
A first mate has no file tool with which to recover the client’s saved file.
First mate Claude sessions pin `MAX_MCP_OUTPUT_TOKENS=100000` through `CLAUDE_SEAT_ENV`, overriding an ambient value and taking precedence over the client’s remote configuration.
The first mate’s explicit cap gives that client a 200,000-character unconditional band; coding and classifier sessions receive no such host override.
The `tasks` tool pages a by-key read that does not fit one answer, by field and offset, instead of compressing it (`docs/task-record.md`, “By-key closing resolution”); it never drops distinct content.
A read whose original heading and indented JSON fit 50,000 characters stays byte-for-byte unchanged on every provider.
That page size remains independent of the first mate’s larger Claude cap.
Every page of the original accepted-plan fixture and the larger INF-91 design record must fit that unconditional band (`tests/account-eval.test.ts` and `taskTools.test.ts`, with the verified client limit in `tests/helpers/claudeMcpLimit.ts`).
`claudeToolSurface.test.ts` sends both production-host evaluation reads and the captured INF-91 row through the installed client, boxed into a scratch HOME with a local provider stub, and requires the model-bound request to carry each byte for byte.
This transport check calls no live model and does not establish that a model acts correctly on the plan; the approved account evaluation supplies that evidence.
