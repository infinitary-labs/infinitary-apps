import { z } from "zod";

export const secretRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const secretRuleSchema = z.strictObject({
  id: z.string().min(1),
  effect: z.enum(["never", "ask", "allow"]),
  secret: secretRefSchema,
  operation: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  note: z.string().optional(),
});
export const secretStateSchema = z.enum([
  "waiting",
  "executing",
  "completed",
  "denied",
  "cancelled",
  "expired",
  "invalidated",
  "unavailable",
  "unknown",
]);
export const SECRET_STATE_WORDS: Record<z.infer<typeof secretStateSchema>, string> = {
  waiting: "Waiting for approval",
  executing: "Running",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
  expired: "Expired",
  invalidated: "Needs a new request",
  unavailable: "Unavailable",
  unknown: "Outcome unknown",
};
export const secretMetadataSchema = z.strictObject({
  ref: secretRefSchema,
  label: z.string(),
  version: z.number().int().positive(),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  updatedAt: z.number(),
  environment: z.string(),
  lastRequest: z.number().nullable(),
  /**
   * The title of the task that made the last request, when the home still
   * knows it (`secrets-last-task.md`): what the Secrets page names beside when.
   */
  lastTask: z.string().optional(),
});
export const secretUseSchema = z.strictObject({
  request: z.string(),
  state: secretStateSchema,
  reason: z.string(),
  recipient: z.string(),
  facts: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  /** Each secret as the use prepared it; an empty environment means the captain gave none. */
  secrets: z.array(
    z.strictObject({
      ref: z.string(),
      label: z.string(),
      version: z.number(),
      environment: z.string(),
    }),
  ),
  shortReadEligible: z.boolean(),
  expires: z.number().nullable(),
  exitCode: z.number().optional(),
});
export const secretHistorySchema = z.strictObject({
  request: z.string(),
  intent: z.string(),
  program: z.string(),
  secrets: z.array(z.string()),
  reason: z.string(),
  requestedAt: z.number(),
  state: secretStateSchema,
  exitCode: z.number().optional(),
  approval: z.enum(["local", "remote", "rule", "short-read"]).optional(),
  device: z.string().optional(),
  reconciled: z.literal(true).optional(),
  /** Historical metadata imported from a recovery archive, never live authority. */
  recoveredFrom: z.string().optional(),
  recoveredAt: z.number().optional(),
});
export const SECRET_APPROVAL_WORDS: Record<
  NonNullable<z.infer<typeof secretHistorySchema>["approval"]>,
  string
> = {
  local: "Confirmed here",
  remote: "Confirmed on an enrolled device",
  rule: "Saved rule",
  "short-read": "Bounded read",
};
export const secretReadPermissionSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  destination: z.string(),
  secrets: z.array(z.string()),
  expires: z.number(),
  remaining: z.number().int().nonnegative(),
});
/**
 * A device enrolled to approve uses from elsewhere (docs/secrets.md, "Remote
 * decisions"), as Settings lists it: never its key, only the code the captain
 * compared when it enrolled.
 */
export const secretApprovalDeviceSchema = z.strictObject({
  device: z.string(),
  label: z.string(),
  generation: z.number().int().positive(),
  code: z.string(),
  /** The paired device that offered this key, whose row in Settings -> Devices carries its switch. */
  paired: z.string().optional(),
  /** The card that stops its approvals is waiting for the captain. */
  stopping: z.boolean().optional(),
});
/**
 * A paired phone on its way to approving uses (docs/secrets.md, "Remote
 * decisions"): the captain turned its switch on in Settings -> Devices and the
 * home waits for it to offer its key (`waiting`), or its key's card, with the
 * code to compare, is up (`comparing`).
 */
