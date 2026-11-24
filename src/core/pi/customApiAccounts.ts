import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type CustomApiAddress,
  type CustomApiConnectInput,
  type CustomApiConnectResult,
  type CustomApiFailure,
  type CustomApiInput,
  type CustomApiReview,
  type CustomApiView,
  type CustomListedModel,
  customApiConnectInputSchema,
  customApiInputSchema,
  customDefaultCacheRetention,
  withListedLimits,
} from "@shared/customApi";
import type { CustomFileDefinition } from "@shared/customApiFile";
import type { AccountRef } from "../accounts/accountBackend";
import {
  approvedCustomApiCertificates,
  reviewCustomApiCertificates,
} from "./customApiCertificates";
import {
  type CustomConnectionCandidate,
  type CustomModelProof,
  checkCustomApiModel,
  customModelProofMatches,
  listCustomApiModels,
} from "./customApiCheck";
import {
  type CustomApiCatalogSource,
  type CustomCapabilities,
  customCacheRetentions,
  customCapabilities,
  customCapabilityProfiles,
  customCatalog,
  customModelCost,
  customPiModel,
  customStatedCapabilities,
} from "./customApiModels";
import {
  assertCustomHeaders,
  assertLiteralBearerKey,
  CustomApiError,
  customApiAnswerKind,
  customApiExceptionAllows,
  customApiHostname,
  normalizeCustomApiBase,
} from "./customApiPolicy";
import { customApiStream } from "./customApiStream";
import { assertCustomTokenCommand } from "./customApiToken";
import {
  type CustomApiResolver,
  type CustomApiTransport,
  type CustomApiTransportOptions,
  createCustomApiTransport,
  readCustomApiDestination,
} from "./customApiTransport";
import { setCustomCompaction } from "./customCompaction";
import { createModelRuntime } from "./modelRuntime";

// This owner alone may read/write a custom key or secret header. Pi receives only an in-memory
// availability marker; the literal credential never goes through its config
// resolver, environment, request hooks, model definitions or session state.
type Stored = {
  input: CustomApiInput;
  credentialRevision: string;
  storageRevision: string;
  proofs: Record<string, CustomModelProof>;
  capabilities?: Record<string, CustomCapabilities>;
  reviewedCertificates: CustomApiView["certificates"];
};
type Draft = Stored & {
  id: string;
  abort: AbortController;
  running: boolean;
  failures: Map<string, CustomApiError>;
  checking?: string;
};
type Live = {
  stored: Stored;
  ref: AccountRef;
  enabled: boolean;
  closed: boolean;
  transport?: CustomApiTransport;
  tokenCommandFailed?: boolean;
  runtime?: Promise<ModelRuntime>;
  ready?: ModelRuntime;
  waiters: Set<() => void>;
  active: number;
  /** Its fresh check in flight (`recheck`); Disconnect aborts it. */
  rechecking?: AbortController;
  /**
   * Whether the connection file's newest reading still says what was
   * approved here. Unread yet, or with no file chosen, it stays unset and
   * holds nothing; `changed` and `missing` hold it until approved again.
   */
  file?: "current" | "changed" | "missing";
};

export class CustomApiAccountOwner {
  private readonly drafts = new Map<string, Draft>();
  private readonly live = new Map<string, Live>();

  /**
   * `resolve` stands in for DNS in tests, for the address and the model list; policy still classifies every answer.
   * `catalogSource` supplies profiles, names and prices; absent, the bundled catalog alone, fetching nothing.
   */
  constructor(
    private readonly resolve?: CustomApiResolver,
    private readonly catalogSource: CustomApiCatalogSource = {
      want: async () => {},
      models: () => customCatalog(),
    },
  ) {}

  /**
   * The Reasoning profiles a model line may choose, from the catalog as it
   * stands now. A person setting up a connection may pick any protocol, so
   * each one's live catalog is asked for; the form asks again on a change.
   */
  profiles() {
    void this.catalogSource.want(["anthropic-messages", "openai-completions", "openai-responses"]);
    return customCapabilityProfiles(this.catalog());
  }

  private catalog() {
    return this.catalogSource.models();
  }

  /** Stops the live catalog's fetch; resolves once nothing more writes its store. */
  async closeCatalog(): Promise<void> {
    await this.catalogSource.close?.();
  }

