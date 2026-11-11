/** The project's push filters, applied to the queue's explicit after-merge event too. */
export function relevantFiles(workflow, files) {
  if (workflow === "main")
    return files.some(
      (file) =>
        file === "docs/contract.json" ||
        !["ios/", "docs/", "primitives/", "release-notes/changes/"].some((prefix) =>
          file.startsWith(prefix),
        ),
    );
  const exact =
    workflow === "prompt-budget"
      ? [
          "scripts/prompt-budget.ts",
          "tests/helpers/promptBudget.ts",
          "tests/crewmate-fixed-context.test.ts",
          "tests/firstmate-fixed-context.test.ts",
          ".github/workflows/prompt-budget.yml",
        ]
      : [
          ".github/workflows/republish-casks.yml",
          "packaging/alpha-notice.txt",
          "scripts/publish-tap.sh",
          "scripts/tap-publication.ts",
          "src/core/update/tapPublication.ts",
          "src/core/update/macInstallation.ts",
          "packaging/mac-installation.json",
          "src/core/update/updateChannels.ts",
          "src/shared/userDataFolders.ts",
        ];
  return files.some(
    (file) =>
      exact.includes(file) ||
      (workflow === "prompt-budget" &&
        (file.startsWith("src/") || file.startsWith("resources/runbooks/"))),
  );
}

/** Stable workflow step whose successful completion witnesses that the run read its source. */
export const PATH_READING_STEP = "Select changed paths";

/** Pending or cancelled runs cannot cover a newer signal: GitHub may have replaced them. */
async function lastReadSource(github, context, workflow) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: `${workflow}.yml`,
    branch: "main",
    status: "completed",
    per_page: 100,
  });
  if (!Array.isArray(data.workflow_runs)) return undefined;
  for (const run of data.workflow_runs) {
    if (
      run.id === context.runId ||
      run.status !== "completed" ||
      ["cancelled", "skipped"].includes(run.conclusion)
    ) continue;
    if (!/^[0-9a-f]{40,64}$/.test(run.head_sha ?? "")) return undefined;
    const { jobs } = (await github.rest.actions.listJobsForWorkflowRun({
      ...context.repo,
      run_id: run.id,
      filter: "latest",
      per_page: 100,
    })).data;
    if (
      Array.isArray(jobs) && jobs.some((job) => job.steps?.some(
        (step) => step.name === PATH_READING_STEP && step.conclusion === "success",
      ))
    ) return run.head_sha;
    // A completed run that never read its source covers nothing; an older reading may still do so.
  }
  return undefined;
}

/** Compare all work since a completed source reading, not just the newest batch's own diff. */
export async function afterMergeShouldRun(github, context, workflow) {
  if (context.eventName !== "repository_dispatch") return true;
  try {
    const base = await lastReadSource(github, context, workflow);
    if (!base) return true;
    const { data } = await github.rest.repos.compareCommits({
      ...context.repo,
      base,
      head: context.sha,
      per_page: 100,
    });
    // GitHub returns at most 300 files for a comparison, only on its first page.
    if (
      !Array.isArray(data.files) || data.files.length >= 300 ||
      !["ahead", "identical"].includes(data.status)
    ) return true;
    return relevantFiles(workflow, data.files.flatMap((file) => [
      file.filename,
      ...(file.previous_filename ? [file.previous_filename] : []),
    ]));
  } catch {
    return true;
  }
}
