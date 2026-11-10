import { createHash, createPublicKey, type KeyObject, randomBytes, verify } from "node:crypto";
import type { ApprovalDevice } from "./authority";

/**
 * Host capability: the operating system confirms the person at this computer,
 * now (macOS LocalAuthentication in `src/main/host/darwinFreshAuthentication.ts`,
 * Linux polkit in `src/main/host/linuxFreshAuthentication.ts`). Effects only:
 * `confirm` is true only after the system itself confirmed the person for this
 * one reason, and an adapter never caches a confirmation.
 */
export interface FreshAuthentication {
  /** Whether this computer can confirm the person at all. Not a confirmation. */
  available(): Promise<boolean>;
  confirm(reason: string): Promise<boolean>;
}

/** An opaque, single-use, in-process proof. Only `LocalApprovals.confirm` makes one. */
export type LocalProof = { readonly kind: "local" };

type Held = { subject: string; digest: string; expires: number; used: boolean };

/**
 * Local fresh approval (docs/secrets.md, "Trusted approvals"). The proof is an
 * object only this owner made, held in a private map, bound to one subject
 * and digest, spent on first use and dead at its expiry. A string, a copied
 * object or an agent's file cannot pass, and nothing here is persisted, so no
 * approval survives a restart.
 */
export class LocalApprovals {
  private readonly held = new WeakMap<object, Held>();

