import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { CoreInvokeChannel } from "@shared/ipc";
import {
  SECRET_MAC_WORDS,
  type SecretApprovals,
  type SecretDecision,
  secretUseAnswerOf,
} from "@shared/secrets";
import { escapeCardText } from "../../core/orchestrator/cardText";
import {
  approvalCode,
  decisionMessage,
  type FreshAuthentication,
} from "../../core/secrets/approvals";
import type { SecretCustody } from "../../core/secrets/custody";

/** This Mac's approval key as its custody keeps it: never sent anywhere but its public half. */
type Held = { device: string; privateKey: string; publicKey: string };

/** What this Mac approves with (`nativeApprover`): none on a run that keeps no Secrets. */
export type MacApproverHost = {
  /** This Mac's own custody for its key, under a name of its own (`SECRET_APPROVER_NAMES`). */
  custody: SecretCustody;
  /** Touch ID or this Mac's password, asked before each signature. */
  authentication: FreshAuthentication;
};

export type MacApproverOptions = {
  /** Made on first use; undefined where this Mac cannot approve. */
  host: () => MacApproverHost | undefined;
  /** This Mac's own name, as it joined the home and as the home's enrollment card shows it. */
  label: () => string | Promise<string>;
  /** The other Mac's name, for the words this Mac says. */
  home: () => string;
  invoke: (channel: CoreInvokeChannel, args: unknown[]) => Promise<unknown>;
  /** Whether this Mac approves changed, so the window's cards are shown again. */
  changed?: () => void;
};

type ShownCard = { id?: unknown; body?: unknown; actions?: unknown };
type ShownAction = { id?: unknown; default?: unknown; variant?: unknown };

const USE_CARD = "card-secrets-use-";
const ENROLL_CARD = "card-secrets-enroll-";

/**
 * A Mac that approves Secrets uses for the first mate's computer, as a phone
 * does (docs/secrets.md, "Remote decisions"). Its P-256 key is made and kept
 * here, in this Mac's own custody; the home learns only its public half,
 * once the captain compares the code on both screens and confirms it on the
 * home. Each Allow on a use card in this Mac's window asks for this Mac's
 * Touch ID or password, then signs that one use's challenge. A Deny needs no
 * key; a saved decision is the home's to make.
 */
export class MacApprover {
  private held: Held | null | undefined;
  private reading: Promise<void> | null = null;
  private native: MacApproverHost | null | undefined;
  /** Whether the home holds this Mac's key now, as its last read answered. */
  private approves = false;

  constructor(private readonly options: MacApproverOptions) {}

  private approver(): MacApproverHost | undefined {
    if (this.native === undefined) this.native = this.options.host() ?? null;
    return this.native ?? undefined;
  }

  /** Read this Mac's standing on the home and offer its key once the captain asked for it. */
  refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(): Promise<void> {
    if (!this.approver()) return;
    try {
      const existing = await this.key(false);
      const device = existing?.device ?? randomUUID();
      const approvals = (await this.options.invoke("inf:secrets:approvals", [
        { device },
      ])) as SecretApprovals;
      this.standing(!!existing && approvals.device?.key === existing.publicKey);
      if (!approvals.asked || approvals.offered) return;
      if (approvals.device && approvals.device.key === existing?.publicKey) return;
      const held = existing ?? (await this.key(true));
      if (!held) return;
      const label = (await this.options.label()).slice(0, 64);
      await this.options.invoke("inf:secrets:enroll", [
        { device: held.device, label, key: held.publicKey },
      ]);
    } catch {
      // Out of reach or no custody: the next push asks again.
    }
  }

  private standing(approves: boolean): void {
    if (approves === this.approves) return;
    this.approves = approves;
    this.options.changed?.();
  }

  /**
   * The home's own cards as this Mac's window shows them, as a phone shows
   * them: a use card offers Allow once and Don't allow while this Mac
   * approves, and only Don't allow with where to set it up while it does not,
   * or where to answer where no approver can exist here;
   * a lasting allowance stays the home's. Its enrollment card for this Mac
   * carries the code this Mac computes from its own key.
   */
  shown(cards: unknown): unknown {
    if (!Array.isArray(cards)) return cards;
    const held = this.held;
    return cards.map((card: unknown) => {
      if (!card || typeof card !== "object") return card;
      const shown = card as ShownCard;
      if (typeof shown.id !== "string" || typeof shown.body !== "string") return card;
      if (held && shown.id === `${ENROLL_CARD}${held.device}`)
        return {
          ...shown,
          body: `${shown.body}<p>${SECRET_MAC_WORDS.code(approvalCode(held.publicKey))}</p>`,
        };
      if (!shown.id.startsWith(USE_CARD) || !Array.isArray(shown.actions)) return card;
      const offered = (shown.actions as ShownAction[]).filter((action) => {
        const answer = typeof action.id === "string" ? secretUseAnswerOf(action.id) : undefined;
        return answer === "deny" || (answer === "allow-once" && this.approves);
      });
      return {
        ...shown,
        body: `${shown.body}${this.noteUnderUse()}`,
        actions: offered.map((action, i) =>
          i === 0
            ? { ...action, default: true, variant: "primary" }
            : { ...action, default: false, variant: "ghost" },
        ),
      };
    });
  }