  /**
   * The live line under the address: its canonical form and the network its
   * name points to now. Reads DNS only; nothing is sent to the server.
   */
  async address(baseUrl: string): Promise<CustomApiAddress> {
    try {
      const destination = await readCustomApiDestination(baseUrl, this.resolve);
      return { destination: destination.baseUrl, network: destination.mode };
    } catch (error) {
      if (!(error instanceof CustomApiError)) return {};
      if (error.baseSuggestion) return { suggestion: error.baseSuggestion, failure: "address" };
      if (error.category === "address") return { failure: "address" };
      // A refused name says what DNS answered, and whether an exception may reach it.
      const answered = deniedAnswers(baseUrl, error);
      // A name that does not resolve yet, or points somewhere refused: still say
      // where it would send, in the canonical form the approval binds.
      try {
        return {
          destination: normalizeCustomApiBase(baseUrl, "public").baseUrl,
          failure: error.category,
          ...answered,
        };
      } catch {
        return { failure: error.category, ...answered };
      }
    }
  }

  /**
   * Save's and Fetch's one step: read the address's network (a same-address
   * edit keeps the class it was saved with), prepare a draft, then read the
   * server's model list and fill the limits nobody typed. Every failure comes
   * back as a category, never thrown text; a draft survives a failed list, so
   * it can still be saved paused.
   */
  async connect(raw: CustomApiConnectInput): Promise<CustomApiConnectResult> {
    const input = customApiConnectInputSchema.parse(raw);
    let draft: Draft;
    try {
      const { mode, exception } = await this.networkFor(input);
      const { addressException, ...rest } = input;
      const view = this.prepare({
        ...rest,
        mode,
        ...(exception && addressException !== undefined ? { addressException } : {}),
      });
      draft = this.requireDraft(view.draftId ?? "");
    } catch (error) {
      return { failure: failureOf(error, "address") };
    }
    try {
      const listed = await this.discover(draft.id);
      if (this.drafts.get(draft.id) !== draft) throw new CustomApiError("cancelled");
      // A fresh draft has no proof yet, so its limits may still be filled in.
      draft.input.models = withListedLimits(draft.input.models, listed);
      return { view: this.viewStored(draft, false, undefined, draft), listed };
    } catch (error) {
      if (this.drafts.get(draft.id) !== draft) return { failure: failureOf(error, "list") };
      return {
        view: this.viewStored(draft, false, undefined, draft),
        failure: failureOf(error, "list"),
      };
    }
  }

  /**
   * The network the connection is held to, and whether the person's exception
   * for this address goes with it. A same-address edit keeps the saved class
   * and takes the exception as the form now sends it; a fresh read needs the
   * exception only when DNS answered what no class holds.
   */
  private async networkFor(
    input: CustomApiConnectInput,
  ): Promise<{ mode: CustomApiInput["mode"]; exception: boolean }> {
    const asked = input.addressException !== undefined;
    const saved = input.replaceAccountId
      ? this.requireLive(input.replaceAccountId).stored.input
      : undefined;
    if (saved) {
      try {
        if (normalizeCustomApiBase(input.baseUrl, saved.mode).baseUrl === saved.baseUrl)
          return { mode: saved.mode, exception: asked };
      } catch {
        /* A changed address reads its own network. */
      }
    }
    try {
      return {
        mode: (await readCustomApiDestination(input.baseUrl, this.resolve)).mode,
        exception: false,
      };
    } catch (error) {
      // It is sent as the public internet, the class with the strongest warnings.
      if (
        asked &&
        error instanceof CustomApiError &&
        deniedAnswers(input.baseUrl, error).exceptionOffered
      )
        return { mode: "public", exception: true };
      throw error;
    }
  }

  review(baseUrl: string, mode: CustomApiInput["mode"], pem?: string): CustomApiReview {
    const certificates = pem?.trim() ? reviewCustomApiCertificates(pem) : [];
    try {
      return { destination: normalizeCustomApiBase(baseUrl, mode).baseUrl, certificates };
    } catch (error) {
      if (error instanceof CustomApiError && error.baseSuggestion)
        return { destination: "", certificates, suggestion: error.baseSuggestion };
      throw error;
    }
  }

