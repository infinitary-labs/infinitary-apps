# Release notes ledger

What a person is told about a release is reviewed data the app carries, never inferred at startup.
This page owns that data, who writes it, the checks on it, the version tracking, and the startup note that reads them.

## Who writes what

- **The change author** (normally the implementation crewmate) adds a note to the same pull request, in plain language for someone who has never opened a terminal and by the rules in "What a note may say", or an exclusion with a reason for internal work a person does not notice.
  A source change with neither blocks the next alpha.
  The note declares the feature area it belongs to, and a change a person can see keeps its hero picture pair beside the note, or says in one sentence why there is nothing to see ("Hero pictures" below).
- **The reviewing crewmate** checks the notes against the actual changes before merge: accuracy, omissions, repeated descriptions, plain wording, the rules in "What a note may say", and any declared highlight ranks.
  A note about internal work becomes an exclusion, and a product the app does not support is written out of the note.
  Prefer a new feature most people will see and use over a bug fix or a niche case when choosing highlights.
  Inspect each highlight's hero picture; the lead always has one.
  An automatic alpha uses the exact fully checked main commit, with no notes-only review commit or follow-up record commit required for publication (`docs/alpha.md`, "Cutting an alpha").
  The existing published-release reader derives an uncommitted manifest from its immutable source tag; committed records remain immutable and are still validated.
  Editorial corrections merge as ordinary changes and wait for their own passing main check.
  A manual notes-only candidate retains its reviewed-source and committed-record requirements.
  A note added separately names the change it describes in `covers`, so it keeps its releases after squash merge.
  A stable's optional committed record retains its captain-picked highlights (`--highlights`); a rehearsal publishes no tag and pins nothing.
- **The captain** picks a stable's highlights on a card when an alpha is promoted (`docs/alpha.md` "Promoting an alpha"): three, lead first, from every change since the last stable, and only a change with a hero picture can lead.
  The release run writes them into the stable's catalog as its only ranks, so declared alpha ranks reach alpha users alone.
- **The workflow** checks declarations and packages the prose.
  It cannot tell whether a note is true or well written; that is the pre-merge review above.
  The captain is not the copywriter; a stable's highlights are the captain's one editorial choice.

A release whose notes are ready makes no notes-only commit to assemble them.
Editorial work is ordinary crewmate work at development and release time; the app makes no model request for notes.

## What a note may say

The captain's FI3-783 rules, for every note a change or a release review writes.
They cover what the app shows: each entry's `title`, its `body` and its picture's `alt`.
An exclusion's `reason` and a `noPicture` reason never reach a screen, so the rules leave them alone.

- **Only changes a person notices.**
  A note describes something a person sees on screen, or a result the first mate or a crewmate gives them.
  Internal work takes an exclusion with a reason, never a note: refactors, tests, docs, build, CI and release work, library upgrades, how the project itself is developed, and a change to what the first mate or a crewmate is told that has no result a person notices.
  When a change to what the first mate or a crewmate is told does have a result a person notices, the note describes that result, not the instructions.
  The check refuses a `maintenance` entry from a change or a release review; `pi-1-0`, written and shipped before the rule, is the one it allows.
- **Only products the app supports.**
  A note may name a product Infinitary explicitly supports: a subscription on the Subscriptions tab (`src/shared/providers.ts`: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, or a custom provider the person names), a host where projects live (`docs/forge.md`: GitHub, on github.com and as GitHub Enterprise, and GitLab, on gitlab.com and on the person's own server, and Bitbucket, at bitbucket.org and as Bitbucket Data Center on the person's own server), GitHub CLI, whose sign-in the app can use for GitHub (`docs/forge.md`, "GitHub CLI's sign-in"), the Mac the app runs on, a Linux system it publishes packages for (`docs/linux-packages.md`: Ubuntu, Fedora, Arch, Omarchy and NixOS, and any other Linux through the AppImage), and a model a supported subscription serves, named the way the app names it.
  It names nothing else from outside: no engine or library the app is built on (such as Pi or Electron), no developer tool (such as npm), no other service (such as Discord), and no provider the app no longer supports.
  A `removal` entry may name the product whose support it removes, since saying what is gone is its whole point.
