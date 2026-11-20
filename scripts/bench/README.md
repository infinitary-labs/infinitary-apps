# Benchmark tooling (`scripts/bench`)

Dev tooling for Infinitary's benchmark runs on DeepSWE (the leaderboard's 113 tasks). It has two halves:

- **The task runtime (S0).** It gets the task pool onto Apple container, grades a patch with a task's own verifier, runs a crewmate's commands inside the task's container (the bridge), and opens a task's private GitHub mirror.
- **The attempt driver (S1).** It sends one task through the headless core and grades what the crewmate left. See [The attempt driver](#the-attempt-driver-s1) below.

The driver meets the runtime at the contract in [`INTERFACE.md`](INTERFACE.md).

None of this is product code. Nothing in `src/` imports it, it never ships in the app, and the app never learns the benchmark's name.

## Setup on a fresh Mac

Everything runs as your user. No step needs `sudo`, except installing Rosetta the first time.

1. **Rosetta.** Every task image is `linux/amd64`, so it runs under Rosetta. Check with `pgrep oahd`. If it is missing, install it once with `softwareupdate --install-rosetta --agree-to-license`.
2. **Apple container** (1.4.1; the locked-in runtime, never Docker): `brew install container`, then start its services:

   ```sh
   container system start --enable-kernel-install
   container system status        # status: running
   ```

   The first start downloads the default kernel. The services run until `container system stop`. After a reboot, check `container system status` and run the start again if the services are down. There is no other system configuration.
3. **Node 24** (it strips the scripts' types; there is no build step) and **Python 3.11 or later** (`tomllib` reads each `task.toml`).
4. **The pool:**

   ```sh
   node scripts/bench/bench.ts pool sync
   ```

   This clones `datacurve-ai/deep-swe` at the pinned commit (`DEEPSWE_COMMIT` in `pool.ts`) into `.bench/deep-swe` and checks that all 113 tasks are there. `.bench/` is git-ignored. Set `INFINITARY_BENCH_DIR` to put it somewhere else.
5. **Mirrors only:** `gh` signed in as the account that owns the mirrors (`gh api user --jq .login`).

## Commands

Run them from the repository root: `node scripts/bench/bench.ts <command>`. With no command, it prints usage.

| Command | What it does |
| --- | --- |
| `pool sync` | Clones or re-pins the task repository and checks the pool is whole. |
| `pool list [--json]` | Prints the task index: id, language, category, and whether the image is cached. `--json` prints the full index, including image, base commit and verifier budget. |
| `pool pull <task>...` | Caches task images. It refuses below the free-disk floor. |
| `pool checkout <task> <dest>` | Clones the task's repository from the image's own `/app`, at the base commit on its default branch, with no remote. This is the host repository a crewmate works in. |
| `verify <task> <source> [--out <dir>]` | Grades a patch with the task's own verifier and prints the result JSON. For `<source>`, pass exactly one of `--empty`, `--patch <file or ->`, `--worktree <dir>` or `--repo <dir> --ref <ref>`. `verify-task.ts <task> <patch> <out-dir>` does the same behind the driver's verifier seam. See [`INTERFACE.md`](INTERFACE.md). |
| `sweep [--concurrency N] [--keep-images] [--tasks a,b]` | Runs every verifier on the empty patch and times it. The sweep can be resumed (below). |
| `bridge <task> [--worktree <dir>] [--timeout <s>] -- <command>` | Applies the worktree's patch to `/app` in the task's container and runs the command there. The worktree defaults to the current directory. |
| `bridge stop <task> [--worktree <dir>]` | Removes that worktree's task container. |
| `mirror <task> [--owner <login>]` | Opens the task's private GitHub mirror (the Careful arm's pull-request target). |
| `containers` | Lists the task containers this tooling started. |

### The sweep

`sweep` is S0's exit criterion. For each task, it pulls the image, grades the pristine base (the empty patch), records one row and deletes the image again. An image already cached before the sweep began is kept.

- Rows append to `.bench/empty-patch-sweep.jsonl` as they finish. A stopped sweep resumes where it left off. To re-run one task, delete its line.
- An infrastructure failure is retried once, straight away, and the row keeps the first failure. These count as infrastructure failures: a timeout, a verifier that wrote no reward or wrote its own `-1`, or a container or pull error.
- A registry rate limit (HTTP 429 from public ECR) or a 5xx is waited out inside the pull: up to five tries, 30 s apart and growing. It does not use up the task's retry.
- At the end it writes the committed table, `scripts/bench/data/empty-patch-sweep.json`: one row per task, plus the named outliers. `suiteDidNotRun` lists a graded task whose pass-to-pass tests all failed on the base. Those tests pass by construction, so the suite never ran on this runtime. The last full sweep and what it found are in [`INTERFACE.md`](INTERFACE.md#timing).

## Limits

- **At most three task containers at once**, counted across every process that uses this tooling. Each takes the task's 2 CPUs and 8 GB. A start takes a short lock, counts the running containers with the `infinitary-bench` label, and waits for a free slot. The limit applies to the verifier, the bridge and exports alike, so a sweep and a driver can share a machine safely.
- **At least 100 GB of free disk.** A pull is refused below 105 GB free. Refused at the floor, the sweep stops and records nothing for that task. Each image unpacks to about 4.3 GB, so the sweep keeps at most three images at a time.
- Task containers run offline (`--network none`, the tasks' `no-network` mode).

## Cleanup

```sh
node scripts/bench/bench.ts containers          # what this tooling left running
container delete --force <id>                   # one of them (bench ids start fmb-)
container image ls                              # cached task images (public.ecr.aws/d3j8x8q7/swe-bench-202605)
container image delete --force <image>          # one image; prints the space it reclaimed
container system df                             # disk used by images and containers
container system stop                           # stop the services entirely
rm -rf .bench/runs                              # verifier and bridge logs
```

Never run `container image prune` on a shared machine: it also removes images that are not the benchmark's. A mirror is a normal private repository. Delete it on GitHub when its run is over.

## The attempt driver (S1)

One attempt does the following:

1. Boots the whole Infinitary core in a plain Node process through `startCore(host)`, against a state directory of its own.
2. Registers the task's repository.
3. Sends the task's words as the captain's message.
4. Answers decision cards as a scripted captain.
5. Scores what the crewmate left in its working copy.

It writes one row per attempt.

### Run it

```sh
# The whole path at no spend: fixture task, e2e mock provider, stub verifier.
pnpm bench:attempt --dry-run --out /tmp/attempt-1

# A real task (on the machine that runs evals, never this MacBook).
pnpm bench:attempt --task <harbor-task-dir> --task-id <id> \
  --repo <git-source> --base <sha> --care quick|default|careful \
  [--pin <provider>/<model>] [--mirror <url>] \
  --bridge "<command prefix the crew builds and tests through>" \
  --verifier <command> --out <new-dir>
```

`--out` must be a new directory. It holds the following:

| Path | Contents |
| --- | --- |
| `state/` | The attempt's own userData |
| `work/<task-id>/` | The attempt's clone of the task repository |
| `patch.diff` | The graded patch |
| `verifier/` | `reward.json` and the verifier's output |
| `row.json` | The attempt's row |

### What each lever is

Every lever is a primitive the app already has:

| Benchmark concept | Infinitary primitive |
| --- | --- |
| Care: `quick` / `default` / `careful` | Rigor `quick` / `standard` / `reviewed`, written to the repository row through `inf:repos:configure` (the row `configure_repo` and Settings write) |
| Careful's pull request | Delivery `direct-pr` with the task's private mirror as `origin` |
| Pinned or auto | `inf:settings:routing:set`: one pin that `route()` reads first, or none |
| The ask | `instruction.md` verbatim through `inf:converse` (max 20,000 characters) |
| Repository instructions | `crew-instructions.md` committed as `AGENTS.md` on top of the base commit. Crewmates read `AGENTS.md` first. Driver-created, so it is excluded from the graded patch. |
| The scripted captain | `inf:cards:act`, chosen from each card's typed actions only (`policy.ts`) |
| The graded work | The working copy of the task record (a temporary index, uncommitted edits included), then `refs/infinitary/kept/<task-id>`, then the branch, then a landed head |
| Usage and routing | The published views `v_usage_v1`, `v_routing_v1` and `v_tasks_v1`, read after the core stops |

#### How an attempt ends

The driver watches typed state only. Something is still moving while any of these holds:

- the Firstmate is mid-turn;
- an inbox row is undelivered;
- a work task is starting or running;
- a work task has a background job.

Once nothing has moved for the quiet window (30 s live, 5 s mock), the attempt ends with one of these reasons:

| Reason | Meaning |
| --- | --- |
| `ready` | A card offers to land the work. The driver never clicks it; grading reads the tree. |
| `closed` | Every work task is closed. |
| `idle` | The work is reported and there is no card to answer. |
| `no-work` | The Firstmate started no work. |

Other ends:

| Reason | Meaning |
| --- | --- |
| `host-card` | The host raised a stall or sign-in card. |
| `over-asking` | The captain was asked more than 6 decisions. |
| `timeout` | The attempt hit the 3-hour cap. |
| `infra` | A boot failure, no model available, or a refused ask. |

The row records `rigor_asked` (the care level) and `rigor_served` (what the host stamped on the graded task). They differ when the Firstmate passes a rigor of its own. The dry run shows this: the mock Firstmate always asks for `quick`.

### The verifier seam

`verifier.ts`: a unified diff against the task's base commit plus the task id go in; `reward.json` comes out.

`--verifier <command>` runs:

```sh
<command> <task-id> <patch-path> <out-dir>
```

The command must exit 0 and write `<out-dir>/reward.json` with at least a numeric `reward`. The task verifier's own fields (`partial`, `f2p_*`, `p2p_*`) are carried as they are.

The real grader is the S0 verifier runner: `--verifier <repo>/scripts/bench/verify-task.ts`. It grades in a fresh task container with the task's own verifier, and exits 3 without a `reward.json` when the verifier itself failed. The contract is in [`INTERFACE.md`](INTERFACE.md). The stub (`--check <shell command>`, or the dry run's `fixtures/mock-task/check.sh`) grades on the host instead: the patch must apply to a clean checkout of the base, and the check must pass. A stub-graded row says `verifier.kind: "stub"`.

`--bridge` is the command prefix written into the crew's instructions: `node <repo>/scripts/bench/bench.ts bridge <task-id> --`. The crewmate calls it from its working copy, which is the bridge's default worktree.

### Isolation

- The state directory must be new or empty. It may not overlap the app's folders under either name: `<appData>/infinitary`, `<appData>/infinitary-dev`, `<appData>/firstmate-3000` or `<appData>/firstmate-3000-dev`.
- The headless host reads bundled resources, including runbooks, from the Infinitary checkout resolved by the module runner, independently of the caller's working directory.
  Mutable userData stays in the attempt's state directory; no resources are copied into it.
- A mock attempt (`--dry-run` or `--mock`) boots with the e2e suite's isolation:
  - `PI_OFFLINE=1`;
  - a quota fixture with no providers;
  - a throwaway `HOME`;
  - a Claude client path that does not exist;
  - every provider key variable unset.
- A live attempt refuses to start with these set: any API-key variable, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `PI_OFFLINE`, `INFINITARY_CLAUDE_CLI` or `INFINITARY_QUOTA_FIXTURE_DIR`.

### Live runs: status

The live path is written but not yet exercised. Proving it needs model spend, which S2 authorizes. S1 was proven on the mock provider only.

What code reading found about real sign-ins in a dedicated state directory:

- **Claude:** Infinitary always runs the installed `claude` client on the machine's default login. It clears `CLAUDE_CONFIG_DIR` (`src/core/claude/claudeCli.ts`). A dedicated directory therefore shares the captain's Claude login with no sign-in of its own.
  - The account row still has to be added once through `inf:accounts:add`. With a working Keychain this adopts the existing login without a browser.
  - The driver never adds accounts itself. Adding one is an attended step.
  - With no Keychain, the add path would run `claude auth login` and could sign the captain's sessions out.
- **Keychain:** the headless host uses the desktop shell's Security.framework lookup (`createDarwinKeychain`). With the absent stub, Claude's quota reads fail and its health can drop to signed-out mid-run.
- **Codex and Grok (Pi):** stores live under userData, so each state directory needs its own sign-in (`inf:accounts:add` / `inf:accounts:sign-in`, with the URL arriving on `inf:auth:notice`). A fresh directory per attempt suits Claude-only runs (S2). Pi providers would need a persistent signed-in directory.
- **Token refresh:** two processes on one Claude login can both trigger the client's own token refresh, the same exposure as running two Claude Code sessions.

The careful arm (`--mirror`) sends the start commit to the mirror's `main` and lands through a pull request. That needs the app's forge sign-in in the state directory. It is also unexercised. S0 opened one mirror as proof (`bench.ts mirror`).
