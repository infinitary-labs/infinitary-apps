import type { ForgeSignInState } from "@shared/forges";
import type { IntegrationDoorView, IntegrationEffect, IntegrationKind } from "@shared/integrations";
import type { z } from "zod";

/**
 * What one kind of integration declares and does (docs/integrations.md,
 * "A kind"): a binding, the way a forge kind is one (`createForgeResolver`).
 * The service reads these facts and nothing of the kind's name, so a new
 * kind is one more binding under `./providers/`.
 */

/**
 * Who is calling: the first mate's seat, or one task's crewmate. A task's
 * call runs under that task's rules - a change it asks for is kept on the
 * task as an ask the captain's click sends (`docs/forge.md`, "A write that asks").
 */
export type IntegrationCaller = { kind: "firstmate" } | { kind: "task"; taskId: string };

/** One action a kind can do, as its binding declares it. */
export type IntegrationActionSpec = {
  name: string;
  /** A few plain words for the Settings row ("Read from GitHub"). */
  label: string;
  /** What it does to the world: the binding's own word, never read off its name. */
  effect: IntegrationEffect;
  /** What it does and how to call it, for the first mate and the crew. */
  description: string;
  /** Its input, checked before the call; its JSON Schema is what `show` lists. */
  input: z.ZodType;
  /**
   * The input's JSON Schema as the place itself declared it, shown in
   * place of `input`'s: an MCP server's tool keeps its own, and the server
   * checks the input it receives.
   */
  schema?: Record<string, unknown>;
};

/**
 * A key a kind signs in with (docs/integrations.md, "Keys"): a name and
 * words, never a value. The captain enters the value in Settings ->
 * Integrations; the binding uses it only through `IntegrationSecrets`.
 */
export type IntegrationSecretSlot = {
  name: string;
  /** A few plain words for the Settings row ("Linear key"). */
  label: string;
  /** Its actions run without it. */
  optional?: true;
};

/**
 * Something a connection can tell (docs/integrations.md, "What an integration can tell"): a rule
 * listening to it looks every `every` minutes through the binding's `look`.
 */
export type IntegrationEventSpec = {
  name: string;
  /** A few plain words for the Settings row ("The count changed"). */
  label: string;
  /** What it means and how to read what changed, for the first mate. */
  description: string;
  /** How often, in minutes, a listening rule looks. */
  every: number;
  /**
   * Closed string filters the kind accepts, drawn by the shared event
   * editor; a rule must name a `required` one, since the kind cannot look without it.
   */
  filters?: readonly IntegrationEventFilter[];
  /**
   * The kind says when something arrives (the inbox's drop), so a rule
   * finds its place the moment it listens and the next arrival fires it.
   */
  atOnce?: boolean;
};

/** One filter field an event declares. */
export type IntegrationEventFilter = {
  name: string;
  label: string;
  defaultValue?: string;
  required?: true;
};

/** One thing that happened, by the place's own id, in one line. */
export type IntegrationEventItem = { id: string; summary: string };

/**
 * What a look found since the cursor: the items, and the cursor to pass
 * next time. `resynced` says the place could not answer from that cursor -
 * what happened in between is not known - so the rule starts again from now.
 */
export type IntegrationLook = { cursor: string; items: IntegrationEventItem[]; resynced?: boolean };

/** One connection of a kind that exists now: a sign-in there, or a server it runs. */
export type IntegrationConnection = {
  id: string;
  /** The forge sign-in this connection manages, when it has one. */
  host?: string;
  /** Who it is signed in as; null until it has answered once, or where nothing signs in. */
  account: string | null;
  health: ForgeSignInState;
  /** Its name until the person renames it; the kind's name without one. */
  name?: string;
  /** What it runs, for Settings alone (`IntegrationView.runs`). */
  runs?: string;
  /** What it can do. */
  actions: readonly IntegrationActionSpec[];
  /** What it can tell. */
  events?: readonly IntegrationEventSpec[];
  /** The inbox's door, for Settings alone (`IntegrationView.door`). */
  door?: IntegrationDoorView;
};

/** An action's answer: words for the caller, or a refusal that says why and what to do. */
export type IntegrationAnswer = {
  text: string;
  refused?: "refused" | "invalid";
  /**
   * The first mate's call only, set by the service (INF-1108): the approval
   * card the host raised for its held call, or that a change or send ran.
   * Its turn counts either as an action that took effect.
   */
  card?: string;
  ran?: "changes" | "sends";
};

/**
 * What a binding's `call` throws when it failed after the request left for
 * the place - a timeout, a dropped connection, a server error - so whether
 * the place acted on it is not known. A kept ask that meets one is never
 * run again, and its crewmate reads the place before going on.
 */
export class IntegrationOutcomeUnknown extends Error {}

export type IntegrationBinding = {
  kind: IntegrationKind;
  /**
   * A kind with one connection, whose identity exists even while signed
   * out (GitHub's project sign-in, Google's). Its id, default name and
   * saved name belong to it; another connection cannot take them while it
   * is absent. A kind the person adds again and again declares none.
   */
  identity?: { id: string; name: string };
  /** The keys its connections sign in with; none for a kind whose sign-in has its own owner. */
  secrets?: readonly IntegrationSecretSlot[];
  /**
   * Its answers and event summaries carry words anyone can write, such as
   * a message or an invitation: the label they reach every agent under,
   * between marks nobody who wrote them could forge (`@shared/outsideData`,
   * docs/integrations.md "Data from outside"). Absent, they reach it as
   * they are.
   */
  fence?: string;
  /**
   * With a fence: how many days its words stay in saved conversations
   * before a note takes their place, and what a person calls them
   * (`SavedOutsideData`, docs/task-retention.md "Words from outside").
   */
  kept?: { days: number; what: string };
  /** A kind the person adds again and again, one row each (an MCP server): always addable. */
  many?: true;
  /** The connections of this kind that exist now. */
  connections: () => IntegrationConnection[];
  /**
   * Add a connection from the person's own words (an MCP server's name and
   * what it runs) and answer its id; throws words when it cannot connect.
   * `claim` holds a candidate id for this addition before the binding waits
   * on the place, and answers false when the id or a name like it is
   * another's, so the binding tries its next one (docs/integrations.md, "Names").
   */
  add?: (input: unknown, claim?: (id: string) => boolean) => Promise<string>;
  /**
   * Sign in where the person signs in in their own browser (Google's
   * loopback sign-in) and answer the connection's id once it comes back;
   * throws words when it cannot, and ends when `signal` aborts.
   */
  signIn?: (signal: AbortSignal) => Promise<string>;
  /** Ask the place who the person is now, and keep its answer as the health. */
  check: (id: string) => Promise<void>;
  /** Forget the connection's sign-in, and tell the place to forget it where it can. */
  remove: (id: string) => void | Promise<void>;
  /** Refresh action facts before the service checks a grant (MCP can change tools). */
  prepare?: (id: string) => Promise<void>;
  /** Run one action whose input already passed its schema. */
  call: (
    id: string,
    action: string,
    input: unknown,
    caller: IntegrationCaller,
  ) => Promise<IntegrationAnswer>;
  /** Look for one event since the cursor (null: start from now). */
  look?: (
    id: string,
    event: string,
    cursor: string | null,
    filter?: Record<string, string>,
  ) => Promise<IntegrationLook>;
  /** Stop whatever the binding started (an MCP server's program) as the app quits. */
  close?: () => Promise<void>;
};
