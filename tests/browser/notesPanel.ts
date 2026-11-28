import type { PersonalExtensionView } from "@shared/personal/manifest";
import { type FakeBridge, fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";

/**
 * A window with one panel of the captain's own, Notes, whose mount the test
 * answers; every other mount is the fresh home's.
 */

const NOTES: PersonalExtensionView = {
  id: "notes",
  source: "yours",
  by: null,
  title: "Notes",
  placement: { x: "left", y: "top" },
  order: 0,
  size: "content",
  present: true,
  ownPresence: false,
  moves: false,
  running: false,
  reads: [],
  sql: [],
  panel: null,
  frame: { version: "0123456789abcdef" },
  server: null,
  cardViews: [],
  cards: {},
  header: [],
  commands: [],
  error: null,
};

export const notesFailedText = () =>
  document.querySelector<HTMLElement>("[data-frame-mount-failed]")?.textContent ?? "";

export function notesWindow(answerNotes: () => unknown): FakeBridge {
  const home = subscribed(freshHome());
  const mountAnswer = home["inf:frames:mount"];
  if (typeof mountAnswer !== "function") throw new Error("the fresh home answers every mount");
  const bridge = fakeBridge({ ...home, "inf:plugins:personal:list": { extensions: [NOTES] } });
  bridge.answer("inf:frames:mount", (request) => {
    if (request.kind === "panel" && request.panel.source !== "builtin") {
      return answerNotes() as ReturnType<typeof mountAnswer>;
    }
    return mountAnswer(request);
  });
  return bridge;
}

/** Words the transport and the main process carried, which a panel's place never shows. */
export const RAW_MOUNT_WORDS = [
  "inf:frames:mount",
  "PanelMountError",
  "Error invoking remote method",
];