  prepare(raw: CustomApiInput): CustomApiView {
    const input = customApiInputSchema.parse(raw);
    input.baseUrl = normalizeCustomApiBase(input.baseUrl, input.mode).baseUrl;
    if (input.approvedDestination !== input.baseUrl) throw new CustomApiError("destination");
    if (input.baseUrl.startsWith("http:") && !input.unencryptedLocalApproved)
      throw new CustomApiError("destination");
    // An exception is the person's for the one address it was made for, and only for a name.
    if (
      input.addressException !== undefined &&
      (input.addressException !== input.baseUrl || isIP(customApiHostname(input.baseUrl)))
    )
      throw new CustomApiError("destination");
    const original = input.replaceAccountId ? this.requireLive(input.replaceAccountId) : undefined;
    const source = input.sourceDraftId ? this.requireDraft(input.sourceDraftId) : undefined;
    const sameAddress = (previous: CustomApiInput) =>
      previous.baseUrl === input.baseUrl && previous.mode === input.mode;
    const previous = source?.input ?? original?.stored.input;
    if (input.tokenCommand && (input.key || input.noKey)) throw new CustomApiError("credential");
    if (!input.tokenCommand && !input.noKey && !input.key) {
      if (!previous || !sameAddress(previous)) throw new CustomApiError("credential");
      input.key = previous.key;
    }
    // An empty secret value keeps the one saved under that name, at the same address only.
    input.headers = input.headers.map((header) => {
      if (!header.secret || header.value) return header;
      const kept =
        previous && sameAddress(previous)
          ? previous.headers.find(
              (saved) => saved.secret && saved.name.toLowerCase() === header.name.toLowerCase(),
            )
          : undefined;
      if (!kept) throw new CustomApiError("header");
      return { ...header, value: kept.value };
    });
    // A server that needs no key gets none, wherever it is.
    if (input.tokenCommand) {
      assertCustomTokenCommand(input.tokenCommand);
    } else if (input.noKey) {
      if (input.key !== "") throw new CustomApiError("credential");
    } else assertLiteralBearerKey(input.key);
    assertCustomHeaders(input.headers, !input.noKey);
    if (input.useExistingCertificates) {
      if (!original || !sameAddress(original.stored.input))
        throw new CustomApiError("certificate-policy");
      const saved = original.stored.input.certificates;
      if (!saved || input.certificates?.fingerprints.join() !== saved.fingerprints.join())
        throw new CustomApiError("certificate-policy");
      input.certificates = saved;
    }
    approvedCustomApiCertificates(input.certificates, input.mode);
    if (
      input.allowStorageDefault &&
      (!input.storageApproved || input.protocol !== "openai-responses")
    )
      throw new CustomApiError("incompatible");
    if (new Set(input.models.map((model) => model.id)).size !== input.models.length)
      throw new CustomApiError("incompatible");
    if (input.replaceAccountId) {
      const original = this.requireLive(input.replaceAccountId);
      if (
        original.stored.input.baseUrl !== input.baseUrl ||
        original.stored.input.mode !== input.mode
      ) {
        // Never carry a key/trust/selection to a changed address.
        input.replaceAccountId = undefined;
      }
    }
    const catalog = this.catalog();
    // An edit that changes nothing but model names and prices keeps the saved
    // checks, since neither reaches the server. Any other Save, one with no
    // change included, checks every model again: Save is how a person retries
    // a refused or timed-out check.
    const kept =
      original && input.replaceAccountId && onlyNamesOrPrices(original.stored.input, input)
        ? original.stored
        : undefined;
    const draft: Draft = {
      input,
      credentialRevision: kept?.credentialRevision ?? revision(),
      storageRevision: kept?.storageRevision ?? revision(),
      proofs: kept ? { ...kept.proofs } : {},
      capabilities: Object.fromEntries(
        input.models.flatMap((model) => {
          const snapshot = capabilitiesOf(input.protocol, model, catalog);
          return snapshot ? [[model.id, snapshot]] : [];
        }),
      ),
      reviewedCertificates: input.certificates
        ? reviewCustomApiCertificates(input.certificates.pem)
        : [],
      id: revision(),
      abort: new AbortController(),
      failures: new Map(),
      running: false,
    };
    if (source) this.cancel(source.id);
    input.sourceDraftId = undefined;
    this.drafts.set(draft.id, draft);
    return this.viewStored(draft, false, undefined, draft);
  }

  async check(draftId: string, modelId: string): Promise<CustomApiView> {
    const draft = this.requireDraft(draftId);
    if (draft.running) throw new Error("A connection check is already running.");
    draft.running = true;
    draft.checking = modelId;
    draft.failures.delete(modelId);
    try {
      const proof = await checkCustomApiModel(this.candidate(draft, modelId), draft.abort.signal);
      if (this.drafts.get(draftId) !== draft || draft.abort.signal.aborted)
        throw new CustomApiError("cancelled");
      draft.proofs[modelId] = proof;
    } catch (error) {
      if (draft.abort.signal.aborted) throw new CustomApiError("cancelled");
      const safe = error instanceof CustomApiError ? error : new CustomApiError("malformed");
      draft.failures.set(modelId, safe);
    } finally {
      draft.running = false;
      draft.checking = undefined;
    }
    return this.viewStored(draft, false, undefined, draft);
  }

  async discover(draftId: string): Promise<CustomListedModel[]> {
    const draft = this.requireDraft(draftId);
    const transport = createCustomApiTransport(this.destination(draft), this.resolve);
    try {
      return await listCustomApiModels(transport, draft.abort.signal);
    } finally {
      transport.close();
    }
  }

