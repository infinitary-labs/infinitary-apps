# Linux packages

Infinitary is packaged for Linux on x64 as one package for each supported system and an AppImage for every other Linux (captain's install answer on FI3-1432: "per-system packages plus AppImage").
This page is how the packages are made and checked.
Every alpha and stable publishes them at the configured public destination beside the Mac ZIP and disk image, with their checksums, and installed Linux apps update from them (`docs/alpha.md` "Builds by system and chip" and "Updates on Linux").

## What is built

`linux-packages.yml` builds them on Ubuntu 24.04 from `electron-builder.linux.yml`, which extends `electron-builder.yml`:

| System | Package | Made by |
| --- | --- | --- |
| Ubuntu 24.04 and 26.04 | `infinitary-<version>-linux-amd64.deb` | electron-builder |
| Fedora | `infinitary-<version>-linux-x86_64.rpm` | electron-builder |
| Arch and Omarchy | `infinitary-bin`, or `infinitary-alpha-bin` for an alpha | `packaging/linux/aur/PKGBUILD.in` |
| NixOS | `infinitary`, or `infinitary-alpha` for an alpha | `packaging/linux/nix/package.nix.in` |
| Any other Linux | `infinitary-<version>-linux-x86_64.AppImage` | electron-builder |

The app installs to `/opt/infinitary` with the command `infinitary`.
Every package names Infinitary's website, `https://getinfinitary.com/`, as its homepage: the Ubuntu package's `Homepage` and the Fedora package's `URL` come from `extraMetadata.homepage` in `electron-builder.linux.yml`, since electron-builder otherwise names the repository, which is private, and the Arch recipe's `url` and the Nix package's `meta.homepage` are in their templates.
Each package names itself in the app's resources folder, `resources/package-type` (`deb`, `rpm`, `arch` or `nix`), which the update notice reads to know how this installation updates; the deb and rpm get theirs from `packaging/linux/package-type/` through electron-builder's `fpm` option, and the AppImage is told by its runtime instead.
The install folder takes the package's name rather than the app's because Chromium splits a sandbox-helper path that holds a space; people read "Infinitary" in the desktop entry.
Each package carries only Linux's own speech library and koffi's Linux addon, unpacked from the archive.
The electron fuses are the Mac's (`docs/architecture.md` section 4).

## The old program path

Infinitary's packages take the place of `firstmate-3000`, the package of Firstmate 3000, the app's earlier name.
The Ubuntu and Fedora packages each replace, conflict with and provide `firstmate-3000`, through electron-builder's `fpm` option in `electron-builder.linux.yml`: the Ubuntu package's `Replaces`, `Conflicts` and `Provides`, and the Fedora package's `Obsoletes`, `Conflicts` and `Provides`.
So apt or dnf, given the Infinitary package where `firstmate-3000` is installed, takes that package away and installs this one, as an older app does with an update it offers (`src/core/update/linuxInstall.ts`).
Firstmate 3000's package put its program at `/opt/firstmate-3000/firstmate-3000` and its command at `/usr/bin/firstmate-3000`, and an older app starts again from the program it ran from once it installs an update.
So the install script leaves both paths as links to `/opt/infinitary/infinitary`: an older app that installed this package starts Infinitary, and so does what an older app set up to start at login or in the background.
The install script is electron-builder's own with that one step added (`packaging/linux/scripts/after-install.tpl`), and the step leaves a path alone while it still leads to a program elsewhere.
On Ubuntu dpkg runs it once the replaced package is gone, but on Fedora rpm runs it before it takes the replaced package away, which deletes both paths, so the Fedora package makes the links again in `%posttrans`, once its whole transaction is done (`packaging/linux/scripts/rpm-posttrans.sh`).
The removal script (`packaging/linux/scripts/after-remove.tpl`) takes the links away on a removal alone, never on an upgrade, and only while they still lead into `/opt/infinitary`.
`scripts/check-linux-package.sh` checks that both paths lead to the installed program after each Ubuntu and Fedora install.
No check installs a package over Firstmate 3000's yet: each installs on a clean system ("The checks").

## The inbox's command

Each package puts the inbox's command on everyone's search path, so a script runs `infinitary-inbox-axi` by its short name (`docs/integrations.md`, "The inbox").
The Ubuntu and Fedora install script links `/usr/bin/infinitary-inbox-axi` to `/opt/infinitary/resources/axi-bin/infinitary-inbox-axi`, leaving the path alone while it holds something not of this package's, and the removal script takes the link away on a removal alone while it still leads into `/opt/infinitary`.
The Arch package owns the same link, and the Nix package links it in its `bin` to the command in its `lib/infinitary/resources/axi-bin`.
Settings reads the `/usr/bin` link as linked; the Nix link is on the person's path but Settings does not look for it, so it offers the full path.

## Arch, Omarchy and NixOS

The Arch recipe and the Nix package install the release's Ubuntu package, so the two systems run the same bytes as Ubuntu.
`node scripts/linux-recipes.ts render --version <version> --deb <file> --out <dir>` fills their templates with the version, the Ubuntu package's name, its download address and its checksum.
The address comes from `packaging/release-source.json` and the version's `releases/v<version>/` directory on `downloads.getinfinitary.com`, independently of Homebrew (`docs/alpha.md`).
Before storage is configured, release publication selects `RECIPE_HOST=tap` so the recipes and newly installed copies still use the public tap's downloads.
An alpha's Arch version swaps its hyphen for an underscore, as Arch versions take none, and the stable and alpha packages conflict, so only one is installed.
Each recipe takes its channel's package names, the version's own by default, and a release renders alpha's for a stable version too, for when stable is handed to alpha.
Each writes `resources/update-channel.json` with its channel and version beside the app, so its update notice follows its own channel.
Each Arch package provides `infinitary` and `firstmate-3000`, conflicts with `infinitary`, `firstmate-3000` and the other channel's package, and replaces `firstmate-3000` and its own channel's Firstmate 3000 package, `firstmate-3000-bin` or `firstmate-3000-alpha-bin`.
Firstmate 3000's Arch packages provided `firstmate-3000`, so pacman asks to remove the installed one when the Infinitary package is installed; `replaces` acts only on a repository's upgrade, and these recipes install from a file.
The Arch package also owns links at the old program path, `/opt/firstmate-3000/firstmate-3000` and `/usr/bin/firstmate-3000`, to its program ("The old program path").
The Nix package's main program is `infinitary`, and its `bin` links `firstmate-3000` to it.
Nix has no way to say that one package replaces another: `nix-env` refuses to install the Infinitary package beside Firstmate 3000's, whose `firstmate-3000` command it shares, until `nix-env -e` takes the older one away.
Omarchy is Arch with its own desktop, so it takes the Arch recipe.
The Nix package builds against nixpkgs' own libraries with `autoPatchelfHook`, and its wrapper puts its own git on the search path.
Never edit a rendered copy by hand.

## Git

Linux ships no git of its own (`src/core/workspace/bundledGit.ts`): the crew works through the system's.
The Ubuntu, Fedora and Arch packages require `git`, so the system's installer brings it, and the Nix package wraps its own.
An AppImage cannot require anything, so the app asks instead (below).

## Xvfb

Running work for another computer, the app draws its hidden windows on a display of its own (`docs/helper.md`, "No screen needed"), so each package requires Xvfb: `xvfb` for Ubuntu, `xorg-x11-server-Xvfb` for Fedora, `xorg-server-xvfb` for Arch and Omarchy, and the Nix package puts nixpkgs' `xvfb` on its wrapper's search path.
An AppImage cannot require it: its work draws on an X session's display while there is one, and with neither it says to install Xvfb.

## The sandbox

Chromium's sandbox stays on in every package: no package, desktop entry or AppImage passes `--no-sandbox`.
On Ubuntu 24.04 and newer, which restrict user namespaces, the Ubuntu package's install script loads electron-builder's AppArmor profile that allows them; without user namespaces it makes the sandbox helper setuid instead.
Fedora, Arch and NixOS allow user namespaces, so the Arch recipe and the Nix package keep the helper an ordinary program.
An AppImage's launcher turns the sandbox off on a system where it cannot make a user namespace, so the app asks there too.
A computer added by its address on any other Linux system gets the AppImage, with nobody there to ask, so the home refuses to add one where the sandbox would be off and points to the package and a link instead (`docs/devices.md`, "Adding, step by step").
The command for another computer gets the AppImage too, so on such a computer it stops before it asks or gets anything, with the same pointer to the package and a link (`docs/devices.md`, "Joining by a command").
Ubuntu 24.04 and 26.04 added by address get this package instead: the home installs it over SSH, so the profile loads and the sandbox stays on (`docs/devices.md`, "The Ubuntu package").

## What the AppImage needs

An AppImage carries Electron and none of the system's libraries.
Its runtime is FUSE 2's: it opens `libfuse.so.2` and mounts itself with `fusermount`, so a system with only FUSE 3's library cannot start it; `scripts/check-linux-package.sh` runs it unpacked instead (`APPIMAGE_EXTRACT_AND_RUN=1`), since a container has no FUSE.
Electron's program is linked against GTK 3 and the libraries GTK is built on, NSS, GBM, ALSA and libudev, which a desktop has and a server often lacks.
A computer added by its address gets the AppImage with nobody there to install them, so the look reads the dynamic linker's list (`ldconfig -p`) for each and refuses before anything is sent, naming the packages for that system (`docs/devices.md`, "Adding, step by step").
The list is `APPIMAGE_LIBRARIES` in `src/core/devices/farSystems.ts`, read from Electron's program (`readelf -d`); read it again when Electron changes.
A system whose list cannot be read, such as NixOS, which keeps none, is not refused for it.

## What the app checks at start

An installed Linux app checks two things before it opens its window (`src/main/linuxStartup.ts`):

- git is on its search path;
- Chromium's sandbox is on.

When either is missing it asks in a system dialog, Quit by default or Open anyway, saying what to install or which package to use.
A Mac and a run from source never ask, and the app started by a command says them instead of asking (`docs/run.md`).

## The checks

`linux-packages.yml` runs on a pull request that changes how the packages are made, on demand, and inside every release, where `release.yml`'s `linux` job calls it with the release's source commit and version.
There it builds with the notes job's verified catalog and the release's diagnostics settings, and verifies the packaged catalog, as the Mac build does.
It keeps the packages, the two rendered recipes and `SHA256SUMS` as the run's `linux-packages` artifact for three days; the workflow itself uploads them nowhere else, and only a release's publication job, once every check passed, records the files it checked and publishes them.
`scripts/check-linux-package.sh` then installs each one the way a person would, one job a system:

- the Ubuntu package with apt on Ubuntu 24.04 and 26.04 machines themselves, AppArmor's restriction on user namespaces left on;
- the Ubuntu package with apt in clean `ubuntu:24.04` and `ubuntu:26.04` containers;
- the Fedora package with dnf in a clean `fedora:latest` container;
- the Arch recipe, built with `makepkg` and installed with `pacman`, in a clean `archlinux:latest` container;
- the AppImage in a clean `fedora:latest` container with a desktop's libraries and no git, where it must ask for git and quit when told to, and then, with git installed, the journey below;
- the Nix package, built with `nix-build` against nixos-26.05 and run from the Nix store on the runner.

Every job runs on the label the repository variable `LINUX_RUNNER` names, the PC's fresh virtual machines, and the 26.04 machine on that label with `-2604` (`shell-pc-linux-2604`); with the variable unset, each runs on GitHub's hosted Ubuntu of its release (`docs/testing.md`, "Notes").

A container stands in for a clean copy of its system.
It runs privileged so Chromium can make its sandbox's namespaces, and the runner lifts Ubuntu's restriction on user namespaces for it, as Fedora, Arch and NixOS have none; the Ubuntu machine jobs keep the restriction and the package's own profile.

On each, `tests/installed/installed-package.spec.ts` opens the installed app as its desktop entry does, on the runner's virtual screen with a throwaway HOME, profile and mock model provider (`playwright.installed.config.ts`, never the journey suite's).
The release's fuses turn off the Node inspector Playwright's Electron launcher needs, so it reaches the window through Chromium's debugging port (`tests/installed/installedApp.ts`).
It checks that no process of the app runs with `--no-sandbox`, that the app reports the package's version, and that a crewmate takes a task on a project in a worktree the system's git made and reports.
Each job keeps its pictures, the app's output and the results as its own artifact.

## Automatic startup for joined work

Infinitary sets up automatic startup through systemd on Linux, not through every Linux startup system.
A container or another unsupported startup arrangement can keep a successful join without automatic startup.
Devices reports that distinction without promising work at the next login; explicit startup and the kept join are described in [the helper manual](helper.md#in-the-background).
This does not configure container startup or add an adapter for another startup system.