  /**
   * What this window adds under a use card: the card's lines for allows it
   * does not offer are left out, and one line in the card's own fine print
   * says where the rest is answered - a lasting allowance on the home while
   * this Mac approves, and otherwise where to set it up or where to answer.
   */
  private noteUnderUse(): string {
    const home = this.options.home();
    const hidden = this.approves
      ? '.secret-request .secret-request-allows > [data-secret-allow="lasting"]'
      : ".secret-request .secret-request-allows";
    const words = this.approves ? SECRET_MAC_WORDS.saveOnHome(home) : this.notApproving(home);
    return `<style>${hidden} { display:none; } .secret-request-window { max-width:44rem; }</style><p class="secret-request-fine secret-request-window">${escapeCardText(words)}</p>`;
  }

  /** Why this window offers no Allow: where to set it up, or, with no approver here at all, where to answer. */
  private notApproving(home: string): string {
    return this.approver() ? SECRET_MAC_WORDS.notSetUp(home) : SECRET_MAC_WORDS.cannotApprove(home);
  }

  /**
   * A press on a use card's Allow, answered here with this Mac's signature;
   * undefined for every other press, which goes to the home as it is.
   */
  async act(card: string, action: string): Promise<{ refusal?: string } | undefined> {
    if (!card.startsWith(USE_CARD)) return undefined;
    const answer = secretUseAnswerOf(action);
    if (!answer || answer === "deny") return undefined;
    const home = this.options.home();
    if (answer !== "allow-once") return { refusal: SECRET_MAC_WORDS.saveOnHome(home) };
    const request = card.slice(USE_CARD.length);
    if (!this.approver()) return { refusal: SECRET_MAC_WORDS.cannotApprove(home) };
    const held = await this.key(false).catch(() => undefined);
    if (!held) return { refusal: SECRET_MAC_WORDS.notSetUp(home) };
    const approvals = (await this.options.invoke("inf:secrets:approvals", [
      { device: held.device },
    ])) as SecretApprovals;
    if (!approvals.device || approvals.device.key !== held.publicKey || !approvals.home)
      return { refusal: SECRET_MAC_WORDS.notSetUp(home) };
    const waiting = approvals.waiting.find((use) => use.request === request);
    if (!waiting?.nonce) return { refusal: SECRET_MAC_WORDS.gone };
    let confirmed = false;
    try {
      confirmed =
        (await this.approver()?.authentication.confirm(SECRET_MAC_WORDS.confirm(home))) === true;
    } catch {
      // A failed or cancelled confirmation allows nothing.
    }
    if (!confirmed) return { refusal: SECRET_MAC_WORDS.notConfirmed };
    const signature = sign(
      "sha256",
      Buffer.from(
        decisionMessage({
          home: approvals.home,
          device: held.device,
          generation: approvals.device.generation,
          request,
          digest: waiting.digest,
          nonce: waiting.nonce,
          expires: waiting.expires,
        }),
      ),
      {
        key: createPrivateKey({
          key: Buffer.from(held.privateKey, "base64"),
          format: "der",
          type: "pkcs8",
        }),
        dsaEncoding: "der",
      },
    ).toString("base64");
    const decision = (await this.options.invoke("inf:secrets:decide", [
      {
        kind: "allow",
        request,
        device: held.device,
        generation: approvals.device.generation,
        nonce: waiting.nonce,
        signature,
      },
    ])) as SecretDecision;
    return decision.state === "waiting" || decision.state === "unavailable"
      ? { refusal: SECRET_MAC_WORDS.refused(home) }
      : {};
  }

  /** This Mac's key: read once from its custody, made and kept there when `create` asks. */
  private async key(create: boolean): Promise<Held | undefined> {
    const custody = this.approver()?.custody;
    if (!custody) return undefined;
    if (this.held === undefined) {
      const read = await custody.read("root");
      if (read.kind === "value") {
        try {
          this.held = JSON.parse(read.bytes.toString("utf8")) as Held;
        } finally {
          read.bytes.fill(0);
        }
      } else if (read.kind === "absent") this.held = null;
      else return undefined;
    }
    if (this.held || !create) return this.held ?? undefined;
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const made: Held = {
      device: randomUUID(),
      privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    };
    const bytes = Buffer.from(JSON.stringify(made));
    try {
      if ((await custody.write("root", bytes)) !== "stored") return undefined;
    } finally {
      bytes.fill(0);
    }
    this.held = made;
    return made;
  }
}
