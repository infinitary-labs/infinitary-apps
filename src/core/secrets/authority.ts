import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CustodyRead,
  canonical,
  type RootKeys,
  type SecretCustody,
  sha256,
  writePrivateFile,
} from "./custody";
import { validRef } from "./vault";

export type RuleEffect = "never" | "ask" | "allow";

/**
 * One saved rule. `operation` is the operation key of a prepared recipient
 * (`recipient.ts`): the bound program, its snapshot digests, arguments, working
 * folder, variable mapping and delivery. Never and Ask may name no operation
 * (every use of that secret); Allow always names one - there is no wildcard Allow.
 */
export type Rule = {
  id: string;
  effect: RuleEffect;
  secret: string;
  operation?: string;
  /** The captain's own note, shown in rehearsal; never parsed. */
  note?: string;
};

/**
 * A device enrolled to approve from elsewhere (docs/secrets.md, "Remote
 * decisions"): a P-256 public key held for this purpose alone, not the
 * device's paired-view identity. `generation` rises on every re-enrollment so
 * a decision signed under an older enrollment is refused.
 */
export type ApprovalDevice = {
  device: string;
  label: string;
  generation: number;
  /** SPKI DER, base64. */
  publicKey: string;
};

/** The protected record that produces authority: rules, approval devices and the home they bind to. */
export type Authority = {
  /** This enforcing home. A remote decision names it, so it cannot be replayed at another. */
  home: string;
  revision: number;
  rules: Rule[];
  devices: ApprovalDevice[];
};

export type Evaluation = { effect: RuleEffect; matched: string[] };

type Head = { revision: number; digest: string };
type Stored = { authority: Authority; mac: string };

/**
 * The authority record (docs/secrets.md, "Protected rules"). Its check is
 * keyed by custody and its head - revision and digest - lives in custody too,
 * so an agent-written file, an edited one or an older valid one is refused:
 * rules then answer `tampered` and every use is unavailable until the captain
 * saves a new revision with fresh authentication. Saving writes the next record,
 * moves the head, then renames, so an interruption leaves one record that
 * matches the head.
 */
export class ProtectedAuthority {
  private constructor(
    private readonly dir: string,
    private readonly keys: RootKeys,
    private readonly custody: SecretCustody,
    private current: Authority,
  ) {}

  static async load(
    dir: string,
    keys: RootKeys,
    custody: SecretCustody,
  ): Promise<ProtectedAuthority | "tampered" | "locked" | "unavailable"> {
    let head: CustodyRead;
    try {
      head = await custody.read("authority-head");
    } catch {
      return "unavailable";
    }
    if (head.kind === "locked" || head.kind === "unavailable") return head.kind;
    const file = join(dir, "authority.json");
    const next = join(dir, "authority.next.json");
    const stored = await readStored(file);
    if (head.kind === "absent") {
      // A first open: no head was ever stored. A record without a head was not
      // written here; a lone next record is a first open interrupted before
      // its head, which held no rules or devices.
      if (stored !== undefined || (await exists(file))) return "tampered";
      await rm(next, { force: true });
      const fresh: Authority = { home: randomUUID(), revision: 0, rules: [], devices: [] };
      const authority = new ProtectedAuthority(dir, keys, custody, fresh);
      return (await authority.write(fresh)) === "stored" ? authority : "unavailable";
    }
    let expected: Head;
    try {
      expected = JSON.parse(head.bytes.toString("utf8")) as Head;
    } catch {
      return "tampered";
    }
    const matches = (candidate: Stored | undefined) =>
      candidate !== undefined &&
      keys.verify("authority", canonical(candidate.authority), candidate.mac) &&
      candidate.authority.revision === expected.revision &&
      sha256(canonical(candidate.authority)) === expected.digest &&
      validAuthority(candidate.authority);
    if (matches(stored))
      return new ProtectedAuthority(dir, keys, custody, (stored as Stored).authority);
    const pending = await readStored(next);
    if (matches(pending)) {
      await rename(next, file);
      return new ProtectedAuthority(dir, keys, custody, (pending as Stored).authority);
    }
    return "tampered";
  }

  get authority(): Authority {
    return structuredClone(this.current);
  }

