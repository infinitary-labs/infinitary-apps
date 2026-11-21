import { spawn } from "node:child_process";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostEnv } from "../hostEnv";

/**
 * Owner-only folders on Windows (docs/windows-private-files.md).
 *
 * A Mac or Linux computer keeps a private file to its owner with its mode
 * (0600, 0700), which every writer here already passes. Windows ignores those
 * modes: a file there gets the access list it inherits from where it is, and a
 * folder outside the person's profile - another drive, or `C:\` itself -
 * lets every account on the PC read what it holds. So on Windows the app gives
 * each folder it keeps private data in an access list of its own, protected
 * from what its parent would hand down, that grants only this account; every
 * file and folder the app writes below it takes that list. A folder the app
 * cannot make so - a drive with no access lists, a folder another account
 * owns - is an unsafe place, and the app refuses it.
 *
 * Windows' own PowerShell reads and writes the lists, as security descriptor
 * strings (SDDL): a closed, typed form, so the judgment here never reads a
 * name in the PC's language.
 */

/** One access control entry: `(type;flags;rights;object;inherited object;account)`. */
export type AccessEntry = {
  readonly type: string;
  readonly flags: string;
  readonly rights: string;
  readonly account: string;
  readonly text: string;
};

/** A folder's owner and access list, read from its security descriptor string. */
export type AccessList = {
  readonly owner: string | null;
  /** Null when the folder has no list at all, which lets everyone in. */
  readonly entries: readonly AccessEntry[] | null;
  /** Whether the list is protected from what the parent hands down (`P`). */
  readonly protected: boolean;
};

/** SDDL's short names for the accounts a judgment meets, with their numbers. */
const SHORT_ACCOUNTS: Readonly<Record<string, string>> = {
  SY: "S-1-5-18",
  BA: "S-1-5-32-544",
  CO: "S-1-3-0",
  OW: "S-1-3-4",
  AC: "S-1-15-2-1",
};

function accountNumber(account: string): string {
  return SHORT_ACCOUNTS[account] ?? account;
}

/**
 * Accounts that may hold access besides this one: Windows itself (SYSTEM),
 * the PC's administrators, who can take any file anyway, and the creator and
 * owner placeholders, which stand for this account on what it makes here.
 * An app package's number (`S-1-15-…`) only narrows a process this account
 * runs: Windows checks it together with the account, so it opens nothing to
 * another account.
 */
function accountMayHold(account: string, user: string): boolean {
  const number = accountNumber(account);
  if (number === user) return true;
  if (["S-1-5-18", "S-1-5-32-544", "S-1-3-0", "S-1-3-4"].includes(number)) return true;
  return number.startsWith("S-1-15-");
}

/** Owners that keep a folder this account's: itself, Windows, or the administrators. */
function ownerKeeps(owner: string | null, user: string): boolean {
  if (owner === null) return true;
  const number = accountNumber(owner);
  return number === user || number === "S-1-5-18" || number === "S-1-5-32-544";
}

/** Reads a security descriptor string's owner (`O:`) and access list (`D:`). */
export function readAccessList(sddl: string): AccessList {
  const owner = /O:([^:()]+?)(?=[GDS]:|$)/.exec(sddl)?.[1] ?? null;
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl || /D:NO_ACCESS_CONTROL/.test(sddl)) return { owner, entries: null, protected: false };
  const flags = dacl[1] ?? "";
  const entries = [...(dacl[2] ?? "").matchAll(/\(([^)]*)\)/g)].map((match) => {
    const fields = (match[1] ?? "").split(";");
    return {
      type: fields[0] ?? "",
      flags: fields[1] ?? "",
      rights: fields[2] ?? "",
      account: fields[5] ?? "",
      text: match[0],
    };
  });
  return { owner, entries, protected: flags.includes("P") };
}

/** An entry that lets an account in: allow, object allow and the callback forms of them. */
function allows(entry: AccessEntry): boolean {
  return entry.type === "A" || entry.type === "OA" || entry.type === "XA" || entry.type === "ZA";
}

/** Whether `user` is the only ordinary account that can reach what the list guards. */
export function onlyOwnerReaches(list: AccessList, user: string): boolean {
  if (list.entries === null) return false;
  if (!ownerKeeps(list.owner, user)) return false;
  return list.entries.every((entry) => !allows(entry) || accountMayHold(entry.account, user));
}

