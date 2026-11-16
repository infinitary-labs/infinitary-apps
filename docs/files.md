# Files on another computer

A crewmate reads a file on another of the captain's computers by copying it into its own task's hand-over folder with `infinitary-files-axi` (INF-2468).
It is a plain file transport between the computers Infinitary already connects, in every direction: from the computer where the first mate lives to a computer that runs work, back, and from one computer that runs work to another through the first.
It only reads: nothing writes onto another computer.

The captain chose its reach and its consent on INF-2468.
It reaches any file that computer's user can read, except the app's own sign-ins and keys.
A computer that runs as another macOS user on the home's own Mac reaches the home's files only as that user, outside the captain's private folders (below, "Another user on this Mac").
A copy needs no click: each one adds one line to its task's record.

## The command

`infinitary-files-axi` (`src/core/axi/fileCommands.ts`) is a task command (`docs/axi-commands.md`, "The files command").

- The bare command names each computer, with its role, whether it is in reach, and which one this task runs on.
- `ls <computer>:<folder>` lists one folder, each name with its kind, size and when it changed; the app's own sign-ins and keys show as `protected`.
- `get <computer>:<path>` copies one file into the task's hand-over folder, checks it by its sha256, and prints its path there, where it came from, its size and its sha256.

A computer is named as the crewmate's computers paragraph names it, compared without case, spaces or punctuation, or as `home` for the computer where the first mate lives.
A path is absolute, or starts with `~` for that computer's home folder.
A file on the computer the task runs on is refused with words that say to read it there with the crewmate's own tools.

A crewmate whose shell has the command reads one sentence about it in its computers paragraph (`crewmateComputersNote`, `src/core/pi/piResources.ts`), which also says that a file the command refuses, and a program or action on another computer, stays out of its reach.
Every task on this Mac has it when the host has a command process.
A task on a computer that runs work has it when that computer keeps task browsers and takes current work (`PlacedSessions.takesFiles`).

## How a copy travels

Every computer keeps one `FileReach` (`src/core/files/fileReach.ts`) over its own files.
It lists a folder, sets one file aside whole by copying it into the app's own `file-reach/set-aside/` at 0600, reads that copy in pieces of 4 MB, and lets it go.
A file is set aside before it is read, so it cannot change between pieces.
It is copied from the handle opened to the file that was checked, never through a link at the path's end, and only while the path still names that file: the same device and inode, reached with no link along it.
A link swapped in after the check, for the file or a folder on its path, is refused as a change, with words to ask again; a folder's names are held to the checked folder the same way.
A file that starts with SQLite's header is set aside through the database's own backup, so a database another program has open arrives complete, rows still in its write-ahead log included.
SQLite opens a database, and its log, shared memory and journal beside it, by name, so the database must still be the checked file once SQLite has it open and once the copy is done, and a database with a link for any of those beside it is refused.
A link swapped in just before SQLite's own open and swapped back before the check after it is not seen, since SQLite cannot be handed the file already opened and checked.
A file over 1 GB, the most a hand-over folder takes (`HANDOVER_FILE_BYTES`), an empty file and a folder are refused.

The file is opened, checked and copied in a process of its own, started for that one file and stopped once it answers (`setAsideFile` in `src/core/files/setAside.ts`, run by `src/core/files/setAsideProcess.ts`): an Electron utility process through `HostCapabilities.setAsideProcess` on the home, the same entry on a computer that runs work, and a plain `fork` in tests.
Closing any handle to a file drops every lock its process holds on that file, SQLite's included, so a copy made in the app's own process would drop the app's locks on its own record (`firstmate.db`), its log or its shared memory.
The next program to open the record, such as the query process starting again, would then take it over as its first opener and cut its shared memory to 3 bytes while the app still reads it, and the app's next read would crash.
The path is resolved and checked in the app's own process, which opens nothing, and only a test leaves the separate process out (`FileReachOptions.setAsideProcess`).
A refusal from that process reaches the crewmate in the same words, and a process that stops before it answers is refused as a copy that could not be made.

The home keeps the one `FileRouter` (`src/core/files/fileRouter.ts`), composed by `startHomeFiles` (`src/core/files/homeFiles.ts`), which answers every task's list and copy, wherever the task runs and wherever the file is.

