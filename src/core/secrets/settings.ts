import { randomUUID } from "node:crypto";
import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import {
  SECRET_DEVICE_WORDS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  type SecretAction,
  type SecretApprovals,
  type SecretDecision,
  type SecretDecisionInput,
  type SecretEnrollInput,
  type SecretEntryInput,
  type SecretRehearsal,
  type SecretRehearsalInput,
  type SecretsView,
} from "@shared/secrets";
import { askingView } from "../askedFromAView";
import type { HostSecretsRecovery } from "../host";
import { escapeCardText } from "../orchestrator/cardText";
import { secretApprovalBody } from "./approvalCard";
import { approvalCode, approvalKey, type RemoteDecision } from "./approvals";
import type { ApprovalDevice } from "./authority";
import { type BrokeredUse, type SecretBroker, validBrokeredUse } from "./brokers";
import type { HistoryItem } from "./journal";
import type { ProtectedSecrets, ProtectedSecretsOptions } from "./protected";
import { SHORT_READ_SECONDS, SHORT_READ_USES } from "./readAccess";
import type { RecipientFacts } from "./recipient";
import type { RecoveryFiles } from "./recoveryArchive";
import {
  type EndedUseReceipt,
  type Injection,
  SECRET_REQUEST_LIFETIME_MS,
  SecretRequests,
  type SecretsCommand,
  type UseReceipt,
  validInjection,
} from "./requests";

export type SecretsSettingsOptions = {
  /** Absent in production until native custody and confirmation have been proven. */
  open?: (initialize: boolean) => Promise<ProtectedSecrets>;
  unlock?: () => Promise<boolean>;
  recovery?: HostSecretsRecovery;
  raise: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
  withdraw: (id: string, reason: string) => void;
  changed: () => void;
  /** A waiting requester hears the terminal receipt through the existing task inbox, never values. */
  settled?: (task: string, receipt: EndedUseReceipt) => void;
  /** A task's title, so the Secrets page can say which task last used a secret. */
  taskTitle?: (task: string) => string | undefined;
  now?: ProtectedSecretsOptions["now"];
};
type Owner = { protected: ProtectedSecrets; requests: SecretRequests };
type Offer = { group: string; run: () => Promise<void> };

/**
 * Trusted Settings/controller facade. It shares the protected owner and coordinator with
 * brokered consumers; no plaintext getter, approval proof or broker result crosses its view.
 * Agent commands receive only commandFor's metadata/receipt methods, never this controller.
 * Offers are process-local and single-use: a persisted host card after restart grants nothing.
 */
export class SecretsSettings {
  private opening: Promise<Owner> | undefined;
  private owner: Owner | undefined;
  private readonly offers = new Map<string, Offer>();
  private readonly taskOf = new Map<string, Set<string>>();
  private readonly awaiting = new Map<string, Set<string>>();
  private readonly brokers = new Map<string, SecretBroker>();
  private readonly now: () => number;
  private message: string | null = null;
  private offeredCard: string | null = null;
  private choosingRecovery = false;
  /** Uses whose approval card is up: a phone draws its own Allow and Deny on that card. */
  private readonly useCards = new Set<string>();
  /**
   * Paired phones whose switch the captain turned on in Settings -> Devices:
   * each offers its key when it next reads its approvals. Process-local, like
   * the cards it leads to; nothing is enrolled until the code card is confirmed.
   */
  private readonly askedPhones = new Set<string>();
  /** The paired device each waiting enrollment offer came from, by its approval device. */
  private readonly offeredFrom = new Map<string, string>();
  private viewEpoch = 0;

  constructor(private readonly options: SecretsSettingsOptions) {
    this.now = options.now ?? Date.now;
    // Every published change invalidates older async snapshots, including ones
    // that kept the same owner (for example an explicit history deletion).
    this.options = {
      ...options,
      changed: () => {
        this.viewEpoch += 1;
        options.changed();
      },
    };
  }

