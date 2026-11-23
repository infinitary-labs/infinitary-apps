/**
 * What Diagnostics may send: the allowlist, and the policy it enforces
 * (`docs/sharing.md` "The policy" is the prose home; this file is the one
 * code home, shared so the Settings viewer lists exactly what the core
 * sends).
 *
 * THE POLICY - no personal data, no user content, ever:
 *
 * 1. An event is a name in `DIAGNOSTIC_EVENTS` and nothing else. The set is
 *    closed and code-defined; there is no way to send an event this file
 *    does not declare.
 * 2. An event's data is exactly the fields its entry declares, plus the app
 *    `version` every event carries. A field's type is one of three - an
 *    `enum` of code-defined words, a `boolean`, a finite `number` - and the
 *    version is checked as a version string. There is deliberately no
 *    free-form string type, so no text a person wrote or a machine names
 *    (a conversation, a prompt, code, a card, a title, a repository, a
 *    path, an account, an email, a host) can ride any event.
 * 3. The one identifier is the anonymous install ID: a random UUID minted
 *    on the first launch, derived from nothing about the person or the
 *    machine, dropped when Diagnostics is turned off and minted afresh when
 *    it is turned back on. It is what lets actives, the first-run funnel
 *    and retention count per install; it identifies no one. A phone's
 *    events (`ios_*`) carry an install ID of their own, which the computer
 *    keeps for that phone and drops the same way, and when the phone leaves.
 *
 * `diagnosticDataViolation` is the check (the wire refuses anything that
 * fails it, `src/core/telemetry.ts`). `diagnostics.test.ts` fails if an
 * entry ever declares a field outside the three types or an enum word that
 * is not a code word, and `src/core/telemetry.test.ts` builds every body
 * the allowlist can produce and checks each key and value of it. Widening what leaves is an edit here, reviewed, and
 * the alpha notice and `docs/sharing.md` move with it.
 */

export type DiagnosticFieldSpec =
  | { readonly type: "enum"; readonly values: readonly string[]; readonly description: string }
  | { readonly type: "boolean"; readonly description: string }
  | { readonly type: "number"; readonly description: string };

/** The only field types an event may declare (policy rule 2). */
export const DIAGNOSTIC_FIELD_TYPES = ["enum", "boolean", "number"] as const;

export type DiagnosticEventSpec = {
  /** What the event means, in the words the payload viewer shows. */
  readonly description: string;
  readonly fields: Readonly<Record<string, DiagnosticFieldSpec>>;
};

/** Who a Firstmate turn answered: the person, or the app's own operations. */
export const TURN_TRIGGERS = ["captain", "operation"] as const;
export type TurnTrigger = (typeof TURN_TRIGGERS)[number];

/**
 * Why a Firstmate turn failed, coarsely: the sign-in was refused, the
 * provider's time limit was hit, the provider failed the turn, no session
 * could start, or anything else.
 */
export const TURN_FAILURE_REASONS = [
  "sign_in",
  "time_limit",
  "provider",
  "no_session",
  "error",
] as const;
export type TurnFailureReason = (typeof TURN_FAILURE_REASONS)[number];

/** How a crewmate's task closed (the record's closed reasons). */
export const DISPOSAL_OUTCOMES = [
  "landed",
  "merged",
  "released",
  "answered",
  "settled",
  "finished",
  "cancelled",
  "discarded",
  "failed",
  "superseded",
] as const;

export const PHONE_DEVICES = ["iphone", "ipad"] as const;
export type PhoneDevice = (typeof PHONE_DEVICES)[number];

const device = {
  type: "enum",
  values: PHONE_DEVICES,
  description: "the kind of phone",
} as const;

const trigger = {
  type: "enum",
  values: TURN_TRIGGERS,
  description: "captain = the person asked; operation = the app's own work woke it",
} as const;

/**
 * Every event Diagnostics can send. The `ftue_*` events are the first-run
 * funnel: each is sent at most once per install, the first time it happens
 * (`FTUE_MILESTONES`).
 */
export const DIAGNOSTIC_EVENTS = {
  app_launch: {
    description: "The app started.",
    fields: {},
  },
  main_agent_turn_end: {
    description: "Your first mate finished a turn without an error.",
    fields: { trigger },
  },
  main_agent_turn_failed: {
    description: "Your first mate's turn failed.",
    fields: {
      trigger,
      reason: {
        type: "enum",
        values: TURN_FAILURE_REASONS,
        description: "the kind of failure, never its message",
      },
    },
  },
  ftue_first_launch: {
    description: "First-time setup: the first launch.",
    fields: {},
  },
  ftue_gate_shown: {
    description: "First-time setup: the app asked to connect a subscription.",
    fields: {},
  },
  ftue_signed_in: {
    description: "First-time setup: the first subscription that can answer was connected.",
    fields: {},
  },
  ftue_first_turn: {
    description: "First-time setup: the first message to your first mate.",
    fields: {},
  },
  ftue_first_spawn_started: {
    description: "First-time setup: the first crewmate started work.",
    fields: {},
  },
  ftue_first_spawn_succeeded: {
    description: "First-time setup: the first crewmate reported back.",
    fields: {},
  },
  ftue_first_disposal: {
    description: "First-time setup: the first crewmate's task was closed.",
    fields: {
      outcome: {
        type: "enum",
        values: DISPOSAL_OUTCOMES,
        description: "how it closed",
      },
    },
  },
  ios_launch: {
    description: "Phone: the Infinitary app started on a phone joined to this computer.",
    fields: { device },
  },
  ios_opened: {
    description: "Phone: the app came to the front.",
    fields: { device },
  },
  ios_ftue_joined: {
    description: "Phone first-time setup: the phone joined this computer.",
    fields: { device },
  },
  ios_ftue_first_message: {
    description: "Phone first-time setup: the first message to your first mate from the phone.",
    fields: { device },
  },
  ios_message_sent: {
    description: "Phone: a message to your first mate was sent from the phone.",
    fields: { device },
  },
  ios_card_answered: {
    description: "Phone: a card was answered with one of its choices from the phone.",
    fields: { device },
  },
} as const satisfies Readonly<Record<string, DiagnosticEventSpec>>;

