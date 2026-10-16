import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ACTIONS, type ActionActor, type ActionName, isProjectChange } from "@shared/actions";
import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import type { DeviceView } from "@shared/devices";
import { deviceRunsWork } from "@shared/devices";
import { AUTOMATIC_COMPUTER, AUTOMATIC_WORD, type PlacementRequirements } from "@shared/placement";
import type { RepoPolicyPatch, RepoView } from "@shared/repos";
import { devicePlace } from "@shared/signIns";
import { AUTONOMY_WORDS, CARE_WORDS, PROJECT_DELIVERY_WORDS } from "@shared/vocabulary";
import { z } from "zod";
import type { CoreDispatch } from "../dispatcher";
import { escapeCardText } from "../orchestrator/cardText";
import type { WakeFacts } from "../orchestrator/wakes";
import { actionRequest, actionValue } from "../pi/appTools";
import type { RepoRegistry } from "./repoRegistry";

const names = ["project-settings", "project-runs-on"] as const;
const offerSchema = z.object({
  token: z.string(),
  action: z.enum(names),
  value: z.record(z.string(), z.unknown()),
  before: z.unknown(),
  title: z.string(),
});
type Offer = z.infer<typeof offerSchema>;

/** One path for project changes: exact captain words, or an app-written exact-change card. */
export class ProjectChanges {
  private dispatch: CoreDispatch | undefined;
  private readonly consumed = new Set<string>();
  constructor(
    private readonly options: {
      repos: RepoRegistry;
      devices: () => readonly DeviceView[];
      raiseCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
      tell: (facts: Extract<WakeFacts, { kind: "project-change" }>) => void;
    },
  ) {}
  bindDispatch(dispatch: CoreDispatch): void {
    this.dispatch = dispatch;
  }

  async request(
    action: ActionName,
    raw: unknown,
    actor: ActionActor,
  ): Promise<{ text: string; cardId?: string }> {
    if (!isProjectChange(action)) throw new Error("Not a project change.");
    const line = ACTIONS[action];
    const value = line.value.parse(raw) as Record<string, unknown>;
    const dispatch = this.ready();
    const before = await this.current(action, value);
    if (action === "project-settings") {
      const patch = value.changes as RepoPolicyPatch;
      if (patch.origin === null && patch.delivery === undefined) patch.delivery = "local-only";
      if (
        (patch.delivery ?? (before as RepoView).delivery) === "direct-pr" &&
        !(patch.origin === undefined ? (before as RepoView).origin : patch.origin)
      )
        throw new Error(
          "This project is kept on this computer. Approve where it lives before choosing pull requests.",
        );
    }
    if (
      action === "project-runs-on" &&
      value.deviceId !== null &&
      value.deviceId !== AUTOMATIC_COMPUTER &&
      !this.options
        .devices()
        .some((device) => device.id === value.deviceId && deviceRunsWork(device.kind))
    )
      throw new Error("Choose a computer that runs work from app_state.");
    if (action === "project-settings") {
      await this.options.repos.checkDetails(
        value.repoId as string,
        value.changes as RepoPolicyPatch,
      );
    }
    // A normal card choice is not authority for a different change. Only
    // the host button below applies the exact stored patch. A destination
    // discovered in git always needs that button, even on a captain turn.
    const address =
      action === "project-settings" && (value.changes as RepoPolicyPatch).origin !== undefined;
    if (
      !address &&
      actor.kind === "firstmate" &&
      (actor.wake === "captain" || actor.wake === "scheduled") &&
      actor.projectWords === true &&
      actor.evidence?.trim()
    ) {
      const args = await actionRequest(dispatch, action, value);
      await dispatch(line.change!, args, actor);
      return {
        text: JSON.stringify({
          action,
          current: actionValue(action, await dispatch(line.current!, [])),
        }),
      };
    }
    const repo = this.options.repos.get(value.repoId as string);
    if (!repo) throw new Error("That project is no longer here.");
    const title = `Change ${repo.name}?`;
    const offer: Offer = {
      token: randomUUID(),
      action: action as Offer["action"],
      value,
      before,
      title,
    };
    const cardId = `card-project-change-${action}-${repo.id}`;
    this.options.raiseCard({
      id: cardId,
      title,
      meta: FIRSTMATE_CARD_META,
      body: `<p>Your first mate asks for this project change. Nothing changes until you click Apply change.</p>${changeRows(offer, this.options.devices())}<p>Your project keeps its history and key.</p>`,
      actions: [
        {
          id: `apply-${offer.token}`,
          label: "Apply change",
          default: true,
          variant: "primary",
          effect: { kind: "host", op: "apply-project-change", arg: JSON.stringify(offer) },
        },
        {
          id: `not-now-${offer.token}`,
          label: "Not now",
          effect: { kind: "host", op: "decline-project-change", arg: JSON.stringify(offer) },
        },
      ],
    });
    return {
      cardId,
      text: `The app's exact-change card is up (${cardId}). Nothing changes until the captain clicks Apply change. Do not write another card or start work that needs the change; you hear how he answered.`,
    };
  }

