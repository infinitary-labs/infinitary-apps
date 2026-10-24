import { createHash, randomUUID } from "node:crypto";

/** Metadata only. Values never cross this contract. Task labels are not authority (INF-1093). */
export type SecretReference = { ref: string; label: string; version: string };
export type Injection = {
  id: string;
  reason: string;
  env: Record<string, string>;
  argv: string[];
};
export type UseState =
  | "waiting"
  | "executing"
  | "completed"
  | "denied"
  | "cancelled"
  | "expired"
  | "invalidated"
  | "unavailable"
  | "unknown";
export type UseReceipt = { request: string; state: UseState; exitCode?: number };

/**
 * A protected backend snapshots code, dependencies, configuration and inputs and
 * binds all recipient/destination/delivery facts before returning this handle.
 * A hash of an agent-provided script or label is NOT such a backend.
 * No production backend is installed yet. Tests supply disposable adapters only.
 */
export type PreparedUse = {
  /** Canonical digest of the backend-checked complete operation, including secret versions and policy. */
  digest: string;
  rule: "never" | "ask" | "allow";
  /** Revalidates every bound fact, including custody availability, immediately before consumption. */
  current: () => Promise<boolean>;
  /** Journal and consume once before launching; never returns values, logs or arbitrary results. */
  execute: () => Promise<{ exitCode: number }>;
  /** Dispose snapshots and private output; failure makes the outcome unknown. */
  dispose: () => Promise<void>;
};
export interface SecretsBackend {
  /** Only explicitly linked metadata, never system credentials or values. */
  list(): Promise<SecretReference[]>;
  /** Unsupported or unavailable protection refuses before policy; no plaintext fallback. */
  prepare(input: Injection): Promise<PreparedUse | undefined>;
  /** Trusted controller checks fresh authentication, nonce, expiry and exact digest. Not an agent operation. */
  authenticate(request: string, digest: string, expires: number, proof: unknown): Promise<boolean>;
}

type Kept = {
  inputDigest: string;
  prepared?: PreparedUse;
  receipt: UseReceipt;
  expires: number;
};

/**
 * First-piece operation coordinator, not a credential store or task-authentication boundary.
 * Only the private controller gets approve(). The command facade cannot approve,
 * save policy or read values. Pending approvals are deliberately process-local.
 * Production wiring waits for protected native custody/journaling/authentication.
 */
export class SecretRequests {
  private readonly intents = new Map<string, Promise<Kept>>();
  private readonly requests = new Map<string, Kept>();

  constructor(
    private readonly backend: SecretsBackend,
    private readonly now: () => number = Date.now,
    private readonly changed: (receipt: UseReceipt) => void = () => {},
  ) {}

  async list(): Promise<SecretReference[]> {
    return this.backend.list();
  }

  receipts(): UseReceipt[] {
    return [...this.requests.values()].map((kept) => this.view(kept));
  }

