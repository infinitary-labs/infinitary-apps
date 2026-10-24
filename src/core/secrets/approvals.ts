import { createPublicKey, randomBytes, verify } from "node:crypto";
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
    if (!this.authentication || this.now() >= expires) return undefined;
    let confirmed = false;
    try {
      confirmed = (await this.authentication.confirm(reason)) === true;
    } catch {
      // A failed or cancelled confirmation reveals nothing and approves nothing.
    }
    if (!confirmed || this.now() >= expires) return undefined;
    const proof: LocalProof = Object.freeze({ kind: "local" });
    this.held.set(proof, { subject, digest, expires, used: false });
    return proof;
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

/** The exact bytes a device signs: every binding on its own line, so none can be confused for another. */
export function decisionMessage(fields: DecisionFields): string {
  return [
    "infinitary-secrets-decision/1",
    `home:${fields.home}`,
    `device:${fields.device}`,
    `generation:${fields.generation}`,
    `request:${fields.request}`,
    `digest:${fields.digest}`,
    `nonce:${fields.nonce}`,
    `expires:${fields.expires}`,
    "decision:allow",
  ].join("\n");
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
    const message = decisionMessage({
      home: fields.home,
      device: device.device,
      generation: device.generation,
      request: fields.request,
      digest: fields.digest,
      nonce: kept.nonce,
      expires: kept.expires,
    });
    try {
      const key = createPublicKey({
        key: Buffer.from(device.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
        return undefined;
      const passed = verify(
        "sha256",
        Buffer.from(message),
        { key, dsaEncoding: "der" },
        Buffer.from(decision.signature, "base64"),
      );
      if (!passed || kept.used) return undefined;
    } catch {
      return undefined;
    }
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
