import { randomUUID } from "node:crypto";
import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import {
  SECRET_ASK_CARD_WORDS,
  type SecretKeep,
  type SecretKeepInput,
  type SecretKeepOffer,
} from "@shared/secrets";
import { secretAskBody, secretAskCardId, secretAskTitle } from "./askCard";
import { secretAskHow } from "./askHow";
import {
  type KeptSecret,
  type SecretAskAnswer,
  SecretAskBook,
  type SecretAskEnded,
  type SecretAskInput,
  validSecretAsk,
  type WaitingSecretAsk,
} from "./asks";
import { SECRET_ASK_WORDS } from "./commandWords";
import type { ProtectedSecrets } from "./protected";
import { newReference } from "./references";

/** What an ask reads of Secrets' protected owner (`SecretsSettings`' own). */
type AskOwner = { protected: ProtectedSecrets };

/**
 * One of the controller's one-time passes (`SecretsSettings`' offers), as an
 * ask's card makes and spends them: an ask card's Keep is spent only by
 * `keep`, with the values the window sends (`ask` names the waiting ask).
 */
type Pass = {
  group: string;
  run: () => Promise<void>;
  place: "card" | "settings" | "keep";
  ask?: string;
};

/** What `SecretsSettings` lends its asks to keep a secret. */
export type AskHost = {
  /** The controller's options (`SecretsSettingsOptions`, where each is described). */
  options: {
    open?: (initialize: boolean) => Promise<ProtectedSecrets>;
    unlock?: () => Promise<boolean>;
    raise: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
    withdraw: (id: string, reason: string) => void;
    changed: () => void;
    taskTitle?: (task: string) => string | undefined;
    asksFile?: string;
    asked?: (task: string | null, ended: SecretAskEnded) => void;
    taskOpen?: (task: string) => boolean;
  };
  /** Every pass the controller holds, which its `decide` and this `keep` spend. */
  offers: Map<string, Pass>;
  /** The protected owner, opened (and set up, with `initialize`) when it is not open yet. */
  ready: (initialize?: boolean) => Promise<AskOwner | undefined>;
  now: () => number;
  /** The owner open now, without opening one. */
  owner: () => AskOwner | undefined;
  /** Lets go of the open owner, as Unlock does, so the next read opens it again. */
  letGo: () => void;
};

/**
 * Asking the captain to keep a secret (docs/secrets.md, "Asking to keep a
 * secret"), for Settings' controller (`SecretsSettings`): each ask is
 * answered here, raised on Infinitary's own card and kept with the values
 * typed on it. The controller holds the passes; this owns the waiting asks.
 */
export class SecretAsks {
  /** The asks waiting for the captain to keep a secret, by the asker and its id. */
  private readonly asks: SecretAskBook;

  constructor(private readonly host: AskHost) {
    this.asks = new SecretAskBook(host.options.asksFile);
  }

