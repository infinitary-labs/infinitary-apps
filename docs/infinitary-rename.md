# The Infinitary rename in the code

Firstmate 3000 becomes Infinitary in steps (FI3-1780's plan, under FI3-1719).
The captain's answer on its code names: every code name is renamed, and the old names stay as aliases.
This page says which names the app writes now, which old ones it still reads, and how every old name left in the tree is accounted for.
Steps 9 and 10 made the app Infinitary: its words, its identity, its folders, its packages and its release names.

## What this build writes, and what it still reads

The code names follow one spelling, `OWN_SPELLING` in `src/shared/codeNames.ts`: `inf` since step 8, where Firstmate 3000 wrote `fm`.
The app's identity as a system knows it - its bundle id, data folders, background label and work folder - follows `OWN_IDENTITY`, which is `inf` since step 10, with the bundle id `com.getinfinitary.infinitary` (`.dev` for development) and `Infinitary.app` (`APP_IDENTITIES`).

| Name | Written now | Still read |
| --- | --- | --- |
| A setting | `INFINITARY_<NAME>` | `FM3000_<NAME>`; the newer name wins (`src/shared/envSettings.ts`) |
| A channel on the connection | `inf:` to a side that reads it | `fm:`, and `fm:` is written to a side from before the rename (`docs/connection.md`, "Two spellings") |
| The update order | `fm:firstmate:update` in every spelling | - |
| A card's hooks | `data-inf-*`, the `inf-*` classes, `inf.action`, `inf.stage`, `window.infAction` | `data-fm-*`, `fm-*`, `window.fm`, `window.fmAction` (`docs/ui-plugins.md`, the bridge's hooks) |
| The window's API | `window.infinitary` | `window.firstmate`, the same frozen API |
| A panel's modules | `@infinitary/ui`, `@infinitary/contracts` | `@firstmate/ui`, `@firstmate/contracts` (`docs/personal-panels.md`) |
| The workspace's types | `infinitary-env.d.ts` | `firstmate-env.d.ts` is removed at the next seed |
| The host global of panel modules | `__infinitaryHost` | `__firstmateHost` |
| A task command | `infinitary-browser-axi` | `fm-browser-axi`, a link to the same launcher (`docs/axi-commands.md`) |
| The Claude seat's tools | `mcp__infinitary__<name>` | `mcp__firstmate__<name>` in a recorded or resumed conversation |
| Kept work, a seeded workspace, a source ref | `refs/infinitary/kept/`, `refs/infinitary/home-main`, `refs/infinitary/sources/` | `refs/fm3000/...`; a computer before protocol 8.4 is named the older ones (`docs/helper.md`) |
| A pairing link | `infinitary://join?`, which Devices shows | `firstmate3000://join?`, which a computer from before the rename built (`docs/devices.md`) |
| A downloaded artifact | `.infinitary-artifacts/` | a computer before protocol 8.4 writes `.firstmate-artifacts/` |
| A task's temporary folder marker | `.infinitary-temp` | `.fm3000-temp` (`docs/task-retention.md`) |
| A task export | `infinitary-tasks/1` | `fm3000-tasks/1` |
| The development package's stamp | `infinitaryBuildFlavor` | `fm3000BuildFlavor` |
| The vendored git's stamp | `.infinitary-source` | `.fm3000-source` |
| The app's SSH key comment | `infinitary` | `firstmate-3000` |
| The data folders | `infinitary`, `infinitary-dev` | `firstmate-3000`, `firstmate-3000-dev`, which the one-time move brings in once and keeps as the recovery copy (`docs/saved-data-compatibility.md`) |
| The background work's label | `com.getinfinitary.infinitary.work` (`.dev.work`) | `com.kunchenguid.firstmate3000.work`, which the move hands over (`docs/helper.md`) |
| The Linux package and command | `infinitary`, `/opt/infinitary/infinitary` | `firstmate-3000`, which the package replaces, conflicts with and provides, and its program paths, left as links (`docs/linux-packages.md`) |
| The development signer | `~/.infinitary/local-codesign`, "Infinitary Local Dev" | `~/.firstmate-3000/local-codesign`, left as it was for a rollback (`docs/local-code-signing.md`) |
| The release | the tap `infinitary-labs/homebrew-tap`, casks `infinitary` and `infinitary@alpha`, tags `infinitary-v` and `infinitary-alpha-v`, `Infinitary-<v>-universal.zip`, `infinitary-updates.json` and `infinitary-builds.json` | Firstmate 3000's tap, casks, tags and update files, which the old-cask switch writes and an installation that came through the old cask reads (`docs/alpha.md`, "The old-cask switch") |
| The design skill | `.claude/skills/infinitary-design/` | `firstmate-3000-design`, which a personal workspace seed takes away |

Names nothing outside one run reads - scratch and socket folder prefixes and log prefixes - are renamed outright.
The app's git author is `Infinitary <infinitary@localhost>` since step 9; a repository the app made before keeps the author it was given.

## The words

Step 9 renamed the words a person reads and the words the models read: the app is Infinitary, and the agent the person talks to is "your first mate", a common noun, never a name (the captain's answer on FI3-1720).
The design skill's `copy/Vocabulary.prompt.md` is the one home of that rule.
Code names built on `firstmate` - identifiers, files, stored values such as a card's author `firstmate` - stay; only how they are shown changed.

## Every old name, accounted for

`scripts/old-names.ts` is the ledger: it finds every old name in the files git sees, tracked or new - a name with 3000 in it, and Firstmate 3000's code names above - and classifies each by rule as a reader, an identity, words or history.
`pnpm check` runs it, and it refuses an old name no rule classifies, so new code writes Infinitary's names.
A **reader** is code that reads an old name, and the test that holds it.
An **identity** is a name a system outside the code holds: Firstmate 3000's bundle id, data folders, packages, casks, tags and development signer, which step 10 renamed and the move, the old-cask switch and the Linux packages still name; Firstmate 3000's repository, which step 11 moved to the archive ("The repository" below); and names another program or a saved hash keeps, such as the Ollama alias, the placement salts and the Diagnostics series.
**Words** are the product's old name kept on purpose in prose: the vocabulary's never-say column; step 9 renamed the rest.
**History** is what was published or recorded: the changelog, release notes, contract revisions, recorded fixtures and cited design records.

`node scripts/old-names.ts --counts` counts them by family and class, and `--list` names each with its file and line.
A step that renames an identity or words removes its rules once nothing matches them; an old name kept on purpose gets a rule that says why.

## The repository

The code lives in `infinitary-labs/infinitary`, whose history starts at one parentless commit of the tree Firstmate 3000's main held once every check had passed on it (step 11).
Firstmate 3000's repository is `infinitary-labs/firstmate-3000-archive`: its commits, tags, releases and pull requests stay there, and GitHub forwards `kunchenguid/firstmate-3000` to it.
The archive stays open to pull requests, so a Firstmate 3000 task (key FI3) still delivers there; new work starts in the Infinitary project (key INF).
A pull request, issue or commit number from before step 11 belongs to the archive, not to `infinitary-labs/infinitary`.

## A fresh history

Step 7 carries the release record across the new repository's one parentless commit: `release-notes/archive.json` (`docs/release-notes.md`, "A fresh history").

## Tests

`tests/old-names.test.ts` holds the ledger's refusal of a new old name; each reader's own test holds the name it reads, beside its new name.
