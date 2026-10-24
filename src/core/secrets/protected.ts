import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type FreshAuthentication,
  LocalApprovals,
  type LocalProof,
  RemoteApprovals,
} from "./approvals";
import { type Authority, type Evaluation, ProtectedAuthority } from "./authority";
import { type CustodyRefusal, canonical, RootKeys, type SecretCustody, sha256 } from "./custody";
import { type HistoryItem, UseJournal } from "./journal";
import { prepareRecipient, type RecipientFacts } from "./recipient";
import {
  type Injection,
  inputDigest,
  type PreparedUse,
  type SecretReference,
  type SecretsBackend,
  type UseReceipt,
  type UseState,
} from "./requests";
import { SecretVault, type VaultEntry } from "./vault";

/** Whether this owner can serve uses, or why not. Every state but `available` refuses every use. */
export type SecretsAvailability = "available" | CustodyRefusal | "tampered";

export type ProtectedSecretsOptions = {
  /** The owner's private folder, outside every project: `<userData>/secrets`. */
  dir: string;
  custody: SecretCustody;
  /** Absent on a computer that cannot confirm the person (a headless start): human Allow waits. */
  authentication?: FreshAuthentication;
  /** The host environment a recipient's few base variables come from (`hostEnv`). */
  environment: () => NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Create the root key when nothing was ever sealed here. Only the trusted
   * controller's first Add sets it; an ordinary start never creates custody.
   */
  initialize?: boolean;
};

/** What a trusted approval screen shows: checked facts, and the requester's words beside them. */
export type UseDescription = {
  request: string;
  facts: RecipientFacts;
  secrets: Pick<VaultEntry, "ref" | "label" | "version">[];
  reason: string;
  evaluation: Evaluation;
};

type Ready = {
  keys: RootKeys;
  vault: SecretVault;
  authority: ProtectedAuthority;
  journal: UseJournal;
  local: LocalApprovals;
  remote: RemoteApprovals;
};

type Ended = Exclude<UseState, "waiting" | "executing" | "completed">;

/**
 * The protected Secrets backend (docs/secrets.md): native root custody, a
 * sealed vault, protected rules, an exact recipient, a durable journal and
 * trusted approvals behind `SecretRequests`. It refuses whenever any of them is
 * unavailable - there is no plaintext, environment or unprotected fallback - and
 * nothing in production constructs it yet: production refusal stays until the
 * protection is proven on macOS and Linux and the settings land.
 */
export class ProtectedSecrets implements SecretsBackend {
  private readonly described = new Map<string, UseDescription>();
  private readonly now: () => number;

