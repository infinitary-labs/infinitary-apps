import { createHash, randomUUID } from "node:crypto";
import { type BrokeredUse, brokerInputDigest, validBrokeredUse } from "./brokers";

/** Metadata only. Values never cross this contract. Task labels are not authority (INF-1093). */
/** One listed secret: metadata only, with the captain's environment label when it has one. */
export type SecretReference = { ref: string; label: string; version: string; environment?: string };
export type Injection = {
  id: string;
  reason: string;
  env: Record<string, string>;
  argv: string[];
  /** The folder relative arguments resolve from: context the backend binds, never authority. */
  cwd?: string;
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
export type EndedUseReceipt = UseReceipt & {
  state: Exclude<UseState, "waiting" | "executing">;
};

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
  /**
   * Journal and consume once before launching; never returns values, logs or arbitrary results.
   * A fact that changed after consumption, or a journal that could not be written, stops the
   * launch and says so; `unknown` or a thrown error means the effect may have happened.
   */
  execute: () => Promise<
    | { exitCode: number }
    | { completed: true }
    | { state: "invalidated" | "unavailable" | "unknown" }
  >;
  /** Dispose snapshots and private output, recording how the use ended; failure makes the outcome unknown. */
  dispose: (ended: UseState) => Promise<void>;
};
export interface SecretsBackend {
  /** The captain's own entries' metadata, never system credentials or values. */
  list(): Promise<SecretReference[]>;
  /** Unsupported or unavailable protection refuses before policy; no plaintext fallback. */
  prepare(input: Injection, request: string, expires: number): Promise<PreparedUse | undefined>;
  /** A registered trusted adapter, not an arbitrary value getter. */
  prepareBrokered?(
    input: BrokeredUse,
    request: string,
    expires: number,
  ): Promise<PreparedUse | undefined>;
  /** Trusted controller checks fresh authentication, nonce, expiry and exact digest. Not an agent operation. */
  authenticate(request: string, digest: string, expires: number, proof: unknown): Promise<boolean>;
  /**
   * Uses settled before this process started, with the intent that named each, so
   * a restarted owner answers an earlier intent instead of running it again.
   */
  restored?(): { intent: string; inputDigest: string; receipt: UseReceipt }[];
}

/** The existing exact-use confirmation lifetime, also used for a Settings rule proposal. */
export const SECRET_REQUEST_LIFETIME_MS = 300_000;