  /**
   * An agent's ask to keep secrets (docs/secrets.md, "Asking to keep a
   * secret"): names, places and a reason, never a value. It answers at once:
   * unavailable where Secrets is not offered, kept when every secret it names
   * is already kept under that name and place, or waiting while Infinitary's
   * own card asks the captain. Asking again with a waiting ask's id raises
   * nothing new.
   */
  async askToKeep(task: string | null, input: SecretAskInput): Promise<SecretAskAnswer> {
    const copied = structuredClone(input);
    if (!validSecretAsk(copied)) throw new Error("Invalid ask.");
    if (!this.host.options.open)
      return { ask: copied.id, state: "unavailable", help: SECRET_ASK_WORDS.notOffered };
    const key = SecretAskBook.key(task, copied.id);
    const waiting = this.asks.get(key);
    if (waiting) {
      this.raiseAsk(waiting);
      return { ask: copied.id, state: "waiting" };
    }
    const owner = await this.host.ready().catch(() => undefined);
    const state = owner ? await owner.protected.status().catch(() => "unavailable" as const) : null;
    const readable = state === "available";
    const entries = readable
      ? (await owner?.protected.metadata().catch(() => undefined))?.filter(
          (one) => one.discoverable,
        )
      : state === "uninitialized"
        ? []
        : undefined;
    const fields: WaitingSecretAsk["fields"] = [];
    const already: KeptSecret[] = [];
    for (const secret of copied.secrets) {
      const name = secret.name?.trim() ?? "";
      const place = secret.place?.trim() ?? "";
      if (secret.replace !== undefined) {
        // The card names the kept secret and its version, so it must be read now.
        if (!entries)
          return { ask: copied.id, state: "unavailable", help: SECRET_ASK_WORDS.cannotRead };
        const entry = entries.find((one) => one.ref === secret.replace);
        if (!entry)
          return { ask: copied.id, state: "unavailable", help: SECRET_ASK_WORDS.noSuchSecret };
        fields.push({
          id: `s${fields.length + 1}`,
          name: entry.label,
          place: entry.environment ?? "",
          replaces: { ref: entry.ref, version: entry.version, revision: entry.revision },
        });
        continue;
      }
      const kept = entries?.find((one) => one.label === name && (one.environment ?? "") === place);
      if (kept) already.push({ ref: kept.ref, name, place, version: kept.version });
      else fields.push({ id: `s${fields.length + 1}`, name, place });
    }
    if (fields.length === 0) return { ask: copied.id, state: "kept", secrets: already };
    // Checked by `validSecretAsk` above; the card draws it again from its parsed elements.
    const how = copied.how === undefined ? undefined : secretAskHow(copied.how);
    const ask: WaitingSecretAsk = {
      key,
      task,
      id: copied.id,
      reason: copied.reason.trim(),
      ...(how && "html" in how ? { how: how.html } : {}),
      at: this.host.now(),
      fields,
      already,
    };
    this.asks.put(ask);
    this.raiseAsk(ask);
    this.host.options.changed();
    return { ask: copied.id, state: "waiting" };
  }

  /** The asker withdrew its waiting ask: its card goes, and nothing is kept. */
  cancelAsk(task: string | null, id: string): boolean {
    const key = SecretAskBook.key(task, id);
    if (!this.asks.get(key)) return false;
    this.endAsk(key, { ask: id, state: "withdrawn", why: SECRET_ASK_WORDS.cancelled }, false);
    return true;
  }

  /**
   * Raises each ask that waited through a restart again, with new passes:
   * the card an earlier process raised is inert. A closed task's ask ends.
   */
  resumeAsks(): void {
    for (const ask of this.asks.all()) {
      if (ask.task && this.host.options.taskOpen && !this.host.options.taskOpen(ask.task)) {
        this.endAsk(ask.key, { ask: ask.id, state: "withdrawn", why: SECRET_ASK_WORDS.closed });
        continue;
      }
      this.raiseAsk(ask);
    }
  }

  /** A restore or Start over replaced the home: what each waiting ask replaces is read again. */
  homeReplaced(): void {
    for (const ask of this.asks.all()) void this.reaskAfterReplace(ask);
  }

  private askCardId(ask: WaitingSecretAsk): string {
    return secretAskCardId(ask.task, ask.id);
  }

