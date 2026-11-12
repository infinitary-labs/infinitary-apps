import { expect, it } from "vitest";
import { commitEnvelope, NAMING_DECISION } from "../src/core/queue/shipped/message.mjs";
import { passed, QUEUE } from "../src/core/queue/shipped/rules.mjs";
import { GITHUB_STUB_KEY, startGitHubStub } from "./e2e/githubStub";
import { GITLAB_STUB_KEY, GITLAB_STUB_PROJECT, startGitLabStub } from "./e2e/gitlabStub";
import { mergePassedFixture } from "./e2e/queueMergeDriver";

// Accepted current-queue fork journey: its driver must reach the host's real HTTP resources.
it.each(["github", "gitlab"] as const)(
  "runs the %s shipped merge job through the isolated HTTP fixture",
  async (kind) => {
    const head = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
    const title = "Review the meter";
    const requestTitle = "Fix typo";
    const summary = "Keep the meter reading.";
    const github = kind === "github" ? await startGitHubStub() : undefined;
    const gitlab = kind === "gitlab" ? await startGitLabStub("gitlab.com") : undefined;
    const stub = github ?? gitlab;
    if (!stub) throw new Error("The queue needs its host fixture");
    try {
      stub.headOf(() => head);
      const project = github ? "octo/meterlab" : GITLAB_STUB_PROJECT;
      let number = 151;
      if (github)
        github.serveNumbered({
          number,
          branch: "contribution",
          title: requestTitle,
          body: summary,
          headSha: head,
          headRepo: "contributor/meterlab",
          headRepoId: 99,
        });
      if (gitlab)
        number = gitlab.openMergeRequest({
          branch: "contribution",
          title: requestTitle,
          description: summary,
          sourceProjectId: 99,
        });
      const path = github
        ? `/repos/${project}/issues/${number}/comments`
        : `/projects/${encodeURIComponent(project)}/merge_requests/${number}/notes`;
      const response = await fetch(`${stub.url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${github ? GITHUB_STUB_KEY : GITLAB_STUB_KEY}`,
        },
        body: JSON.stringify({
          body: `Approved for the batch queue at this version.\n\n<!-- infinitary-merge-approval -->\n${commitEnvelope(head, summary, title, { naming: NAMING_DECISION.off, requestTitle })}`,
        }),
      });
      expect(response.ok).toBe(true);
      if (github)
        github.setStatus(head, { context: QUEUE, state: "success", description: passed(1, head) });
      if (gitlab)
        gitlab.setStatus(head, { name: QUEUE, status: "success", description: passed(1, head) });
      await mergePassedFixture({ kind, url: stub.url, project, base: head });
      expect(stub.requestText(number)).toEqual({ title: requestTitle, description: summary });
      if (github)
        expect(github.merges()).toEqual([
          { number, sha: head, method: "squash", title, message: summary },
        ]);
      if (gitlab)
        expect(gitlab.merges()).toEqual([
          { iid: number, sha: head, squash: true, message: `${title}\n\n${summary}` },
        ]);
    } finally {
      await stub.close();
    }
  },
);
