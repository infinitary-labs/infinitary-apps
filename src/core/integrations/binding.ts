import type { ForgeSignInState } from "@shared/forges";
import type { IntegrationEffect, IntegrationKind } from "@shared/integrations";
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
};

/** One connection of a kind that exists now: a sign-in there. */
export type IntegrationConnection = {
  id: string;
  /** Who it is signed in as; null until it has answered once. */
  account: string | null;
  health: ForgeSignInState;
};

/** An action's answer: words for the caller, or a refusal that says why and what to do. */
export type IntegrationAnswer = { text: string; refused?: "refused" | "invalid" };

export type IntegrationBinding = {
  kind: IntegrationKind;
  actions: readonly IntegrationActionSpec[];
  /** The connections of this kind that exist now. */
  connections: () => IntegrationConnection[];
  /** Ask the place who the person is now, and keep its answer as the health. */
  check: (id: string) => Promise<void>;
  /** Forget the connection's sign-in. */
  remove: (id: string) => void;
  /** Run one action whose input already passed its schema. */
  call: (
    id: string,
    action: string,
    input: unknown,
    caller: IntegrationCaller,
  ) => Promise<IntegrationAnswer>;
};
