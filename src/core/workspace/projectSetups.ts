import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Card, type CardAnswer, FIRSTMATE_CARD_META } from "@shared/cards";
import { COMPUTER, HERE } from "@shared/deviceNames";
import { type DeviceView, deviceRunsWork } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import { AUTOMATIC_COMPUTER, AUTOMATIC_WORD } from "@shared/placement";
import {
  SETUP_CARD_FIELDS as FIELDS,
  type ProjectSetupOffer,
  projectSetupOfferSchema,
  projectSetupProposalSchema,
  setupSettingsWords,
  SETUP_CARD_WORDS as WORDS,
} from "@shared/projectSetup";
import {
  type RepoPolicyPatch,
  type RepoSetupCheck,
  type RepoSetupSpec,
  type RepoView,
  RUNS_ON_THIS_MAC,
  repoDeliverySchema,
  runsHereOnly,
} from "@shared/repos";
import { rigorSchema } from "@shared/rigor";
import { signInPlace } from "@shared/signIns";
import { AUTONOMY_WORDS, CARE_WORDS, PROJECT_DELIVERY_WORDS } from "@shared/vocabulary";
import { resolveWorkComputer } from "@shared/workComputer";
import type { CoreDispatch } from "../dispatcher";
import { renderSignInRefusal, SignInRequiredError } from "../forge";
import { escapeCardText } from "../orchestrator/cardText";
import type { WakeFacts } from "../orchestrator/wakes";
import type { RepoRegistry } from "./repoRegistry";

/**
 * Adding a project Firstmate proposed (docs/fleet.md, "Asking the first mate to
 * add a project"; design skill `components/projects/SetupCard`; captain's
 * direction A on FI3-1531): `app_change project-setup`, from any wake,
 * reaches `propose`, which checks the request without writing anything and
 * puts up one card the app writes from what it checked - where the project
 * comes from, how it lands on this computer, the task key Firstmate asked
 * for, and its four settings with Firstmate's suggestions selected. Only
 * the captain's click on its Add project (a host effect, which no body
 * script or agent can run) sets it up, through the same dispatcher
 * Settings uses, as the captain: the setup, then its settings, all before
 * the Firstmate hears. Not now, or closing the card, adds nothing. Either
 * way the Firstmate is told once.
 */

export type ProjectSetupFacts = Extract<WakeFacts, { kind: "project-setup" }>;

export type ProjectSetupsOptions = {
  repos: Pick<RepoRegistry, "check">;
  /** Every device on the list; the card offers the computers that run work. */
  devices: () => readonly DeviceView[];
  raiseCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
  /** Tells the Firstmate how the captain answered, once. */
  tell: (facts: ProjectSetupFacts) => void;
  broadcast: (event: FmEvent) => void;
};