  cancel(draftId: string): void {
    const draft = this.drafts.get(draftId);
    if (!draft) return;
    draft.abort.abort();
    draft.input.key = "";
    draft.input.headers = [];
    this.drafts.delete(draftId);
  }

  draftReplacement(draftId: string): string | undefined {
    return this.requireDraft(draftId).input.replaceAccountId;
  }
  draftLabel(draftId: string): string {
    return this.requireDraft(draftId).input.label;
  }

  /** Vault creates the directory/registry row. No discovery/generation on save. */
  async save(draftId: string, ref: AccountRef, paused: boolean): Promise<void> {
    const draft = this.requireDraft(draftId);
    if (draft.running) throw new Error("Wait for the connection check or cancel it.");
    if (!draft.input.models.length) throw new Error("Add at least one model before saving.");
    if ((!paused || draft.input.replaceAccountId) && !this.allChecked(draft))
      throw new Error("Check every saved model before using this connection.");
    if (paused && draft.input.replaceAccountId)
      throw new Error("A paused candidate cannot replace a working connection.");
    const old = this.live.get(ref.accountId);
    if (old?.active)
      throw new Error(
        "Wait for this connection's requests to finish before applying a replacement.",
      );
    const stored: Stored = {
      input: { ...draft.input, replaceAccountId: undefined },
      credentialRevision: draft.credentialRevision,
      storageRevision: draft.storageRevision,
      proofs: { ...draft.proofs },
      capabilities: draft.capabilities,
      reviewedCertificates: draft.reviewedCertificates,
    };
    this.write(ref, stored);
    if (old) {
      // Apply only at the idle boundary checked by the vault's caller. Keep
      // existing runtime closures alive; their next request reads this owner.
      old.transport?.close();
      old.transport = undefined;
      old.tokenCommandFailed = undefined;
      old.stored.input.key = "";
      old.stored.input.headers = [];
      old.stored = stored;
      // Replacement preserves Pause and use choices; Resume is separate.
      if (old.ready) this.registerRuntime(old, old.ready);
    } else
      this.live.set(ref.accountId, {
        stored,
        ref,
        enabled: !paused,
        closed: false,
        waiters: new Set(),
        active: 0,
      });
    this.cancel(draftId);
  }

  attach(ref: AccountRef, enabled: boolean): void {
    const existing = this.live.get(ref.accountId);
    if (existing) {
      existing.enabled = enabled;
      return;
    }
    try {
      const stored = JSON.parse(readFileSync(join(ref.dir, "custom-auth.json"), "utf8")) as Stored;
      stored.input = customApiInputSchema.parse(stored.input);
      this.live.set(ref.accountId, {
        stored,
        ref,
        enabled,
        closed: false,
        waiters: new Set(),
        active: 0,
      });
    } catch {
      /* An unreadable private store stays unavailable, never invent a key. */
    }
  }

  view(accountId: string, label: string, enabled: boolean): CustomApiView {
    const live = this.requireLive(accountId);
    return { ...this.viewStored(live.stored, enabled, accountId), label };
  }
  /** Whether it serves now: a connection the file holds serves nothing until approved again. */
  checked(accountId: string, modelId?: string): boolean {
    const live = this.live.get(accountId);
    if (!live || live.closed || held(live)) return false;
    return modelId ? this.proofMatches(live.stored, modelId) : this.allChecked(live.stored);
  }
  unchecked(accountId: string): string[] {
    const live = this.live.get(accountId);
    if (!live || live.closed) return [];
    return live.stored.input.models
      .filter((model) => !this.proofMatches(live.stored, model.id))
      .map((model) => model.id);
  }

  /**
   * One fresh check of a saved connection whose saved checks no longer count,
   * such as checks an earlier version made (docs/saved-data-compatibility.md).
   * It sends Check model's two requests per unchecked model, to the address,
   * key and settings the person already approved, and changes nothing but the
   * proofs. Each passing model is saved at once; the first failure stops the
   * check and comes back on its model, as a draft's does.
   */
  async recheck(accountId: string, only?: readonly string[]): Promise<CustomApiView> {
    const live = this.requireLive(accountId);
    if (live.rechecking) throw new Error("A connection check is already running.");
    const abort = new AbortController();
    live.rechecking = abort;
    const stored = live.stored;
    const failures = new Map<string, CustomApiError>();
    // A Disconnect or an applied replacement meanwhile ends this check.
    const superseded = () => live.closed || live.stored !== stored;
    try {
      for (const model of stored.input.models) {
        if (this.proofMatches(stored, model.id) || (only && !only.includes(model.id))) continue;
        try {
          const proof = await checkCustomApiModel(this.candidate(stored, model.id), abort.signal);
          if (superseded()) throw new CustomApiError("cancelled");
          stored.proofs[model.id] = proof;
          this.write(live.ref, stored);
        } catch (error) {
          if (superseded()) throw new CustomApiError(live.closed ? "closed" : "cancelled");
          failures.set(
            model.id,
            error instanceof CustomApiError ? error : new CustomApiError("malformed"),
          );
          break;
        }
      }
      if (live.ready) this.registerRuntime(live, live.ready);
    } finally {
      if (live.rechecking === abort) live.rechecking = undefined;
    }
    return this.viewStored(stored, live.enabled, accountId, undefined, failures);
  }
  enabled(accountId: string): boolean {
    return this.live.get(accountId)?.enabled === true;
  }