type Kept = {
  inputDigest: string;
  prepared?: PreparedUse;
  receipt: UseReceipt;
  expires: number;
  disposing?: boolean;
  notified?: UseReceipt;
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
  private paused = false;
  private readonly active = new Set<Promise<unknown>>();

  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }

  /** Trusted recovery only: stop new work, drain metadata writes, and end unused approvals. */
  async pauseForRecovery(): Promise<(() => void) | undefined> {
    if (
      this.paused ||
      [...this.requests.values()].some((kept) => kept.receipt.state === "executing")
    )
      return undefined;
    this.paused = true;
    try {
      while (this.active.size > 0) await Promise.allSettled([...this.active]);
      for (const kept of this.requests.values()) {
        if (kept.receipt.state !== "waiting") continue;
        kept.receipt.state = "invalidated";
        await this.dispose(kept);
        this.notify(kept);
      }
      return () => {
        this.paused = false;
      };
    } catch (error) {
      this.paused = false;
      throw error;
    }
  }

  constructor(
    private readonly backend: SecretsBackend,
    private readonly now: () => number = Date.now,
    private readonly changed: (receipt: UseReceipt) => void = () => {},
  ) {
    for (const { intent, inputDigest, receipt } of backend.restored?.() ?? []) {
      const kept: Kept = {
        inputDigest,
        receipt: { ...receipt },
        notified: { ...receipt },
        expires: 0,
      };
      this.requests.set(receipt.request, kept);
      this.intents.set(intent, Promise.resolve(kept));
    }
  }

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
    return this.submit(copied.id, inputDigest(copied), (request, expires) =>
      this.backend.prepare(copied, request, expires),
    );
  }

  /** Trusted consumers submit brokered operations; AXI still exposes no raw result reader. */
  async broker(input: BrokeredUse): Promise<UseReceipt> {
    if (!validBrokeredUse(input)) throw new Error("Invalid brokered request.");
    const copied = structuredClone(input);
    return this.submit(
      copied.id,
      brokerInputDigest(copied),
      (request, expires) =>
        this.backend.prepareBrokered?.(copied, request, expires) ?? Promise.resolve(undefined),
    );
  }

  private async submit(
    intent: string,
    digest: string,
    prepare: (request: string, expires: number) => Promise<PreparedUse | undefined>,
  ): Promise<UseReceipt> {
    if (this.paused) return { request: randomUUID(), state: "unavailable" };
    let work = this.intents.get(intent);
    if (!work) {
      work = this.track(this.prepare(prepare, digest));
      this.intents.set(intent, work);
    }
    const kept = await work;
    if (kept.inputDigest !== digest)
      throw new Error("This intent already names a different operation.");
    return this.view(kept);
  }

  private async prepare(
    prepare: (request: string, expires: number) => Promise<PreparedUse | undefined>,
    inputDigest: string,
  ): Promise<Kept> {
    const kept: Kept = {
      inputDigest,
      expires: this.now() + SECRET_REQUEST_LIFETIME_MS,
      receipt: { request: randomUUID(), state: "unavailable" },
    };
    this.requests.set(kept.receipt.request, kept);
    try {
      kept.prepared = await prepare(kept.receipt.request, kept.expires);
      if (kept.prepared) {
        kept.receipt.state = kept.prepared.rule === "never" ? "denied" : "waiting";
        if (kept.prepared.rule === "allow") void this.start(kept);
        else if (kept.prepared.rule === "never") await this.dispose(kept);
      }
      this.notify(kept);
    } catch {
      // Backend errors may contain values; never serialize their text.
      kept.receipt.state = "unavailable";
    }
    return kept;
  }

  /** What a trusted controller approves: the checked digest and its expiry. Never an agent operation. */
  pending(request: string): { digest: string; expires: number } | undefined {
    const kept = this.requests.get(request);
    if (!kept?.prepared || this.view(kept).state !== "waiting") return undefined;
    return { digest: kept.prepared.digest, expires: kept.expires };
  }

  status(request: string): UseReceipt | undefined {
    const kept = this.requests.get(request);
    return kept ? this.view(kept) : undefined;
  }

  /** A terminal observation only after disposal/journaling, for callers attaching after submission. */
  settled(request: string): EndedUseReceipt | undefined {
    const receipt = this.requests.get(request)?.notified;
    return receipt && receipt.state !== "waiting" && receipt.state !== "executing"
      ? { ...receipt, state: receipt.state }
      : undefined;
  }

  private view(kept: Kept): UseReceipt {
    if (!this.paused && kept.receipt.state === "waiting" && this.now() >= kept.expires) {
      kept.receipt.state = "expired";
      void this.dispose(kept).then(() => this.notify(kept));
    }
    return { ...kept.receipt };
  }

  cancel(request: string): Promise<UseReceipt | undefined> {
    return this.paused
      ? Promise.resolve(this.status(request))
      : this.track(this.cancelNow(request));
  }

  private async cancelNow(request: string): Promise<UseReceipt | undefined> {
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
  deny(request: string): Promise<UseReceipt | undefined> {
    return this.paused ? Promise.resolve(this.status(request)) : this.track(this.denyNow(request));
  }

  private async denyNow(request: string): Promise<UseReceipt | undefined> {
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
  /**
   * `until: "started"` answers once the proof passed and the use began, for a
   * caller on another device that hears the end through Secrets' own change.
   */
  approve(
    request: string,
    proof: unknown,
    until: "ended" | "started" = "ended",
  ): Promise<UseReceipt | undefined> {
    return this.paused
      ? Promise.resolve(this.status(request))
      : this.track(this.approveNow(request, proof, until));
  }

  private async approveNow(
    request: string,
    proof: unknown,
    until: "ended" | "started",
  ): Promise<UseReceipt | undefined> {
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
    if (authenticated && this.view(kept).state === "waiting") {
      // start never rejects: every failure becomes the use's own state.
      const started = this.start(kept);
      if (until === "ended") await started;
    }
    return this.view(kept);
  }

  private start(kept: Kept): Promise<void> {
    return this.paused ? Promise.resolve() : this.track(this.startNow(kept));
  }

  private async startNow(kept: Kept): Promise<void> {
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
        if ("state" in result) kept.receipt.state = result.state;
        else if ("completed" in result)
          kept.receipt = { request: kept.receipt.request, state: "completed" };
        else if (!Number.isInteger(result.exitCode)) throw new Error("Invalid exit status.");
        else
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

  private dispose(kept: Kept): Promise<void> {
    return this.track(this.disposeNow(kept));
  }

  private async disposeNow(kept: Kept): Promise<void> {
    const prepared = kept.prepared;
    kept.prepared = undefined;
    kept.disposing = true;
    try {
      await prepared?.dispose(kept.receipt.state);
    } catch {
      kept.receipt.state = "unknown";
    } finally {
      kept.disposing = false;
    }
  }

  private notify(kept: Kept): void {
    if (kept.disposing) return;
    kept.notified = { ...kept.receipt };
    try {
      this.changed({ ...kept.receipt });
    } catch {
      /* Observers cannot alter the effect's outcome. */
    }
  }
}

/** The digest of what a requester submitted: one intent names one operation, across restarts too. */
export function inputDigest(input: Injection): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        reason: input.reason,
        argv: input.argv,
        env: Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)),
        cwd: input.cwd ?? null,
      }),
    )
    .digest("hex");
}

/** Typed mapping validation, not a heuristic for whether code is safe. */
export function validInjection(input: Injection): boolean {
  return (
    typeof input?.id === "string" &&
    Object.keys(input).every((key) => ["id", "reason", "env", "argv", "cwd"].includes(key)) &&
    (input.cwd === undefined ||
      (typeof input.cwd === "string" && input.cwd.startsWith("/") && !input.cwd.includes("\0"))) &&
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
export type SecretsCommand = Pick<SecretRequests, "list" | "receipts" | "inject" | "cancel"> & {
  /** A lazy native owner may need to read its durable receipts before answering. */
  status: (request: string) => UseReceipt | undefined | Promise<UseReceipt | undefined>;
};
/**
 * Discovery alone, for a task on another computer (docs/secrets.md, "Current
 * command seam"): the same metadata a local task lists, asked of the home.
 * It has no use, receipt or approval, so nothing there can reach a value or custody.
 */
export type SecretsCatalog = Pick<SecretsCommand, "list">;
export { SECRETS_COMMAND } from "./commandWords";
