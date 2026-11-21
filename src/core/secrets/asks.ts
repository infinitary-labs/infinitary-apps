import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { secretAskHow } from "./askHow";

/**
 * Asking the captain to keep a secret (docs/secrets.md, "Asking to keep a
 * secret"; INF-4239, direction A): an agent names each secret, an optional
 * place and the kept secret it replaces, with a reason, and never a value.
 * Infinitary raises its own card, whose window draws one masked field per
 * secret; the values go from that field straight to the protected owner.
 */
export type SecretAskInput = {
  /** The asker's own id for this ask: asking again with it while it waits raises nothing new. */
  id: string;
  reason: string;
  /** Each secret by name and place, or by the reference of a kept one it replaces. */
  secrets: { name?: string; place?: string; replace?: string }[];
  /**
   * How the captain gets the secrets, when they must make or find them
   * themselves: an HTML fragment the asker designs, drawn under "How to get
   * it" once it passes `secretAskHow`'s checks.
   */
  how?: string;
};

/** One secret the captain kept for an ask: what the asker hears, never the value. */
export type KeptSecret = { ref: string; name: string; place: string; version: number };

/** What an ask answers at once. */
export type SecretAskAnswer =
  /** `without` names what an older home could not take, and so left off the card. */
  | { ask: string; state: "waiting"; without?: "how" }
  /** Every secret it names is already kept under that name and place: no card. */
  | { ask: string; state: "kept"; secrets: KeptSecret[] }
  | { ask: string; state: "unavailable"; help: string };

/** What the asker hears once, through its inbox, when the ask ends. */
export type SecretAskEnded =
  | { ask: string; state: "kept"; secrets: KeptSecret[] }
  /** The captain chose Don't keep. */
  | { ask: string; state: "not-kept" }
  /** The asker cancelled it, or it named something that no longer exists. */
  | { ask: string; state: "withdrawn"; why: string };

/** The shape of a secret's reference, and of an ask's own id. */
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A well-formed ask: an id, a reason, and at least one named secret, each name once per place, and a how-to that passes its checks. */
export function validSecretAsk(input: SecretAskInput): boolean {
  return wellFormed(input) && !secretAskHowProblem(input);
}

/** Why an otherwise well-formed ask's how-to is refused, in words for the asker; none when it passes or has none. */
export function secretAskHowProblem(input: SecretAskInput): string | undefined {
  if (input.how === undefined) return undefined;
  // i18n-exempt: served to the asking agent, which reads English
  if (typeof input.how !== "string") return "The how-to must be text: an HTML fragment.";
  const how = secretAskHow(input.how);
  return how && "problem" in how ? how.problem : undefined;
}

function wellFormed(input: SecretAskInput): boolean {
  if (!input || typeof input !== "object") return false;
  if (!Object.keys(input).every((key) => ["id", "reason", "secrets", "how"].includes(key)))
    return false;
  if (typeof input.id !== "string" || !REFERENCE.test(input.id)) return false;
  if (typeof input.reason !== "string" || !input.reason.trim()) return false;
  if (!Array.isArray(input.secrets) || input.secrets.length === 0) return false;
  const seen = new Set<string>();
  for (const secret of input.secrets) {
    if (!secret || typeof secret !== "object") return false;
    if (!Object.keys(secret).every((key) => ["name", "place", "replace"].includes(key)))
      return false;
    if (secret.replace !== undefined) {
      // A replacement is named by its reference; the card names it as it is kept.
      if (typeof secret.replace !== "string" || !REFERENCE.test(secret.replace)) return false;
      if (secret.name !== undefined || secret.place !== undefined) return false;
    } else {
      if (typeof secret.name !== "string" || !secret.name.trim()) return false;
      if (secret.place !== undefined && typeof secret.place !== "string") return false;
    }
    const key = secret.replace ?? `${secret.name?.trim()}\0${secret.place?.trim() ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

const fieldSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  place: z.string(),
  replaces: z
    .strictObject({ ref: z.string(), version: z.number(), revision: z.string() })
    .optional(),
});
const askSchema = z.strictObject({
  /** The book's own key: the asker and its id together. */
  key: z.string(),
  /** The asking task, or null for the first mate. */
  task: z.string().nullable(),
  id: z.string(),
  reason: z.string(),
  /** The how-to as the card draws it, already checked and drawn again by `secretAskHow`. */
  how: z.string().optional(),
  at: z.number(),
  fields: z.array(fieldSchema).min(1),
  /** Secrets the ask named that were already kept: they ride the answer with the kept ones. */
  already: z.array(
    z.strictObject({ ref: z.string(), name: z.string(), place: z.string(), version: z.number() }),
  ),
});
export type SecretAskField = z.infer<typeof fieldSchema>;
export type WaitingSecretAsk = z.infer<typeof askSchema>;
const bookSchema = z.strictObject({ asks: z.array(askSchema) });

/**
 * The asks still waiting for the captain, kept beside Secrets in one small
 * file (`<userData>/secret-asks.json`) so a card comes back after a restart
 * with a new pass. It holds names, places, reasons, how-tos and references,
 * never a value. `SecretsSettings` is its one writer.
 */
export class SecretAskBook {
  private readonly asks = new Map<string, WaitingSecretAsk>();

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const parsed = bookSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) for (const ask of parsed.data.asks) this.asks.set(ask.key, ask);
    } catch {
      // No file yet, or one this build cannot read: no ask waits.
    }
  }

  static key(task: string | null, id: string): string {
    return `${task ?? "firstmate"}:${id}`;
  }

  get(key: string): WaitingSecretAsk | undefined {
    return this.asks.get(key);
  }

  all(): WaitingSecretAsk[] {
    return [...this.asks.values()].sort((a, b) => a.at - b.at);
  }

  put(ask: WaitingSecretAsk): void {
    this.asks.set(ask.key, ask);
    this.save();
  }

  drop(key: string): WaitingSecretAsk | undefined {
    const ask = this.asks.get(key);
    if (!ask) return undefined;
    this.asks.delete(key);
    this.save();
    return ask;
  }

  private save(): void {
    if (!this.file) return;
    if (this.asks.size === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    writeFileSync(next, `${JSON.stringify({ asks: this.all() })}\n`, { mode: 0o600 });
    renameSync(next, this.file);
  }
}