  private constructor(
    private readonly options: ProtectedSecretsOptions,
    readonly availability: SecretsAvailability,
    private readonly ready?: Ready,
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Open the owner. Always answers: an owner that cannot open is a refusing one,
   * so a headless start with no custody reports `unavailable` honestly. Private
   * run folders a previous process left are removed first, whatever happens next.
   */
  static async open(options: ProtectedSecretsOptions): Promise<ProtectedSecrets> {
    const now = options.now ?? Date.now;
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    await rm(join(options.dir, "runs"), { recursive: true, force: true });
    const keys = await RootKeys.open(options.custody, {
      initialize: options.initialize === true,
      hasRecords: await SecretVault.hasRecords(options.dir),
    });
    if (typeof keys === "string") return new ProtectedSecrets(options, keys);
    const authority = await ProtectedAuthority.load(options.dir, keys, options.custody);
    if (typeof authority === "string") return new ProtectedSecrets(options, authority);
    return new ProtectedSecrets(options, "available", {
      keys,
      vault: new SecretVault(options.dir, keys, now),
      authority,
      journal: await UseJournal.open(options.dir, keys, now),
      local: new LocalApprovals(options.authentication, now),
      remote: new RemoteApprovals(now),
    });
  }

  async list(): Promise<SecretReference[]> {
    if (!this.ready) return [];
    return (await this.ready.vault.list())
      .filter((entry) => entry.discoverable)
      .map((entry) => ({ ref: entry.ref, label: entry.label, version: String(entry.version) }));
  }

  restored(): { intent: string; inputDigest: string; receipt: UseReceipt }[] {
    return this.ready?.journal.restored() ?? [];
  }

  async prepare(
    input: Injection,
    request: string,
    _expires: number,
  ): Promise<PreparedUse | undefined> {
    const ready = this.ready;
    if (!ready || !input.cwd || !(await this.custodyCurrent())) return undefined;
    const refs = [...new Set(Object.values(input.env))].sort();
    const entries: VaultEntry[] = [];
    for (const ref of refs) {
      const entry = await ready.vault.entry(ref);
      // Unknown and hidden references answer the same: unavailable, naming nothing.
      if (!entry?.discoverable) return undefined;
      entries.push(entry);
    }
    const runDir = join(this.options.dir, "runs", request);
    const base = this.options.environment();
    const recipient = await prepareRecipient(
      { argv: input.argv, cwd: input.cwd, env: input.env },
      runDir,
      base.PATH ?? "",
    ).catch(() => undefined);
    if (!recipient) {
      await rm(runDir, { recursive: true, force: true });
      return undefined;
    }
    const authority = ready.authority.authority;
    const evaluation = ready.authority.evaluate(refs, recipient.operation);
    const versions = entries.map(({ ref, version }) => ({ ref, version }));
    const digest = sha256(
      canonical({
        home: authority.home,
        request,
        operation: recipient.operation,
        facts: recipient.facts,
        secrets: versions,
        authority: authority.revision,
      }),
    );
    try {
      await ready.journal.append({
        kind: "requested",
        request,
        intent: input.id,
        inputDigest: inputDigest(input),
        digest,
        secrets: refs,
        program: recipient.facts.executable.path,
        reason: input.reason,
        rule: evaluation.effect,
      });
      if (evaluation.effect === "allow")
        await ready.journal.append({ kind: "approved", request, method: "rule" });
    } catch {
      // A use the journal cannot hold is never offered.
      await recipient.dispose();
      return undefined;
    }
    this.described.set(request, {
      request,
      facts: recipient.facts,
      secrets: entries.map(({ ref, label, version }) => ({ ref, label, version })),
      reason: input.reason,
      evaluation,
    });

    let recorded = false;
    const end = async (state: Ended) => {
      if (recorded) return;
      recorded = true;
      await ready.journal.append({ kind: "ended", request, state }).catch(() => {});
    };
    const current = async (): Promise<boolean> => {
      if (!(await this.custodyCurrent())) return false;
      if (ready.authority.authority.revision !== authority.revision) return false;
      for (const { ref, version } of versions) {
        const entry = await ready.vault.entry(ref);
        if (!entry?.discoverable || entry.version !== version) return false;
      }
      return recipient.check();
    };

    return {
      digest,
      rule: evaluation.effect,
      current,
      execute: async () => {
        try {
          await ready.journal.append({ kind: "consumed", request });
        } catch {
          // Consumption could not be made durable: nothing starts.
          await end("unavailable");
          return { state: "unavailable" };
        }
        const values: Record<string, Buffer> = {};
        try {
          for (const [name, ref] of Object.entries(input.env)) {
            const opened = await ready.vault.open(ref);
            const bound = versions.find((one) => one.ref === ref);
            if (!opened || opened.entry.version !== bound?.version) {
              await end("invalidated");
              return { state: "invalidated" };
            }
            values[name] = opened.value;
          }
          const launched = await recipient.launch(values, base).catch(() => "failed" as const);
          if (launched === "changed") {
            await end("invalidated");
            return { state: "invalidated" };
          }
          if (launched === "undeliverable") {
            await end("unavailable");
            return { state: "unavailable" };
          }
          if (launched === "failed" || "signal" in launched) {
            await end("unknown");
            return { state: "unknown" };
          }
          recorded = true;
          await ready.journal
            .append({ kind: "completed", request, exitCode: launched.exitCode })
            .catch(() => {
              // The effect happened; the next open reads this use as unknown, which is honest.
            });
          return { exitCode: launched.exitCode };
        } finally {
          for (const value of Object.values(values)) value.fill(0);
        }
      },
      dispose: async (ended) => {
        this.described.delete(request);
        ready.remote.forget(request);
        try {
          await recipient.dispose();
        } catch (failure) {
          await end("unknown");
          throw failure;
        }
        if (ended !== "waiting" && ended !== "executing" && ended !== "completed") await end(ended);
      },
    };
  }

  async authenticate(
    request: string,
    digest: string,
    _expires: number,
    proof: unknown,
  ): Promise<boolean> {
    const ready = this.ready;
    if (!ready) return false;
    let device: string | undefined;
    const local = ready.local.consume(proof, `use:${request}`, digest);
    if (!local) {
      const authority = ready.authority.authority;
      device = ready.remote.consume(proof, {
        home: authority.home,
        request,
        digest,
        devices: authority.devices,
      });
      if (!device) return false;
    }
    try {
      await ready.journal.append({
        kind: "approved",
        request,
        method: local ? "local" : "remote",
        ...(device ? { device } : {}),
      });
    } catch {
      return false;
    }
    return true;
  }

  // Trusted controller only. None of what follows is reachable from the agent facade.

  /** The checked facts of a waiting use, for the trusted approval screen. */
  describe(request: string): UseDescription | undefined {
    return this.described.get(request);
  }

  /** Ask the system to confirm the person for this exact use; the proof passes `approve` once. */
  async confirmUse(
    request: string,
    digest: string,
    expires: number,
    reason: string,
  ): Promise<LocalProof | undefined> {
    return this.ready?.local.confirm(`use:${request}`, digest, expires, reason);
  }

  /** The nonce an enrolled device signs with its decision on this use. */
  challenge(
    request: string,
    digest: string,
    expires: number,
  ): { nonce: string; home: string } | undefined {
    const ready = this.ready;
    if (!ready || !this.described.has(request)) return undefined;
    const challenge = ready.remote.challenge(request, digest, expires);
    return challenge ? { ...challenge, home: ready.authority.authority.home } : undefined;
  }

  authority(): Authority | undefined {
    return this.ready?.authority.authority;
  }

  /** The next revision and the digest the captain approves before it is saved. */
  proposeAuthority(
    next: Pick<Authority, "rules" | "devices">,
  ): { authority: Authority; digest: string } | undefined {
    return this.ready?.authority.proposal(next);
  }

  async confirmAuthority(
    digest: string,
    expires: number,
    reason: string,
  ): Promise<LocalProof | undefined> {
    return this.ready?.local.confirm("authority", digest, expires, reason);
  }

  /** Save rules and approval devices: only with a fresh local proof for this exact revision. */
  async saveAuthority(
    authority: Authority,
    proof: unknown,
  ): Promise<"stored" | "refused" | "invalid" | "locked" | "unavailable"> {
    const ready = this.ready;
    if (!ready) return "unavailable";
    if (!ready.local.consume(proof, "authority", sha256(canonical(authority)))) return "refused";
    return ready.authority.save(authority);
  }

  /**
   * Metadata-only rehearsal: which rules a use would meet, without journaling,
   * approving or running anything.
   */
  async rehearse(
    input: Pick<Injection, "argv" | "env" | "cwd">,
  ): Promise<{ evaluation: Evaluation; operation: string; facts: RecipientFacts } | undefined> {
    const ready = this.ready;
    if (!ready || !input.cwd) return undefined;
    const runDir = join(this.options.dir, "runs", `rehearsal-${randomUUID()}`);
    const recipient = await prepareRecipient(
      { argv: input.argv, cwd: input.cwd, env: input.env },
      runDir,
      this.options.environment().PATH ?? "",
    ).catch(() => undefined);
    try {
      if (!recipient) return undefined;
      const refs = [...new Set(Object.values(input.env))].sort();
      return {
        evaluation: ready.authority.evaluate(refs, recipient.operation),
        operation: recipient.operation,
        facts: recipient.facts,
      };
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  /** Trusted secure entry's write. Never an agent operation, and there is no reveal. */
  async putSecret(
    ref: string,
    label: string,
    value: Buffer,
    options: { discoverable?: boolean } = {},
  ): Promise<VaultEntry | undefined> {
    return this.ready?.vault.put(ref, label, value, options);
  }

  async forgetSecret(ref: string): Promise<void> {
    await this.ready?.vault.remove(ref);
  }

  history(): HistoryItem[] {
    return this.ready?.journal.history() ?? [];
  }

  async storageUse(): Promise<number> {
    return (await this.ready?.journal.storageUse()) ?? 0;
  }

  exportHistory(): string | undefined {
    return this.ready?.journal.export();
  }

  async clearHistory(): Promise<"cleared" | "busy" | "unavailable"> {
    return (await this.ready?.journal.clear()) ?? "unavailable";
  }

  /** Custody is read again at every consumption: a locked or replaced root stops the use. */
  private async custodyCurrent(): Promise<boolean> {
    const ready = this.ready;
    if (!ready) return false;
    try {
      const read = await this.options.custody.read("root");
      if (read.kind !== "value") return false;
      const same = sha256(read.bytes).slice(0, 16) === ready.keys.fingerprint;
      read.bytes.fill(0);
      return same;
    } catch {
      return false;
    }
  }
}