  /** The connection file's key it was approved from, if any. */
  fileName(accountId: string): string | undefined {
    const live = this.live.get(accountId);
    return live && !live.closed ? live.stored.input.file : undefined;
  }

  /** No connection file is chosen now: what the last one held serves again. */
  releaseFile(accountId: string): void {
    const live = this.live.get(accountId);
    if (!live || !held(live)) {
      if (live) live.file = undefined;
      return;
    }
    live.file = undefined;
    if (live.enabled) for (const wake of [...live.waiters]) wake();
  }

  /**
   * The connection file's newest reading of this connection: absent when it
   * left the file. A changed address, protocol or header holds it until it
   * is approved again here, and never inherits a key. Otherwise the file's
   * names, prices, limits, pictures, reasoning, cache and compaction apply
   * at once, against the address already approved; `recheck` names each
   * model this reading cost its check or added, which `recheck` then checks.
   * `applied` says the definition is the one in use, so its name is too.
   * A model whose reasoning profile this computer's catalog lacks keeps
   * what it had.
   */
  applyFile(
    accountId: string,
    definition: CustomFileDefinition | undefined,
  ): { applied: boolean; recheck: string[] } {
    const live = this.live.get(accountId);
    if (!live || live.closed || !live.stored.input.file) return { applied: false, recheck: [] };
    const input = live.stored.input;
    if (!definition || approvalOf(input) !== fileApprovalOf(definition, input.mode)) {
      live.file = definition ? "changed" : "missing";
      return { applied: false, recheck: [] };
    }
    const checkedBefore = new Set(
      input.models.filter((model) => this.proofMatches(live.stored, model.id)).map((m) => m.id),
    );
    const listedBefore = new Set(input.models.map((model) => model.id));
    const catalog = this.catalog();
    const capabilities: Record<string, CustomCapabilities> = {};
    const models: CustomApiInput["models"] = [];
    for (const stated of definition.models) {
      const saved = input.models.find((model) => model.id === stated.id);
      // A limit the file leaves out keeps the one the server's list gave on approval.
      const model = {
        ...stated,
        context: stated.context || saved?.context || 0,
        output: stated.output || saved?.output || 0,
      };
      const sameReasoning =
        saved &&
        saved.reasoningProfile === model.reasoningProfile &&
        JSON.stringify(saved.statedReasoning) === JSON.stringify(model.statedReasoning);
      try {
        const snapshot = sameReasoning
          ? live.stored.capabilities?.[model.id]
          : capabilitiesOf(input.protocol, model, catalog);
        const retention = model.cacheRetention ?? customDefaultCacheRetention(input.protocol);
        if (
          !(snapshot?.cacheRetentions ?? customCacheRetentions(input.protocol)).includes(retention)
        )
          throw new CustomApiError("incompatible");
        if (snapshot) capabilities[model.id] = snapshot;
        models.push(model);
      } catch {
        if (!saved) continue;
        const kept = live.stored.capabilities?.[saved.id];
        if (kept) capabilities[saved.id] = kept;
        models.push(saved);
      }
    }
    const next: Stored = {
      ...live.stored,
      input: {
        ...input,
        label: definition.label,
        compaction: definition.compaction,
        models,
      },
      capabilities,
    };
    if (!definition.compaction) delete next.input.compaction;
    const wasHeld = held(live);
    live.file = "current";
    if (
      JSON.stringify([next.input, next.capabilities]) !==
      JSON.stringify([input, live.stored.capabilities ?? {}])
    ) {
      this.write(live.ref, next);
      // A new stored record ends a recheck of the old one (`superseded`).
      live.stored = next;
      if (live.ready) this.registerRuntime(live, live.ready);
    }
    if (wasHeld && live.enabled) for (const wake of [...live.waiters]) wake();
    // Only a model this reading cost its check, or one it added, is checked
    // again: a model left unchecked before, such as on a connection saved
    // paused, waits for the person's own check.
    const recheck = live.stored.input.models
      .filter(
        (model) =>
          (checkedBefore.has(model.id) || !listedBefore.has(model.id)) &&
          !this.proofMatches(live.stored, model.id),
      )
      .map((model) => model.id);
    return { applied: true, recheck };
  }