export const secretPhoneSetupSchema = z.strictObject({
  paired: z.string(),
  state: z.enum(["waiting", "comparing"]),
  /** The card with the code to compare, while it is up. */
  card: z.string().optional(),
});
export const secretsViewSchema = z.strictObject({
  availability: z.enum([
    "not-enabled",
    "available",
    "locked",
    "unavailable",
    "uninitialized",
    "lost",
    "tampered",
  ]),
  home: z.string().nullable(),
  offeredCard: z.string().nullable(),
  entries: z.array(secretMetadataSchema),
  uses: z.array(secretUseSchema),
  rules: z.array(secretRuleSchema),
  history: z.array(secretHistorySchema),
  historyBytes: z.number().nonnegative(),
  recoveryAvailable: z.boolean(),
  reads: z.array(secretReadPermissionSchema),
  devices: z.array(secretApprovalDeviceSchema),
  /** Paired phones the captain is turning on; absent from an older home. */
  phones: z.array(secretPhoneSetupSchema).optional(),
  message: z.string().nullable(),
  /**
   * Only on the answer to a Settings entry: the record it saved, so an entry
   * whose reference the controller chose can be found in this view.
   */
  saved: z.strictObject({ ref: secretRefSchema, version: z.number().int().positive() }).optional(),
});
export const secretEntryInputSchema = z.strictObject({
  /**
   * Absent on a new entry: the controller makes a stable reference from the
   * name, never one a saved rule already names. A replacement names its own.
   */
  ref: secretRefSchema.optional(),
  label: z.string().trim().min(1),
  value: z.string().min(1),
  /** Zero adds a new entry; a replacement must still name its displayed version. */
  expectedVersion: z.number().int().nonnegative(),
  /** Null adds an absent entry; a replacement binds the exact sealed record shown by Settings. */
  expectedRevision: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  environment: z.string(),
});
export const secretRehearsalInputSchema = z.strictObject({
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), secretRefSchema),
});
export const secretRehearsalSchema = z
  .strictObject({
    effect: z.enum(["never", "ask", "allow"]),
    operation: z.string(),
    matched: z.array(z.string()),
    facts: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  })
  .nullable();
export const secretActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unlock") }),
  z.strictObject({ kind: z.literal("review-use"), request: z.string() }),
  z.strictObject({ kind: z.literal("cancel-use"), request: z.string() }),
  z.strictObject({ kind: z.literal("end-read"), id: z.string() }),
  z.strictObject({ kind: z.literal("save-rules"), rules: z.array(secretRuleSchema) }),
  z.strictObject({ kind: z.literal("forget"), ref: secretRefSchema }),
  z.strictObject({ kind: z.literal("delete-history") }),
  z.strictObject({ kind: z.literal("backup-recovery") }),
  z.strictObject({ kind: z.literal("restore-recovery") }),
  z.strictObject({ kind: z.literal("forget-device"), device: z.string() }),
  // Settings -> Devices' switch on a paired phone: ask it to offer its key, or stop asking.
  z.strictObject({ kind: z.literal("ask-phone"), paired: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("cancel-phone"), paired: z.string().min(1).max(64) }),
]);

/**
 * A phone's own name for its approval capability: a random id it keeps beside
 * its approval key, so a new key re-enrolls the same device at a higher
 * generation. An id, never authority: the signature is the gate.
 */
export const approvalDeviceIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
/** What a phone asks: its own enrollment and the uses waiting now. */
export const secretApprovalsInputSchema = z.strictObject({ device: approvalDeviceIdSchema });
export const secretApprovalsSchema = z.strictObject({
  availability: secretsViewSchema.shape.availability,
  /** The enforcing home a decision names; null until storage opens. */
  home: z.string().nullable(),
  /** This device's enrollment, with the key the computer holds for it. */
  device: z
    .strictObject({
      label: z.string(),
      generation: z.number().int().positive(),
      /** SPKI DER, base64: the phone compares it with its own key. */
      key: z.string(),
    })
    .nullable(),
  /** An enrollment offer from this device is waiting on the computer. */
  offered: z.boolean(),
  /**
   * The captain turned on this paired device's switch in Settings -> Devices,
   * so it offers its key now; absent from an older home.
   */
  asked: z.boolean().optional(),
  waiting: z.array(
    z.strictObject({
      request: z.string(),
      /** The approval card the computer raised for this use, when it raised one. */
      card: z.string().nullable(),
      digest: z.string(),
      expires: z.number(),
      /** The challenge this device signs; null unless this device is enrolled. */
      nonce: z.string().nullable(),
      reason: z.string(),
      recipient: z.string(),
      /**
       * Each secret as the use prepared it: its name, with the environment label
       * and reference that tell two of one name apart. An empty environment
       * means the captain gave none.
       */
      secrets: z.array(
        z.strictObject({
          ref: secretRefSchema,
          label: z.string(),
          version: z.number(),
          environment: z.string(),
        }),
      ),
      /** The checked facts the approval card lists, in its order. */
      facts: z.array(z.strictObject({ name: z.string(), value: z.string() })),
    }),
  ),
});
/** An enrollment offer: the captain confirms it on the computer before it counts. */
export const secretEnrollInputSchema = z.strictObject({
  device: approvalDeviceIdSchema,
  label: z.string().min(1).max(64),
  /** P-256 SPKI DER, base64. */
  key: z.string().min(1).max(512),
});
/** A phone's decision: an Allow signed by its enrolled key, or a refusal, which needs none. */
export const secretDecisionInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("allow"),
    request: z.string(),
    device: approvalDeviceIdSchema,
    generation: z.number().int().positive(),
    nonce: z.string().min(1).max(128),
    /** ECDSA P-256 over SHA-256 of the decision message, DER, base64. */
    signature: z.string().min(1).max(256),
  }),
  z.strictObject({ kind: z.literal("deny"), request: z.string() }),
]);
export const secretDecisionSchema = z.strictObject({ state: secretStateSchema });
export type SecretsView = z.infer<typeof secretsViewSchema>;
export type SecretEntryInput = z.infer<typeof secretEntryInputSchema>;
export type SecretAction = z.infer<typeof secretActionSchema>;
export type SecretRehearsalInput = z.infer<typeof secretRehearsalInputSchema>;
export type SecretRehearsal = z.infer<typeof secretRehearsalSchema>;
export type SecretApprovals = z.infer<typeof secretApprovalsSchema>;
export type SecretApprovalsInput = z.infer<typeof secretApprovalsInputSchema>;
export type SecretEnrollInput = z.infer<typeof secretEnrollInputSchema>;
export type SecretDecisionInput = z.infer<typeof secretDecisionInputSchema>;
export type SecretDecision = z.infer<typeof secretDecisionSchema>;