  /**
   * Infinitary's own card for one ask. Save secret carries the fields the
   * window draws (`SecretKeepOffer`) and its id is a pass only `keep`
   * spends, with the values; Don't save is an ordinary one-time pass.
   * `trouble` puts why the card changed above the reason, with Unlock when
   * storage is locked and this computer can unlock it. A Save's own trouble
   * is `answered`: Save's answer already says it in the window or phone that
   * pressed it, so the body does not say it again.
   */
  private raiseAsk(
    ask: WaitingSecretAsk,
    trouble?: "locked" | "recovery" | "unavailable" | "stale",
    answered = false,
  ) {
    const group = `ask-${ask.key}`;
    for (const [id, offer] of this.host.offers)
      if (offer.group === group) this.host.offers.delete(id);
    const words = SECRET_ASK_CARD_WORDS;
    const keep = randomUUID();
    const dont = randomUUID();
    this.host.offers.set(keep, { group, run: async () => {}, place: "keep", ask: ask.key });
    this.host.offers.set(dont, {
      group,
      place: "card",
      run: async () => this.endAsk(ask.key, { ask: ask.id, state: "not-kept" }),
    });
    const unlock = trouble === "locked" && this.host.options.unlock ? randomUUID() : undefined;
    if (unlock)
      this.host.offers.set(unlock, {
        group,
        place: "card",
        run: async () => {
          await this.host.options.unlock?.();
          const owner = this.host.owner();
          if (owner && owner.protected.availability !== "available") this.host.letGo();
          const current = this.asks.get(ask.key);
          if (current) this.raiseAsk(current);
        },
      });
    const offer: SecretKeepOffer = {
      fields: ask.fields.map((field) => ({
        id: field.id,
        name: field.name,
        ...(field.place ? { place: field.place } : {}),
        ...(field.replaces
          ? { replaces: { ref: field.replaces.ref, version: field.replaces.version } }
          : {}),
      })),
    };
    const taskTitle = ask.task ? (this.host.options.taskTitle?.(ask.task) ?? null) : null;
    // Whoever asked answers a reply under the card, and its head names them:
    // a crewmate's ask heads with its task, the first mate's with the first mate.
    this.host.options.raise({
      id: this.askCardId(ask),
      title: secretAskTitle(ask),
      body: secretAskBody(ask, taskTitle, trouble && !answered ? words[trouble] : undefined),
      meta: taskTitle ?? FIRSTMATE_CARD_META,
      answeredBy: ask.task ? "crewmate" : "firstmate",
      ...(ask.task ? { taskId: ask.task } : {}),
      actions: [
        {
          id: dont,
          label: words.dontSave,
          variant: "ghost" as const,
          declines: true,
          effect: { kind: "host" as const, op: "secrets-decision" as const, arg: dont },
        },
        ...(unlock
          ? [
              {
                id: unlock,
                label: words.unlock,
                variant: "secondary" as const,
                effect: { kind: "host" as const, op: "secrets-decision" as const, arg: unlock },
              },
            ]
          : []),
        {
          id: keep,
          label: words.save(ask.fields.length > 1),
          default: true,
          variant: "primary" as const,
          effect: {
            kind: "host" as const,
            op: "secrets-keep" as const,
            arg: JSON.stringify(offer),
          },
        },
      ],
    });
  }

  /** The ask ended: its passes stop working, its card goes, and its asker hears once. */
  private endAsk(key: string, ended: SecretAskEnded, tell = true): void {
    const ask = this.asks.drop(key);
    if (!ask) return;
    const group = `ask-${key}`;
    for (const [id, offer] of this.host.offers)
      if (offer.group === group) this.host.offers.delete(id);
    this.host.options.withdraw(this.askCardId(ask), SECRET_ASK_CARD_WORDS.ended);
    if (tell) this.host.options.asked?.(ask.task, ended);
    this.host.options.changed();
  }

  /** After a restore or Start over, what a waiting ask replaces is read again from the new home. */
  private async reaskAfterReplace(ask: WaitingSecretAsk): Promise<void> {
    if (!ask.fields.some((field) => field.replaces)) {
      this.raiseAsk(ask);
      return;
    }
    const owner = await this.host.ready().catch(() => undefined);
    const entries = owner ? await owner.protected.metadata().catch(() => []) : [];
    const fields = ask.fields.flatMap((field) => {
      if (!field.replaces) return [field];
      const entry = entries.find((one) => one.ref === field.replaces?.ref && one.discoverable);
      return entry
        ? [
            {
              ...field,
              replaces: { ref: entry.ref, version: entry.version, revision: entry.revision },
            },
          ]
        : [];
    });
    if (fields.length === 0) {
      this.endAsk(ask.key, { ask: ask.id, state: "withdrawn", why: SECRET_ASK_WORDS.noSuchSecret });
      return;
    }
    const next = { ...ask, fields };
    this.asks.put(next);
    this.raiseAsk(next, fields.length === ask.fields.length ? undefined : "stale");
  }