  setEnabled(accountId: string, enabled: boolean): void {
    const live = this.requireLive(accountId);
    if (enabled && !this.allChecked(live.stored))
      throw new Error("Check the saved models before resuming.");
    live.enabled = enabled;
    if (enabled) for (const wake of [...live.waiters]) wake();
  }

  /** Block now; active requests and paused waits stop before any deletion. */
  close(accountId: string): void {
    const live = this.live.get(accountId);
    if (!live) return;
    live.closed = true;
    setCustomCompaction(live.ref.providerId, []);
    live.rechecking?.abort();
    live.transport?.close();
    live.stored.input.key = "";
    live.stored.input.headers = [];
    for (const wake of [...live.waiters]) wake();
    for (const draft of this.drafts.values())
      if (draft.input.replaceAccountId === accountId) this.cancel(draft.id);
  }
  async forget(accountId: string): Promise<void> {
    this.close(accountId);
    const live = this.live.get(accountId);
    await live?.runtime?.catch(() => undefined);
    this.live.delete(accountId);
  }

  async runtime(ref: AccountRef): Promise<ModelRuntime> {
    const live = this.requireLive(ref.accountId);
    live.runtime ??= Promise.all([
      createModelRuntime({
        authPath: join(ref.dir, "runtime-auth.json"),
        modelsPath: join(ref.dir, "runtime-models.json"),
        connectionProvider: ref.providerId,
      }),
      // Its names and prices read the live catalog its protocol keeps fresh.
      this.catalogSource.want([live.stored.input.protocol]),
    ]).then(([runtime]) => {
      if (live.closed || this.live.get(ref.accountId) !== live) throw new CustomApiError("closed");
      this.registerRuntime(live, runtime);
      live.ready = runtime;
      return runtime;
    });
    return live.runtime;
  }
  settledRuntime(accountId: string): ModelRuntime | undefined {
    return this.live.get(accountId)?.ready;
  }

  private registerRuntime(live: Live, runtime: ModelRuntime): void {
    const input = live.stored.input;
    const catalog = this.catalog();
    // Pi sees only availability. It never resolves this connection's key or
    // any ambient account. The guarded stream below owns actual authentication.
    runtime.getAuth = async (requested) => {
      const provider = typeof requested === "string" ? requested : requested.provider;
      if (provider !== live.ref.providerId || live.closed) throw new CustomApiError("closed");
      return {
        auth: { apiKey: "firstmate-custom-availability-only" },
        source: "connection availability",
      };
    };
    setCustomCompaction(
      live.ref.providerId,
      input.models.map((model) => [model.id, { ...input.compaction, ...model.compaction }]),
    );
    runtime.registerProvider(live.ref.providerId, {
      api: input.protocol,
      baseUrl: input.baseUrl,
      apiKey: "firstmate-custom-availability-only",
      streamSimple: customApiStream(async (modelId, signal) => {
        live.active++;
        try {
          await this.admit(live, signal);
          if (!this.proofMatches(live.stored, modelId)) throw new CustomApiError("incompatible");
          const candidate = this.candidate(live.stored, modelId);
          live.transport ??= createCustomApiTransport({
            ...candidate,
            generation: "turn",
            onTokenState: (failed) => {
              live.tokenCommandFailed = failed;
            },
          });
          let released = false;
          return {
            transport: live.transport,
            release: () => {
              if (!released) {
                released = true;
                live.active--;
              }
            },
            generation: {
              protocol: candidate.protocol,
              model: modelId,
              limits: candidate.limits,
              storage: candidate.storage,
              readsPictures: live.stored.proofs[modelId]?.readsPictures === true,
              capabilities: candidate.capabilities,
              cacheRetention: candidate.cacheRetention,
            },
          };
        } catch (error) {
          live.active--;
          throw error;
        }
      }),
      models: input.models
        .filter((model) => this.proofMatches(live.stored, model.id))
        .map((model) => {
          // Exact ids only, in catalog order if several providers list the id.
          // Borrow descriptive/pricing metadata, never another provider's
          // credentials, wire settings or unchecked capability claims. What
          // the person stated wins over the catalog.
          const known = catalog.find((entry) => entry.id === model.id);
          return customPiModel({
            protocol: input.protocol,
            provider: live.ref.providerId,
            model: model.id,
            name: model.name ?? known?.name,
            limits: { context: model.context, output: model.output },
            readsPictures: live.stored.proofs[model.id]?.readsPictures,
            capabilities: live.stored.capabilities?.[model.id],
            cost: customModelCost(model.cost, known?.cost),
          });
        }),
    });
  }