  /** What the captain approves before a save: the digest of the next revision. */
  proposal(next: Pick<Authority, "rules" | "devices">): { authority: Authority; digest: string } {
    const authority: Authority = {
      home: this.current.home,
      revision: this.current.revision + 1,
      rules: next.rules,
      devices: next.devices,
    };
    return { authority, digest: sha256(canonical(authority)) };
  }

  /** Save a revision the caller has already checked fresh authentication for. */
  async save(authority: Authority): Promise<"stored" | "invalid" | "locked" | "unavailable"> {
    if (authority.home !== this.current.home || authority.revision !== this.current.revision + 1)
      return "invalid";
    if (!validAuthority(authority)) return "invalid";
    const written = await this.write(authority);
    if (written === "stored") this.current = structuredClone(authority);
    return written;
  }

  /** Never precedes Ask, then Allow; every required secret must pass; no match asks. */
  evaluate(secrets: string[], operation: string): Evaluation {
    return evaluateRules(this.current.rules, secrets, operation);
  }

  private async write(authority: Authority): Promise<"stored" | "locked" | "unavailable"> {
    const text = canonical(authority);
    const stored: Stored = { authority, mac: this.keys.mac("authority", text) };
    const next = join(this.dir, "authority.next.json");
    await writePrivateFile(next, JSON.stringify(stored));
    let moved: "stored" | "locked" | "unavailable";
    try {
      moved = await this.custody.write(
        "authority-head",
        Buffer.from(JSON.stringify({ revision: authority.revision, digest: sha256(text) })),
      );
    } catch {
      moved = "unavailable";
    }
    if (moved !== "stored") {
      await rm(next, { force: true });
      return moved;
    }
    await rename(next, join(this.dir, "authority.json"));
    return "stored";
  }
}

/** Metadata-only rehearsal and the live check share this one evaluation. */
export function evaluateRules(rules: Rule[], secrets: string[], operation: string): Evaluation {
  const matched: string[] = [];
  const effects = secrets.map((secret) => {
    const applies = rules.filter(
      (rule) =>
        rule.secret === secret && (rule.operation === undefined || rule.operation === operation),
    );
    for (const effect of ["never", "ask", "allow"] as const) {
      const hits = applies.filter((rule) => rule.effect === effect);
      if (hits.length > 0) {
        matched.push(...hits.map((rule) => rule.id));
        return effect;
      }
    }
    return "ask" as const;
  });
  const effect: RuleEffect =
    secrets.length === 0
      ? "ask"
      : effects.includes("never")
        ? "never"
        : effects.every((one) => one === "allow")
          ? "allow"
          : "ask";
  return { effect, matched: [...new Set(matched)] };
}

function validAuthority(authority: Authority): boolean {
  const ids = new Set<string>();
  const devices = new Set<string>();
  return (
    typeof authority.home === "string" &&
    authority.home.length > 0 &&
    Number.isInteger(authority.revision) &&
    authority.revision >= 0 &&
    Array.isArray(authority.rules) &&
    authority.rules.every((rule) => {
      const fresh = typeof rule.id === "string" && rule.id.length > 0 && !ids.has(rule.id);
      ids.add(rule.id);
      return (
        fresh &&
        ["never", "ask", "allow"].includes(rule.effect) &&
        validRef(rule.secret) &&
        (rule.operation === undefined || /^[0-9a-f]{64}$/.test(rule.operation)) &&
        (rule.effect !== "allow" || rule.operation !== undefined) &&
        (rule.note === undefined || typeof rule.note === "string")
      );
    }) &&
    Array.isArray(authority.devices) &&
    authority.devices.every((device) => {
      const fresh = typeof device.device === "string" && !devices.has(device.device);
      devices.add(device.device);
      return (
        fresh &&
        device.device.length > 0 &&
        typeof device.label === "string" &&
        Number.isInteger(device.generation) &&
        device.generation > 0 &&
        typeof device.publicKey === "string" &&
        device.publicKey.length > 0
      );
    })
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readStored(path: string): Promise<Stored | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Stored;
    return parsed && typeof parsed === "object" && parsed.authority ? parsed : undefined;
  } catch {
    return undefined;
  }
}
