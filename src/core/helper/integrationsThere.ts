import { HOME } from "@shared/deviceNames";
import { workRequests } from "@shared/work";
import type { TaskIntegrations } from "../integrations";

const integrationAnswerSchema = workRequests["inf:work:use-integration"].response;
type IntegrationWireAnswer = ReturnType<typeof integrationAnswerSchema.parse>;

/** What a computer that runs work asks its home for the integrations command, by work request. */
export type AskHomeForIntegrations = (
  channel: "inf:work:integrations" | "inf:work:use-integration",
  input: object,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * The integrations a task's command reaches on a computer that runs work
 * (docs/integrations.md, "On a computer that runs work"): each list and show
 * is asked of the home (`inf:work:integrations`), and each call too
 * (`inf:work:use-integration`). The home answers it with its own integrations
 * and sign-ins under the task's rules, and keeps the answer, so one asked
 * again after a drop is answered once. Nothing of a sign-in is here. The
 * command's `signal` ends a wait it could no longer answer: one never sent
 * then is not sent when the home returns.
 */
export function integrationsAskedOfHome(ask: AskHomeForIntegrations): TaskIntegrations {
  const asked = async (
    channel: "inf:work:integrations" | "inf:work:use-integration",
    input: object,
    signal?: AbortSignal,
  ): Promise<IntegrationWireAnswer> =>
    integrationAnswerSchema.parse(await ask(channel, input, signal));
  const words = (answer: IntegrationWireAnswer) => ({
    text: answer.text ?? `${HOME.The} answered nothing.`,
    ...(answer.refused ? { refused: answer.refused } : {}),
  });
  return {
    list: async (signal) => {
      const answer = await asked("inf:work:integrations", {}, signal);
      const rows = answer.data?.integrations;
      if (!Array.isArray(rows)) throw new Error(words(answer).text);
      return rows as Record<string, unknown>[];
    },
    show: async (name, signal) => {
      const answer = await asked("inf:work:integrations", { name }, signal);
      return answer.data ?? words(answer);
    },
    call: async (name, action, input, signal, reason) =>
      words(
        await asked(
          "inf:work:use-integration",
          { name, action, input, ...(reason !== undefined ? { reason } : {}) },
          signal,
        ),
      ),
  };
}