  private async admit(live: Live, signal?: AbortSignal): Promise<void> {
    if (live.closed) throw new CustomApiError("closed");
    if (signal?.aborted) throw new CustomApiError("cancelled");
    if (live.enabled && !held(live)) return;
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        live.waiters.delete(wake);
        signal?.removeEventListener("abort", wake);
        if (live.closed) reject(new CustomApiError("closed"));
        else if (signal?.aborted) reject(new CustomApiError("cancelled"));
        else resolve();
      };
      live.waiters.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
    if (!live.enabled || held(live)) throw new CustomApiError("closed");
  }

  private destination(stored: Stored): CustomApiTransportOptions {
    const input = stored.input;
    return {
      ...(input.protocol === "anthropic-messages" ? { anthropic: true } : {}),
      baseUrl: input.baseUrl,
      mode: input.mode,
      ...(input.addressException ? { exception: true } : {}),
      credential: input.tokenCommand
        ? { kind: "command", settings: input.tokenCommand }
        : input.noKey
          ? { kind: "local-no-key" }
          : { kind: "bearer", key: input.key },
      ...(input.headers.length ? { headers: input.headers } : {}),
      ...(input.certificates ? { certificates: input.certificates } : {}),
    };
  }
  private candidate(stored: Stored, modelId: string): CustomConnectionCandidate {
    const input = stored.input;
    const model = input.models.find((entry) => entry.id === modelId);
    if (!model) throw new CustomApiError("limits");
    return {
      ...this.destination(stored),
      protocol: input.protocol,
      credentialRevision: stored.credentialRevision,
      model: modelId,
      limits: { context: model.context, output: model.output },
      capabilities: stored.capabilities?.[modelId],
      cacheRetention: model.cacheRetention ?? customDefaultCacheRetention(input.protocol),
      ...(model.input && !model.input.includes("image") ? { textOnly: true } : {}),
      storage: input.allowStorageDefault
        ? { kind: "server-default", consentRevision: stored.storageRevision }
        : { kind: "no-store" },
    };
  }
  private proofMatches(stored: Stored, modelId: string): boolean {
    try {
      return customModelProofMatches(this.candidate(stored, modelId), stored.proofs[modelId]);
    } catch {
      return false;
    }
  }
  private allChecked(stored: Stored): boolean {
    return stored.input.models.every((model) => this.proofMatches(stored, model.id));
  }
  private viewStored(
    stored: Stored,
    enabled: boolean,
    accountId?: string,
    draft?: Draft,
    failures = draft?.failures,
  ): CustomApiView {
    const input = stored.input;
    return {
      ...(draft ? { draftId: draft.id } : {}),
      ...(accountId ? { accountId } : {}),
      label: input.label,
      baseUrl: input.baseUrl,
      mode: input.mode,
      protocol: input.protocol,
      keyPresent: !input.noKey && Boolean(input.key),
      ...(input.tokenCommand ? { tokenCommand: input.tokenCommand } : {}),
      ...(accountId && this.live.get(accountId)?.tokenCommandFailed
        ? { tokenCommandFailed: true }
        : {}),
      noKey: input.noKey,
      headers: input.headers.map((header) =>
        header.secret
          ? { name: header.name, secret: true }
          : { name: header.name, secret: false, value: header.value },
      ),
      enabled,
      allowStorageDefault: input.allowStorageDefault,
      ...(input.addressException ? { addressException: true } : {}),
      ...(input.compaction ? { compaction: input.compaction } : {}),
      ...(input.file
        ? {
            file: {
              name: input.file,
              state: accountId ? (this.live.get(accountId)?.file ?? "current") : "current",
            },
          }
        : {}),
      // Saved identity can still be read after expiry; admission/proof validation
      // continues to parse the actual PEM and refuses invalid trust.
      certificates: stored.reviewedCertificates ?? [],
      models: input.models.map((model) => {
        const checked = this.proofMatches(stored, model.id);
        const failure = failures?.get(model.id);
        return {
          ...model,
          checked,
          readsPictures: checked && stored.proofs[model.id]?.readsPictures === true,
          state:
            draft?.checking === model.id
              ? "checking"
              : failure
                ? failure.category === "key-rejected"
                  ? "key-rejected"
                  : ["network", "timeout", "stalled", "certificate"].includes(failure.category)
                    ? "unreachable"
                    : "incompatible"
                : checked
                  ? "checked"
                  : "untested",
          ...(failure ? { failure: failure.message, category: failure.category } : {}),
        };
      }),
    };
  }
  private requireDraft(id: string): Draft {
    const draft = this.drafts.get(id);
    if (!draft) throw new CustomApiError("cancelled");
    return draft;
  }
  private requireLive(id: string): Live {
    const live = this.live.get(id);
    if (!live || live.closed) throw new CustomApiError("closed");
    return live;
  }
  private write(ref: AccountRef, stored: Stored): void {
    const target = join(ref.dir, "custom-auth.json");
    const temporary = join(ref.dir, `.${revision()}.pending`);
    try {
      writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
/** True when the edit changed some model's name or prices and nothing else a check or request reads. */
function onlyNamesOrPrices(saved: CustomApiInput, next: CustomApiInput): boolean {
  const checked = (input: CustomApiInput) =>
    JSON.stringify([
      input.key,
      input.noKey,
      input.tokenCommand ?? null,
      input.headers.map(({ name, value, secret }) => [name, value, secret]),
      input.protocol,
      input.allowStorageDefault,
      input.models.map((model) => [
        model.id,
        model.context,
        model.output,
        model.reasoningProfile ?? null,
        model.cacheRetention ?? customDefaultCacheRetention(input.protocol),
        model.input ?? null,
        model.statedReasoning ?? null,
      ]),
    ]);
  // Compaction is the session's own budget, sent nowhere, so it joins names and prices.
  const described = (input: CustomApiInput) =>
    JSON.stringify([
      input.compaction ?? null,
      input.models.map(({ name, cost, compaction }) => [
        name ?? null,
        cost ?? null,
        compaction ?? null,
      ]),
    ]);
  return checked(saved) === checked(next) && described(saved) !== described(next);
}
/** A capability snapshot for a model line: its catalog profile's, the file's stated reasoning, or none. */
function capabilitiesOf(
  protocol: CustomApiInput["protocol"],
  model: CustomApiInput["models"][number],
  catalog: ReturnType<typeof customCatalog>,
): CustomCapabilities | undefined {
  const retention = model.cacheRetention ?? customDefaultCacheRetention(protocol);
  const snapshot = model.reasoningProfile
    ? customCapabilities(protocol, model.reasoningProfile, catalog)
    : model.statedReasoning
      ? customStatedCapabilities(protocol, model.statedReasoning)
      : undefined;
  if (!(snapshot?.cacheRetentions ?? customCacheRetentions(protocol)).includes(retention))
    throw new CustomApiError("incompatible");
  return snapshot;
}
function held(live: Live): boolean {
  return live.file === "changed" || live.file === "missing";
}
/**
 * What a computer approves for a connection: its address, protocol and
 * headers, a secret one by name alone, since its value is typed here.
 */
function approvalOf(input: Pick<CustomApiInput, "baseUrl" | "protocol" | "headers">): string {
  return JSON.stringify([
    input.baseUrl,
    input.protocol,
    input.headers
      .map((header) => [
        header.name.toLowerCase(),
        header.secret,
        header.secret ? "" : header.value,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}
function fileApprovalOf(definition: CustomFileDefinition, mode: CustomApiInput["mode"]): string {
  try {
    return approvalOf({
      baseUrl: normalizeCustomApiBase(definition.baseUrl, mode).baseUrl,
      protocol: definition.protocol,
      headers: definition.headers.map((header) => ({ ...header, value: header.value ?? "" })),
    });
  } catch {
    return "";
  }
}
function revision(): string {
  return randomBytes(16).toString("hex");
}
/**
 * What DNS answered for a refused name, each with its kind of network, and
 * whether the person may make an exception for them. A literal address was
 * never answered by DNS, so it gets neither.
 */
function deniedAnswers(
  baseUrl: string,
  error: CustomApiError,
): Pick<CustomApiAddress, "answers" | "exceptionOffered"> {
  if (error.category !== "destination" || !error.addresses?.length) return {};
  try {
    if (isIP(customApiHostname(baseUrl))) return {};
  } catch {
    return {};
  }
  return {
    answers: error.addresses.map((address) => ({ address, kind: customApiAnswerKind(address) })),
    exceptionOffered: customApiExceptionAllows(error.addresses),
  };
}
function failureOf(error: unknown, stage: CustomApiFailure["stage"]): CustomApiFailure {
  if (!(error instanceof CustomApiError)) return { category: "malformed", stage };
  return {
    category: error.category,
    stage,
    ...(error.baseSuggestion ? { suggestion: error.baseSuggestion } : {}),
  };
}
