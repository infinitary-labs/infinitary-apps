import { Type } from "typebox";
import { type SecretAskAnswer, type SecretAskInput, secretAskHowProblem } from "../secrets/asks";
import { boundTool } from "../session/tools";

/**
 * The first mate's ask to keep a secret (docs/secrets.md, "Asking to keep a
 * secret"): the same ask a crewmate makes with `infinitary-secrets-axi ask`.
 * The first mate names each secret and why, never a value; Infinitary raises
 * its own card with a masked field per secret, and the first mate hears
 * once, as a wake, the references kept or that the captain did not keep them.
 */

export const ASK_SECRET_TOOL_NAME = "ask_secret";

export const ASK_SECRET_TOOL_DESCRIPTION =
  "Ask the captain to keep a key, token or password in Secrets: name each short (place only tells two of one name apart) or a kept reference to replace, and why; never a value. Give how when the captain must make or find it. The app raises its masked card; emit none. You hear once what was kept; cancel withdraws. Never ask for one in another tool: a crewmate moves it (bring-secrets skill).";

/** What the first mate's ask reaches: the Secrets owner's ask, for the first mate. */
export type SecretAskReach = {
  ask: (input: SecretAskInput) => Promise<SecretAskAnswer>;
  cancel: (id: string) => boolean;
};

/** `raised` hears the card id when an ask waits for the captain, so the turn counts it. */
export function createSecretTools(reach: SecretAskReach, raised?: (askId: string) => void) {
  return [
    boundTool({
      name: ASK_SECRET_TOOL_NAME,
      label: "Ask to keep a secret",
      description: ASK_SECRET_TOOL_DESCRIPTION,
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64 }),
        reason: Type.Optional(Type.String()),
        secrets: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.Optional(Type.String()),
              place: Type.Optional(Type.String()),
              replace: Type.Optional(Type.String()),
            }),
          ),
        ),
        how: Type.Optional(
          Type.String({
            description:
              "How to get it, an HTML fragment you lay out: <ol> steps, <code> names, <table>, <details>. No script, style or field; each link a full https:// address shown as its text.",
          }),
        ),
        cancel: Type.Optional(Type.Boolean()),
      }),
      run: async (params) => {
        if (params.cancel === true) {
          const cancelled = reach.cancel(params.id);
          return { text: JSON.stringify({ ask: params.id, cancelled }) };
        }
        const secrets = (params.secrets ?? []).map((secret) => ({
          ...(secret.name !== undefined ? { name: secret.name } : {}),
          ...(secret.place !== undefined ? { place: secret.place } : {}),
          ...(secret.replace !== undefined ? { replace: secret.replace } : {}),
        }));
        const input: SecretAskInput = {
          id: params.id,
          reason: params.reason ?? "",
          secrets,
          ...(params.how !== undefined ? { how: params.how } : {}),
        };
        const problem = secretAskHowProblem(input);
        if (problem) return { text: `Refused: nothing was asked. ${problem}` };
        const answer = await reach.ask(input).catch(() => undefined);
        if (!answer)
          return {
            text: "Refused: give an id, a reason and at least one secret, each by name (and place) or by replace with a kept reference, each once.",
          };
        if (answer.state === "waiting") raised?.(answer.ask);
        return { text: JSON.stringify(answer) };
      },
    }),
  ];
}