  async inject(input: Injection): Promise<UseReceipt> {
    // Copy before awaiting: the requesting program cannot mutate approved input.
    const copied: Injection = JSON.parse(JSON.stringify(input));
    if (!validInjection(copied)) throw new Error("Invalid injection request.");
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          reason: copied.reason,
          argv: copied.argv,
          env: Object.entries(copied.env).sort(([a], [b]) => a.localeCompare(b)),
        }),
      )
      .digest("hex");
    let work = this.intents.get(copied.id);
    if (!work) {
      work = this.prepare(copied, digest);
      this.intents.set(copied.id, work);
    }
    const kept = await work;
    if (kept.inputDigest !== digest)
      throw new Error("This intent already names a different operation.");
    return this.view(kept);
  }

  private async prepare(input: Injection, inputDigest: string): Promise<Kept> {
    const kept: Kept = {
      inputDigest,
      expires: this.now() + 300_000,
      receipt: { request: randomUUID(), state: "unavailable" },
    };
    this.requests.set(kept.receipt.request, kept);
    try {
      kept.prepared = await this.backend.prepare(input);
      if (kept.prepared) {
        kept.receipt.state = kept.prepared.rule === "never" ? "denied" : "waiting";
        if (kept.prepared.rule === "allow") void this.start(kept);
        else if (kept.prepared.rule === "never") await this.dispose(kept);
      }
    } catch {
      // Backend errors may contain values; never serialize their text.
      kept.receipt.state = "unavailable";
    }
    return kept;
  }

  status(request: string): UseReceipt | undefined {
    const kept = this.requests.get(request);
    return kept ? this.view(kept) : undefined;
  }

  private view(kept: Kept): UseReceipt {
    if (kept.receipt.state === "waiting" && this.now() >= kept.expires) {
      kept.receipt.state = "expired";
      void this.dispose(kept);
    }
    return { ...kept.receipt };
  }

  async cancel(request: string): Promise<UseReceipt | undefined> {
    const kept = this.requests.get(request);
    if (!kept) return undefined;
    if (this.view(kept).state === "waiting") {
      kept.receipt.state = "cancelled";
      await this.dispose(kept);
      this.notify(kept);
    }
    // Already sent is not reported as cancelled; it may have external effects.
    return this.view(kept);
  }

  /** A trusted human refusal ends the intent; repeating its command does not ask again. */
  async deny(request: string): Promise<UseReceipt | undefined> {
    const kept = this.requests.get(request);
    if (!kept) return undefined;
    if (this.view(kept).state === "waiting") {
      kept.receipt.state = "denied";
      await this.dispose(kept);
      this.notify(kept);
    }
    return this.view(kept);
  }

  /** Called by trusted app chrome/native authentication only, never through AXI. */
  async approve(request: string, proof: unknown): Promise<UseReceipt | undefined> {
    const kept = this.requests.get(request);
    if (!kept?.prepared || this.view(kept).state !== "waiting")
      return kept ? this.view(kept) : undefined;
    let authenticated = false;
    try {
      authenticated = await this.backend.authenticate(
        request,
        kept.prepared.digest,
        kept.expires,
        proof,
      );
    } catch {
      /* Authentication failure reveals no backend detail. */
    }
    if (authenticated && this.view(kept).state === "waiting") await this.start(kept);
    return this.view(kept);
  }

  private async start(kept: Kept): Promise<void> {
    // Reserve synchronously before the first await: racing approvals cannot launch twice.
    if (this.view(kept).state !== "waiting" || !kept.prepared) return;
    kept.receipt.state = "executing";
    this.notify(kept);
    try {
      const current = await kept.prepared.current();
      if (this.now() >= kept.expires || !current) {
        kept.receipt.state = "invalidated";
      } else {
        const result = await kept.prepared.execute();
        if (!Number.isInteger(result.exitCode)) throw new Error("Invalid exit status.");
        kept.receipt = {
          request: kept.receipt.request,
          state: "completed",
          exitCode: result.exitCode,
        };
      }
    } catch {
      kept.receipt.state = "unknown";
    } finally {
      await this.dispose(kept);
      this.notify(kept);
    }
  }

  private async dispose(kept: Kept): Promise<void> {
    const prepared = kept.prepared;
    kept.prepared = undefined;
    try {
      await prepared?.dispose();
    } catch {
      kept.receipt.state = "unknown";
    }
  }

  private notify(kept: Kept): void {
    try {
      this.changed({ ...kept.receipt });
    } catch {
      /* Observers cannot alter the effect's outcome. */
    }
  }
}

/** Typed mapping validation, not a heuristic for whether code is safe. */
export function validInjection(input: Injection): boolean {
  return (
    typeof input?.id === "string" &&
    Object.keys(input).every((key) => ["id", "reason", "env", "argv"].includes(key)) &&
    input.id.length > 0 &&
    typeof input.reason === "string" &&
    input.reason.trim().length > 0 &&
    Array.isArray(input.argv) &&
    input.argv.length > 0 &&
    input.argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) &&
    !!input.argv[0] &&
    input.env !== null &&
    typeof input.env === "object" &&
    !Array.isArray(input.env) &&
    Object.keys(input.env).length > 0 &&
    Object.entries(input.env).every(
      ([name, ref]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        !controlVariable(name) &&
        typeof ref === "string" &&
        ref.length > 0 &&
        !ref.includes("\0"),
    )
  );
}

/** Interpreter and launcher controls cannot be credential delivery variables. */
function controlVariable(name: string): boolean {
  return (
    [
      "PATH",
      "HOME",
      "SHELL",
      "ENV",
      "BASH_ENV",
      "IFS",
      "CDPATH",
      "NODE_OPTIONS",
      "NODE_PATH",
    ].includes(name) ||
    name.startsWith("LD_") ||
    name.startsWith("DYLD_") ||
    name.startsWith("INFINITARY_") ||
    name.startsWith("FM3000_") // Firstmate 3000's launcher controls remain forbidden.
  );
}

/** Closed command facade. Context is for organization only, never authority. */
export type SecretsCommand = Pick<
  SecretRequests,
  "list" | "receipts" | "inject" | "status" | "cancel"
>;
export const SECRETS_COMMAND = "infinitary-secrets-axi";