/** Host-owned fact labels kept in the open; file digests and complete delivery details fold below. */
export const SECRET_OVERVIEW_FACTS: readonly string[] = [
  "Arguments",
  "Working folder",
  "Destination",
  "Operation",
];

/** Captain's bounded-read choice, shared by enforcement and its visible permission label. */
export const SHORT_READ_SECONDS = 600;
export const SHORT_READ_USES = 20;

/**
 * The quiet rows under the Secrets list, each opening in place: saved
 * decisions, phone approvals, what happened and a copy kept elsewhere.
 */
export const SECRETS_AREAS = [
  { value: "decisions", label: "Saved decisions" },
  { value: "phone", label: "Approve from your phone" },
  { value: "history", label: "What happened" },
  { value: "copy", label: "Keep a copy" },
] as const;

export const SECRETS_WORDS = {
  title: "Secrets",
  count: (count: number) =>
    count === 0
      ? "Add a secret your crew needs. Your crew uses it but never sees it."
      : `${count} ${count === 1 ? "secret" : "secrets"} kept on this computer. Your crew uses ${count === 1 ? "it" : "them"} but never sees ${count === 1 ? "it" : "them"}.`,
  disabled: "Protected storage is not enabled in this build.",
  unavailable: "Secrets could not open its protected storage. No access was granted.",
  stale: "This secret changed. Read its current version before replacing it.",
  saved: "Secret saved. New uses ask for approval.",
  value: "Secret value",
  nameRequired: "Enter a name for this secret.",
  valueRequired: "Enter the secret value.",
  name: "Name",
  place: "Place (optional)",
  placeHint: "For example, staging or production",
  save: "Save secret",
  historyRegion: "Secrets history",
  approvalTitle: "Allow secret access?",
  add: "Add secret",
  replace: "Replace",
  forget: "Forget",
  once: "Allow once",
  short: `Allow up to ${SHORT_READ_SECONDS / 60} minutes`,
  deny: "Deny",
  waiting: "Review request",
  waitingFor: (names: string) =>
    `${names} ${names.includes(", ") ? "are" : "is"} waiting for your answer.`,
  end: "End access",
  devicesRegion: "Devices that approve uses",
  noDevices:
    "No iPhone or iPad approves uses. To add one, turn on Approves secret uses beside it in Settings → Devices.",
  stopApprovals: "Stop approvals",
  history: "History stays here until you delete it. Exports contain metadata, never secret values.",
  noReveal: "The value stays hidden after saving. Only an approved use can receive it.",
  search: "Search secrets",
  noMatch: "No matching secrets.",
  noneYet: "No secrets added yet.",
  waitingStorage: "Secrets will appear when storage is available.",
  decisionsRegion: "Saved decisions",
  noDecisions: "No saved decisions. Every use asks you first.",
  remove: "Remove",
  notUsed: "Not used yet",
  inUse: "In use now",
  waitingRow: "Waiting for your answer",
  readingUntil: (time: string) => `Reading until ${time}`,
  used: (when: string, task?: string) => (task ? `Used ${when} by ${task}` : `Used ${when}`),
  today: "today",
  yesterday: "yesterday",
  noPhone: "Not set up",
  historySummary: (count: number, newest: string) =>
    `${count} ${count === 1 ? "use" : "uses"}, newest ${newest}`,
  noHistory: "Nothing yet",
  storageUse: (size: string) => `${size} kept on this computer`,
} as const;