  private async ready(initialize = false): Promise<Owner | undefined> {
    if (!this.options.open) return undefined;
    if (this.opening) await this.opening;
    if (this.owner && !(initialize && this.owner.protected.availability === "uninitialized"))
      return this.owner;
    const opening = this.options.open(initialize).then((protectedOwner) => {
      const requests = new SecretRequests(protectedOwner, this.now, (receipt) =>
        this.receiptChanged(receipt),
      );
      return { protected: protectedOwner, requests };
    });
    this.opening = opening;
    try {
      const opened = await opening;
      for (const broker of this.brokers.values()) opened.protected.registerBroker(broker);
      this.owner = opened;
      return this.owner;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  private receiptChanged(receipt: UseReceipt): void {
    if (receipt.state !== "waiting" && receipt.state !== "executing") {
      const group = `use-${receipt.request}`;
      for (const [id, offer] of this.offers) if (offer.group === group) this.offers.delete(id);
      const card = `card-secrets-${group}`;
      this.options.withdraw(card, "This Secrets request is no longer waiting.");
      if (this.offeredCard === card) this.offeredCard = null;
      this.useCards.delete(receipt.request);
      const tasks = this.awaiting.get(receipt.request);
      this.awaiting.delete(receipt.request);
      for (const task of tasks ?? []) {
        this.options.settled?.(task, { ...receipt, state: receipt.state });
      }
    }
    this.options.changed();
  }

  private track(owner: Owner, receipt: UseReceipt, task: string): void {
    const tasks = this.taskOf.get(receipt.request) ?? new Set<string>();
    tasks.add(task);
    this.taskOf.set(receipt.request, tasks);
    if (receipt.state !== "waiting" && receipt.state !== "executing") return;
    const waiting = this.awaiting.get(receipt.request) ?? new Set<string>();
    waiting.add(task);
    this.awaiting.set(receipt.request, waiting);
    // An allowed operation can finish between returning its initial receipt and this continuation.
    const settled = owner.requests.settled(receipt.request);
    if (settled) this.receiptChanged(settled);
  }

  /** Whether this build keeps protected storage at all; it never opens the storage to answer. */
  shown(): boolean {
    return !!this.options.open;
  }

  async view(): Promise<SecretsView> {
    const owner = await this.ready().catch(() => undefined);
    const epoch = this.viewEpoch;
    const empty: SecretsView = {
      availability: this.options.open ? "unavailable" : "not-enabled",
      home: null,
      offeredCard: this.offeredCard,
      entries: [],
      uses: [],
      rules: [],
      history: [],
      historyBytes: 0,
      recoveryAvailable: !!this.options.open && !!this.options.recovery,
      reads: [],
      devices: [],
      message: this.message,
    };
    if (!owner) return empty;
    const authority = owner.protected.authority();
    const history = owner.protected.history();
    const snapshot: SecretsView = {
      ...empty,
      availability: await owner.protected.status(),
      home: authority?.home ?? null,
      entries: (await owner.protected.metadata()).map(
        ({ ref, label, version, revision, updatedAt, environment }) => ({
          ref,
          label,
          version,
          revision,
          updatedAt,
          environment: environment ?? "",
          ...this.lastUse(history.filter((item) => item.secrets.includes(ref)).at(-1)),
        }),
      ),
      uses: owner.requests.receipts().map((receipt) => this.receiptView(owner, receipt)),
      rules: authority?.rules ?? [],
      history,
      historyBytes: await owner.protected.storageUse(),
      reads: owner.protected.readPermissions(),
      devices: (authority?.devices ?? []).map(
        ({ device, label, generation, publicKey, paired }) => ({
          device,
          label,
          generation,
          code: approvalCode(publicKey),
          ...(paired ? { paired } : {}),
          ...(this.offering(`forget-device-${device}`) ? { stopping: true } : {}),
        }),
      ),
      phones: this.phoneSetups(),
    };
    // Recovery can replace the owner; other changes can invalidate its snapshot
    // while native status or metadata is being read.
    return this.owner === owner && this.viewEpoch === epoch ? snapshot : this.view();
  }

  /** Whether a card of this group still waits for the captain's choice. */
  private offering(group: string): boolean {
    return [...this.offers.values()].some((offer) => offer.group === group);
  }

  /** Paired phones on their way to approving: a key's card is up, or the home waits for the key. */
  private phoneSetups(): NonNullable<SecretsView["phones"]> {
    const comparing = new Map(
      [...this.offeredFrom]
        .filter(([device]) => this.offering(`enroll-${device}`))
        .map(([device, paired]) => [paired, `card-secrets-enroll-${device}`]),
    );
    return [
      ...[...comparing].map(([paired, card]) => ({ paired, state: "comparing" as const, card })),
      ...[...this.askedPhones]
        .filter((paired) => !comparing.has(paired))
        .map((paired) => ({ paired, state: "waiting" as const })),
    ];
  }

  /** The switch on a paired phone turned off before its key enrolled: stop asking, and take down its card. */
  private cancelPhone(paired: string): void {
    this.askedPhones.delete(paired);
    for (const [device, from] of this.offeredFrom) {
      if (from !== paired) continue;
      this.offeredFrom.delete(device);
      const group = `enroll-${device}`;
      for (const [id, offer] of this.offers) if (offer.group === group) this.offers.delete(id);
      this.options.withdraw(`card-secrets-${group}`, SECRET_DEVICE_WORDS.cancelled);
    }
  }

  /** When a secret was last asked for, and the title of the task that asked, when it is known. */
  private lastUse(item: HistoryItem | undefined): {
    lastRequest: number | null;
    lastTask?: string;
  } {
    if (!item) return { lastRequest: null };
    const task = this.taskOf.get(item.request)?.values().next().value ?? intentTask(item.intent);
    const title = task ? this.options.taskTitle?.(task) : undefined;
    return { lastRequest: item.requestedAt, ...(title ? { lastTask: title } : {}) };
  }

  private receiptView(owner: Owner, receipt: UseReceipt): SecretsView["uses"][number] {
    const script = owner.protected.describe(receipt.request);
    const broker = owner.protected.describeBrokered(receipt.request);
    const historical = owner.protected.history().find((item) => item.request === receipt.request);
    return {
      ...receipt,
      reason: script?.reason ?? broker?.reason ?? historical?.reason ?? "",
      recipient: script?.facts.executable.path ?? broker?.facts.label ?? historical?.program ?? "",
      facts: script
        ? commandFacts(script.facts)
        : broker
          ? [
              { name: "Destination", value: broker.facts.destination },
              { name: "Operation", value: broker.facts.operation },
              { name: "Result handling", value: broker.facts.result },
              { name: "Read only", value: broker.facts.read ? "Yes" : "No" },
              { name: "Exact request", value: broker.facts.inputDigest },
            ]
          : [],
      // The record the use prepared, never a later lookup that could describe a replacement.
      secrets: (script?.secrets ?? broker?.secrets ?? []).map(
        ({ ref, label, version, environment }) => ({
          ref,
          label,
          version,
          environment: environment ?? "",
        }),
      ),
      shortReadEligible: broker?.shortReadEligible ?? false,
      expires: owner.requests.pending(receipt.request)?.expires ?? null,
    };
  }

  /**
   * Only secure Settings entry invokes this; the value is not stored in cards, receipts or history.
   * Every entry saved here joins the one catalog every crewmate's command lists; listing grants no use.
   */
  async put(input: SecretEntryInput): Promise<SecretsView> {
    const value = Buffer.from(input.value);
    let saved: SecretsView["saved"];
    try {
      const owner = await this.ready(true);
      if (!owner) this.message = SECRETS_WORDS.disabled;
      else {
        const metadata = await owner.protected.metadata();
        const replacing = input.expectedVersion !== 0 || input.expectedRevision !== null;
        const ref =
          input.ref ??
          (replacing
            ? undefined
            : newReference(input.label, [
                ...metadata.map((entry) => entry.ref),
                ...(owner.protected.authority()?.rules.map((rule) => rule.secret) ?? []),
                ...owner.protected.history().flatMap((item) => item.secrets),
              ]));
        const written = ref
          ? await owner.protected.putSecret(ref, input.label, value, {
              discoverable: true,
              expectedVersion: input.expectedVersion,
              expectedRevision: input.expectedRevision,
              environment: input.environment,
            })
          : undefined;
        if (written) {
          this.message = SECRETS_WORDS.saved;
          saved = { ref: written.ref, version: written.version };
        } else {
          const current = (await owner.protected.metadata()).find((entry) => entry.ref === ref);
          this.message =
            ref &&
            ((current?.version ?? 0) !== input.expectedVersion ||
              (current?.revision ?? null) !== input.expectedRevision)
              ? SECRETS_WORDS.stale
              : SECRETS_WORDS.unavailable;
        }
      }
    } catch {
      this.message = SECRETS_WORDS.unavailable;
    } finally {
      value.fill(0);
      this.options.changed();
    }
    const view = await this.view();
    return saved ? { ...view, saved } : view;
  }

  async action(action: SecretAction): Promise<SecretsView> {
    this.message = null;
    this.offeredCard = null;
    const owner = await this.ready();
    if (!owner) return this.view();
    switch (action.kind) {
      case "backup-recovery":
      case "restore-recovery":
        await this.recoveryAction(owner, action.kind);
        break;
      case "unlock":
        if (this.options.unlock) await this.options.unlock();
        if (owner.protected.availability !== "available") this.owner = undefined;
        this.message = null;
        break;
      case "review-use":
        this.offerUse(owner, action.request);
        break;
      case "cancel-use":
        await owner.requests.cancel(action.request);
        break;
      case "end-read":
        owner.protected.endReadAccess(action.id);
        break;
      case "forget": {
        const entry = (await owner.protected.metadata()).find((one) => one.ref === action.ref);
        if (entry)
          this.offer(
            `forget-${entry.ref}`,
            "Forget this secret?",
            `<p>Forget ${escapeCardText(entry.label)} from this computer?</p><p>This does not revoke the key at its provider or remove copies a recipient kept.</p>`,
            [
              {
                label: "Forget secret",
                run: async () => {
                  const forgotten = await owner.protected.forgetSecret(
                    entry.ref,
                    entry.version,
                    entry.revision,
                  );
                  this.message = forgotten
                    ? "Secret forgotten locally."
                    : "This secret changed or storage is locked. Nothing was forgotten.";
                },
              },
              { label: "Keep secret", run: async () => {} },
            ],
          );
        break;
      }
      case "forget-device": {
        const device = owner.protected
          .authority()
          ?.devices.find((one) => one.device === action.device);
        if (!device) break;
        const label = escapeCardText(device.label);
        this.offer(
          `forget-device-${device.device}`,
          SECRET_DEVICE_WORDS.stopTitle(device.label),
          `<p>${label} will no longer approve Secrets uses. Uses it could approve wait for you on this computer instead.</p><p>${label} stays paired. The system will ask you to confirm.</p>`,
          [
            {
              label: SECRETS_WORDS.stopApprovals,
              run: async () => {
                const saved = await this.saveDevices(
                  owner,
                  (devices) => devices.filter((one) => one.device !== device.device),
                  `Stop Secrets approvals from ${device.label}.`,
                );
                this.message = saved
                  ? SECRET_DEVICE_WORDS.stopped(device.label)
                  : SECRET_DEVICE_WORDS.unchanged;
              },
            },
            { label: SECRET_DEVICE_WORDS.keep, run: async () => {} },
          ],
        );
        break;
      }
      case "ask-phone":
        this.askedPhones.add(action.paired);
        break;
      case "cancel-phone":
        this.cancelPhone(action.paired);
        break;
      case "delete-history":
        this.offer(
          "delete-history",
          "Delete Secrets history?",
          "<p>Delete the metadata history on this computer?</p><p>Pending and running uses keep their records until they end. Export anything you want to keep first.</p><p>This includes older retained history files, but leaves recovery archives and exported copies unchanged.</p>",
          [
            {
              label: "Delete history",
              run: async () => {
                const result = await owner.protected.clearHistory();
                this.message =
                  result === "cleared"
                    ? "Secrets history deleted."
                    : result === "busy"
                      ? "Wait for pending or running uses to end before deleting history."
                      : SECRETS_WORDS.unavailable;
              },
            },
            { label: "Keep history", run: async () => {} },
          ],
        );
        break;
      case "save-rules": {
        const authority = owner.protected.authority();
        if (!authority) break;
        const proposal = owner.protected.proposeAuthority({
          rules: structuredClone(action.rules),
          devices: authority.devices,
        });
        if (!proposal) break;
        const rows = action.rules
          .map(
            (rule) =>
              `<li>${escapeCardText(rule.effect)}: ${escapeCardText(rule.secret)}${rule.operation ? ` — ${escapeCardText(rule.operation)}` : " — every use"}${rule.note ? ` (${escapeCardText(rule.note)})` : ""}</li>`,
          )
          .join("");
        this.offer(
          "rules",
          "Save these Secrets rules?",
          `<p>These rules replace your current Secrets rules.</p><ul>${rows || "<li>No saved rules. Every use asks.</li>"}</ul><p>Never wins over Ask, then Allow. Allow names one exact operation; it cannot allow every program.</p><p>The system will ask you to confirm. Rules do not grant permission for an external action.</p>`,
          [
            {
              label: "Confirm and save",
              run: async () => {
                const proof = await owner.protected.confirmAuthority(
                  proposal.digest,
                  this.now() + SECRET_REQUEST_LIFETIME_MS,
                  "Confirm the exact Secrets rule changes shown in Infinitary.",
                );
                const result = proof
                  ? await owner.protected.saveAuthority(proposal.authority, proof)
                  : "refused";
                this.message =
                  result === "stored"
                    ? "Secrets rules saved."
                    : "Rules did not change. Confirmation failed or the rules changed while you were deciding.";
              },
            },
            { label: "Keep current rules", run: async () => {} },
          ],
        );
        break;
      }
    }
    this.options.changed();
    return this.view();
  }

  private async recoveryAction(
    owner: Owner,
    kind: "backup-recovery" | "restore-recovery",
  ): Promise<void> {
    const files = this.options.recovery;
    if (!files) {
      this.message = SECRETS_RECOVERY_WORDS.unavailable;
      return;
    }
    if (this.choosingRecovery) {
      this.message = SECRETS_RECOVERY_WORDS.choosing;
      return;
    }
    this.choosingRecovery = true;
    let selected: RecoveryFiles | undefined;
    let restoring = false;
    try {
      if (kind === "backup-recovery") {
        const writer = await files.chooseSave();
        this.message = writer
          ? SECRETS_RECOVERY_WORDS.save[await owner.protected.backupRecovery(writer)]
          : SECRETS_RECOVERY_WORDS.cancelled;
      } else {
        selected = await files.chooseRestore();
        if (!selected) {
          this.message = SECRETS_RECOVERY_WORDS.cancelled;
          return;
        }
        restoring = true;
        const result = await owner.protected.restoreRecovery(selected, () =>
          owner.requests.pauseForRecovery(),
        );
        this.message = SECRETS_RECOVERY_WORDS.restore[result];
        if (result === "restored" || result === "unknown") {
          const groups = new Set([...this.offers.values()].map((offer) => offer.group));
          this.offers.clear();
          this.offeredCard = null;
          this.owner = undefined;
          for (const group of groups) {
            try {
              this.options.withdraw(
                `card-secrets-${group}`,
                "Recovery changed protected storage. This earlier choice no longer applies.",
              );
            } catch {
              /* A failed presentation update cannot restore the retired authority. */
            }
          }
        }
      }
    } catch {
      this.message =
        kind === "restore-recovery"
          ? restoring
            ? SECRETS_RECOVERY_WORDS.restore.unknown
            : SECRETS_RECOVERY_WORDS.unreadable
          : SECRETS_RECOVERY_WORDS.save.unknown;
    } finally {
      selected?.archive.fill(0);
      selected?.key.fill(0);
      this.choosingRecovery = false;
    }
  }

  /**
   * What a phone reads (docs/secrets.md, "Remote decisions"): its own
   * enrollment and the uses waiting now, described as the approval card
   * describes them. The challenge it signs goes only to an enrolled device; no
   * value, rule or other device crosses.
   */
  async approvals(device: string): Promise<SecretApprovals> {
    const view = askingView();
    const owner = await this.ready().catch(() => undefined);
    const authority = owner?.protected.authority();
    const enrolled = authority?.devices.find((one) => one.device === device);
    const waiting = owner
      ? owner.requests.receipts().flatMap((receipt) => {
          const pending = owner.requests.pending(receipt.request);
          if (!pending) return [];
          const use = this.receiptView(owner, receipt);
          const challenge = enrolled
            ? owner.protected.challenge(receipt.request, pending.digest, pending.expires)
            : undefined;
          return [
            {
              request: receipt.request,
              card: this.useCards.has(receipt.request)
                ? `card-secrets-use-${receipt.request}`
                : null,
              digest: pending.digest,
              expires: pending.expires,
              nonce: challenge?.nonce ?? null,
              reason: use.reason,
              recipient: use.recipient,
              secrets: use.secrets.map(({ ref, label, version, environment }) => ({
                ref,
                label,
                version,
                environment,
              })),
              facts: use.facts,
            },
          ];
        })
      : [];
    return {
      availability: owner
        ? await owner.protected.status()
        : this.options.open
          ? "unavailable"
          : "not-enabled",
      home: authority?.home ?? null,
      device: enrolled
        ? { label: enrolled.label, generation: enrolled.generation, key: enrolled.publicKey }
        : null,
      offered: this.offering(`enroll-${device}`),
      asked: !!view && this.askedPhones.has(view),
      waiting,
    };
  }

  /**
   * A phone offers its approval key. Nothing changes until the captain compares
   * the code on both screens and confirms on this computer; a new key for the
   * same device enrolls it at the next generation.
   */
  async enroll(input: SecretEnrollInput): Promise<SecretApprovals> {
    // The paired device that asks, so its row in Settings -> Devices carries the switch.
    const paired = askingView();
    const owner = await this.ready().catch(() => undefined);
    const current = owner?.protected
      .authority()
      ?.devices.find((one) => one.device === input.device);
    // Only Secrets that are set up and open can take an approval device. The same
    // key offered again from a paired device the home has not linked it to links
    // it, through the same comparison and confirmation as a new key.
    if (
      owner &&
      (await owner.protected.status()) === "available" &&
      approvalKey(input.key) &&
      (current?.publicKey !== input.key || (!!paired && current.paired !== paired))
    ) {
      if (paired) this.offeredFrom.set(input.device, paired);
      else this.offeredFrom.delete(input.device);
      const settled = () => {
        if (paired) this.askedPhones.delete(paired);
        this.offeredFrom.delete(input.device);
      };
      const label = escapeCardText(input.label);
      this.offer(
        `enroll-${input.device}`,
        SECRET_DEVICE_WORDS.enrollTitle(input.label),
        `<p>${label} asks to approve Secrets uses from where it is.</p>
        <p>Check that this code matches the one Infinitary shows on ${label}:</p>
        <p><code class="inf-mono" style="font-size:14px">${approvalCode(input.key)}</code></p>
        <p>If the codes differ, choose Not now.</p>
        <p>Each Allow from ${label} needs its Face ID, Touch ID or passcode, for that one use. It never receives a secret, and your rules still apply.</p>
        ${current && current.publicKey !== input.key ? `<p>This replaces the approvals ${escapeCardText(current.label)} could give before.</p>` : ""}
        <p>The system will ask you to confirm.</p>`,
        [
          {
            label: SECRET_DEVICE_WORDS.confirm,
            run: async () => {
              const saved = await this.saveDevices(
                owner,
                (devices) => {
                  const previous = devices.find((one) => one.device === input.device);
                  return [
                    ...devices.filter((one) => one.device !== input.device),
                    {
                      device: input.device,
                      label: input.label,
                      generation: (previous?.generation ?? 0) + 1,
                      publicKey: input.key,
                      ...(paired ? { paired } : {}),
                    },
                  ];
                },
                `Let ${input.label} approve Secrets uses.`,
              );
              settled();
              this.message = saved
                ? SECRET_DEVICE_WORDS.enrolled(input.label)
                : SECRET_DEVICE_WORDS.unchanged;
            },
          },
          { label: SECRET_DEVICE_WORDS.notNow, run: async () => settled() },
        ],
      );
      this.options.changed();
    }
    return this.approvals(input.device);
  }

  /** A phone's decision on one use: Allow passes only with its enrolled signature; a refusal needs none. */
  async decideRemotely(input: SecretDecisionInput): Promise<SecretDecision> {
    const owner = await this.ready().catch(() => undefined);
    if (!owner) return { state: "unavailable" };
    if (input.kind === "deny") {
      return { state: (await owner.requests.deny(input.request))?.state ?? "unavailable" };
    }
    const decision: RemoteDecision = {
      kind: "remote",
      device: input.device,
      generation: input.generation,
      nonce: input.nonce,
      signature: input.signature,
    };
    const receipt = await owner.requests.approve(input.request, decision, "started");
    return { state: receipt?.state ?? "unavailable" };
  }

  /** Rules stay as saved; only the approval devices change, under fresh local confirmation. */
  private async saveDevices(
    owner: Owner,
    change: (devices: ApprovalDevice[]) => ApprovalDevice[],
    reason: string,
  ): Promise<boolean> {
    const authority = owner.protected.authority();
    if (!authority) return false;
    const proposal = owner.protected.proposeAuthority({
      rules: authority.rules,
      devices: change(structuredClone(authority.devices)),
    });
    if (!proposal) return false;
    const proof = await owner.protected.confirmAuthority(
      proposal.digest,
      this.now() + SECRET_REQUEST_LIFETIME_MS,
      reason,
    );
    return !!proof && (await owner.protected.saveAuthority(proposal.authority, proof)) === "stored";
  }

  async rehearse(input: SecretRehearsalInput): Promise<SecretRehearsal> {
    const owner = await this.ready();
    const result = await owner?.protected.rehearse(input);
    return result
      ? { ...result.evaluation, operation: result.operation, facts: commandFacts(result.facts) }
      : null;
  }

  async exportHistory(): Promise<string | undefined> {
    return (await this.ready())?.protected.exportHistory();
  }

  private offerUse(owner: Owner, request: string, notice?: string): void {
    const pending = owner.requests.pending(request);
    if (!pending) return;
    const use = this.receiptView(owner, { request, state: "waiting" });
    const confirm = async (short: boolean) => {
      if (!owner.requests.pending(request)) {
        this.message = "This request is no longer waiting. Check its current result in Secrets.";
        return;
      }
      if ((await owner.protected.status()) !== "available") {
        this.message =
          "This use is still waiting. Unlock the system’s secret store, then review it again.";
        this.offerUse(owner, request, this.message);
        return;
      }
      const reason = short
        ? `Allow this exact read for ${SHORT_READ_SECONDS / 60} minutes or ${SHORT_READ_USES} uses, whichever ends first.`
        : "Allow the exact Secrets use shown in Infinitary once.";
      const proof = short
        ? await owner.protected.confirmShortRead(request, pending.digest, pending.expires, reason)
        : await owner.protected.confirmUse(request, pending.digest, pending.expires, reason);
      if (proof) await owner.requests.approve(request, proof);
      if (owner.requests.status(request)?.state === "waiting") {
        this.message = "No confirmation was accepted. This request is still waiting.";
        this.offerUse(owner, request, this.message);
      }
    };
    this.useCards.add(request);
    this.offer(
      `use-${request}`,
      SECRETS_WORDS.approvalTitle,
      secretApprovalBody(use, !!owner.protected.describe(request), notice),
      [
        { label: SECRETS_WORDS.once, run: () => confirm(false) },
        ...(use.shortReadEligible
          ? [{ label: SECRETS_WORDS.short, run: () => confirm(true) }]
          : []),
        {
          label: SECRETS_WORDS.deny,
          run: async () => {
            await owner.requests.deny(request);
          },
        },
      ],
      this.taskOf.get(request)?.values().next().value,
    );
    // A phone reads which card is this use's once the card is up.
    this.options.changed();
  }

  private offer(
    group: string,
    title: string,
    body: string,
    actions: { label: string; run: () => Promise<void> }[],
    taskId?: string,
  ): void {
    for (const [id, offer] of this.offers) if (offer.group === group) this.offers.delete(id);
    const offered = actions.map((action) => ({ ...action, id: randomUUID() }));
    for (const action of offered) this.offers.set(action.id, { group, run: action.run });
    this.offeredCard = `card-secrets-${group}`;
    this.options.raise({
      id: this.offeredCard,
      title,
      body,
      meta: FIRSTMATE_CARD_META,
      ...(taskId ? { taskId } : {}),
      actions: offered.map((action, i) => ({
        id: action.id,
        label: action.label,
        ...(i === 0
          ? { default: true, variant: "primary" as const }
          : { variant: "ghost" as const }),
        effect: { kind: "host" as const, op: "secrets-decision" as const, arg: action.id },
      })),
    });
  }

  /** Only host-authored card chrome calls this. A stale card after restart is inert. */
  async decide(id: string): Promise<void> {
    const offer = this.offers.get(id);
    if (!offer) return;
    for (const [key, sibling] of this.offers)
      if (sibling.group === offer.group) this.offers.delete(key);
    this.message = null;
    this.offeredCard = null;
    try {
      await offer.run();
    } catch {
      this.message = SECRETS_WORDS.unavailable;
    }
    this.options.changed();
  }

  /**
   * One task's command. Discovery is global: every crewmate lists the same
   * catalog of secrets the captain added, metadata only, and listing grants
   * no use. The task names its own receipts and inbox, never authority.
   */
  commandFor(context: { task: string }): SecretsCommand {
    return {
      receipts: () =>
        (this.owner?.requests.receipts() ?? []).filter((receipt) =>
          this.taskOf.get(receipt.request)?.has(context.task),
        ),
      list: async () => (await this.ready())?.protected.list() ?? [],
      inject: async (input: Injection) => {
        const copied = structuredClone(input);
        if (!validInjection(copied)) throw new Error("Invalid injection request.");
        const owner = await this.ready();
        if (!owner) return { request: copied.id, state: "unavailable" as const };
        const receipt = await owner.requests.inject({
          ...copied,
          id: taskIntent(context.task, copied.id),
        });
        this.track(owner, receipt, context.task);
        if (receipt.state === "waiting") this.offerUse(owner, receipt.request);
        return receipt;
      },
      status: async (request: string) => (await this.ready())?.requests.status(request),
      cancel: async (request: string) => {
        const owner = await this.ready();
        // The caller receives its cancellation directly; other requesters still need the result.
        this.awaiting.get(request)?.delete(context.task);
        return owner?.requests.cancel(request);
      },
    };
  }

  /** Core composition supplies executable adapters, never data from a renderer or agent. */
  registerBroker(broker: SecretBroker): void {
    if (this.brokers.has(broker.id)) throw new Error("Duplicate secret broker.");
    this.owner?.protected.registerBroker(broker);
    this.brokers.set(broker.id, broker);
  }

  /** Host-registered consumers only. The caller keeps raw results inside its trusted boundary. */
  async broker(input: BrokeredUse, task?: string): Promise<UseReceipt> {
    const copied = structuredClone(input);
    if (!validBrokeredUse(copied)) throw new Error("Invalid brokered request.");
    const owner = await this.ready();
    if (!owner) return { request: copied.id, state: "unavailable" };
    const receipt = await owner.requests.broker(copied);
    if (task) this.track(owner, receipt, task);
    if (receipt.state === "waiting") this.offerUse(owner, receipt.request);
    return receipt;
  }
  async takeBrokerResult(request: string): Promise<unknown> {
    return (await this.ready())?.protected.takeBrokerResult(request);
  }
}

/** Namespace idempotency, not authority: two tasks may choose the same local intent name. */
function taskIntent(task: string, id: string): string {
  return JSON.stringify([task, id]);
}

/** The task a crewmate's intent names (`taskIntent`), or undefined for any other intent. */
function intentTask(intent: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(intent);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      parsed[0] !== "" &&
      typeof parsed[1] === "string"
      ? parsed[0]
      : undefined;
  } catch {
    return undefined;
  }
}

function commandFacts(facts: RecipientFacts): { name: string; value: string }[] {
  return [
    { name: "Program", value: facts.executable.path },
    { name: "Program digest", value: facts.executable.sha256 },
    { name: "Arguments", value: JSON.stringify(facts.argv) },
    { name: "Working folder", value: facts.cwd },
    { name: "Delivery", value: "Private process environment; output stays private" },
    { name: "Variable mapping", value: JSON.stringify(facts.env) },
    ...(facts.interpreter
      ? [
          {
            name: "Interpreter",
            value: `${facts.interpreter.path} — ${facts.interpreter.sha256}${facts.interpreter.arg ? ` (${facts.interpreter.arg})` : ""}`,
          },
        ]
      : []),
    ...facts.inputs.map((input) => ({
      name: `Input argument ${input.index}`,
      value: `${input.path} — ${input.sha256}`,
    })),
    {
      name: "Limit",
      value:
        "Only the listed program, interpreter and input files are checked. Files loaded later and the recipient's behavior are not isolated.",
    },
  ];
}

/** The reference format holds 64 characters; a made-up one keeps room for its number. */
const REFERENCE_STEM = 64 - "-9999999".length;

/**
 * A stable reference for a new entry, made from its name: lowercase letters and
 * digits joined by dashes, numbered past every reference an entry, a saved rule
 * or the history already holds, so a rule kept for a forgotten secret never
 * names it and its history never reads as the new one's.
 */
export function newReference(label: string, taken: readonly string[]): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, REFERENCE_STEM)
      .replace(/-+$/, "") || "secret";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}
