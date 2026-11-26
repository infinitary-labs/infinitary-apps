import type { Core } from "@core/index";
import { ANSWER_PROMPT_MARKER } from "../e2e/mockProvider";

/**
 * The computer's side of the talk-compose part's messages
 * (ios/Infinitary/InfinitaryUITests/PhoneJourney+TalkCompose.swift): each waits, on the core's own events, for the
 * message the phone sent to reach its saved state, then answers with the last turn the phone reads.
 */
export function phoneTalkControls(
  core: Core,
  writes: readonly { channel: string; actor: unknown; args: unknown[] }[],
  until: (predicate: () => boolean) => Promise<void>,
  observe: (observation: unknown) => void,
) {
  const asks = () => core.services.tasks.capture.listAsks();
  const lastTurn = () => core.dispatch("inf:conversation:last-turn", []);
  return {
    /** The harbour ask's turn ended on the computer. */
    async sent() {
      await until(() =>
        asks().some((ask) => ask.text.includes(ANSWER_PROMPT_MARKER) && ask.turnState !== "open"),
      );
      const result = { writes, lastTurn: await lastTurn(), asks: asks() };
      observe({ check: "captain-turn-from-phone", result });
      return result;
    },
    /** INF-6763's plan, part 3: the message with these words is saved, and taken back or not. */
    async ask(body: string) {
      const want = JSON.parse(body) as { text: string; takenBack: boolean };
      await until(() =>
        asks().some(
          (ask) => ask.text === want.text && (ask.takenBackAt !== undefined) === want.takenBack,
        ),
      );
      return { writes, lastTurn: await lastTurn() };
    },
  };
}
