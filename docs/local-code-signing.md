# Local code signing (macOS)

Status: **decided**, 2026-09-14.
Scope: the two *local* forms of the app - `pnpm dev` and `pnpm package:mac`.
Release signing is unchanged and is described in `docs/architecture.md` section 10.

Keychain and signing access is sensitive and needs the captain's consent on a card before a crewmate uses it for validation (`docs/delivery-rigor.md`, the general validation resource rule).
The crewmate prompt and `spawn_crewmate` guidance prefer reproductions under a scratch home with stand-in signing commands; a scratch home alone does not move the real keychain search list.
Secrets remain off command lines and out of printed output.

No install signs.
An install often runs with nobody there: pnpm installs on its own before a `pnpm run` or `pnpm exec` whose packages are out of date (its `verifyDepsBeforeRun` default), so bringing a branch up to date with a new version is enough to start one, and the app installs every working copy it makes for a crewmate.
Signing can unlock the signing keychain, rebuild it, or regenerate the certificate, and none of that may happen without the captain’s consent.
So run from any install stage (`preinstall`, `install`, `postinstall`, `prepare`, as `npm_lifecycle_event` names it), `scripts/prepare-local-codesign.mjs` only checks the dev Electron: it reads `designated-requirement.txt`, runs `codesign --verify`, and never calls `security`, signs, or writes the material.
Signing waits for a command the captain runs or explicitly consents to for validation: `pnpm dev`, `pnpm codesign:local`, or `pnpm package:mac`.

## In a crewmate's working copy

A crewmate's working copy is on the person's Mac, where a keychain or signing command reaches the person's real keychains.
A scratch `HOME` does not move macOS's keychain search list.

- **An install is safe to let run.**
  `pnpm install`, the app's install of a new working copy and the install pnpm starts on its own all only check (above), so `pnpm install --ignore-scripts` is not needed for the keychain's sake.
  Before the next `pnpm run` or `pnpm exec`, pnpm starts one whenever `package.json` or `pnpm-lock.yaml` differs from what it last installed.
  That happens after bringing a branch up to date with a dependency or version change, and after any edit to `package.json`, even one put back by copying the original over it.
  A `touch` that leaves the content alone starts none.
- **Real signing asks first.**
  `pnpm dev` and `pnpm codesign:local` can unlock, rebuild or regenerate the signing keychain and put it on the user search list.
  `pnpm package:mac` signs with the same material, after electron-builder lists the identities in the user's keychains.
  In a working copy, launch the app through the hermetic launcher instead (`docs/testing.md`, "Capturing pictures of a change").
  Prefer reproducing signing behavior under a scratch `INFINITARY_LOCAL_CODESIGN_DIR`, with the stand-in `security` and `codesign` from `tests/fixtures/local-codesign/` named by `INFINITARY_SECURITY_BIN` and `INFINITARY_CODESIGN_BIN`, as `tests/local-codesign.test.ts` does.