/** The card's id for one project: asking again for it revises the one card. */
export function setupCardId(spec: RepoSetupSpec): string {
  const key =
    spec.kind === "clone"
      ? `clone:${spec.origin.trim()}`
      : spec.kind === "init"
        ? `init:${spec.name.trim()}`
        : `adopt:${resolve(spec.path)}`;
  return `card-project-setup-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

export class ProjectSetups {
  private dispatch: CoreDispatch | undefined;

  constructor(private readonly options: ProjectSetupsOptions) {}

  /** The core's dispatcher, which the setup runs through as Settings' does. */
  bindDispatch(dispatch: CoreDispatch): void {
    this.dispatch = dispatch;
  }

  /**
   * The Firstmate's proposal: checked, and put on one card, or refused in
   * words. A project already on the list gets no card.
   */
  async propose(raw: unknown): Promise<{ text: string; cardId?: string }> {
    const {
      delivery,
      autonomy,
      rigor,
      runsOn: runsOnAsk,
      work,
      ...asked
    } = projectSetupProposalSchema.parse(raw);
    const spec: RepoSetupSpec =
      asked.kind === "adopt" ? { ...asked, path: resolve(expandHome(asked.path)) } : asked;
    const checked = await this.options.repos.check(spec);
    if ("existing" in checked) {
      if (checked.existing.kind === "personal")
        throw new Error("Your personal workspace is already managed and cannot be added here.");
      return {
        text: `${checked.existing.name} is already one of the captain's projects (repo_id ${checked.existing.id}), so no setup card went up.`,
      };
    }
    if (delivery === "direct-pr" && !checked.origin)
      throw new Error(
        "This project is kept on this computer. Use Local merge until it lives somewhere else.",
      );
    const computers = runsHereOnly({ kind: "project", origin: checked.origin })
      ? []
      : this.options.devices().filter((device) => deviceRunsWork(device.kind));
    if (runsOnAsk && !checked.origin)
      throw new Error(
        `${checked.name} would be kept on ${HERE.this} only, so its tasks run here. Pass runsOn null.`,
      );
    const resolved = runsOnAsk ? resolveWorkComputer(runsOnAsk, computers) : runsOnAsk;
    const runsOn = resolved === RUNS_ON_THIS_MAC ? null : resolved;
    const offer: ProjectSetupOffer = {
      name: checked.name,
      setup: spec,
      ...(spec.kind === "adopt" && checked.origin
        ? // A clone picked instead keeps the name and task key the card shows.
          {
            clone: {
              kind: "clone" as const,
              origin: checked.origin,
              name: checked.name,
              ...(checked.key ? { key: checked.key } : {}),
            },
          }
        : {}),
      proposed: {
        delivery: delivery ?? (checked.origin ? "direct-pr" : "local-only"),
        autonomy: autonomy ?? false,
        rigor: rigor ?? "standard",
        runsOn: runsOn === undefined ? (checked.origin ? AUTOMATIC_COMPUTER : null) : runsOn,
      },
      ...(work ? { work } : {}),
    };
    const cardId = setupCardId(spec);
    this.options.raiseCard(setupCard(cardId, offer, checked, computers));
    return {
      cardId,
      text: `The captain's setup card for ${offer.name} is up (${cardId}): where it comes from, how it lands, and its settings, with your suggestions selected. Nothing is added until they click ${WORDS.add} there, and you hear once how they answered; start work that needs it only once they have added it. Say nothing more about it now.`,
    };
  }

  /** The captain's Add project: the setup, then the settings he chose, then the Firstmate hears. */
  async add(arg: string | undefined, answers?: readonly CardAnswer[]): Promise<void> {
    const offer = readOffer(arg);
    if (!offer) return;
    const dispatch = this.dispatch;
    if (!dispatch) {
      this.couldNotAdd(offer, "the app was not ready to add projects yet.");
      return;
    }
    const pick = (name: string) => answers?.find((answer) => answer.name === name)?.values[0];
    const spec = pick(FIELDS.landing) === "clone" && offer.clone ? offer.clone : offer.setup;
    const delivery = repoDeliverySchema.safeParse(pick(FIELDS.delivery)).data;
    const rigor = rigorSchema.safeParse(pick(FIELDS.care)).data ?? offer.proposed.rigor;
    const asks = pick(FIELDS.autonomy);
    const autonomy = asks === "merges" ? true : asks === "asks" ? false : offer.proposed.autonomy;
    const where = pick(FIELDS.runsOn);
    const runsOn =
      where === undefined ? offer.proposed.runsOn : where === RUNS_ON_THIS_MAC ? null : where;
    let repo: RepoView;
    try {
      const result = await dispatch("inf:repos:setup", [spec]);
      if (!result.created) {
        this.options.tell({
          kind: "project-setup",
          outcome: "already",
          name: result.repo.name,
          repoId: result.repo.id,
          ...(offer.work ? { work: offer.work } : {}),
        });
        return;
      }
      repo = result.repo;
    } catch (error) {
      this.couldNotAdd(offer, error);
      return;
    }
    const chosen = delivery ?? offer.proposed.delivery;
    const patch: Partial<RepoPolicyPatch> = {
      ...(chosen !== repo.delivery ? { delivery: chosen } : {}),
      ...(autonomy !== repo.autonomy ? { autonomy } : {}),
      ...(rigor !== repo.rigor ? { rigor } : {}),
    };
    const unsaved: string[] = [];
    if (Object.keys(patch).length > 0) {
      try {
        repo = await dispatch("inf:repos:configure", [repo.id, patch as RepoPolicyPatch]);
      } catch (error) {
        unsaved.push(errorText(error));
      }
    }
    if (runsOn !== repo.runsOn && runsHereOnly(repo) === null) {
      try {
        repo = await dispatch("inf:devices:runs-on", [repo.id, runsOn]);
      } catch (error) {
        unsaved.push(errorText(error));
      }
    }
    this.options.tell({
      kind: "project-setup",
      outcome: "added",
      name: repo.name,
      repoId: repo.id,
      settings: setupSettingsWords(repo, this.options.devices()),
      ...(unsaved.length > 0
        ? { reason: `These settings could not be saved: ${unsaved.join(" ")}` }
        : {}),
      ...(offer.work ? { work: offer.work } : {}),
    });
  }

  /** The captain's Not now, or his close of the card. */
  decline(arg: string | undefined): void {
    const offer = readOffer(arg);
    if (offer) this.options.tell({ kind: "project-setup", outcome: "not-now", name: offer.name });
  }

  private couldNotAdd(offer: ProjectSetupOffer, error: unknown): void {
    const refusal = error instanceof SignInRequiredError ? error.refusal : undefined;
    const text = refusal?.text ?? errorText(error);
    this.options.broadcast({
      type: "firstmate_note",
      text: `Could not add ${offer.name}: ${text}`,
    });
    this.options.tell({
      kind: "project-setup",
      outcome: "failed",
      name: offer.name,
      reason: refusal ? renderSignInRefusal(refusal) : text,
    });
  }
}