- **People judge, not a word list.**
  Whether a name is supported or a change is internal is a judgment, so the change author makes it and the release crewmate reviews it; no check reads a note's words (`AGENTS.md` "Put ambiguous judgments in agent instructions").

## The ledger

Everything lives under `release-notes/`.
Never hand-edit `CHANGELOG.md`; it stopped changing at stable 0.1.30.

| Path | Holds |
| --- | --- |
| `changes/*.json` | One file per change, added by the change itself. `{ "entries": [...], "exclusions": [...] }`. The commit that adds the file is the change it covers. |
| `history/<version>.json` | The backfill of published history. Names the commits it covers in `covers`. |
| `releases/<version>.json` | One immutable manifest per published release: exact `version`, `channel`, `sourceCommit`, `date`, `promotedFrom`, and `entryIds`, the cumulative membership. `highlights` is a promoted stable's picked highlights, lead first. `incomplete` marks a range that cannot be recovered. |
| `archive.json` | The record of past releases ("A fresh history"): where the archived history lives, the newest `stable` and `alpha` it published, and each of its releases' manifest by the SHA-256 of its file. |

An entry has a stable `id`, a `kind` (`feature`, `improvement`, `fix`, `removal`, or `maintenance`, which a change or a release review no longer writes), a `title`, an optional `body`, an optional `highlight` rank, an `area`, a `picture` or a `noPicture` reason, and `provenance` (`origin`: `change`, `release-review` or `changelog-backfill`; `covers`: commits beyond the adding commit).
The `area` is one of the closed list in `NOTE_AREAS` (`src/core/releaseNotes/catalog.ts`), in the order a person meets them: First mate, Message box, Cards, Tasks, Crewmates, Projects, Subscriptions, Settings and appearance, Your devices, Updates, Other changes.
Every entry a change or a release review writes declares one; nothing infers an area from the words, and backfilled history declares none.
An exclusion has an `id`, a `reason`, and optional `covers`.
Fields are closed: an unknown field is refused.
One change keeps one id for life; a new fix or a reversal gets its own id, and a removal is authored explicitly, never inferred from two histories differing.

An alpha and the stable promoted from it share ids and prose.
Prose corrections need a new alpha; a promotion whose source differs from its alpha's `release-notes/` is refused.
They do not share highlights: a stable's are the captain's picks, written into its catalog at release and kept in its record, never in the notes themselves.

A release's membership is the entries whose covered commits are in its source history, so it is exact: skipped releases are included, an unrelated branch's entries are not, and a promoted stable repeats nothing its alpha had.
The release crewmate pins each published manifest after publication, with `node scripts/release-notes.ts manifest --version <v> --write`, and never rewrites it.
`validate` recomputes each from its source commit and refuses a change.

### A fresh history

