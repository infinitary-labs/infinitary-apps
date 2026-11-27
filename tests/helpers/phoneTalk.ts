import type { Core } from "@core/index";
import { JUDGEABLE_DELIVERY } from "@core/orchestrator/answerDelivery";
import type { AskRecord } from "@core/storage/askStore";
import { ANSWER_PROMPT_MARKER } from "../e2e/mockProvider";

/** The captain's requests the talk parts read back from the test home as its writes. */
export const TALK_WRITES: readonly string[] = [
  "inf:converse",
  "inf:conversation:take-back",
  "inf:task:run",
  "inf:task:steer",
  "inf:task:interrupt",
];

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
    /**
     * INF-6763's plan, part 3: the message with these words is saved, and taken back or not. With `answered`, its
     * answer is also judged (docs/task-capture.md, "Answer delivery") and the notice it got, if any, is up as a card,
     * whose title the answer names: INF-7085's take-back step presses the message only once its own answer has landed.
     */
    async ask(body: string) {
      const want = JSON.parse(body) as { text: string; takenBack: boolean; answered?: boolean };
      const saved = () =>
        asks().find(
          (ask) => ask.text === want.text && (ask.takenBackAt !== undefined) === want.takenBack,
        );
      const notice = (ask: AskRecord | undefined) =>
        core.services.supervisor.cards.snapshot().find((card) => card.id === ask?.noticeCardId);
      const landed = (ask: AskRecord) =>
        !JUDGEABLE_DELIVERY.includes(ask.delivery) &&
        (ask.noticeCardId === null || notice(ask) !== undefined);
      await until(() => {
        const ask = saved();
        return ask !== undefined && (!want.answered || landed(ask));
      });
      return { writes, lastTurn: await lastTurn(), notice: notice(saved())?.title ?? null };
    },
  };
}