/**
 * Rights that let an account remove, rename or re-permit what a folder holds, or the folder
 * itself: delete, delete a child, change the list or owner, or all of them.
 */
const CHANGE_MASK = 0x10000 | 0x40 | 0x40000 | 0x80000 | 0x10000000;
const CHANGE_LETTERS = new Set(["GA", "FA", "SD", "DT", "WD", "WO"]);

function letsChange(rights: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(rights)) return (Number.parseInt(rights, 16) & CHANGE_MASK) !== 0;
  return (rights.match(/../g) ?? []).some((letters) => CHANGE_LETTERS.has(letters));
}

/**
 * Whether an account besides this one, Windows and the administrators could remove, rename or
 * re-permit what a folder holds, or the folder itself: an owner that is none of them nor a
 * Windows service, no list at all, or an entry on the folder itself (not one only handed down)
 * giving another account such a right. Reading or adding entries alone changes nothing there.
 */
export function othersCanChange(list: AccessList, user: string): boolean {
  if (list.entries === null) return true;
  if (!ownerKeeps(list.owner, user) && !accountNumber(list.owner ?? "").startsWith("S-1-5-80-"))
    return true;
  return list.entries.some(
    (entry) =>
      allows(entry) &&
      !entry.flags.includes("IO") &&
      !accountMayHold(entry.account, user) &&
      letsChange(entry.rights),
  );
}

/**
 * The verdict on a folder the app keeps private data in: `owner-only` when its
 * list is its own (protected) and lets in no other ordinary account.
 */
export function ownerOnlyVerdict(
  list: AccessList,
  user: string,
): "owner-only" | "no-list" | "other-owner" | "inherited" | "others" {
  if (list.entries === null) return "no-list";
  if (!ownerKeeps(list.owner, user)) return "other-owner";
  if (!onlyOwnerReaches(list, user)) return "others";
  if (!list.protected) return "inherited";
  return "owner-only";
}

/**
 * The access list that makes a folder owner-only: protected from its parent,
 * full control for this account on the folder and everything made in it, and
 * every entry the folder set itself that stays allowed - a deny, or an app
 * package's narrowing - kept, denies first as Windows orders them.
 */
export function ownerOnlyAccessList(list: AccessList, user: string): string {
  const kept = (list.entries ?? []).filter(
    (entry) =>
      !entry.flags.includes("ID") &&
      (!allows(entry) ||
        (accountMayHold(entry.account, user) && accountNumber(entry.account) !== user)),
  );
  const denies = kept.filter((entry) => !allows(entry)).map((entry) => entry.text);
  const others = kept.filter(allows).map((entry) => entry.text);
  return `D:P${denies.join("")}(A;OICI;FA;;;${user})${others.join("")}`;
}

/** What one PowerShell run is asked: lists to set, then folders to read. */
export type AccessAsk = {
  readonly set: readonly { readonly path: string; readonly sddl: string }[];
  readonly read: readonly string[];
};

/** What it answers: this account's number, each set's failure and each folder's descriptor. */
export type AccessAnswer = {
  readonly user: string;
  readonly set: readonly { readonly path: string; readonly error: string | null }[];
  readonly read: readonly {
    readonly path: string;
    readonly sddl: string | null;
    readonly error: string | null;
  }[];
};

export type AccessRun = (ask: AccessAsk) => Promise<AccessAnswer>;

/**
 * The PowerShell that answers an `AccessAsk`, given as JSON in
 * `INFINITARY_ACCESS_ASK` so no path is ever quoted into the script. A set
 * writes only the access list (never the owner), and Windows hands the new
 * list down to what the folder already holds. Its answer is plain ASCII, every
 * other letter written as a JSON escape: Windows PowerShell prints in the
 * console's old code page, where a path such as `C:\Users\José` would come
 * back garbled. Each answer is in the order it was asked.
 */
const ACCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ask = $env:INFINITARY_ACCESS_ASK | ConvertFrom-Json
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sets = New-Object System.Collections.ArrayList
foreach ($s in @($ask.set)) {
  if ($null -eq $s) { continue }
  try {
    $sec = New-Object System.Security.AccessControl.DirectorySecurity
    $sec.SetSecurityDescriptorSddlForm($s.sddl, [System.Security.AccessControl.AccessControlSections]::Access)
    [System.IO.Directory]::SetAccessControl($s.path, $sec)
    [void]$sets.Add(@{ path = $s.path; error = $null })
  } catch {
    [void]$sets.Add(@{ path = $s.path; error = $_.Exception.Message })
  }
}
$reads = New-Object System.Collections.ArrayList
foreach ($p in @($ask.read)) {
  if ($null -eq $p) { continue }
  try {
    $sddl = (Get-Acl -LiteralPath $p).Sddl
    [void]$reads.Add(@{ path = $p; sddl = $sddl; error = $null })
  } catch {
    [void]$reads.Add(@{ path = $p; sddl = $null; error = $_.Exception.Message })
  }
}
$json = ConvertTo-Json -InputObject @{ user = $user; set = @($sets); read = @($reads) } -Depth 4 -Compress
[regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
`;

/** Windows' own PowerShell, by its path, so a different one earlier on the search path never answers. */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** PowerShell's `-EncodedCommand`: the script in UTF-16LE, base64. */
export function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * How long a run that only reads may take before it counts as failed;
 * PowerShell starts in about a second. A run that sets a list has no limit:
 * Windows hands the list down to every file the folder holds, and ending it
 * part way would leave some of them with their old lists.
 */
const ACCESS_RUN_WAIT_MS = 60_000;

function asArray<T>(value: T | readonly T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value as T];
}

/** Runs `ACCESS_SCRIPT` with Windows' own PowerShell. */
export const powerShellAccess: AccessRun = (ask) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      windowsPowerShell(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand(ACCESS_SCRIPT),
      ],
      {
        env: { ...hostEnv(), INFINITARY_ACCESS_ASK: JSON.stringify(ask) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err += chunk;
    });
    const timer =
      ask.set.length === 0 ? setTimeout(() => child.kill(), ACCESS_RUN_WAIT_MS) : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`PowerShell ended with ${code}: ${err.trim()}`));
        return;
      }
      try {
        const answer = JSON.parse(out) as AccessAnswer;
        resolve({ user: answer.user, set: asArray(answer.set), read: asArray(answer.read) });
      } catch {
        reject(new Error(`PowerShell answered no access lists: ${err.trim()}`));
      }
    });
  });

/** A folder's state once the app has kept it: private, or why not. */
export type KeptFolder =
  | { readonly kind: "owner-only"; readonly path: string; readonly changed: boolean }
  | {
      readonly kind: "unsafe";
      readonly path: string;
      /** `unread`: Windows could not be asked; `unfinished`: a set did not finish. */
      readonly why: "no-list" | "other-owner" | "inherited" | "others" | "unread" | "unfinished";
      readonly detail?: string;
    };

/**
 * The file a folder holds while its new list is being handed down to what it
 * already held. Windows changes the folder's own list first, so a hand-down
 * that stopped part way - the app ended, the PC shut down, Windows answered an
 * error - leaves a folder that reads owner-only over files that may not be;
 * while this file is there, the next launch sets the list again.
 */
export const UNFINISHED_MARK = ".owner-only-unfinished";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes each folder owner-only (creating it if missing) and answers what each
 * became. A folder already owner-only is left as it is, unless an earlier set
 * of its list did not finish (`UNFINISHED_MARK`). One read - with any `look`
 * folders, which are only judged, never changed - then one set and one read
 * again only where a list had to change.
 */
export async function keepOwnerOnly(
  folders: readonly string[],
  run: AccessRun = powerShellAccess,
  look: readonly string[] = [],
): Promise<{ kept: KeptFolder[]; othersReach: (folder: string) => boolean }> {
  for (const folder of folders) await mkdir(folder, { recursive: true });
  const asked = [...folders, ...look];
  let first: AccessAnswer;
  try {
    first = await run({ set: [], read: asked });
  } catch (error) {
    return {
      kept: folders.map((path) => ({
        kind: "unsafe",
        path,
        why: "unread",
        detail: (error as Error).message,
      })),
      othersReach: () => true,
    };
  }
  const user = first.user;
  // Answers are matched to what was asked by their order, never by the path
  // printed back, so no spelling of a path can lose its answer.
  const lists = new Map(asked.map((path, index) => [path, first.read[index]]));
  const changes: { path: string; sddl: string }[] = [];
  for (const folder of folders) {
    const read = lists.get(folder);
    if (!read?.sddl) continue;
    const list = readAccessList(read.sddl);
    const verdict = ownerOnlyVerdict(list, user);
    if (verdict === "others" || verdict === "inherited" || verdict === "no-list")
      changes.push({ path: folder, sddl: ownerOnlyAccessList(list, user) });
    else if (verdict === "owner-only" && (await exists(join(folder, UNFINISHED_MARK))))
      changes.push({ path: folder, sddl: ownerOnlyAccessList(list, user) });
  }
  let second: AccessAnswer | null = null;
  if (changes.length > 0) {
    try {
      for (const change of changes) await writeFile(join(change.path, UNFINISHED_MARK), "");
      second = await run({
        set: changes.map(({ path, sddl }) => ({ path, sddl })),
        read: changes.map((change) => change.path),
      });
    } catch (error) {
      second = {
        user,
        set: changes.map((change) => ({ path: change.path, error: (error as Error).message })),
        read: [],
      };
    }
  }
  const after = new Map(changes.map((change, index) => [change.path, second?.read[index]]));
  const setErrors = new Map(
    changes.map((change, index) => [change.path, second?.set[index]?.error ?? null]),
  );
  const kept = folders.map((path): KeptFolder => {
    const changed = changes.some((each) => each.path === path);
    const read = changed ? after.get(path) : lists.get(path);
    const verdict = read?.sddl ? ownerOnlyVerdict(readAccessList(read.sddl), user) : null;
    const setError = changed ? setErrors.get(path) : null;
    if (setError) {
      // Windows took the folder's own list but stopped handing it down, so
      // its files may not be private; one whose list did not change is the
      // place refusing it, as a drive with no access lists does.
      if (verdict && verdict !== "owner-only")
        return { kind: "unsafe", path, why: verdict, detail: setError };
      return { kind: "unsafe", path, why: "unfinished", detail: setError };
    }
    if (!verdict) return { kind: "unsafe", path, why: "unread", detail: read?.error ?? undefined };
    if (verdict === "owner-only") return { kind: "owner-only", path, changed };
    return { kind: "unsafe", path, why: verdict };
  });
  for (const folder of kept)
    if (folder.kind === "owner-only" && folder.changed)
      await rm(join(folder.path, UNFINISHED_MARK), { force: true });
  return {
    kept,
    othersReach: (folder) => {
      const sddl = lists.get(folder)?.sddl;
      return !sddl || !onlyOwnerReaches(readAccessList(sddl), user);
    },
  };
}

/** The folder a Windows data folder keeps temporary files in when the system's is not private. */
export const PRIVATE_TEMP_DIR = "private-temp";

/**
 * Clears what earlier launches left in the data folder's own temporary
 * folder, which Windows' cleanup never reaches. Only the launch that holds the
 * data folder runs it, before anything it starts writes there; a file still
 * open somewhere is left for the next launch.
 */
export async function clearPrivateTemp(temp: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(temp);
  } catch {
    return;
  }
  for (const name of names)
    await rm(join(temp, name), { recursive: true, force: true }).catch(() => {});
}

/** The data folder kept private, or why it cannot be; and where temporary files now go, if moved. */
export type DataFolderPrivacy = {
  readonly refused: Extract<KeptFolder, { kind: "unsafe" }> | null;
  readonly temp: string | null;
};

/**
 * On Windows, before anything opens it: makes the data folder owner-only, or
 * refuses it as an unsafe place; and where the system's temporary folder lets
 * another account in - one moved outside the profile - points this app and
 * every program it starts (`TEMP`, `TMP`) at a folder inside the data folder,
 * which takes its owner-only list. Elsewhere the modes already do this, and
 * nothing is read or changed.
 */
export async function keepDataFolderPrivate(options: {
  platform: NodeJS.Platform;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  tempDir: string;
  run?: AccessRun;
}): Promise<DataFolderPrivacy> {
  if (options.platform !== "win32") return { refused: null, temp: null };
  const { kept, othersReach } = await keepOwnerOnly([options.dataDir], options.run, [
    options.tempDir,
  ]);
  const data = kept[0];
  if (!data || data.kind === "unsafe")
    return { refused: data && data.kind === "unsafe" ? data : null, temp: null };
  if (!othersReach(options.tempDir)) return { refused: null, temp: null };
  const temp = join(options.dataDir, PRIVATE_TEMP_DIR);
  await mkdir(temp, { recursive: true });
  options.env.TEMP = temp;
  options.env.TMP = temp;
  return { refused: null, temp };
}