/** A saved decision in one plain sentence, naming the secret it covers (`secretName`). */
export function decisionWords(rule: z.infer<typeof secretRuleSchema>, name: string): string {
  if (rule.effect === "never")
    return rule.operation
      ? `Never give ${name} to one exact run.`
      : `Never give ${name} to anyone.`;
  if (rule.effect === "allow") return `Always give ${name} to one exact run.`;
  return rule.operation
    ? `Ask before giving ${name} to one exact run.`
    : `Ask before giving ${name} to anyone.`;
}

export const SECRETS_RECOVERY_WORDS = {
  region: "Secrets recovery",
  recoveredHistory: "Recovered history, not a current approval",
  reconciledAfterRestart: "checked after restart",
  saveButton: "Save encrypted backup",
  restoreButton: "Restore from backup",
  unavailable:
    "Recovery files are available only in this computer's native app when Secrets is enabled.",
  choosing: "Finish the open recovery dialog first.",
  cancelled: "No recovery files selected. Nothing changed.",
  unreadable: "The recovery files could not be read. No restore was attempted.",
  save: {
    saved:
      "Encrypted archive and recovery key saved. Keep the key separately; there is no key reset.",
    partial:
      "The backup did not finish. Newly created files remain at your chosen locations. Keep any earlier working backup and key.",
    cancelled: "No recovery files saved.",
    unavailable:
      "No complete backup was saved. Choose new, writable file names; existing files are never replaced.",
    refused: "No recovery files saved. Confirmation was not accepted.",
    unknown:
      "The save result is unknown. Check both chosen locations before trying again; existing files will not be replaced.",
  },
  restore: {
    restored:
      "Secrets restored. Rules, device approvals and temporary access were reset. History was kept; archived history cannot authorize a use.",
    refused: "Secrets were not restored. Confirmation was not accepted.",
    invalid: "The archive and key do not match, or the archive is damaged. Nothing changed.",
    busy: "Wait for running secret uses and their results to finish before restoring.",
    changed:
      "Protected storage changed while restoring. The staged copy was not activated; read the current entries before trying again.",
    locked: "Protected storage is locked. The staged copy was not activated.",
    unavailable: "Restore did not finish. Current entries and saved permissions remain unchanged.",
    unknown:
      "The restore result is unknown. Check the current entries before doing anything else; do not repeat the restore without reconciling them.",
  },
} as const;

/** The words of a phone's Secrets approvals on this computer, around the label the device offered. */
export const SECRET_DEVICE_WORDS = {
  enrollTitle: (label: string) => `Let ${label} approve Secrets uses?`,
  confirm: "Confirm and allow",
  notNow: "Not now",
  enrolled: (label: string) => `${label} can approve Secrets uses.`,
  stopTitle: (label: string) => `Stop approvals from ${label}?`,
  keep: "Keep approvals",
  stopped: (label: string) => `${label} no longer approves Secrets uses.`,
  unchanged: "Nothing changed. Confirmation failed or Secrets changed while you were deciding.",
  /** The switch on a paired phone's row in Settings -> Devices. */
  approves: "Approves secret uses",
  on: (code: string) =>
    `Each Allow there asks for its Face ID, Touch ID or passcode. Code ${code}.`,
  waiting: (name: string) => `Waiting for ${name}. Open Infinitary there to show its code.`,
  comparing: (name: string) =>
    `${name} offered its key. Check that the card's code matches the one ${name} shows.`,
  compare: "Compare codes",
  showCard: "Show the card",
  stopping: "Confirm on the card to stop its approvals.",
  cancelled: "The switch was turned off before this phone was confirmed.",
} as const;
