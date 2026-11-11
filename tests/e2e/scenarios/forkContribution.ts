import { resolve } from "node:path";
import type { Scenario } from "../mockProvider";
import { isTaskRequest, sinceLastUser } from "../providerRequest";

export const CONTRIBUTION_TASK = "contribute through sample-project fork";
export const CONTRIBUTION_TITLE = "docs: update the contribution example";
export const READ_CONTRIBUTION_STATUS = "read the maintainers' latest status";
const low = { level: "low" as const, why: "A disposable example with no external dependencies" };
const risk = {
  blast: low,
  behavior: low,
  undo: low,
  evidence: low,
  sensitivity: low,
  novelty: low,
  deps: low,
};

/** Approved D: a scripted contributor uses the real commit, publication, checks and card boundaries. */
export const forkContribution: Scenario = () => {
  let stage = 0;
  let head = "";
  let base = "";
  let revision = 0;
  return ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream || !isTaskRequest(body, CONTRIBUTION_TASK)) return undefined;
    const results = sinceLastUser(body).results;
    const last = results.at(-1) ?? "";
    if (stage >= 6 && latestUserTail.includes(READ_CONTRIBUTION_STATUS))
      return results.length === 0
        ? { calls: [{ name: "check_change", args: {} }] }
        : { text: "The host's confirmed outcome is shown on the contribution note." };
    switch (stage++) {
      case 0:
        return {
          calls: [
            {
              name: "bash",
              args: {
                command:
                  `cp ${JSON.stringify(resolve("tests/e2e/fixtures/contribution-picture.png"))} contribution-picture.png; ` +
                  "BASE=$(git rev-parse HEAD); printf 'A contribution from the fork.\\n' > README.md; git add README.md; git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm 'docs: update contribution example' && git push -q origin HEAD && printf 'BASE=%s\\nHEAD=%s\\n' \"$BASE\" \"$(git rev-parse HEAD)\"",
                description: "Commit and push the disposable contribution",
              },
            },
          ],
        };
      case 1: {
        base = last.match(/BASE=([a-f0-9]{40})/)?.[1] ?? "";
        head = last.match(/HEAD=([a-f0-9]{40})/)?.[1] ?? "";
        if (!base || !head)
          throw new Error(`The real contribution command did not return its commits: ${last}`);
        return {
          calls: [
            {
              name: "prepare_change",
              args: {
                story: {
                  title: CONTRIBUTION_TITLE,
                  base,
                  head,
                  publishable: true,
                  why: ["The example needs a contribution."],
                  whatChanged: ["Updated the disposable example."],
                  before: ["The example held its original text."],
                  after: ["The task branch holds the contribution."],
                  views: [
                    {
                      id: "contribution-picture",
                      caption: "Contribution picture",
                      kind: "new",
                      before: [],
                      after: [
                        {
                          path: "contribution-picture.png",
                          alt: "A cyan panel with a dark cross",
                          inspected: true,
                          captureHead: head,
                        },
                      ],
                    },
                  ],
                  checked: [
                    {
                      check: "Real task branch push",
                      result: "The fork accepted the contribution commit.",
                    },
                  ],
                  verification: ["The task committed the example and pushed its task branch."],
                  risk,
                  requiredActions: [],
                  unfinished: [],
                },
              },
            },
          ],
        };
      }
      case 2:
        revision = Number(last.match(/Prepared presentation (\d+)/)?.[1]);
        if (!revision) throw new Error(`The contribution story was not prepared: ${last}`);
        return {
          calls: [
            { name: "open_change", args: { title: CONTRIBUTION_TITLE, presentation: revision } },
          ],
        };
      case 3:
        if (!last.includes("waits for the original project's maintainers"))
          throw new Error(`The contribution did not open upstream: ${last}`);
        return { calls: [{ name: "check_change", args: {} }] };
      case 4:
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: CONTRIBUTION_TITLE,
                presentation: revision,
                actions: [{ id: "merge", effect: { kind: "merge", after: "close" } }],
              },
            },
          ],
        };
      case 5:
        if (!last.includes("maintainers"))
          throw new Error(`The host did not refuse a contributor merge: ${last}`);
        return {
          calls: [
            {
              name: "emit_card",
              args: { title: CONTRIBUTION_TITLE, presentation: revision, actions: [] },
            },
            {
              name: "report",
              args: {
                summary: "The contribution waits for its maintainers",
                text: "Intent\nContribute an example.\n\nWhat changed\nUpdated the disposable example.\n\nVerified\nCommitted and pushed its task branch, opened upstream, and read its checks.\n\nRisk\nLow: disposable example.\n\nNot done\nThe maintainers review and merge it.",
              },
            },
          ],
        };
      default:
        return { text: "The contribution follows its maintainers' review without a merge action." };
    }
  };
};