- A file on the home is set aside there.
- A file on a computer that runs work is set aside there by the order `inf:files:snapshot`, read piece by piece with `inf:files:read` into the home's `file-reach/fetched/`, checked against its sha256, and let go with `inf:files:release`.
- The checked copy is delivered into the task's hand-over folder on the computer it runs on (`CrewSessions.deliverHandover`): a copy on the home, or the `inf:session:source-file` order with `into: handover` on a computer that runs work.

A task on a computer that runs work asks the home through its task channel there, with the work requests `inf:work:files` (the computers and a listing) and `inf:work:copy-file` (a copy).
A copy between two computers that run work goes through the home: read from one and delivered to the other.
A copy that does not arrive whole is refused and delivers nothing.

The delivered copy is named by its sha256 and its own name (`handoverFileName`), at 0600 in `crewmates/<task>/temp/handover/`, and goes when its task closes (`docs/task-retention.md`).
A second copy of the same file lands under the same name.
Neither computer keeps its own copy once the file is delivered.
The app also delivers one file unasked through the same `deliverHandover`: an automation rule's notes, into the hand-over folder of a crewmate the rule's run started (`docs/automation.md`, "A rule's notes").
A copy left in `file-reach/` when the app stopped goes before the next one, and a set-aside copy nobody read for ten minutes is let go, since the home that asked for it stopped.

## Files on a card

A crewmate's file for the captain is kept with its task's card copies on the computer it runs on, and the card carries only its reference (`docs/card-authoring.md`, "Files for the captain").
The captain's Save reads it then, and only then: the home reads its own copy in pieces, and a copy on a computer that runs work is set aside there with `inf:files:snapshot`, checked against the card's size and sha256, read with `inf:files:read` and let go with `inf:files:release` once the last piece is served or after two minutes with no piece asked (`CardFileReads`, `src/core/files/cardFileReads.ts`).
The home keeps nothing of it: each piece goes on to the window that asked, which saves it into Downloads on its own computer.
The home asks only for a copy whose name is that file's kept name.
The copy there goes with that task's folder (`docs/task-retention.md`), so a Save after that answers that the app no longer keeps the file.

## What is refused

The command follows that computer's own file permissions, and refuses the app's own sign-ins and keys by place, with links followed, so a link elsewhere that points into one is refused too (`protectedPlaces`).
A place is matched through the folders on it as their links resolve, so one made after the first look is refused too, under a linked folder as well.
It is matched by device and inode too, for the path and every folder above it, so the same folder or file reached by another name is refused: a Mac reaches every folder on its data volume under `/System/Volumes/Data` as well.
A hard link to a refused file, such as `home.json`, is refused the same way, but a hard link to a file inside a refused folder is not, since no folder above it is the refused one.

- In each app data folder, of either flavor under every name the app has had (`USER_DATA_FOLDERS`), the Firstmate 3000 folders the one-time move leaves in place included: `auth`, `accounts`, `forges`, `integrations`, `devices`, `web-sign-ins`, `task-channel`, the phone's door folder, `pi-agent`, `joined` and `decisions`.
- In the folder a computer runs work from: `home.json`, `accounts`, `claude-login.json`, `forges`, `pi-agent`, `task-channel`, `display.auth` and `chromium`.
- Pi's own folder (`~/.pi`), the system's saved passwords (`~/Library/Keychains`, `~/.local/share/keyrings`), and any file named `.credentials.json`.

On a Mac, names compare without case, as its own disk does.
The record and the crewmates' folders stay readable.
A task that is not running has no hand-over folder and is refused, as is a computer out of reach and one whose Infinitary must be updated first.
Every refusal says what to do, never an error code, and nothing is set aside for it.

## Another user on this Mac