function readOffer(arg: string | undefined): ProjectSetupOffer | undefined {
  if (!arg) return undefined;
  try {
    return projectSetupOfferSchema.parse(JSON.parse(arg));
  } catch {
    return undefined;
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "pull requests" as an option's own words: "Pull requests". */
function leading(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One setting as a row, the way its row in Settings -> Projects reads: the
 * question on the left, its control on the right, a hairline above.
 */
function row(legend: string, control: string, optionsOnly = true): string {
  return `<fieldset${optionsOnly ? " data-inf-options-only" : ""} style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin: 0; padding: var(--space-2) 0; border: none; border-top: 1px solid var(--line-1); border-radius: 0"><legend style="float: left; padding: 0">${escapeCardText(legend)}</legend>${control}</fieldset>`;
}

function radios(
  legend: string,
  name: string,
  options: readonly { value: string; label: string }[],
  checked: string,
): string {
  const labels = options
    .map(
      (option) =>
        `<label style="margin: 0"><input type="radio" name="${name}" value="${option.value}"${option.value === checked ? " checked" : ""}> ${escapeCardText(option.label)}</label>`,
    )
    .join("");
  return row(legend, `<div class="inf-row" style="gap: var(--space-4)">${labels}</div>`);
}

function fact(key: string, value: string, mono = false): string {
  return `<div class="inf-fact"><span class="inf-fact-k">${escapeCardText(key)}</span><span class="inf-fact-v${mono ? " inf-mono" : ""}">${escapeCardText(value)}</span></div>`;
}

/** The setup card itself, from what the check read: words and controls the app writes. */
function setupCard(
  id: string,
  offer: ProjectSetupOffer,
  checked: Exclude<RepoSetupCheck, { existing: RepoView }>,
  computers: readonly DeviceView[],
): Omit<Card, "author" | "priority" | "status" | "createdAt"> {
  const { setup, proposed } = offer;
  const where =
    setup.kind === "clone"
      ? [
          fact("From", setup.origin, true),
          fact(`On ${HERE.this}`, "Cloned into your projects folder"),
        ]
      : setup.kind === "init"
        ? [
            fact("From", "A new project"),
            fact(`On ${HERE.this}`, "Started in your projects folder"),
          ]
        : [
            fact("Folder", setup.path, true),
            ...(checked.origin ? [fact("From", checked.origin, true)] : []),
            ...(offer.clone ? [] : [fact(`On ${HERE.this}`, "Linked where it is")]),
          ];
  // The key Firstmate asked for, as the check normalized it; none, and the app derives one.
  const facts = checked.key ? [...where, fact(WORDS.key, checked.key, true)] : where;
  const work = offer.work
    ? `<p>Once it is added, your first mate starts this work: ${escapeCardText(offer.work)}${/[.!?]$/.test(offer.work) ? "" : "."}</p>`
    : "";
  const startsGit = checked.startsGit
    ? "<p>It has no git yet, so adding it starts git in that folder with an empty first commit.</p>"
    : "";
  const landing = offer.clone
    ? radios(
        WORDS.landing,
        FIELDS.landing,
        [
          { value: "link", label: WORDS.link },
          { value: "clone", label: WORDS.clone },
        ],
        "link",
      )
    : "";
  const option = (device: DeviceView) =>
    `<option value="${escapeCardText(device.id)}"${device.id === proposed.runsOn ? " selected" : ""}>${escapeCardText(signInPlace({ name: device.name, user: device.user, onThisMac: device.onThisMac ?? false }).label)}</option>`;
  const macs = computers.filter((device) => !device.onThisMac);
  const users = computers.filter((device) => device.onThisMac);
  const runsOn = checked.origin
    ? row(
        WORDS.runsOn,
        `<select name="${FIELDS.runsOn}" aria-label="${WORDS.runsOn}" data-inf-options-only><option value="${AUTOMATIC_COMPUTER}"${proposed.runsOn === AUTOMATIC_COMPUTER ? " selected" : ""}>${AUTOMATIC_WORD}</option><option value="${RUNS_ON_THIS_MAC}"${proposed.runsOn === null ? " selected" : ""}>${HERE.This}</option>${macs.length > 0 ? `<optgroup label="Your ${COMPUTER.many}">${macs.map(option).join("")}</optgroup>` : ""}${users.length > 0 ? `<optgroup label="As another user">${users.map(option).join("")}</optgroup>` : ""}</select>`,
        false,
      )
    : "";
  // The approved sketch's order: where it runs first, then its row's settings.
  const settings = [
    landing,
    runsOn,
    radios(
      WORDS.delivery,
      FIELDS.delivery,
      (["direct-pr", "local-only"] as const)
        .filter((value) => checked.origin || value === "local-only")
        .map((value) => ({
          value,
          label: leading(PROJECT_DELIVERY_WORDS[value]),
        })),
      proposed.delivery,
    ),
    radios(
      WORDS.autonomy,
      FIELDS.autonomy,
      [
        { value: "asks", label: AUTONOMY_WORDS.asksFirst },
        { value: "merges", label: AUTONOMY_WORDS.putsInItself },
      ],
      proposed.autonomy ? "merges" : "asks",
    ),
    radios(
      WORDS.care,
      FIELDS.care,
      (["quick", "standard", "reviewed"] as const).map((value) => ({
        value,
        label: CARE_WORDS[value],
      })),
      proposed.rigor,
    ),
  ].filter(Boolean);
  const arg = JSON.stringify(offer);
  return {
    id,
    title: WORDS.title(offer.name),
    meta: FIRSTMATE_CARD_META,
    body: [
      `<p>Your first mate asks to add <b>${escapeCardText(offer.name)}</b> to your projects. Nothing changes until you click ${WORDS.add}.</p>`,
      work,
      `<div class="inf-facts">${facts.join("")}</div>`,
      startsGit,
      `<div style="margin-top: var(--space-3); border-bottom: 1px solid var(--line-1)">${settings.join("")}</div>`,
    ]
      .filter(Boolean)
      .join("\n"),
    actions: [
      {
        id: "add",
        label: WORDS.add,
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "add-project", arg },
      },
      {
        id: "not-now",
        label: WORDS.notNow,
        variant: "ghost",
        effect: { kind: "host", op: "decline-project", arg },
      },
    ],
  };
}
