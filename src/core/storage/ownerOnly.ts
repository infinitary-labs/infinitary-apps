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
  /** Null when the folder has no list at all, which lets everyone in, or none read whole. */
  readonly entries: readonly AccessEntry[] | null;
  /**
   * Whether the descriptor was read whole: its owner, and its list to its end or the list's
   * absence. A reading that is not whole says nothing about the folder, so nothing is set on it.
   */
  readonly whole: boolean;
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

/**
 * Owners that keep a folder this account's: itself, Windows, or the administrators. An owner that
 * could not be read is none of them.
 */
function ownerKeeps(owner: string | null, user: string): boolean {
  if (owner === null) return false;
  const number = accountNumber(owner);
  return number === user || number === "S-1-5-18" || number === "S-1-5-32-544";
}

/**
 * A security descriptor string as Windows writes one, taken apart in order: its owner (`O:`), its
 * group (`G:`), its access list (`D:`) - either `NO_ACCESS_CONTROL`, the one way Windows says a
 * folder has no list, or its flags and entries - and anything of its audit list (`S:`) after.
 */
const DESCRIPTOR =
  /^O:([^:()]+?)(?:G:([^:()]+?))?D:(?:(NO_ACCESS_CONTROL)|((?:P|AI|AR)*)((?:\([^()]*\))*))(?:S:.*)?$/s;

/**
 * Reads a security descriptor string's owner (`O:`) and access list (`D:`), taken apart in order
 * (`DESCRIPTOR`). Only the list's own `NO_ACCESS_CONTROL` says a folder has no list. Anything
 * else - no owner, an owner or group not in Windows' own form (`knownAccount`), no access list at
 * all, a list not read to its end (one holding an entry this reading does not take apart, as a
 * conditional entry with its own brackets, an entry of a kind it does not judge or one whose flags,
 * rights, object fields or account are missing or not in Windows' own form; `ENTRY_TYPES`,
 * `ENTRY_FLAGS`), or text out of that order - reads as not whole (`whole`), which every judgment refuses and nothing repairs, never as
 * the entries it did read nor as a folder with no list.
 */
export function readAccessList(sddl: string): AccessList {
  const read = DESCRIPTOR.exec(sddl);
  if (!read) {
    const owner = /^O:([^:()]+?)(?=[GDS]:|$)/.exec(sddl)?.[1] ?? null;
    return { owner, entries: null, protected: false, whole: false };
  }
  const owner = read[1] ?? null;
  const notWhole = { owner, entries: null, protected: false, whole: false };
  if (!knownAccount(owner ?? "") || (read[2] !== undefined && !knownAccount(read[2])))
    return notWhole;
  if (read[3]) return { owner, entries: null, protected: false, whole: true };
  const flags = read[4] ?? "";
  const entries: AccessEntry[] = [];
  for (const match of (read[5] ?? "").matchAll(/\(([^)]*)\)/g)) {
    const fields = (match[1] ?? "").split(";");
    const [type = "", entryFlags = "", rights = "", object = "", inherited = "", account = ""] =
      fields;
    const objects = type === "OA" || type === "OD" || type === "ZA";
    if (
      fields.length !== 6 ||
      !ENTRY_TYPES.has(type) ||
      !ENTRY_FLAGS.test(entryFlags) ||
      rightsMask(rights) === null ||
      !(objects ? OBJECT_FIELD : NO_OBJECT).test(object) ||
      !(objects ? OBJECT_FIELD : NO_OBJECT).test(inherited) ||
      !knownAccount(account)
    )
      return notWhole;
    entries.push({ type, flags: entryFlags, rights, account, text: match[0] });
  }
  return { owner, entries, protected: flags.includes("P"), whole: true };
}

/**
 * The kinds of entry an access list holds that this reading judges: allow and deny, their object
 * forms and their callback forms. An entry of another kind, or one missing a field it needs (its
 * rights or its account), is an entry this reading did not take apart, so the list is not whole.
 */
const ENTRY_TYPES = new Set(["A", "D", "OA", "OD", "XA", "XD", "ZA"]);

/**
 * What an entry this reading takes apart must say in its other fields, each in the form Windows
 * writes it, so nothing is judged from a field half read: its flags as the pairs Windows names
 * (`hasFlag` reads them pair by pair), its rights as one number or the pairs naming rights
 * (`rightsMask`), its object fields empty, or on the object kinds each empty or one object's
 * number, and its account, as the list's owner and group, a whole account number within Windows'
 * own bounds or one of Windows' own two-letter names for accounts (`knownAccount`).
 */
