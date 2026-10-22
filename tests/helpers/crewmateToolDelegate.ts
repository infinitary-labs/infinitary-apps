import type { CrewmateToolDelegate } from "../../src/core/session/tools";

/**
 * A crewmate's callbacks with every one present, so the whole crewmate tool
 * set binds. Each answers a fixed line naming itself, which is what a test
 * of the generated tools reads back; `calls` records what reached the host.
 */
export function crewmateToolDelegate(): Required<
  Omit<
    CrewmateToolDelegate,
    "picturesDir" | "evidenceDir" | "cardBodiesDir" | "probeMedia" | "probeTypeface"
  >
> & {
  calls: { callback: string; input: unknown }[];
} {
  const calls: { callback: string; input: unknown }[] = [];
  const answer = (callback: string, text: string) => (input?: unknown) => {
    calls.push({ callback, input });
    return text;
  };
  return {
    calls,
    requestedSpeed: () => "standard",
    onSpeed: (model, selection) => {
      calls.push({ callback: "onSpeed", input: { model, selection } });
    },
    taskId: "task-1",
    cwd: "/nowhere",
    onCard: (card) => {
      calls.push({ callback: "onCard", input: card });
      return "card-task-1-1";
    },
    onCardRefused: (refusal) => {
      calls.push({ callback: "onCardRefused", input: refusal });
    },
    onCloseCard: answer("onCloseCard", "closed"),
    onFollowup: answer("onFollowup", "filed"),
    onProgress: answer("onProgress", "noted"),
    onReport: answer("onReport", "reported"),
    onReply: answer("onReply", "replied"),
    onQueryTasks: (input) => {
      calls.push({ callback: "onQueryTasks", input });
      return { rows: [], total: 0 };
    },
    onLintPanel: async (input) => answer("onLintPanel", "lint clean")(input),
    onPlacePanel: async (input) => {
      calls.push({ callback: "onPlacePanel", input });
      return { ok: true as const, waitedMs: 0, panels: [] };
    },
    onCapturePanel: async (input) => {
      calls.push({ callback: "onCapturePanel", input });
      return {
        ok: true as const,
        id: input.id,
        photographed: "docked" as const,
        images: [
          {
            theme: "dark" as const,
            width: 2,
            height: 2,
            path: "/nowhere/dark.png",
            data: "AAAA",
            mimeType: "image/png",
          },
        ],
      };
    },
    onReadWorkflow: async (input) => answer("onReadWorkflow", "workflow evidence")(input),
    onDownloadArtifact: async (input) => answer("onDownloadArtifact", "artifact downloaded")(input),
    onGithubRead: async (input) => answer("onGithubRead", "github answered")(input),
    onGithubWrite: async (input) => answer("onGithubWrite", "github changed")(input),
    onPrepareChange: async (input) => answer("onPrepareChange", "story prepared")(input),
    onOpenChange: async (input) => answer("onOpenChange", "change opened")(input),
    onCheckChange: async () => answer("onCheckChange", "overall: green")(),
    browser: {
      navigate: async (input) => ({ text: answer("browser.navigate", "page opened")(input) }),
      inspect: async (input) => ({ text: answer("browser.inspect", "page read")(input) }),
      act: async (input) => ({ text: answer("browser.act", "page used")(input) }),
      capture: async (input) => {
        calls.push({ callback: "browser.capture", input });
        return { text: "page photographed", image: { data: "AAAA", mimeType: "image/png" } };
      },
      close: async () => ({ text: answer("browser.close", "browser stopped")() }),
      pages: async () => ({ text: answer("browser.pages", "one page")() }),
    },
    knowledge: {
      read: (input) => answer("knowledge.read", "knowledge read")(input),
      record: (input) => answer("knowledge.record", "knowledge recorded")(input),
    },
    integrations: {
      list: async () => {
        calls.push({ callback: "integrations.list", input: undefined });
        return [];
      },
      show: async (name) => ({ text: answer("integrations.show", "integration shown")(name) }),
      call: async (name, action, input) => ({
        text: answer("integrations.call", "integration called")({ name, action, input }),
      }),
    },
  };
}
