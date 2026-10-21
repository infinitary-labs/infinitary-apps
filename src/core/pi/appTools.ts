import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACTION_NAMES,
  ACTIONS,
  type ActionActor,
  type ActionLine,
  type ActionName,
  actionActors,
  actionRefusal,
  type HandoverOffer,
  isMultiMachineLine,
  isProjectChange,
  OWN_WORDS_ACTIONS,
} from "@shared/actions";
import type { Layout } from "@shared/preferences";
import { Type } from "typebox";
import type { CoreDispatch } from "../dispatcher";
import { renderSignInRefusal, SignInRequiredError } from "../forge";
import { boundTool, stringEnum } from "../session/tools";
import { listSurfaces } from "./personalizeTool";

export type AppToolsDelegate = {
  dispatch: CoreDispatch;
  /** Files the hands line's card for the captain; answers what the Firstmate is told. */
  handover?: (target: NonNullable<ActionLine["handover"]>, offer: HandoverOffer) => string;
  /**
   * Puts up the host's own card for a line that proposes (`ActionLine.proposes`),
   * at any wake; answers what the Firstmate is told, or throws a refusal.
   */
  propose?: (action: ActionName, value: unknown) => Promise<string>;
  changeProject?: (action: ActionName, value: unknown, actor: ActionActor) => Promise<string>;
  actor: () => Extract<ActionActor, { kind: "firstmate" }>;
  /** The home's system, for an offer whose words name its settings; a Mac's unless named. */
  platform?: string;
};

/**
 * The card a hands line offers: the line's own when it has one, built from
 * the value the Firstmate passed and the line's current value, or a plain
 * Open Settings card that says the line.
 */
export async function handoverOffer(
  dispatch: CoreDispatch,
  action: ActionName,
  raw: unknown,
  platform = "darwin",
): Promise<HandoverOffer> {
  const line: ActionLine = ACTIONS[action];
  if (!line.offer)
    return {
      cardId: `app-${action}`,
      title: line.line,
      paragraphs: [line.line],
      label: "Open Settings",
      decline: "Not now",
    };
  // A value the line does not read is refused, never offered as something
  // else: an address that is not one never becomes a card for a link.
  const value = line.value.parse(raw ?? {}) as Record<string, unknown>;
  const current = line.current ? await dispatch(line.current, []) : null;
  return line.offer(value, current, { platform });
}

/** Each request preserves unrelated values on the existing whole-value channels. */
export async function actionRequest(
  dispatch: CoreDispatch,
  action: ActionName,
  raw: unknown,
): Promise<unknown[]> {
  const line: ActionLine = ACTIONS[action];
  const value = line.value.parse(raw) as Record<string, unknown>;
  let current: unknown = line.current ? await dispatch(line.current, []) : null;
  if (action === "panel") {
    const personal = await dispatch("inf:plugins:personal:list", []);
    const { held: knowledge } = await dispatch("inf:knowledge:enabled", []);
    const rules = await dispatch("inf:automation:list", []);
    const automation = rules.state === "ready" && rules.rules.length > 0;
    const surfaces = listSurfaces(current as Layout, personal, { knowledge, automation });
    const surface =
      surfaces.find((s) => s.id === value.surface) ??
      surfaces.find((s) => s.title.toLowerCase() === (value.surface as string).toLowerCase());
    if (!surface)
      throw new Error(
        `No surface "${value.surface}". Your surfaces: ${surfaces.map((s) => s.id).join(", ")}. The captain's panels switch is in Settings.`,
      );
    current = { layout: current, surface };
  }
  return line.toRequest(value, current, (path) =>
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
  );
}
export function actionValue(action: ActionName, current: unknown): Record<string, unknown> {
  return ACTIONS[action].readValue(current);
}
export function createAppTools(delegate: AppToolsDelegate) {
  return [
    boundTool({
      name: "app_state",
      label: "App actions",
      description:
        "Look at app actions, their permissions, value schemas and current values. captainAllowed and firstmateAllowed consistently flag who may act; asked means the captain asked in any form, own-words in his typed words, at any wake. No changes.",
      parameters: Type.Object({
        area: Type.Optional(
          stringEnum(["projects", "appearance", "general", "panels", "intelligence"]),
        ),
      }),
      run: async (params) => {
        const lines = await Promise.all(
          ACTION_NAMES.filter((name) => !params.area || ACTIONS[name].area === params.area).map(
            async (name) => {
              const line = ACTIONS[name];
              return {
                action: name,
                area: line.area,
                tier: line.tier,
                ...actionActors(line),
                allowedNow:
                  line.proposes === true ||
                  isProjectChange(name) ||
                  !actionRefusal(line, {
                    ...delegate.actor(),
                    evidence: "permission preview",
                  }),
                line: line.line,
                valueSchema: line.value.toJSONSchema(),
                current: actionValue(
                  name,
                  line.current ? await delegate.dispatch(line.current, []) : null,
                ),
              };
            },
          ),
        );
        return { text: JSON.stringify(lines) };
      },
    }),
    boundTool({
      name: "app_change",
      label: "Change app setting",
      description: `Apply a catalog action (schema: app_state). evidence quotes the captain's ask, whatever began the turn: his message, his choice on any card (a crewmate relays one) or a schedule he set, never your own; ${OWN_WORDS_ACTIONS.join(", ")} need his typed words. For project-settings and project-runs-on, on_words true declares the exact patch his words named; omit it to propose with its source as evidence. The app’s exact-change card alone applies once, on Apply change. No other card permits a patch. Success records one feed line. Hands offer a card (project-setup at any wake); yours explain. Nothing outside the catalog.`,
      parameters: Type.Object({
        action: stringEnum(ACTION_NAMES),
        value: Type.Object({}, { additionalProperties: true }),
        evidence: Type.String({ minLength: 1 }),
        on_words: Type.Optional(Type.Boolean()),
      }),
      run: async (params) => {
        try {
          const action = params.action as ActionName;
          if (!ACTION_NAMES.includes(action)) return { text: "No such app action." };
          // A proposal changes nothing, so any wake may make one: only the
          // captain's click on the host's card runs the change.
          if (ACTIONS[action].proposes)
            return {
              text: delegate.propose
                ? await delegate.propose(action, params.value)
                : ACTIONS[action].line,
            };
          const actor = {
            ...delegate.actor(),
            action,
            evidence: params.evidence as string,
            projectWords: params.on_words === true,
          };
          if (isProjectChange(action) && delegate.changeProject)
            return { text: await delegate.changeProject(action, params.value, actor) };
          const refusal = actionRefusal(ACTIONS[action], actor);
          if (refusal) {
            const line = ACTIONS[action];
            if (line.tier === "hands" && line.handover && delegate.actor().wake !== "other") {
              if (!delegate.handover)
                return {
                  text: isMultiMachineLine(line)
                    ? line.line
                    : `${line.line} Use emit_card with an open ${line.handover} button.`,
                };
              const offer = await handoverOffer(
                delegate.dispatch,
                action,
                params.value,
                delegate.platform,
              );
              return { text: delegate.handover(line.handover, offer) };
            }
            return { text: `${refusal} ${line.line}` };
          }
          const line = ACTIONS[action];
          if (!line.change || !line.current) return { text: line.line };
          const args = await actionRequest(delegate.dispatch, action, params.value);
          await delegate.dispatch(line.change, args, actor);
          const result = await delegate.dispatch(line.current, []);
          return { text: JSON.stringify({ action, current: actionValue(action, result) }) };
        } catch (error) {
          if (error instanceof SignInRequiredError)
            return { text: renderSignInRefusal(error.refusal) };
          return { text: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
  ];
}