  /**
   * Keep on an ask card (`inf:secrets:keep`), from the window that shows
   * it: here, another Mac or the phone. Its pass is spent once, and only
   * with one value for every field the card asked for; each value goes
   * straight to the protected owner, as Settings' Add secret does, and is
   * zero-filled. Nothing records a value. A Keep that cannot finish leaves
   * the card up with a new pass and says why on it.
   */
  async keep(input: SecretKeepInput): Promise<SecretKeep> {
    const words = SECRET_ASK_CARD_WORDS;
    const offer = this.host.offers.get(input.pass);
    const ask = offer?.place === "keep" && offer.ask ? this.asks.get(offer.ask) : undefined;
    if (!offer || !ask) return { kept: false, words: words.gone };
    if (ask.task && this.host.options.taskOpen && !this.host.options.taskOpen(ask.task)) {
      this.endAsk(ask.key, { ask: ask.id, state: "withdrawn", why: SECRET_ASK_WORDS.closed });
      return { kept: false, words: words.closed };
    }
    const values = new Map<string, string>();
    for (const one of input.values) {
      if (values.has(one.field)) return { kept: false, words: words.empty };
      values.set(one.field, one.value);
    }
    if (values.size !== ask.fields.length || ask.fields.some((field) => !values.get(field.id)))
      return { kept: false, words: words.empty };
    // Spent before anything is written, so a second Keep in flight does nothing.
    for (const [id, one] of this.host.offers)
      if (one.group === offer.group) this.host.offers.delete(id);
    const buffers = new Map(
      ask.fields.map((field) => [field.id, Buffer.from(values.get(field.id) ?? "")]),
    );
    values.clear();
    const kept: KeptSecret[] = [];
    const left: WaitingSecretAsk["fields"] = [];
    let trouble: "locked" | "recovery" | "unavailable" | "stale" | undefined;
    try {
      const owner = await this.host.ready(true).catch(() => undefined);
      const state = owner
        ? await owner.protected.status().catch(() => "unavailable" as const)
        : null;
      if (!owner || state !== "available") {
        trouble =
          state === "locked"
            ? "locked"
            : state === "lost" || state === "tampered"
              ? "recovery"
              : "unavailable";
        // As Unlock does: only an owner that is itself no longer open is let go,
        // never one whose custody locked while its uses still wait or run.
        if (owner && owner.protected.availability !== "available") this.host.letGo();
      } else {
        const metadata = await owner.protected.metadata();
        const taken = [
          ...metadata.map((entry) => entry.ref),
          ...(owner.protected.authority()?.rules.map((rule) => rule.secret) ?? []),
          ...owner.protected.history().flatMap((item) => item.secrets),
        ];
        for (const field of ask.fields) {
          if (trouble) {
            left.push(field);
            continue;
          }
          const value = buffers.get(field.id) as Buffer;
          const ref = field.replaces?.ref ?? newReference(field.name, taken);
          taken.push(ref);
          const written = await owner.protected
            .putSecret(ref, field.name, value, {
              discoverable: true,
              expectedVersion: field.replaces?.version ?? 0,
              expectedRevision: field.replaces?.revision ?? null,
              ...(field.place ? { environment: field.place } : {}),
            })
            .catch(() => undefined);
          if (written) {
            kept.push({
              ref: written.ref,
              name: field.name,
              place: field.place,
              version: written.version,
            });
            continue;
          }
          if (!field.replaces) {
            trouble = "unavailable";
            left.push(field);
            continue;
          }
          // What it replaces changed since the card asked: the card names its current version.
          const current = (await owner.protected.metadata()).find(
            (entry) => entry.ref === field.replaces?.ref && entry.discoverable,
          );
          trouble = "stale";
          if (current)
            left.push({
              ...field,
              replaces: { ref: current.ref, version: current.version, revision: current.revision },
            });
        }
      }
    } catch {
      trouble = "unavailable";
    } finally {
      for (const buffer of buffers.values()) buffer.fill(0);
      buffers.clear();
    }
    if (!trouble) {
      this.endAsk(ask.key, { ask: ask.id, state: "kept", secrets: [...ask.already, ...kept] });
      return { kept: true };
    }
    // What was kept stays kept; the card asks again only for the rest.
    const remaining = kept.length || trouble === "stale" ? left : ask.fields;
    if (remaining.length === 0) {
      // Everything it replaced is gone: nothing is left to ask for.
      this.endAsk(
        ask.key,
        kept.length
          ? { ask: ask.id, state: "kept", secrets: [...ask.already, ...kept] }
          : { ask: ask.id, state: "withdrawn", why: SECRET_ASK_WORDS.noSuchSecret },
      );
      return kept.length ? { kept: true } : { kept: false, words: SECRET_ASK_CARD_WORDS.gone };
    }
    const next: WaitingSecretAsk = {
      ...ask,
      fields: remaining,
      already: [...ask.already, ...kept],
    };
    this.asks.put(next);
    this.raiseAsk(next, trouble, true);
    this.host.options.changed();
    return { kept: false, words: SECRET_ASK_CARD_WORDS[trouble] };
  }
}