A computer that runs work as another macOS user on the home's own Mac (`DevicePairing.onThisMac`: as it joined, or for one listed before the list kept that, from where its connection dials from now) reaches the home's files only as that user, as the words for adding that user say: like every user on the Mac, it reads the captain's home folder outside private folders such as Desktop and Documents (`docs/devices.md`, "Asking the first mate" and "Threats and what meets them").
So a home file one of its tasks lists or copies is read on that computer, by its own `FileReach`, which runs as that user: the home asks it the same orders it asks any computer that runs work, with `~` named as the captain's home folder, and that user's own permissions decide what it reaches.
The home refuses it, before asking and again on the path as that user resolved it, anything in the captain's Desktop, Documents, Library and `~/.ssh`, whatever their permissions and by whatever name (`privateFolders`), and the home's own sign-ins and keys (`FileReach.closedToAnotherUser`); a listing shows them as `protected`.
The copy then travels as any other does, and its record line names the home.
Every other computer, and every task on the home or on another Mac, keeps the full reach the captain chose.

## The record

Each copy adds one line to its task's Activity, such as "copied /Users/me/Documents/clips.csv from Studio Mac into its hand-over folder (6.0 MB)", with the path as that computer resolved it, links followed.
No card is raised.
A copied file may hold secrets: nothing reads its content into words or a log, and the command's help tells the crewmate never to print, quote or paste it.

## The contract

Contract major 14 carries the file orders, published in the contract's `fileOrders` section, the two work requests, and the placed spec's optional `files`.
A home never sends the orders or `files` to a computer on another work major, and a computer never asks the requests of a home that sent it no `files`.
A copy past the shell's limit is kept as every task command's answer is (`docs/axi-commands.md`, "A shell's limit").
A copy cut off by a lost connection answers that the copy may already be in the hand-over folder, and to look there before copying again (`CHANGE_RECOVERY`, `src/core/session/workRecovery.ts`).

## Tests

- `src/core/files/fileReach.test.ts`: one computer's files - a listing with a protected entry, a file set aside and read in pieces that match its sha256 at 0600 and let go, a database in use copied through its backup with every row, the sign-ins refused in any case and through a link with nothing set aside, the sign-ins in an app data folder under the app's older name, and in one made after the first look, refused, a sign-in reached by a second name for the same file refused by its device and inode, and on a Mac the sign-ins and private folders reached under `/System/Volumes/Data` (so the Mac lane runs this file too, `scripts/mac-unit-tests.ts`), a link swapped in after the check refused for a file, a folder on its path, a database and a listing, a database with a link beside it refused, the refusal words, and the protected places of every name and flavor.
- `src/core/files/fileReachLocks.integration.test.ts`: the app's own process, holding a record open as the app does, copies its database, log and shared memory through the real set-aside process, and keeps reading and writing after a fresh program opens the record while it writes; and a refusal and a file whole through that process.
- `src/core/files/fileRouter.test.ts`: the home's side over real readers on scratch homes - the computers' rows, a copy from a computer that runs work into a home task's hand-over folder with its record line, the home's database copied for a task elsewhere, every refusal copying nothing, a copy that did not arrive whole delivering nothing, and a computer that runs as another user on this Mac refused a home file only the captain can read and the captain's private folders, while a task on another computer copies the same file.
- `src/core/devices/pairing.test.ts`, "finds whether a computer listed before that runs on this Mac from where it dials now".
- `src/core/axi/channel.test.ts`, "the infinitary-files-axi command": the real launcher and command process reaching only the granted task's files, and a copy kept past the shell's limit and read with the next look.
- `src/core/pi/piResources.test.ts`: the computers paragraph names the command once the shell has it.
- `src/core/files/cardFileSave.test.ts`: a card's file kept once at 0600 and reused by a later version, the refusals, a Save of the home's copy whole and checked into Downloads, a save that never writes over a file, a copy on a computer that runs work read only on Save and let go after the last piece, and a changed or missing copy saving nothing.
- `src/core/placed/placedOutside.test.ts`, "the files command between this Mac and a computer that runs work": over the real connection, a Pi crewmate on that computer, which joins as another user on this Mac, names the computers, lists a folder on this Mac, copies a file and a database in use into its hand-over folder there, each read there as its own user, and is refused a sign-in and a file in the captain's Documents, with each copy one line on the task's record here; and a task here copies a file from that computer piece by piece, with neither computer keeping a copy and that computer's own sign-ins refused; and a card's file a crewmate there keeps reaches this Mac as its reference alone and saves whole into Downloads only on Save.