The Infinitary rename (step 7 of FI3-1780's plan) starts a new repository from one parentless commit of the old one's tree, so the commits every published manifest names, and the tags the versions number from, stay with the archived history, `infinitary-labs/firstmate-3000-archive`.
`archive.json` is the record that carries them across.

- **What it pins.**
  After pausing release publication, run `node scripts/release-notes.ts archive --repository <owner/name> --write` in a full checkout of the project about to be archived.
  Use the repository that published the tags, not the destination of the move.
  To chain a second history, name that history explicitly: the archive preserves the earlier repository names and manifest hashes, and pins the newer history’s releases alongside them.
  The command derives missing records from the local stable and alpha tags, validates the complete ledger before writing, and refuses to rewrite an existing manifest.
  Commit the resulting archive and manifests in the new project’s initial tree; the archive must reflect the last published versions at the cutover, not an earlier rehearsal.
- **How a fresh history reads it.**
  A pinned release whose commit shares no ancestor with the checkout is checked by its hash rather than re-derived.
  A fetched tag for it must still name its original commit; the new history never retags a published version.
  Releases inherit archived entries as well as those whose notes their own commits added.
  A manifest not pinned in the archive must still name a commit in the checkout.
- **Versions.**
  `scripts/resolve-release.sh` numbers from the newest stable tag as always; with none, from the record: the next patch or minor above the newest numeric core either channel published there, so a new repository's restarted run numbers still sort above every archived alpha.
  Every version, either way, must be newer than the record's newest stable and newest alpha ("Versions" in `docs/alpha.md`).
- **Its tests.**
  `tests/release-notes.test.ts` "a fresh history" pins, checks, catalogs and records releases on a parentless copy of an archived fixture, and `tests/release-workflows-resolve.test.ts` "resolving a release" numbers one.

### Hero pictures

The captain's FI3-745 plan: every change a person can see keeps one hero picture pair beside its note, for when a release ranks it as a highlight.

- **What it is.**
  `picture` names `<entry id>-dark.webp` and `<entry id>-light.webp` (PNG accepted) in `release-notes/pictures/`, the same crop in each theme, and the `alt` text that says what it shows.
  A `feature`, `improvement`, `fix` or `removal` entry of origin `change` or `release-review` declares a `picture` or a `noPicture` sentence saying why there is nothing to see; maintenance and backfilled history are exempt.
  Entries recorded before hero pictures were kept say so in their reason, and a release review takes a pair for one it ranks.
- **Who takes it.**
  The crewmate that builds the change, at every care level, from one of its After views, cropped at build time with `heroShot` (`tests/e2e/pictures.ts`) by the recipe in `docs/testing.md` "A hero picture", and committed in the change's own pull request.
  It is part of the change, not evidence; the change's other pictures stay in its evidence folder.
  Nothing is drawn on it: the alt text and the note's title name the new thing.
- **The release crewmate** looks at the pictures of the entries it ranks and re-takes a pair when it does not carry, rather than re-cropping it, since there is no larger source to cut from.
- **The check** (below) refuses a missing picture or reason, a missing file or half a pair, a file that is not the WebP or PNG its name says, missing alt text, a file wider than 1600 px or larger than 300 KB, a picture taller than it is wide, and a lead highlight with no picture.
  Whether a picture shows the right thing stays with the release crewmate's review.

### Backfill and its limits

Published stable and alpha history was recovered from tags, the generated stable changelog and the commits between tags.
Entries with origin `changelog-backfill` carry the changelog's own wording, tidied only for capitalization and scope prefixes, and have not been rewritten into plain language.
The startup note never lists them (the captain's FI3-783 answer); the ledger and the catalog keep them, because published manifests name their ids and the checks read every release's membership.
Commits the changelog does not list are covered by one exclusion per release.
`0.1.0` is the first stable release: its earlier history is not recoverable, so its manifest is marked `incomplete`, not empty.

## The release check

`node scripts/release-notes.ts` (Node type stripping; no install) is the one tool.
`release.yml`'s `notes` job runs it before `verify` or any signing, as two parts of one matrix that run side by side, each with its own full-history checkout: `check` runs step 1 and `catalog` runs steps 2 and 3.
Every later job reads the one `notes` result, which holds only when both parts passed.

1. `check` validates the ledger (schema, unique ids, references, promotion mappings, each entry's area, kind and hero picture and the picture files, published manifests unchanged, the record of past releases), refuses a published release this one stands on that has no record in `releases/` (except the release being cut and the alpha a stable promotes), refuses an alpha whose candidate (`--reviewed`, or `--verified-main` for exact-main cuts) is missing or is not the workflow's resolved source (a rehearsal may omit it), and refuses a source change since the previous release that no note or exclusion covers.
   An automatic exact-main check derives uncommitted historical manifests from immutable tags rather than requiring another notes commit.
   So does a rehearsal that names neither a candidate nor a promoted alpha and builds the dispatched commit, since it publishes no tag and pins nothing; a rehearsal of a candidate requires the records its live alpha would.
   A release stands on a source when its commit is in the source's history, or is a candidate - a notes-only commit - off it, so an alpha cut from a candidate is the previous release of the next one.
   A stable promotion instead proves `release-notes/` is identical to its alpha's.
2. `generate` writes the offline catalog: this release's entries and every published release's membership, and its highlighted entries' hero pairs in `release-notes/pictures/` beside it, each file's sha256 and size in the catalog's `pictures`.
   The signing job, the Linux packages and the Windows installer each download both and package them as `release-notes.json` and `release-notes/pictures/` in the app's resources (`Resources/` on the Mac).
3. For a stable, `stable-highlights --picks <ids>` then rewrites that catalog so the captain's picks are its only highlights, lead first, with only their hero pairs beside it; nothing else in it changes.
   It refuses a lead with no picture, a pick that is not a change since the last stable (backfilled history never is), a change picked twice, and a count of picks other than its slots.
   It runs from the workflow's own commit, since the promoted alpha's may predate it, and the alpha's own `verify-package` checks the result at once.
   Without `--picks` it lists the changes since the last stable to pick from, for the promotion's card.
4. `verify-package` runs against each packaged app, before notarization on the Mac and before the Linux packages and the Windows installer leave their jobs: the catalog is this exact logical version and source commit, and each packaged picture is the file the catalog hashed.

Every change's first check step runs `node scripts/release-notes.ts change` from the commit the change starts at (`ci.yml`, on each push of a task's branch and on a pull request; plain Node with no install, under a second).
It refuses a change whose commits add no file under `release-notes/changes/` declaring a note or an exclusion: a change merges as one commit, squashed alone or as its own commit of a batch of several (`docs/testing.md`, "The swept batch"), and the commit that adds the file is the one the alpha credits, so this is the alpha's coverage rule applied before merge.
Editing a note another change added does not count; the change still adds its own file.
The same step runs the part of `validate` that needs no git history over the real ledger (`ledgerProblems`), so a note with no area, a new `maintenance` note, a visible change with neither picture nor reason, a picture over the caps, or a manifest that no longer matches the record of past releases also fails on its own change rather than at the next alpha.
`tests/release-notes-ledger.test.ts` runs that part again with main's unit tests.
A branch built on a held batch's version skips that step (`docs/testing.md`, "A pushed branch"), so the batch's own run reads its note instead: `batch-checks.yml`'s `notes` job runs `node scripts/release-notes.ts batch --base <the main version the batch left>` with full history on the batch's version.
It refuses a batch with any commit since that version, one per change, that no note or exclusion covers, as `check` counts it for the alpha, and runs `ledgerProblems` the same way, so a held batch's fix with no note of its own fails the batch before it merges.

A development or end-to-end build carries a placeholder (`generate --dev`) with an empty pictures folder that never passes `verify-package`; the app reads it as notes unavailable.
`docs/alpha.md` covers the dispatch inputs and rehearsal.

## Version tracking

`SettingsStore` keeps a typed `release-tracking` record (`src/shared/releaseTracking.ts`).
Migration 61 writes it once and records the profile as `fresh` (created after tracking) or `legacy` (already had saved work); nothing reclassifies it, so a fresh profile keeps its welcome while setup is pending.
The baseline starts unknown.

At startup, after the saved-data check, migrations and first-run eligibility, the running logical version from `host.app.version` (and, for a build that carries a catalog, its source commit) is reconciled against the record: by the startup note below, or, in a build with no catalog to read, by `recordLaunch` (`src/core/releaseTracking.ts`) alone.
The first known baseline is seeded silently; a different version replaces the baseline and keeps the old one as `previous`; the same version writes nothing; a downgrade records the lower version; an unreadable version records nothing.
The baseline is the previous successfully reconciled launch: a version installed but never opened is not recoverable.
The record also keeps each delivered version's note (its boundary, the entry ids it listed, its coverage and card) and the ranges a catalog could not cover.
A saved-data refusal still happens before any of this writes, and a profile opened by an older build is refused by the existing migration-history check.

## The startup note

The captain's FI3-608 choices, as revised on FI3-706 and FI3-1164: the **Briefing** design; an existing profile that came from a version with no recorded history gets every change the catalog records for people, once; a first installation gets no note, so its welcome is its only card.
`ReleaseNotesService` (`src/core/releaseNotes/startup.ts`) runs where `recordLaunch` used to, before the window's first card snapshot, with no network, sign-in or model.
A packaged build reads its own `release-notes.json`; a dev or end-to-end run reads one only from `INFINITARY_RELEASE_NOTES_DIR` (a folder holding `release-notes.json`, ignored by a packaged build) and otherwise just records its version.

- **What it lists** (`select.ts`).
  For a forward upgrade, `entries(current) - entries(previous)` from the releases' exact membership, once per id: skipped releases are in, an unrelated branch's entries are not, and a promoted stable repeats nothing its alpha had.
  Anything an earlier note listed is never listed again.
  Backfilled history is never listed, though its entries still count in each release's membership.
  Alphas order by `compareSemver`, never as strings.
- **How it reads** (`briefing.ts`).
  An ordinary first mate note with no actions, rendered like any card: the title names the version ("What’s new in stable 0.1.27"), then the range from the version last opened, one line on what it covers, at most three highlights by `highlight` rank, then every change behind one "All N changes" disclosure.
  A stable's ranks are the captain's three picks, and an alpha's those of every review it carries.
  Each highlight is numbered with its kind and area ("01 / Added · Cards"); the first spans the card with its hero picture under its words, the next two sit side by side with theirs above, and one without a picture reads as text.
  The full list groups by area in the `NOTE_AREAS` order, skipping empty ones, features first inside each, then improvements, fixes, removals and maintenance, each tagged with its kind; an entry with no area is under Other changes, and the range line, not the list, names the versions.
  With no highlights the disclosure starts open.
  It closes on where the notes came from and then, for a note that lists changes, on where to read it again: the Help menu's What’s New (`READ_AGAIN`).
  A note that says nothing is new, or that the notes could not be read, names no way back, because What's new opens the newest note that listed changes ("Reading a note again").
  Catalog text is escaped into these templates; the catalog never supplies markup, and the body carries no script or stylesheet of its own.
- **Its pictures.**
  Both pictures of a highlight's pair ride the note, each `<img>` marked `data-inf-theme`; the frame stylesheet shows the one matching the frame's theme, so a theme switch swaps them live.
  Each sits on a mat, a `--line-1` hairline panel on `--bg-1` with 12 px of padding, by inline style like the rest of the note.
  At delivery the host copies each pair through the card-picture check into `crewmates/release-notes/cards` (`RELEASE_NOTES_PICTURE_OWNER`, a reserved owner that is no task), so the note keeps its pictures after the next upgrade replaces this build's files and they open in the picture viewer; a pair that is not both in the catalog and on disk leaves its highlight as text.
- **Where it goes.**
  `CardService.addRecordedFirstmateNote(..., { onTop: true })` gives the note a priority one past the highest card on the stack, so it is the stack's top, shown first at launch; a card arriving later sorts as it always does.
  The priority is saved with the card, so a restart restores it on top.
- **Atomic delivery.**
  The note, its completed answer, the new baseline and the delivery stamp commit in one transaction and publish after it.
  A failed write rolls everything back and the next launch retries, holding nothing; a crash after the commit restores the same card.
  A restart, a closed note, a reinstall or a channel switch never reissues it, and an older unread note and its thread stay.
- **Downgrades.**
  A lower version records the lower baseline with no note.
  A version already delivered is never delivered again, open or closed; a later new version is measured from the actual lower baseline, less what earlier notes listed.
- **No recorded history.**
  A `legacy` profile with no `previous` version and no delivery came from a version that kept no record, so its next forward launch lists every entry the target release carries except backfilled history (`select.ts` mode `history`: no base), grouped by area like any note, under the range "An earlier version".
  That covers a profile with no baseline and one 0.1.28-alpha.23 seeded silently; an upgrade, a downgrade or a delivery fills one of those fields, so it happens once.
  With no readable notes, a profile with no baseline is recorded quietly and stays unrecorded; one with a baseline gets the ordinary honest note.
- **A first installation.**
  A clean new installation shows no note (FI3-1164, the captain's call for a clean first launch): the welcome is its only card, and nothing follows it until the person asks.
  While setup or the welcome is pending (the welcome card still open), nothing is written: the baseline stays unknown, so a restart still finds a fresh profile and the welcome is never preceded or suppressed.
  Setup and card changes look again.
  Once the welcome is closed, or skipped on a start that needed no setup, the version is recorded quietly as the baseline, so the next forward upgrade's note lists only what changed since.
  The Help menu's What's New stays greyed until a note has been shown.
- **Honesty.**
  A missing, placeholder or inconsistent catalog gives one note saying the notes could not be read, with the range kept in `unresolved`.
  A previous version the catalog does not know gives this release's own changes and says so; a previous release marked `incomplete`, or a move to a version lacking changes the previous one had, is stated.
  A later upgrade recovers a gap once both its ends are in the catalog, listing it under its original range in a disclosure of its own, grouped by area inside; a closed note is never reopened.
  An unreadable or corrupt version records nothing new and invents no history.

## Reading a note again

The captain's FI3-932 plan, direction B: a note the app showed can be read again after it is closed, from four ways in that take one door.

- **The door.**
  `inf:release-notes:show` (`src/core/dispatcher.ts`) finds a note in the version tracking record's deliveries and brings its card forward as it was shown, writing nothing.
  With no version it takes the newest note that listed changes, past a newer one that said nothing was new, or else the newest (`releaseNoteToShow`, `src/shared/releaseTracking.ts`); with a version, that version's note.
  An open note comes to the front of the stack (`open_card_shown`, which the shell answers with `focusCard`); a closed one comes back read-only as a past card (`past_card_shown`, `docs/card-evidence.md` "The past card"), with its highlights, pictures and full list.
  Before any note was shown it refuses with "No release notes yet."
- **The list.**
  `inf:release-notes:list` reads the notes the app showed, newest first, each with its version, its name with its channel, whether it listed changes and when it was shown, beside the version running now (`releaseNotesView`, `src/core/releaseNotes/shown.ts`).
  A delivery recorded with no card is not on it.
  A new note pushes the list whole (`inf:release-notes`), so the window and the Help menu know at once that there is one to open.
  Both channels are the home's own: a Mac that controls another runs a version of its own, so it asks neither.
- **The Help menu.**
  The app menu gains a Help menu whose one item, What’s New in Infinitary, tells the page the window command `whats-new.show`; it is greyed out until a note was shown (`src/main/appMenu.ts`, `docs/keyboard.md` "The app menu").
- **Command search.**
  Show what's new (`whats-new.show`) has no default key and is chosen by name; release, notes, changes and version find it too (`searchWords`), and before any note its row says "No release notes yet" and runs nothing (`docs/keyboard.md`).
- **Settings → General → Version.**
  The last section of General names the version running now and initially lists the three newest notes the app showed, by version and the day it was shown, a note that said nothing was new marked so (`VersionRow.tsx`).
  It names the version from the update status, which it reads each time it opens, so it never waits on the list, and from the list once that is read.
  A list read refused while the window's link was down is asked again when the link comes back (`docs/view.md`, "The window on the first mate's own computer").
  Show more reveals every remaining note, still newest first, and moves focus to the first newly revealed row.
  This limits only the initial display; the saved list stays complete.
  The list is one Tab stop that ↑, ↓, Home and End move through; Enter or a click goes home and opens that version's note through the door.
- **The first mate.**
  The asked catalog action `show-whats-new` takes the same door, with an optional `version` read from `app_state` (`docs/orchestrator-contract.md`); it needs no card id, makes no card and leaves one feed line.

Tests: `src/core/releaseNotes/shown.test.ts` (the list and which note opens), `src/core/core.settings.test.ts` ("the one What's new door"), `src/main/appMenu.test.ts` (the Help menu), `commandRows.test.ts` and `commandRefusals.test.ts` (the row, its words and its reason), `VersionRow.test.tsx`, and `tests/e2e/whats-new.spec.ts` (the journey by keys and the menu, open and closed, Settings, the first mate, a recorded key, and no note yet).
