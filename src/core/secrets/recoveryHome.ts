import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CustodyRead, CustodyWrite, SecretCustody } from "./custody";
import { canonical, sha256 } from "./custody";
import { SecretVault } from "./vault";

const headSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
const envelopeSchema = z.strictObject({
  format: z.literal("infinitary-secrets-home/1"),
  generation: z.uuid(),
  root: z.string().refine((text) => {
    const bytes = Buffer.from(text, "base64");
    try {
      return bytes.length === 32 && bytes.toString("base64") === text;
    } finally {
      bytes.fill(0);
    }
  }),
  head: headSchema,
});
type Envelope = z.infer<typeof envelopeSchema>;
type Layout = { kind: "legacy"; root: Buffer } | { kind: "recovered"; envelope: Envelope };

/** An exact native-root observation, not authority to change it. It contains no key. */
export type HomeWitness = { kind: "absent" } | { kind: "value"; digest: string };
export type SecretHome = { dir: string; custody: SecretCustody };
export type HomeRefusal = "locked" | "unavailable" | "lost";

// One native read/modify/write at a time per host capability. This is still the
// single Secrets writer, not a second native adapter or a plaintext fallback.
const writers = new WeakMap<SecretCustody, Promise<unknown>>();
function writing<T>(custody: SecretCustody, run: () => Promise<T>): Promise<T> {
  const next = (writers.get(custody) ?? Promise.resolve()).then(run);
  writers.set(
    custody,
    next.catch(() => {}),
  );
  return next;
}

function layout(bytes: Buffer): Layout | undefined {
  if (bytes.length === 32) return { kind: "legacy", root: bytes };
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? { kind: "recovered", envelope: parsed.data } : undefined;
  } catch {
    return undefined;
  }
}
function identity(found: Layout): string {
  if (found.kind === "legacy") return sha256(found.root);
  const root = Buffer.from(found.envelope.root, "base64");
  try {
    return sha256(root);
  } finally {
    root.fill(0);
  }
}
function witness(read: CustodyRead): HomeWitness | HomeRefusal {
  if (read.kind === "value") return { kind: "value", digest: sha256(read.bytes) };
  return read.kind === "absent" ? { kind: "absent" } : read.kind;
}
function sameWitness(left: HomeWitness, right: HomeWitness): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "absent" || (right.kind === "value" && left.digest === right.digest))
  );
}