  constructor(
    private readonly authentication: FreshAuthentication | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async available(): Promise<boolean> {
    try {
      return (await this.authentication?.available()) === true;
    } catch {
      return false;
    }
  }

  async confirm(
    subject: string,
    digest: string,
    expires: number,
    reason: string,
  ): Promise<LocalProof | undefined> {
    return (await this.confirmEach([{ subject, digest, expires }], reason))?.[0];
  }

  /**
   * One confirmation for changes the person approved together on one card, such
   * as running a use now and saving it as a decision: each proof still binds its
   * own subject and digest and is spent once, and none is made unless every
   * one is still live once the system confirmed the person.
   */
  async confirmEach(
    subjects: readonly { subject: string; digest: string; expires: number }[],
    reason: string,
  ): Promise<LocalProof[] | undefined> {
    const live = () => subjects.every(({ expires }) => this.now() < expires);
    if (!this.authentication || subjects.length === 0 || !live()) return undefined;
    let confirmed = false;
    try {
      confirmed = (await this.authentication.confirm(reason)) === true;
    } catch {
      // A failed or cancelled confirmation reveals nothing and approves nothing.
    }
    if (!confirmed || !live()) return undefined;
    return subjects.map(({ subject, digest, expires }) => {
      const proof: LocalProof = Object.freeze({ kind: "local" });
      this.held.set(proof, { subject, digest, expires, used: false });
      return proof;
    });
  }

  consume(proof: unknown, subject: string, digest: string): boolean {
    if (!proof || typeof proof !== "object") return false;
    const held = this.held.get(proof);
    if (
      !held ||
      held.used ||
      held.subject !== subject ||
      held.digest !== digest ||
      this.now() >= held.expires
    )
      return false;
    held.used = true;
    return true;
  }
}

/** A decision another enrolled device signed with its approval key. */
export type RemoteDecision = {
  kind: "remote";
  device: string;
  generation: number;
  nonce: string;
  /** ECDSA P-256 over SHA-256 of `decisionMessage`, DER, base64. */
  signature: string;
};

export type DecisionFields = {
  home: string;
  device: string;
  generation: number;
  request: string;
  digest: string;
  nonce: string;
  expires: number;
};

/** The first line of every decision a device signs; a new layout is a new number. */
export const DECISION_FORMAT = "infinitary-secrets-decision/1";
/**
 * The bindings a decision names, in the order they are signed. The phone builds
 * the same bytes from this list (scripts/generate-phone-contract.ts), so the
 * order has one owner.
 */
export const DECISION_BINDINGS = [
  "home",
  "device",
  "generation",
  "request",
  "digest",
  "nonce",
  "expires",
] as const satisfies readonly (keyof DecisionFields)[];
/** The last line: a signed decision only ever allows. A refusal needs no key. */
export const DECISION_ALLOW = "decision:allow";

/** The exact bytes a device signs: every binding on its own line, so none can be confused for another. */
export function decisionMessage(fields: DecisionFields): string {
  return [
    DECISION_FORMAT,
    ...DECISION_BINDINGS.map((binding) => `${binding}:${fields[binding]}`),
    DECISION_ALLOW,
  ].join("\n");
}

/** Whether a P-256 SPKI (DER, base64) is a key an approval device may enroll. */
export function approvalKey(publicKey: string): KeyObject | undefined {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      ? key
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The check every remote decision passes: an ECDSA P-256 signature, DER,
 * over SHA-256 of `decisionMessage`. `RemoteApprovals.consume` calls it with
 * the challenge it kept; it is exported so the phone's signer is checked
 * against this same code (InfinitaryKit's Fixtures/secrets.json).
 */
export function verifyDecision(
  publicKey: string,
  fields: DecisionFields,
  signature: string,
): boolean {
  const key = approvalKey(publicKey);
  if (!key) return false;
  try {
    return verify(
      "sha256",
      Buffer.from(decisionMessage(fields)),
      { key, dsaEncoding: "der" },
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * What the captain compares on both screens before a device is enrolled:
 * eight digits from SHA-256 of the offered key's SPKI, computed by each side
 * from the key it holds. A different device offering its own key shows a
 * different code. The phone computes it the same way (checked by
 * InfinitaryKit's Fixtures/secrets.json).
 */
export function approvalCode(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest();
  const digits = String(digest.readUInt32BE(0) % 100_000_000).padStart(8, "0");
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

type Challenge = { nonce: string; digest: string; expires: number; used: boolean };

/**
 * Authenticated remote decisions (docs/secrets.md, "Remote decisions"). A
 * request gets one random nonce; a decision passes only when an enrolled
 * device, at its current generation, signed this home, request, digest, nonce
 * and expiry. Being a paired view is not enough. Racing decisions spend the
 * nonce once. Challenges live in memory, so none survives a restart.
 */
export class RemoteApprovals {
  private readonly challenges = new Map<string, Challenge>();

  constructor(private readonly now: () => number = Date.now) {}

  challenge(request: string, digest: string, expires: number): { nonce: string } | undefined {
    if (this.now() >= expires) return undefined;
    const kept = this.challenges.get(request);
    if (kept && !kept.used && kept.digest === digest) return { nonce: kept.nonce };
    const nonce = randomBytes(32).toString("base64url");
    this.challenges.set(request, { nonce, digest, expires, used: false });
    return { nonce };
  }

  /** The device that decided, or nothing when the decision does not pass. */
  consume(
    decision: unknown,
    fields: { home: string; request: string; digest: string; devices: ApprovalDevice[] },
  ): string | undefined {
    if (!isRemoteDecision(decision)) return undefined;
    const kept = this.challenges.get(fields.request);
    if (
      !kept ||
      kept.used ||
      kept.digest !== fields.digest ||
      kept.nonce !== decision.nonce ||
      this.now() >= kept.expires
    )
      return undefined;
    const device = fields.devices.find((one) => one.device === decision.device);
    if (!device || device.generation !== decision.generation) return undefined;
    const passed = verifyDecision(
      device.publicKey,
      {
        home: fields.home,
        device: device.device,
        generation: device.generation,
        request: fields.request,
        digest: fields.digest,
        nonce: kept.nonce,
        expires: kept.expires,
      },
      decision.signature,
    );
    if (!passed || kept.used) return undefined;
    kept.used = true;
    return device.device;
  }

  forget(request: string): void {
    this.challenges.delete(request);
  }
}

function isRemoteDecision(value: unknown): value is RemoteDecision {
  const decision = value as RemoteDecision;
  return (
    !!decision &&
    typeof decision === "object" &&
    decision.kind === "remote" &&
    typeof decision.device === "string" &&
    Number.isInteger(decision.generation) &&
    typeof decision.nonce === "string" &&
    typeof decision.signature === "string"
  );
}
