import type { InvokeRequest } from "@shared/ipc";
import { type MessageFile, withPastedFiles } from "./overflow";

/** The view's actual new input, before attachment decoration; internal replays do not use this boundary. */
export function prepareComposerTurn(turn: InvokeRequest<"inf:converse">[0]) {
  const input: Exclude<typeof turn, string> = typeof turn === "string" ? { text: turn } : turn;
  const messageFiles: MessageFile[] = [];
  return {
    ...input,
    text: withPastedFiles(input.text ?? "", input.files, messageFiles),
    captainText: (input.text ?? "").trim(),
    messageFiles,
  };
}