export type DiagnosticEventName = keyof typeof DIAGNOSTIC_EVENTS;

export const DIAGNOSTIC_EVENT_NAMES = Object.keys(DIAGNOSTIC_EVENTS) as DiagnosticEventName[];

/**
 * The events a phone hands its computer (docs/sharing.md, "A phone's
 * events"): each name starts `ios_`. The computer sends them under the
 * phone's own install ID and names (`src/core/telemetry.ts`), only while its
 * own Diagnostics would send its own events.
 */
export const PHONE_DIAGNOSTIC_EVENT_NAMES = DIAGNOSTIC_EVENT_NAMES.filter((name) =>
  name.startsWith("ios_"),
);
export type PhoneDiagnosticEventName = Extract<DiagnosticEventName, `ios_${string}`>;

export function isPhoneDiagnosticEvent(name: string): name is PhoneDiagnosticEventName {
  return (PHONE_DIAGNOSTIC_EVENT_NAMES as readonly string[]).includes(name);
}

/** The first-run funnel: each sent once per install, the first time it happens. */
export const FTUE_MILESTONES = DIAGNOSTIC_EVENT_NAMES.filter((name) => name.startsWith("ftue_"));

/** A phone's first-run funnel: each sent once per phone install ID, the first time it happens. */
export const PHONE_FTUE_MILESTONES = PHONE_DIAGNOSTIC_EVENT_NAMES.filter((name) =>
  name.startsWith("ios_ftue_"),
);

/** The field every event carries besides its own: the app version. */
export const DIAGNOSTIC_VERSION_FIELD = "version";

/** A version string (`1.2.3`, `0.1.0-beta.1`, `1.0.0+build.5`), never free text. */
export const DIAGNOSTIC_VERSION_PATTERN =
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;

/** The install ID's shape: a random (version 4) UUID, lower case. */
export const DIAGNOSTIC_INSTALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type FieldValue<S> = S extends { type: "enum"; values: readonly (infer V)[] }
  ? V
  : S extends { type: "boolean" }
    ? boolean
    : number;

type EventFields<N extends DiagnosticEventName> = (typeof DIAGNOSTIC_EVENTS)[N]["fields"];

/** An event's own data, typed from its entry; the version is added by the builder. */
export type DiagnosticEventData<N extends DiagnosticEventName> = {
  -readonly [K in keyof EventFields<N>]: FieldValue<EventFields<N>[K]>;
};

export type DiagnosticEvent = {
  [N in DiagnosticEventName]: { name: N; data: DiagnosticEventData<N> };
}[DiagnosticEventName];

/**
 * Why `data` may not go out under `name` - null when it may. `data` must
 * hold exactly the event's declared fields plus `version`, each of its
 * declared type (policy rule 2).
 */
export function diagnosticDataViolation(name: string, data: unknown): string | null {
  if (!Object.hasOwn(DIAGNOSTIC_EVENTS, name)) return `"${name}" is not a declared event`;
  const spec: DiagnosticEventSpec = DIAGNOSTIC_EVENTS[name as DiagnosticEventName];
  if (!data || typeof data !== "object" || Array.isArray(data)) return "data is not an object";
  const record = data as Record<string, unknown>;
  const version = record[DIAGNOSTIC_VERSION_FIELD];
  if (typeof version !== "string" || !DIAGNOSTIC_VERSION_PATTERN.test(version)) {
    return "version is not a version string";
  }
  for (const key of Object.keys(record)) {
    if (key !== DIAGNOSTIC_VERSION_FIELD && !Object.hasOwn(spec.fields, key)) {
      return `"${key}" is not a field of ${name}`;
    }
  }
  for (const [key, field] of Object.entries(spec.fields)) {
    if (!Object.hasOwn(record, key)) return `${name} is missing "${key}"`;
    const value = record[key];
    switch (field.type) {
      case "enum":
        if (typeof value !== "string" || !field.values.includes(value)) {
          return `"${key}" is not one of ${field.values.join(", ")}`;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") return `"${key}" is not a boolean`;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return `"${key}" is not a finite number`;
        }
        break;
      default:
        return `"${key}" has a type the policy does not allow`;
    }
  }
  return null;
}
