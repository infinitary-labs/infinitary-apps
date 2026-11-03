import { Parser } from "htmlparser2";
import { runKeychainCommand } from "./keychainCommand";
import { KEYCHAIN_READ_TIMEOUT_MS } from "./keychainProcess";

/**
 * Claude Code's macOS item is created by Apple's security tool. Its legacy
 * decrypt ACL can trust both Infinitary and /usr/bin/security, while its *separate*
 * partition ACL allows only apple-tool:. In that case Security.framework
 * can reject Infinitary even after Always Allow. Read through the already trusted
 * Apple tool first; NEVER use it for an item whose ACL has not been checked.
 *
 * The check is the one item's access rules, read in the disposable Keychain process
 * (`darwinKeychain.ts`). It does not list the other saved passwords and does
 * not check each trusted app's signature: that walk is what ran out of time
 * on a Mac whose passwords trust large apps. Fail closed on an unfamiliar
 * layout, a locked store, an ambiguous item, or a missing no-password grant.
 * A background tick must not produce a macOS dialog. No credential is
 * persisted by this adapter. The value read's output is captured, never logged.
 */
const TOOL = "/usr/bin/security";
const SERVICE = "Claude Code-credentials";
const MAX_OUTPUT = 64 * 1024;

type Run = (args: string[]) => Promise<string>;
async function runSecurity(args: string[]): Promise<string> {
  return runKeychainCommand(TOOL, args, {
    timeoutMs: KEYCHAIN_READ_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
  });
}

/** One access-list entry of Claude's item, with no signature verdicts. */
export type ClaudeAclEntry = {
  authorizations: readonly string[];
  requirePassword: boolean;
  description: string;
  applicationPaths: readonly string[];
};

const DECRYPT_AUTHORIZATIONS = [
  "decrypt",
  "derive",
  "export_clear",
  "export_wrapped",
  "mac",
  "sign",
] as const;

function sameAuthorizations(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && right.every((tag) => left.includes(tag));
}

/** SecACLCopyContents returns hex-encoded XML, not the tool's printed description.
 * Accept only the known plist shape and the single Apple-tool partition.
 * No external entities are resolved, and malformed/unknown layouts fail closed.
 */
function hasOnlyAppleToolPartition(description: string): boolean {
  if (description.length > MAX_OUTPUT || !/^(?:[\da-f]{2})+$/i.test(description)) return false;
  const xml = Buffer.from(description, "hex").toString("utf8");
  const expected = ["plist", "dict", "key", "array", "string"];
  const parents = [undefined, "plist", "dict", "dict", "array"];
  const opened: string[] = [];
  const stack: string[] = [];
  const values: Record<string, string> = {};
  let valid = true;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name !== expected[opened.length] || stack.at(-1) !== parents[opened.length])
          valid = false;
        if (name === "plist") {
          if (Object.keys(attributes).length !== 1 || attributes.version !== "1.0") valid = false;
        } else if (Object.keys(attributes).length !== 0) valid = false;
        opened.push(name);
        stack.push(name);
      },
      ontext(text) {
        const name = stack.at(-1);
        if (name === "key" || name === "string") values[name] = (values[name] ?? "") + text;
        else if (text.trim()) valid = false;
      },
      onclosetag(name, implied) {
        if (implied || stack.pop() !== name) valid = false;
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.end(xml);
  return (
    valid &&
    stack.length === 0 &&
    opened.length === expected.length &&
    values.key === "Partitions" &&
    values.string === "apple-tool:"
  );
}

/**
 * The same grant the metadata dump used to require, judged from the one
 * item's entries. An absent partition is the older shape and is allowed;
 * any other partition is not. Unfamiliar entries are the caller's to refuse
 * before this is asked.
 */
export function appleToolMayRead(entries: readonly ClaudeAclEntry[]): boolean {
  const trusted = entries.some(
    (entry) =>
      !entry.requirePassword &&
      sameAuthorizations(entry.authorizations, DECRYPT_AUTHORIZATIONS) &&
      entry.applicationPaths.includes(TOOL),
  );
  const partitions = entries.filter((entry) =>
    sameAuthorizations(entry.authorizations, ["partition_id"]),
  );
  const partition =
    partitions.length === 0 ||
    (partitions.length === 1 && hasOnlyAppleToolPartition(partitions[0]?.description ?? ""));
  return trusted && partition;
}

/** The item, not another entry in the same store, must trust the tool. */
export function toolMayReadClaudeItem(dump: string, account: string): boolean {
  const items = dump.split(/(?=^keychain: )/m);
  const matching = items.filter((item) => {
    const attributes = item.split(/^access: /m)[0] ?? "";
    return (
      /^class: "genp"$/m.test(attributes) &&
      attributes.includes(`"svce"<blob>=${JSON.stringify(SERVICE)}`) &&
      attributes.includes(`"acct"<blob>=${JSON.stringify(account)}`)
    );
  });
  if (matching.length !== 1) return false;
  const entries = matching[0]?.split(/(?=^ {4}entry \d+:)/m).slice(1) ?? [];
  const decrypt = entries.some(
    (entry) =>
      /^ {8}authorizations \(6\): decrypt derive export_clear export_wrapped mac sign$/m.test(
        entry,
      ) &&
      entry.includes("        don't-require-password") &&
      /^\s+\d+: \/usr\/bin\/security \(OK\)$/m.test(entry),
  );
  const partitionEntries = entries.filter((entry) =>
    /^ {8}authorizations \(1\): partition_id$/m.test(entry),
  );
  // Older scratch keychains have no partition entry at all. When there is
  // one, it must grant the Apple tool; an unrelated team's grant is unsafe.
  const partition =
    partitionEntries.length === 0 ||
    (partitionEntries.length === 1 &&
      /^ {8}description: apple-tool:$/m.test(partitionEntries[0] ?? ""));
  return decrypt && partition;
}

/**
 * `refused`: the item does not verifiably trust the tool, so the direct
 * refusal stands. `incomplete`: the tool ran out of time or failed, which says
 * nothing about the item - the next refresh simply tries again.
 */
export type TrustedToolRead =
  | { kind: "value"; value: string }
  | { kind: "refused" }
  | { kind: "incomplete" };

/**
 * Caller must first observe an unlocked store and `appleToolMayRead` on that
 * one item. This reads the value only. It never
 * lists the keychain.
 */
export async function readClaudeThroughTrustedTool(
  account: string,
  keychainPath: string,
  run: Run = runSecurity,
): Promise<TrustedToolRead> {
  if (!keychainPath.startsWith("/") || !/\.keychain(-db)?$/.test(keychainPath)) {
    return { kind: "refused" };
  }
  try {
    const value = await run([
      "find-generic-password",
      "-a",
      account,
      "-s",
      SERVICE,
      "-w",
      keychainPath,
    ]);
    // security -w appends a newline and hex-encodes data containing any
    // non-printable byte (including a pretty-printed JSON newline).
    if (!value.endsWith("\n")) return { kind: "refused" };
    const output = value.slice(0, -1);
    return {
      kind: "value",
      value: /^(?:[\da-f]{2})+$/i.test(output)
        ? Buffer.from(output, "hex").toString("utf8")
        : output,
    };
  } catch {
    return { kind: "incomplete" };
  }
}