  async apply(arg: string | undefined): Promise<void> {
    const offer = this.claim(arg);
    if (!offer) return;
    try {
      if (!isDeepStrictEqual(offer.before, await this.current(offer.action, offer.value)))
        throw new Error("The project changed since this card was written. Ask for a new card.");
      const dispatch = this.ready();
      const args = await actionRequest(dispatch, offer.action, offer.value);
      await dispatch(ACTIONS[offer.action].change!, args, {
        kind: "captain",
        projectBefore: offer.before,
      });
      this.options.tell({ kind: "project-change", outcome: "applied", title: offer.title });
    } catch (error) {
      this.options.tell({
        kind: "project-change",
        outcome: "failed",
        title: offer.title,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  decline(arg: string | undefined): void {
    const offer = this.claim(arg);
    if (offer)
      this.options.tell({ kind: "project-change", outcome: "not-now", title: offer.title });
  }

  /** Notice only: git never changes the saved address or the API write fence. */
  async inspect(repoId: string): Promise<void> {
    const repo = this.options.repos.get(repoId);
    if (!repo || repo.kind === "personal") return;
    const origin = await this.options.repos.detectedOrigin(repoId);
    if (origin !== repo.origin)
      await this.request(
        "project-settings",
        { repoId, changes: { origin, ...(!origin ? { delivery: "local-only" } : {}) } },
        { kind: "firstmate", wake: "other" },
      );
  }
  async inspectAll(): Promise<void> {
    for (const repo of this.options.repos.list()) {
      try {
        await this.inspect(repo.id);
      } catch {
        /* An unreadable folder is not evidence for a different address. */
      }
    }
  }
  private ready(): CoreDispatch {
    if (!this.dispatch) throw new Error("Project changes are not ready yet.");
    return this.dispatch;
  }
  private async current(action: ActionName, value: Record<string, unknown>): Promise<unknown> {
    const current = await this.ready()(ACTIONS[action].current!, []);
    const repo = (current as RepoView[]).find((r) => r.id === value.repoId);
    if (!repo) throw new Error("That project is no longer here.");
    if (repo.kind === "personal") throw new Error("The personal workspace's settings stay fixed.");
    return repo;
  }
  private claim(arg: string | undefined): Offer | undefined {
    if (!arg) return;
    const offer = offerSchema.parse(JSON.parse(arg));
    if (this.consumed.has(offer.token)) return;
    this.consumed.add(offer.token);
    return offer;
  }
}

function changeRows(offer: Offer, devices: readonly DeviceView[]): string {
  const previous = offer.before as RepoView & { path?: string };
  const changes: Record<string, unknown> =
    offer.action === "project-settings"
      ? { ...(offer.value.changes as Record<string, unknown>) }
      : { runsOn: offer.value.deviceId };
  if (offer.action === "project-settings" && changes.origin === null && previous.runsOn)
    changes.runsOn = null;
  if (
    offer.action === "project-settings" &&
    typeof changes.origin === "string" &&
    !previous.origin &&
    previous.kind === "project"
  )
    changes.runsOn = AUTOMATIC_COMPUTER;
  const labels: Record<string, string> = {
    name: "Name",
    path: "Folder",
    origin: "Where it lives",
    delivery: "Where changes go",
    autonomy: "Ask before merging",
    rigor: "Care",
    runsOn: "Runs on",
    placementRequirements: "Computer requirements",
  };
  const words = (key: string, value: unknown): string => {
    if (key === "delivery") return PROJECT_DELIVERY_WORDS[value as RepoView["delivery"]];
    if (key === "autonomy") return value ? AUTONOMY_WORDS.putsInItself : AUTONOMY_WORDS.asksFirst;
    if (key === "rigor") return CARE_WORDS[(value ?? "standard") as NonNullable<RepoView["rigor"]>];
    if (key === "origin" && value === null) return "Kept on this computer";
    if (key === "runsOn")
      return value === AUTOMATIC_COMPUTER
        ? AUTOMATIC_WORD
        : value === null
          ? "This computer"
          : devicePlace(devices, String(value)).where;
    if (key === "placementRequirements") {
      const requirements = value as PlacementRequirements | null | undefined;
      const profiles = {
        conversation: "Conversation allowance",
        standard: "Standard allowance",
        heavy: "Heavy allowance",
      };
      return [
        requirements?.systems
          ?.map((system) => (system === "macos" ? "macOS" : "Linux"))
          .join(", ") ?? "This computer's system",
        requirements?.chips?.join(", ") ?? "This computer's architecture",
        requirements?.tools?.length
          ? `Required programs: ${requirements.tools.join(", ")}`
          : "No additional programs",
        profiles[requirements?.profile ?? "standard"],
      ].join(" · ");
    }
    return String(value);
  };
  return `<table><thead><tr><th>Detail</th><th>Now</th><th>After your click</th></tr></thead><tbody>${Object.entries(
    changes,
  )
    .map(
      ([key, value]) =>
        `<tr><th>${escapeCardText(labels[key] ?? key)}</th><td class="inf-mono">${escapeCardText(words(key, previous[key as keyof typeof previous]))}</td><td class="inf-mono">${escapeCardText(words(key, value))}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}
