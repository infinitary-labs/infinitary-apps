import type { ScriptedArgs, ScriptedCall } from "../../helpers/scriptedCalls";
import { GITLAB_STUB_OTHER_PROJECT, GITLAB_STUB_PROJECT } from "../gitlabStub";
import { type Scenario, sinceLastUser } from "../mockProvider";

/**
 * A project on GitLab (gitlab-evidence e2e): a brief carrying this marker
 * lists its version's pipelines and the failed one's jobs with
 * `github_read`, pages that job's log with `read_workflow`, saves its
 * artifacts archive with `download_artifact` and reads it, tries a write to
 * another project, and reports what each answered.
 */
export const GITLAB_EVIDENCE_MARKER = "inspect the GitLab pipeline evidence";

/**
 * The GitLab crewmate gathers its evidence where the project lives: the
 * pipeline for its version, its jobs, the failed job's log and archive, then
 * a write to another project the app holds back.
 */
export const gitlabEvidence: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (!isFirstmate && latestUserTail.includes(GITLAB_EVIDENCE_MARKER) && wantsStream) {
      const { results } = sinceLastUser(body);
      const call = <N extends ScriptedCall["name"]>(name: N, args: ScriptedArgs<N>) => ({
        calls: [{ name, args } as ScriptedCall],
      });
      // The GitLab stand-in's project, by its URL-encoded path.
      const project = `/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`;
      if (!results.length) {
        return call("bash", { command: "git rev-parse HEAD" });
      }
      const last = results[results.length - 1] ?? "";
      if (
        results.length <= 5 &&
        (last.includes("Cannot call") || last.includes("Cannot read workflow evidence"))
      ) {
        return call("report", {
          text: `Evidence blocked: ${last}`,
          summary: "GitLab pipeline evidence could not be read.",
        });
      }
      const headSha = results[0]?.match(/[0-9a-f]{40}/)?.[0] ?? "";
      if (results.length === 1) {
        return call("github_read", { path: `${project}/pipelines?sha=${headSha}` });
      }
      const runId = JSON.parse(results[1] ?? "{}").body?.[0]?.id;
      if (results.length === 2) {
        return call("github_read", { path: `${project}/pipelines/${runId}/jobs` });
      }
      const jobId =
        (JSON.parse(results[2] ?? "{}").body as { id: number; status: string }[] | undefined)?.find(
          (job) => job.status === "failed",
        )?.id ?? 0;
      if (results.length === 3) {
        return call("read_workflow", { runId, jobId, offset: 1, limit: 5 });
      }
      if (results.length === 4) {
        return call("download_artifact", { runId, artifactId: jobId });
      }
      if (results.length === 5) {
        const receipt = JSON.parse(results[4] ?? "{}");
        return call("bash", { command: `unzip -p '${receipt.path}' measurement.json` });
      }
      if (results.length === 6) {
        return call("github_write", {
          method: "POST",
          path: `/projects/${encodeURIComponent(GITLAB_STUB_OTHER_PROJECT)}/issues`,
          body: '{"title":"not this task\'s project"}',
        });
      }
      if (results.length === 7) {
        return call("report", {
          text: `GitLab pipeline evidence returned.\nPipelines: ${results[1]}\nJobs: ${results[2]}\nJob log: ${results[3]}\nArchive receipt: ${results[4]}\nMeasurement contents: ${results[5]}\nWrite to another project: ${results[6]}`,
          summary: "The failed job's log and archive are available through the app's GitLab key.",
        });
      }
      return { text: "Evidence returned." };
    }
    return undefined;
  };