- **Never package with the release `electron-builder.yml` on this Mac.**
  To find its identity, electron-builder runs `/usr/bin/security find-identity -v` against the user's keychain search list, a fixed path that neither a scratch `HOME` nor a stand-in on `PATH` reaches.
  The release config has no `sign` hook, so electron-builder signs with whatever that lookup finds.
  A named identity is looked up even with `CSC_IDENTITY_AUTO_DISCOVERY=false`, and app-builder-lib falls back from Developer ID to any other identity whose listing contains the name it was given.
  So `-c.mac.identity=-` has signed a scratch package with one of the person's own certificates, whose name holds a hyphen.
  Only `-c.mac.identity=null` skips signing before any lookup.
  Such a package is for reading its metadata (`Info.plist`, the archive's `package.json`) and is never launched: its fuses are flipped, and Apple Silicon kills a fuse-flipped binary that is not re-signed.
  A signed release package comes from the release workflow's dry run (`docs/alpha.md`, "The signed channel workflow").

## The problem this solves

macOS pins a Keychain "Always Allow" grant to the requesting binary's **designated requirement** - a sentence about *which code* is allowed, embedded in the code signature.
Ad-hoc code (`codesign -s -`) names no signer, so its designated requirement degrades to the hash of that one build:

```
designated => cdhash H"74cc2c910a4f4c17c8bd84174ba9d84aac60d0f6"
```

Both local forms used to be ad-hoc:

- `pnpm dev` launches Electron's downloaded `Electron.app`, which arrives **linker-signed ad-hoc** with no internal requirements, from a pnpm store path that carries the Electron version (`node_modules/.pnpm/electron@43.4.0/…/Electron`).
- `pnpm package:mac` used `electron-builder.dev.yml` with `identity: "-"`, because the electron fuses are flipped after Electron's own linker signature and Apple Silicon SIGKILLs a fuse-edited binary that is not re-signed.

So the grant was tied to a cdhash that moves on every rebuild and a path that moves on every Electron bump.
The captain was asked for the Claude credential over and over.
No amount of Keychain retry handling in `src/core/` can reach this: it is a code *identity* problem, not a read-failure problem.

## The mechanism

A **self-signed certificate generated on the developer's machine** replaces the ad-hoc signature.
A signature made with a real leaf certificate has a designated requirement that names the certificate, not the build:

```
designated => identifier "com.getinfinitary.infinitary.dev" and certificate leaf = H"<cert sha1>"
```

Nothing in that sentence is a cdhash, a path, or an Electron version, so it survives a rebuild, a `node_modules` wipe, a pnpm store move, and an Electron upgrade.
Both local forms sign with the **same certificate and the same identifier**, so a single "Always Allow" covers the dev run and the local package alike.

`scripts/local-codesign.mjs` owns the material and the invariants:

| what | where |
| --- | --- |
| certificate + PKCS#12 key bundle | `~/.infinitary/local-codesign/` (mode 0600) |
| dedicated keychain (`infinitary-local.keychain-db`) + its generated password | same directory |
| the requirement text, for copy/paste | `~/.infinitary/local-codesign/designated-requirement.txt` |

Nothing is committed, nothing is shared, and nothing is machine-independent.
The directory lives outside the repository *and* outside `node_modules`, so a reinstall cannot take it with it.
Override it with `INFINITARY_LOCAL_CODESIGN_DIR` (tests do).

The load-bearing details:

- **A dedicated keychain, not the login keychain.**
  The login keychain's password is the developer's, so importing into it would have to ask for it.
  A generated keychain with a generated password is created, unlocked, and made non-prompting (`security set-key-partition-list`) with no interaction.
- **The keychain joins the user search list only while codesign runs.**
  `codesign --keychain <file>` narrows the identity lookup to that file, but codesign still resolves the identity through the user search list: off the list it answers `no identity found`, by name or by SHA-1 (`man codesign` says as much).
  A locked file left on the list is what makes git's osxkeychain helper ask, so every signing step goes through `withLocalKeychainOnSearchList`: unlock with the stored secret, add the file to the list, sign, take it off again - on failure too.
  Every worktree shares the one file and the one user search list, so two kernel locks (`O_EXLOCK`/`O_SHLOCK` on open, dropped by the kernel when the process exits - a killed signer leaves no lock behind) keep them apart: `search-list.lock` is held exclusively around each list edit, a few `security` calls and never codesign, because `list-keychains -s` replaces the whole list and two interleaved edits lose one; `signing.lease` is held shared by every signing step for as long as it signs, and the file leaves the list only when an exclusive try on the lease succeeds - when no signer is left.
  So signers never wait for each other (a `pnpm package:mac` in one worktree does not hold up `pnpm dev` in another), the last one out takes the file off, and neither a routine `pnpm dev` nor keychain setup ever pulls it from under a live codesign.
  A signer writes `signing-in-progress` before the file joins and the last one out removes it, so a signer killed mid-step leaves the next `pnpm dev` to take it off; the off-list marker (`search-list-dropped`) is never removed by a signer, because a checkout from before the lease drops the file whenever that marker is missing.
  `create-keychain` adds the file too, and the signing path takes it back off.
  Every rewrite refuses an empty read, so it cannot drop the login keychain.
  The release workflow's throwaway Developer ID keychain edits that same user search list.
  Creating it, putting it first, and deleting it go through `scripts/with-search-list-lock.mjs`, which holds `search-list.lock` for those calls only, so a journeys check signing beside a release cannot lose its own list edit.
  Putting it first also refuses an empty read.
  An install never touches the list.
- **`set-keychain-settings` runs only on a keychain just created.**
  It has no password flag.
  On a locked file (normal after sleep or restart) it opens the password dialog before `unlock-keychain -p` can use the stored secret.
  Unlock never passes `-u`: on this Mac that flag means prompt via the dialog.
- **A keychain that refuses the stored secret is rebuilt from the key bundle.**
  `unlock-keychain -p` refuses a wrong password at once with exit 51 (errSecAuthFailed) and raises no dialog, but nothing else can open that file quietly.
  The PKCS#12 bundle holds the same key and certificate under the stored secret, so the signing path checks that the secret opens the bundle and that its certificate is the stored one, then replaces the keychain with a new one made under the secret and imports the bundle.
  The certificate does not change, so the designated requirement and every grant made against it stay.
  That check gives openssl the secret's file, never the secret on argv.
- **The certificate stays untrusted.**
  Adding trust settings requires an interactive authorization prompt, which would break `pnpm install`.
  Untrusted is fine: `codesign` signs with it, and a designated requirement is a claim about *which leaf certificate signed this code*, not about who trusts that leaf.
  The only consequence is that `security find-identity -v` hides it, which is why the dev overlay needs its own signing hook.

## How each form uses it

| form | who signs | when |
| --- | --- | --- |
| `pnpm dev` | `scripts/prepare-local-codesign.mjs`, from `predev` and `pnpm codesign:local` | only when the dev Electron does not already satisfy `designated-requirement.txt`. That check is `codesign --verify` and does not call `security` against the signing keychain. From `postinstall` the script runs that check alone and never signs |
| `pnpm package:mac` | `scripts/sign-local-mac.mjs`, wired as electron-builder's `mac.sign` hook | after the universal merge and after the fuse flip, which is the only correct point. The hook passes `keychain` so osx-sign signs with `--keychain`, inside the same search-list window |

The dev run's `Electron.app` is signed top-level only, with `--identifier` set to the dev appId; the nested helpers keep the ad-hoc signatures they arrive with.
Keychain work now runs in a utility helper: the ordinary Claude item uses Apple's already-trusted reader, while an explicit native-fallback grant belongs to the helper's identity rather than the main executable's old grant.
The local main-executable identity check therefore does not prove that a native-fallback grant survives helper rebuilds.
The local package is signed inside-out by `@electron/osx-sign` - electron-builder's own signer, reached through electron-builder - with the local identity substituted for the placeholder.

Release builds do not touch any of this.
`electron-builder.yml` still signs with the release team's Developer ID certificate (`Developer ID Application: Infinitary Labs, Inc. (Y44V95NP6K)`), hardened runtime, secure timestamps, notarization, and the two-entitlement allowlist; `tests/release-contract.test.ts` pins the bundle configuration and `tests/release-workflows-resolve.test.ts` pins the signing workflow.

## Setup, and recovery

```
pnpm install     # downloads Electron, checks its identity, signs nothing
pnpm dev         # generates the material, signs the dev Electron, runs it
```

That is the whole setup, and it is idempotent.
An install never calls `security`.
A repeat `pnpm dev`, once the dev Electron already satisfies the stored requirement, does not call `security` against the signing keychain and does not re-sign.
`pnpm codesign:verify` reads the same file and does not call `security` either.
If the material is missing, partial, or deleted, the next sign regenerates it.
If the keychain no longer opens with the stored secret, the next sign rebuilds it from the key bundle and keeps the certificate.
Only when the secret opens neither the keychain nor a bundle holding the stored certificate does the next sign regenerate the material.
Regeneration means a **new certificate**, so the old grant no longer matches and macOS asks once more; that is the only cost.

To repair or reset by hand:

```
pnpm codesign:local                   # re-create anything missing, re-sign the dev Electron
pnpm codesign:verify                  # report identity + designated requirement
rm -rf ~/.infinitary/local-codesign   # full reset (costs one fresh grant)
```

## After the Infinitary rename

The certificate is "Infinitary Local Dev", in `~/.infinitary/local-codesign`, and the signing identifier is `com.getinfinitary.infinitary.dev`.
The captain runs `pnpm codesign:local` once before the captain's next `pnpm dev`, which makes Infinitary Local Dev in `~/.infinitary/local-codesign` and signs the dev Electron with it.
A new certificate is a new designated requirement, so macOS asks for the Claude credential once more.
`~/.firstmate-3000/local-codesign` stays as it was, for a rollback: the signer never reads, moves or deletes it.

## Verifying it: the reproducible check

`pnpm codesign:verify` (`scripts/verify-local-codesign.mjs`) prints, for the dev Electron and every `dist/**/*.app` (with `--packaged`, the `dist/` apps alone, which is what `pnpm package:mac` checks), the identifier, the signing authority, the **cdhash**, and the **designated requirement**, and exits non-zero if any of them is ad-hoc or signed by a different certificate.

Run it on both sides of the events that used to break the grant.
The cdhash must move; the designated requirement must not.

```
# 1. baseline
pnpm codesign:verify | tee /tmp/before.txt

# 2. the node_modules / pnpm-store case
rm -rf node_modules && pnpm install && pnpm codesign:local
pnpm codesign:verify | tee /tmp/after-reinstall.txt

# 3. the local-package rebuild case
pnpm package:mac
pnpm codesign:verify | tee /tmp/after-rebuild.txt

# 4. compare
diff <(grep designated: /tmp/before.txt) <(grep designated: /tmp/after-reinstall.txt)   # no output
grep -h 'cdhash:' /tmp/before.txt /tmp/after-rebuild.txt                                # values differ
```

For the Electron-upgrade case, bump `electron` in `package.json`, run `pnpm install` and `pnpm codesign:local`, and run the same check: the store path and the cdhash both move, the designated requirement does not.

To check a requirement directly the way macOS does:

```
codesign --verify --strict -R "=$(cat ~/.infinitary/local-codesign/designated-requirement.txt)" \
  "dist/mac-universal/Infinitary Dev.app"
```

## Verifying the prompt itself (manual, and required)

This section tests the app's ordinary decrypt ACL grant on a development build.
Claude Code's separate `apple-tool:` partition can still refuse a direct app read after Always Allow; the host's guarded Apple-first reader is documented in [quota.md](quota.md).
Do not treat a matching designated requirement alone as proof that a silent Claude value read will succeed.

The automated checks inspect **signatures**.
They do not, and cannot, prove what macOS does with a Keychain grant - that is a decision made by the security daemon in response to a GUI prompt.
Confirm the actual behaviour by hand:

1. Start from a clean slate for the item under test.
   In **Keychain Access** (or Passwords ▸ search), find the `Claude Code-credentials` item, open **Access Control**, and remove any existing "Infinitary Dev" / "Electron" entry.
   Do **not** switch the item to "Allow all applications" - that would hide the very problem this change fixes.
2. `pnpm dev`, then connect the Claude account in Settings so the app reads the credential. macOS prompts.
   Choose **Always Allow**.
3. Quit the app and run `pnpm dev` again; connect again.
   **Expected: no prompt.**
4. `rm -rf node_modules && pnpm install && pnpm dev`, connect again.
   **Expected: no prompt** (`pnpm codesign:verify` should show a new cdhash and the same designated requirement).
5. `pnpm package:mac`, launch `dist/mac-universal/Infinitary Dev.app`, connect.
   **Expected: no prompt** - the packaged app shares the dev run's identifier and certificate, so it is covered by the same grant.
6. Rebuild with `pnpm package:mac` and launch again.
   **Expected: no prompt.**

If a prompt does return, run `pnpm codesign:verify` first: a changed certificate SHA-1 (regenerated material) explains one extra prompt and is expected; an ad-hoc designated requirement means the signing step did not run.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- Local packaging: `pnpm package:mac` (dev overlay; the fuse-flipped binary MUST be re-signed or Apple Silicon SIGKILLs it at exec).
  That re-signature is no longer ad-hoc: ad-hoc code's designated requirement is just its cdhash, and macOS pins Keychain "Always Allow" grants to the designated requirement, so every rebuild and every `pnpm install` re-asked the captain for the Claude credential.
  `pnpm dev` and `pnpm package:mac` now both sign with one machine-local self-signed certificate under the dev appId as the signing identifier (`scripts/local-codesign.mjs`, wired through `predev`, `pnpm codesign:local` and electron-builder's `mac.sign` hook; material lives in `~/.infinitary/local-codesign/` and is never committed).
  An install only checks and never calls `security`; routine dev does not call `security` against that keychain when `designated-requirement.txt` already matches the dev Electron (`codesign --verify` does not use the private key); signing unlocks with `unlock-keychain -p` (never `-u`), calls `set-keychain-settings` only on a keychain just created, and signs with `codesign --keychain` that file inside `withLocalKeychainOnSearchList` - codesign finds no identity in a keychain off the user search list, so the unlocked file joins the list for the signing step only (kernel flocks across worktrees: an exclusive lock around each list edit, a shared lease per signer, the last one out takes it off - `docs/local-code-signing.md`) and leaves it again so git's osxkeychain helper never meets it locked.
  `verify.yml`'s mac lane runs `pnpm test` because those suites are darwin-only.
  Signing must stay at the `sign` hook - electron-builder flips the fuses immediately before it.
  Release signing stays Developer ID only, never a second Apple certificate.
  Its search-list edits hold the same lock as local signing.
  `pnpm codesign:verify` is the before/after check; `docs/local-code-signing.md` carries the manual Keychain procedure that signature checks cannot replace.
  Universal merge requires every identical per-arch Mach-O tree in `mac.x64ArchFiles` (`electron-builder.yml`), including koffi's `@koromix/koffi-darwin-{arm64,x64}` addons (the JS package has no `.node`) and the app's two git trees (`Contents/Resources/git/darwin-{arm64,x64}`); omitting one aborts the merge.
  The Claude SDK's platform binaries are not in that list because they are not in the package at all (F14, `docs/claude-client.md`).
  Release invariants are pinned by `tests/release-contract.test.ts` and the `tests/release-workflows-*.test.ts` files, and `scripts/verify-app.sh` fails a bundle that carries a Claude client.
  `mac.x64ArchFiles` is the ONE single-arch list: verify-app asks `scripts/x64-arch-files.mjs`, which matches it as `@electron/universal` does, so never give the gate a list of its own (v0.1.0 failed its signed gate on exactly that drift).
  A release's post-test stages rehearse without publishing via `gh workflow run release.yml --ref main -f channel=<stable|alpha> -f dry_run=true` (`docs/alpha.md`).
