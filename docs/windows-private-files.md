# Private files on Windows

A Mac or Linux computer keeps a private file to its owner with its mode: every writer passes `0600` for a file and `0700` for a folder.
Windows ignores those modes.
A file there takes the access list it inherits from where it is, and a folder outside the person's profile, such as one on another drive or at the top of `C:\`, lets every signed-in account on the PC read what it holds.

## The data folder's own list

Before anything writes the data folder, the app gives it an access list of its own on Windows (`keepDataFolderPrivate`, `src/core/storage/ownerOnly.ts`, called from `src/main/app.ts`).
The list is protected from what the parent folder hands down and grants full control to this account alone, on the folder and on everything made in it.
Every private file and folder the app writes lives under the data folder, or in the temporary folder below: the record, sign-ins, accounts, the local door's and the phone door's keys (`src/core/paths.ts`), task channels, working copies, evidence and task folders.
A computer that runs work for another keeps its own folder, and the work mode gives it the same list before it does anything (`prepareOnWindows`, `src/main/work.ts`).
Each takes the folder's owner-only list when it is made, and Windows hands the new list down to what the folder already held.
An entry the folder set itself that opens nothing to another account stays: a deny, or an app package's capability, such as Chromium's network service's grant on its profile, which Windows checks together with this account.

A folder already protected and reaching no other ordinary account is left as it is, so a launch after the first changes nothing.
SYSTEM, the PC's administrators and the creator and owner placeholders may keep an entry, since administrators can take any file anyway.

## An unsafe place

The app refuses a data folder it cannot make owner-only, with the same refusal window as a folder that moved, "Infinitary could not keep this folder private" (`dataFolderRefusal`, `src/core/storage/dataFolderRefusal.ts`).
That is a folder another ordinary account owns, which could change its list back; a drive that keeps no access lists, such as one formatted FAT32 or exFAT; and a folder whose list Windows would not read or write.
A set that failed part way is refused too, even when the folder's own list now reads owner-only, since Windows may have handed the new list down to only some of its files.
Each refusal says which it is: a place that cannot be kept private keeps the words above and the advice to move the folder; a folder Windows could not be asked about, as when a policy blocks Windows PowerShell, says "Infinitary could not check this folder"; and a set that did not finish says "Infinitary could not finish keeping this folder private" (`UNCHECKED_FOLDER_TITLE`, `UNFINISHED_FOLDER_TITLE`).
The reason and Windows' own answer go to the app's log as one `[data folder]` line.
Before a set, the app writes `.owner-only-unfinished` in the folder and removes it once the folder reads owner-only; while it is there, as after a set that failed or a launch that ended during one, the next launch sets the list again (`UNFINISHED_MARK`).
A command run (`<app> run`) ends with the same words.

## The temporary folder

The app writes some private files in the system's temporary folder: short-lived sign-in helpers, a file from outside on its way to a task and a built-in runbook's copy, and every program it starts writes its own temporary files there.
Windows' own temporary folder is inside the profile and reaches no other account.
When it reaches another account, as a `TEMP` moved to `C:\Temp` does, the app points itself and every program it starts at `private-temp` inside the data folder (`TEMP` and `TMP`), which takes the data folder's list.
The system's own temporary folder is only read, never changed.
A launch whose data folder was refused makes no browser profile for a word it would show while another window holds the folder (`wordProfilePrivate`, `docs/run.md`); a launch whose data folder was kept private makes it in the `-word-profiles` folder beside the data folder, which it gives an owner-only access list of its own (`keepOwnerOnly`) or else starts no copy, and the copy's temporary files go in that profile, never in the private temporary folder a holder clears at its start.
Windows' own cleanup never reaches `private-temp`, so the launch that holds the data folder clears what earlier launches left there before it starts anything (`clearPrivateTemp`); a window opened beside a run leaves it to the run, and a file still open elsewhere stays until a later launch.

## How the lists are read and written

Windows' own PowerShell (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`) reads each list with `Get-Acl` and writes only the access list, never the owner, with `Directory.SetAccessControl` (`powerShellAccess`).
Lists travel as security descriptor strings (SDDL), a closed form that names accounts by number, so the judgment never reads an account's name in the PC's language.
The folders and lists travel to PowerShell as JSON in its environment, never quoted into its script.
Its answer comes back as plain ASCII JSON, every other letter escaped, since Windows PowerShell prints in the console's old code page; each answer is matched to what was asked by its order, never by the path printed back.
A run that only reads ends after a minute; a run that writes a list has no limit, since Windows hands the list down to every file the folder holds, working copies included, and ending it part way would leave some with their old lists.
A launch that finds the folder already owner-only runs PowerShell once.

A Mac or Linux computer reads and changes nothing here.