const ENTRY_FLAGS = /^(?:CI|OI|NP|IO|ID|SA|FA|TP|CR)*$/;
const NO_OBJECT = /^$/;
const OBJECT_FIELD = /^(?:[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})?$/;
const ACCOUNT_LETTERS = new Set(
  (
    "AA AC AN AO AP AS AU BA BG BO BU CA CD CG CN CO CY DA DC DD DG DU EA ED EK ER ES HA HI HO " +
    "IS IU KA LA LG LS LU LW ME MP MU NO NS NU OW PA PO PS PU RA RC RD RE RM RO RS RU SA SI SO " +
    "SS SU SY UD WD WR"
  ).split(" "),
);

/**
 * Whether an account is one Windows could write: one of its two-letter names, or an account number
 * (`S-1-<authority>-<part>...`) of one to fifteen parts, each part a plain number that fits the 32
 * bits Windows gives it, and its authority as Windows writes its 48 bits: a plain number below
 * 2^32, and `0x` with twelve hexadecimal digits from 2^32 up.
 */
function knownAccount(account: string): boolean {
  if (ACCOUNT_LETTERS.has(account)) return true;
  const [s, revision, authority = "", ...parts] = account.split("-");
  if (s !== "S" || revision !== "1" || parts.length < 1 || parts.length > 15) return false;
  const part = (text: string) => /^(?:0|[1-9]\d{0,9})$/.test(text) && Number(text) <= 0xffffffff;
  const wide = /^0[xX][0-9A-Fa-f]{12}$/.test(authority) && Number(authority) > 0xffffffff;
  return (part(authority) || wide) && parts.every(part);
}

/**
 * The rights each of Windows' two-letter names stands for, as the number Windows reads them as, so
 * a right is judged the same however it is written.
 */
const RIGHT_LETTERS: Readonly<Record<string, number>> = {
  GA: 0x10000000,
  GR: 0x80000000,
  GW: 0x40000000,
  GX: 0x20000000,
  RC: 0x20000,
  SD: 0x10000,
  WD: 0x40000,
  WO: 0x80000,
  RP: 0x10,
  WP: 0x20,
  CC: 0x1,
  DC: 0x2,
  LC: 0x4,
  SW: 0x8,
  LO: 0x80,
  DT: 0x40,
  CR: 0x100,
  FA: 0x1f01ff,
  FR: 0x120089,
  FW: 0x120116,
  FX: 0x1200a0,
  KA: 0xf003f,
  KR: 0x20019,
  KW: 0x20006,
  KX: 0x20019,
  NR: 0x1,
  NW: 0x2,
  NX: 0x4,
};

/** The rights an entry's rights field gives, as one number; null where it is not in Windows' form. */
function rightsMask(rights: string): number | null {
  if (/^0x[0-9A-Fa-f]{1,8}$/.test(rights)) return Number.parseInt(rights, 16);
  const pairs = rights.match(/../g);
  if (pairs === null || pairs.join("") !== rights) return null;
  let mask = 0;
  for (const pair of pairs) {
    const right = RIGHT_LETTERS[pair];
    if (right === undefined) return null;
    mask |= right;
  }
  return mask;
}

/** Whether an entry's flags hold `flag`, read as the pairs they are, never across two of them. */
function hasFlag(entry: AccessEntry, flag: string): boolean {
  return (entry.flags.match(/../g) ?? ([] as string[])).includes(flag);
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
 * The verdict on a folder the app keeps private data in: `owner-only` when its
 * list is its own (protected) and lets in no other ordinary account, `unread`
 * when its descriptor was not read whole, which no set may replace, and
 * `other-owner` when another account owns it, whatever its list - a folder
 * with no list included - so nothing is set or written there.
 */
export function ownerOnlyVerdict(
  list: AccessList,
  user: string,
): "owner-only" | "no-list" | "other-owner" | "inherited" | "others" | "unread" {
  if (!list.whole) return "unread";
  if (!ownerKeeps(list.owner, user)) return "other-owner";
  if (list.entries === null) return "no-list";
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
      !hasFlag(entry, "ID") &&
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