/** Missing custody must not initialize over a restored or not-yet-activated generation. */
export async function hasSecretHomeRecords(base: string): Promise<boolean> {
  if (await hasProtectedRecords(base)) return true;
  let names: string[];
  try {
    names = await readdir(join(base, "recovered"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  for (const name of names) {
    if (
      z.uuid().safeParse(name).success &&
      (await hasProtectedRecords(join(base, "recovered", name)))
    )
      return true;
  }
  return false;
}

/** History in earlier generations remains until the captain explicitly deletes it. */
export async function secretHistoryFiles(base: string): Promise<string[]> {
  const homes = [base];
  try {
    for (const entry of await readdir(join(base, "recovered"), { withFileTypes: true })) {
      if (entry.isDirectory() && z.uuid().safeParse(entry.name).success)
        homes.push(join(base, "recovered", entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const paths: string[] = [];
  for (const home of homes) {
    for (const entry of await readdir(home, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        (entry.name === "history.jsonl" ||
          (entry.name.startsWith("history.") &&
            (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))))
      )
        paths.push(join(home, entry.name));
    }
  }
  return paths;
}

async function hasProtectedRecords(dir: string): Promise<boolean> {
  if (await SecretVault.hasRecords(dir)) return true;
  try {
    return (await readdir(dir)).some(
      (name) =>
        name === "authority.json" ||
        name === "authority.next.json" ||
        name === "history.jsonl" ||
        (name.startsWith("history.") && (name.endsWith(".jsonl") || name.endsWith(".json"))),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Observe without unlocking, initializing, or returning native bytes to a caller. */
export async function observeSecretHome(
  custody: SecretCustody,
): Promise<HomeWitness | HomeRefusal> {
  let read: CustodyRead | undefined;
  try {
    read = await custody.read("root");
    return witness(read);
  } catch {
    return "unavailable";
  } finally {
    if (read?.kind === "value") read.bytes.fill(0);
  }
}

/**
 * Legacy homes keep their existing two native items and directory. A restored
 * home is selected by its native root item alone: root, authority head and
 * generation are committed in one native write, never an agent-writable file.
 * Older apps see a non-root-sized item and refuse rather than misreading it.
 */
export async function openSecretHome(
  base: string,
  native: SecretCustody,
): Promise<SecretHome | HomeRefusal> {
  let initial: CustodyRead;
  try {
    initial = await native.read("root");
  } catch {
    return "unavailable";
  }
  if (initial.kind === "locked" || initial.kind === "unavailable") return initial.kind;
  const found = initial.kind === "value" ? layout(initial.bytes) : undefined;
  if (initial.kind === "value" && !found) {
    initial.bytes.fill(0);
    return "lost";
  }
  let expectedRoot = found ? identity(found) : undefined;
  const generation = found?.kind === "recovered" ? found.envelope.generation : undefined;
  if (initial.kind === "value") initial.bytes.fill(0);
  const matches = (current: Layout) =>
    identity(current) === expectedRoot &&
    (current.kind === "recovered" ? current.envelope.generation : undefined) === generation;
  const custody: SecretCustody = {
    async read(slot): Promise<CustodyRead> {
      let read: CustodyRead | undefined;
      try {
        read = await native.read("root");
        if (read.kind !== "value") return read;
        const current = layout(read.bytes);
        // A different home never lends its root or head to this old directory.
        if (!current || !matches(current)) return { kind: "unavailable" };
        if (slot === "root") {
          return {
            kind: "value",
            bytes:
              current.kind === "legacy"
                ? Buffer.from(current.root)
                : Buffer.from(current.envelope.root, "base64"),
          };
        }
        return current.kind === "legacy"
          ? await native.read(slot)
          : {
              kind: "value",
              bytes: Buffer.from(canonical(current.envelope.head)),
            };
      } catch {
        return { kind: "unavailable" };
      } finally {
        if (read?.kind === "value") read.bytes.fill(0);
      }
    },
    write(slot, bytes): Promise<CustodyWrite> {
      return writing(native, async () => {
        let read: CustodyRead | undefined;
        try {
          read = await native.read("root");
          if (read.kind === "locked" || read.kind === "unavailable") return read.kind;
          if (slot === "root") {
            // Only the initial root creation uses this path. Restore uses commitSecretHome.
            if (read.kind !== "absent" || expectedRoot !== undefined || bytes.length !== 32)
              return "unavailable";
            const result = await native.write(slot, bytes);
            if (result === "stored") expectedRoot = sha256(bytes);
            return result;
          }
          if (read.kind !== "value") return "unavailable";
          const current = layout(read.bytes);
          if (!current || !matches(current)) return "unavailable";
          if (current.kind === "legacy") return await native.write(slot, bytes);
          const head = headSchema.safeParse(JSON.parse(bytes.toString("utf8")));
          if (!head.success) return "unavailable";
          const updated = Buffer.from(canonical({ ...current.envelope, head: head.data }));
          try {
            return await native.write("root", updated);
          } finally {
            updated.fill(0);
          }
        } finally {
          // A rejected write may already have changed native custody. Let the
          // authority owner retain its pending record and reconcile on reopen.
          if (read?.kind === "value") read.bytes.fill(0);
        }
      });
    },
  };
  return { dir: generation ? join(base, "recovered", generation) : base, custody };
}

export type HomeCommit = "committed" | "changed" | "invalid" | "locked" | "unavailable" | "unknown";

/**
 * Private recovery writer. The caller has authenticated and synced every file
 * in this generation before calling. The native write is the only activation
 * point: a crash before it retains the old home; afterwards reopen selects the
 * complete new one. An uncertain write is reconciled by reading, never replayed.
 * Staged files must be kept on an unknown result.
 */
export function commitSecretHome(
  native: SecretCustody,
  expected: HomeWitness,
  stage: { generation: string; root: Buffer; head: Buffer },
): Promise<HomeCommit> {
  // Snapshot caller-owned buffers before yielding to another writer.
  const root = Buffer.from(stage.root);
  const head = Buffer.from(stage.head);
  const generation = stage.generation;
  const expectedHome = structuredClone(expected);
  return writing(native, async () => {
    let encoded: Buffer | undefined;
    try {
      let value: unknown;
      try {
        value = {
          format: "infinitary-secrets-home/1",
          generation,
          root: root.toString("base64"),
          head: JSON.parse(head.toString("utf8")),
        };
      } catch {
        return "invalid";
      }
      const parsed = envelopeSchema.safeParse(value);
      if (!parsed.success) return "invalid";
      encoded = Buffer.from(canonical(parsed.data));
      let before: HomeWitness | HomeRefusal;
      let previous: CustodyRead | undefined;
      try {
        previous = await native.read("root");
        before = witness(previous);
        if (previous.kind === "value") {
          const current = layout(previous.bytes);
          if (current && identity(current) === sha256(root)) return "invalid";
        }
      } catch {
        return "unavailable";
      } finally {
        if (previous?.kind === "value") previous.bytes.fill(0);
      }
      if (typeof before === "string") return before === "lost" ? "unavailable" : before;
      if (!sameWitness(before, expectedHome)) return "changed";
      let result: CustodyWrite | undefined;
      try {
        result = await native.write("root", encoded);
      } catch {
        // A lost response is not a refusal, even if readback still sees the
        // old root: the already-sent native write may finish later.
      }
      const after = await observeSecretHome(native);
      if (typeof after !== "string" && after.kind === "value" && after.digest === sha256(encoded))
        return "committed";
      if (
        typeof after !== "string" &&
        sameWitness(after, before) &&
        result !== undefined &&
        result !== "stored"
      )
        return result;
      return "unknown";
    } finally {
      root.fill(0);
      head.fill(0);
      encoded?.fill(0);
    }
  });
}
