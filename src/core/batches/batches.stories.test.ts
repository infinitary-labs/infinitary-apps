import type { BatchChange } from "@shared/batches";
import { describe, expect, it } from "vitest";
import {
  APP_ACCOUNT,
  id,
  REPO,
  type StandInComment,
  type StandInPull,
  setup,
} from "../../../tests/helpers/batchesHarness";
import { BATCH_STORIES_MARKER, presentationBodyLimit } from "../forge";
import { BATCH_WORDS } from "./batches";
import { BATCH_DESCRIPTION_WORDS } from "./description";

// Intent: a bug being fixed, in the words of its task: "Batch pull requests open with complete,
// accessible change information when their combined stories exceed the host's description
// limit." GitHub refused a batch of 20 changes on every pass ("body is too long (maximum is
// 65536 characters)"), because its description carried every change's story. The stand-in
// host refuses a description or a comment past GitHub's limit as GitHub does
// (`batchesHarness.ts`).

/** The lengths, in characters, of the stories in this project's own recent batch pull requests. */
const STORY_LENGTHS = [
  2764, 3824, 3015, 3325, 2419, 3838, 4736, 4412, 5109, 3184, 3623, 2121, 2705, 2685,
];

/** As many approved changes as the batch GitHub refused, each with a story of a real length. */
const CHANGES: BatchChange[] = Array.from({ length: 20 }, (_, index) => ({
  taskId: `t-change-${index + 1}`,
  branch: `inf/change-${index + 1}`,
  head: id(`change ${index + 1}`),
  title: `fix(meter): read the meter's dial ${index + 1} as it shows`,
  body: `- Dial ${index + 1} reads as the meter shows it.`,
  at: 1_000 + index,
}));

function approvedBatch(changes: readonly BatchChange[] = CHANGES) {
  const home = setup();
  for (const [index, change] of changes.entries()) {
    home.storyLengths.set(change.taskId, STORY_LENGTHS[index % STORY_LENGTHS.length] as number);
    home.approve(change);
  }
  return home;
}

const storyComments = (comments: readonly StandInComment[] = []) =>
  comments.filter(
    (comment) => comment.author === APP_ACCOUNT && comment.body.startsWith(BATCH_STORIES_MARKER),
  );

/** The changes whose story the pull request carries, in reading order: its description, then those comments. */
const storiesRead = (pull: StandInPull, comments: readonly StandInComment[] = []) =>
  [
    ...[pull.body, ...storyComments(comments).map((comment) => comment.body)]
      .join("\n")
      .matchAll(/<!-- story of (t-[\w-]+) -->/g),
  ].map((match) => match[1]);

describe("a batch whose stories pass the host's description limit", () => {
  it("opens with every change listed and each story whole and once, in order, the ones past the description in the app's own comments", async () => {
    const home = approvedBatch();
    await home.pass();

    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.body).toContain(CHANGES.map((change) => `- ${change.title}`).join("\n"));
    const comments = home.host.comments.get(31) ?? [];
    expect(storyComments(comments)).toEqual(comments);
    expect(storiesRead(pull, comments)).toEqual(CHANGES.map((change) => change.taskId));
    const reading = [pull.body, ...comments.map((comment) => comment.body)].join("\n");
    for (const change of CHANGES) expect(reading).toContain(home.storyOf(change).region);
    const following = storiesRead({ ...pull, body: "" }, comments).length;
    expect(following).toBeGreaterThan(0);
    expect(pull.body).toContain(BATCH_DESCRIPTION_WORDS.continued(following));
    expect(home.heard.notes).toEqual([BATCH_WORDS.formed("meter", "#31", CHANGES.length)]);

    // The app starts again: it reads its comments where the project lives and writes nothing.
    const kept = structuredClone(comments);
    await home.restart();
    await home.pass();
    expect(home.host.comments.get(31)).toEqual(kept);
    expect(home.host.rewrites).toEqual([]);
    expect(home.heard.notes).toHaveLength(1);
  });

  it("keeps its comments in step as the batch changes, and leaves a person's comments alone", async () => {
    const home = approvedBatch();
    await home.pass();
    home.host.comment(31, "maintainer", "Looks good to me once the checks pass.");
    const pull = home.host.pulls.get(31) as StandInPull;

    // The first change leaves: every story moves up, and the stories still pass the limit.
    await home.batches.withdraw(REPO, CHANGES[0]?.taskId as string);
    await home.pass();
    expect(storiesRead(pull, home.host.comments.get(31))).toEqual(
      CHANGES.slice(1).map((change) => change.taskId),
    );
    expect(storyComments(home.host.comments.get(31)).length).toBeGreaterThan(0);

    // Two more leave: every story fits in the description, so no comment of the app's is left.
    await home.batches.withdraw(REPO, CHANGES[1]?.taskId as string);
    await home.batches.withdraw(REPO, CHANGES[2]?.taskId as string);
    await home.pass();
    expect(storiesRead(pull, home.host.comments.get(31))).toEqual(
      CHANGES.slice(3).map((change) => change.taskId),
    );
    expect(home.host.comments.get(31)).toEqual([
      expect.objectContaining({
        author: "maintainer",
        body: "Looks good to me once the checks pass.",
      }),
    ]);
    expect(pull.body).not.toContain(BATCH_DESCRIPTION_WORDS.continued(1));
  });

  it("posts a comment once when the host kept it but its answer was lost", async () => {
    const home = approvedBatch();
    home.host.loseNextComment = true;
    await home.pass();
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(storiesRead(pull, home.host.comments.get(31))).toEqual(
      CHANGES.map((change) => change.taskId),
    );
  });

  it("names a story too long for a comment of its own as missing, once, and never cuts it", async () => {
    const changes = CHANGES.slice(0, 3);
    const home = approvedBatch(changes);
    const [first, longest, last] = changes as [BatchChange, BatchChange, BatchChange];
    // A story as long as GitHub keeps in a description, as the change's own pull request would carry it.
    home.storyLengths.set(longest.taskId, presentationBodyLimit("github.com") - 100);
    await home.pass();
    await home.pass();

    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.body).toContain(changes.map((change) => `- ${change.title}`).join("\n"));
    expect(storiesRead(pull, home.host.comments.get(31))).toEqual([first.taskId, last.taskId]);
    expect(home.heard.notes).toEqual([
      BATCH_WORDS.formed("meter", "#31", 3),
      BATCH_WORDS.noStory("meter", "#31", [longest.title]),
    ]);
  });
});
