/**
 * A task whose story is saved and published on its pull request, delivered
 * through the app's change delivery over a fake forge (prCiHarness): the
 * arrangement changePublication.stories.test.ts and
 * changePublication.mergedStory.test.ts share. The task's project is a real
 * git repository, so a file that uses it is an integration test
 * (docs/test-cohorts.md).
 */
import { createHash } from "node:crypto";
import type { ChangePresentation } from "@shared/changePresentation";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { vi } from "vitest";
import {
  type ForgeChange,
  presentationContentHash,
  presentationMarkdown,
} from "../../src/core/forge";
import { type CheckedOut, FakeForge, insertDirectPrTask, recordPr, setup } from "./prCiHarness";

export const original = "5ca2d466ee21f9733827383f23df81f3874e0d10";
export const repaired = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
// The one story `saved` saves, as a crewmate prepares it.
export function storyFixture(): ChangePresentation {
  return {
    version: 1,
    taskId: "ab12cd34",
    revision: 1,
    title: "One saved story",
    base: original,
    head: original,
    destination: {
      host: "github.com",
      projectId: 1422452335,
      fullName: "kunchenguid/infinitary-evidence-test-public",
      visibility: "public",
    },
    why: ["Keep the approved explanation."],
    whatChanged: ["The publication recovers."],
    before: ["Recovery could wait forever."],
    after: ["Recovery is deliberate."],
    noPicture: "This fixture changes publication recovery, not a screen.",
    views: [],
    assets: [],
    pictures: [],
    verification: ["Read the saved publication."],
    risk: Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [
        dimension,
        { level: "low", why: "A harmless delivery fixture." },
      ]),
    ) as RiskDeclaration,
    requiredActions: [],
    unfinished: [],
    projectText: "",
  };
}
/** The task with that story published on its open pull request #23, its work computer asleep. */
export async function saved(
  kind: "github" | "gitlab" = "github",
  checkedOut?: CheckedOut,
  prepareContribution?: (taskId: string) => Promise<string | undefined>,
) {
  const bringBranchHome = vi.fn(async (): Promise<string> => {
    throw new Error("Work computer is asleep");
  });
  const at = setup({
    bringBranchHome,
    ...(checkedOut ? { checkedOut } : {}),
    ...(prepareContribution ? { prepareContribution } : {}),
    ...(kind === "gitlab" ? { forge: new FakeForge({ kind, place: "GitLab" }) } : {}),
  });
  await insertDirectPrTask(at.tasks, at.repos, { deviceId: "sleeping-work-computer" });
  const story = storyFixture();
  const region = presentationMarkdown(story, new Map(), "passed");
  const published = {
    revision: 1,
    head: original,
    state: "confirmed" as const,
    region,
    regionHash: createHash("sha256").update(region).digest("hex"),
    contentHash: presentationContentHash(story),
    number: 23,
  };
  at.tasks.delivery.updateChangePresentation("ab12cd34", () => ({
    revisions: [story],
    receipts: [],
    publication: published,
    published,
  }));
  at.forge.change = { ...(at.forge.change as ForgeChange), headSha: original, body: region };
  const update = vi.fn(async (_change: ForgeChange, body: string, title?: string) => {
    at.forge.change = {
      ...(at.forge.change as ForgeChange),
      body,
      ...(title === undefined ? {} : { title }),
    };
  });
  Object.assign(at.forge, {
    attachments: {
      destination: async () => story.destination,
      upload: async () => {
        throw new Error("No upload expected");
      },
    },
    branchHead: async () => at.forge.change?.headSha ?? "",
    updateChangeBody: update,
    pull: async () => ({
      number: 23,
      state: "open",
      merged: false,
      headSha: at.forge.change?.headSha,
      base: "main",
      readiness: "clean",
    }),
  });
  recordPr(at.tasks, 23);
  return { ...at, bringBranchHome, update, story };
}

// INF-3717 piece 1, from INF-3472's night: the task's own pull request had
// merged and the crewmate delivered from another branch it checked out.
export const phone = "fm/task-212a7809-phone";
export async function deliveringFromAnotherBranch() {
  // The working copy's checkout, which a later commit moves.
  const checkedOut = { branch: phone, head: original };
  const at = await saved("github", async () => ({ ...checkedOut }));
  // The project's origin names where its pull requests are selected.
  const repoId = at.tasks.get("ab12cd34")?.repoId as string;
  at.repos.configure(repoId, { origin: "https://github.com/x/y.git" });
  const story = at.tasks.delivery.changePresentation("ab12cd34")
    ?.revisions[0] as ChangePresentation;
  at.bringBranchHome.mockResolvedValue("");
  at.readHead.mockResolvedValue(original);
  // The own pull request merged: the host holds only what was opened since.
  at.forge.change = null;
  Object.assign(at.forge, {
    branchHead: async () => original,
    changeFor: async (branch: string) => {
      at.forge.calls.push(`changeFor ${branch}`);
      const change = at.forge.change;
      return change && change.branch === branch ? { ...change } : null;
    },
    openChange: async (input: { branch: string; title: string; body: string }) => {
      at.forge.calls.push(`openChange ${input.branch} ${input.title}`);
      at.forge.change = {
        ...at.forge.opened,
        number: 1413,
        url: "https://github.com/x/y/pull/1413",
        branch: input.branch,
        title: input.title,
        body: input.body,
        headSha: original,
      };
      return at.forge.change;
    },
  });
  return { at, story, checkedOut };
}

/** How many pull requests the fake forge was asked to open. */
export const opens = (at: { forge: FakeForge }) =>
  at.forge.calls.filter((call) => call.startsWith("openChange")).length;
