import type { ChangePresentationDraft } from "@shared/changePresentation";
import type { ScriptedArgs, ScriptedCall } from "../../helpers/scriptedCalls";
import { MOCK_RISK } from "../mockProvider";

/**
 * INF-132: a scripted github.com or gitlab.com author prepares the same typed
 * story as a real crewmate. The change scenarios share it, and each reads
 * back the revision the app saved (`preparedRevision`).
 */
export const MOCK_GITHUB_STORY: Omit<
  ChangePresentationDraft,
  "title" | "base" | "head" | "publishable"
> & { projectText: string } = {
  why: ["The meter should read on time."],
  whatChanged: ["The meter reads on time."],
  before: ["The meter reading lagged."],
  after: ["The meter reads on time."],
  checked: [{ check: "Publication", result: "The selected story and evidence agree." }],
  verification: ["Checked the committed meter change."],
  views: [],
  noPicture: "This disposable git change has no visible interface.",
  risk: MOCK_RISK,
  requiredActions: [],
  unfinished: [],
  projectText: "",
};

/** The story a scripted author passes, at the two versions its git reading printed. */
export function mockStory(
  title: string,
  gitReading: string | undefined,
  content = MOCK_GITHUB_STORY,
): ScriptedArgs<"prepare_change">["story"] {
  const versions = gitReading?.match(/\b[0-9a-f]{40}\b/g) ?? [];
  return {
    ...content,
    title,
    base: versions.at(-2) ?? "",
    head: versions.at(-1) ?? "",
    publishable: true,
  };
}

export function prepareMockStory(
  title: string,
  gitReading: string | undefined,
  content = MOCK_GITHUB_STORY,
): ScriptedCall {
  return { name: "prepare_change", args: { story: mockStory(title, gitReading, content) } };
}

export function preparedRevision(reading: string): number {
  return Number([...reading.matchAll(/Prepared presentation (\d+) for/g)].at(-1)?.[1] ?? 0);
}
