import type { ScriptedArgs, ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";
import { latestContext, sinceLastUser } from "../providerRequest";

export const WORKFLOW_DISPATCH_MARKER = "request the project verification workflow";

export const WORKFLOW_EVIDENCE_MARKER = "inspect the hosted measurement evidence";

/**
 * locate_project's listing from the app's own sign-in (PR 1.2): a Firstmate
 * turn carrying this marker calls locate_project with the name that
 * follows it, then lands one note listing what the tool answered from
 * where the projects live.
 */
export const LOCATE_PROJECTS_PROMPT_MARKER = "which of my projects is ";

export const MOCK_LOCATED_CARD_TITLE = "Your projects where they live";

/**
 * The context's `lives` fact (git integration PR 1.3): a Firstmate turn
 * carrying this marker lands one note listing each project's `lives` as the
 * served context block carried it - what the model was told, decoded from
 * the request itself.
 */
export const PROJECT_LIVES_PROMPT_MARKER = "say where each of my projects lives";

export const MOCK_PROJECT_LIVES_CARD_TITLE = "Where each project lives";

/**
 * A project on GitHub through the app's own sign-in: the first mate says
 * where each project lives and locates one by name, and a crewmate requests
 * the verification workflow and inspects its hosted evidence.
 */
export const forgeSignin: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate && wantsStream) {
      if (latestUserTail.includes(PROJECT_LIVES_PROMPT_MARKER)) {
        if (hasToolResults) {
          return { text: "done" };
        }
        const lives = (latestContext(body)?.repos ?? []).map(
          (repo) => `<li>${repo.name}: ${repo.lives ?? "?"}</li>`,
        );
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: MOCK_PROJECT_LIVES_CARD_TITLE,
                body: `<p>Where each project lives.</p><ul>${lives.join("")}</ul>`,
              },
            },
          ],
        };
      }
    }
    if (isFirstmate && wantsStream) {
      if (latestUserTail.includes(LOCATE_PROJECTS_PROMPT_MARKER)) {
        if (!hasToolResults) {
          const name = latestUserTail
            .match(/which of my projects is ([\w.-]+)/)?.[1]
            ?.trim() as string;
          return { calls: [{ name: "locate_project", args: { name } }] };
        }
        if (latestUserTail.includes(MOCK_LOCATED_CARD_TITLE)) {
          return { text: "done" };
        }
        // Only what the tool answered: the lines naming a project there.
        const listed = [
          ...latestUserTail.matchAll(/- ([\w.-]+\/[\w.-]+) [^|]*\| (?:private \| )?clone origin/g),
        ].map((match) => match[1] as string);
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: MOCK_LOCATED_CARD_TITLE,
                body:
                  listed.length > 0
                    ? `<p>These are your projects where they live.</p><ul>${listed.map((name) => `<li>${name}</li>`).join("")}</ul>`
                    : "<p>No projects were listed where they live.</p>",
              },
            },
          ],
        };
      }
    }
    if (!isFirstmate && latestUserTail.includes(WORKFLOW_DISPATCH_MARKER) && wantsStream) {
      const { results } = sinceLastUser(body);
      const call = <N extends ScriptedCall["name"]>(name: N, args: ScriptedArgs<N>) => ({
        calls: [{ name, args } as ScriptedCall],
      });
      const project = "/repos/octo/meterlab";
      const runs = `${project}/actions/runs?branch=main&event=workflow_dispatch`;
      if (!results.length) {
        return call("github_write", { method: "POST", path: "/user/keys", body: "{}" });
      }
      if (results.length === 1) {
        return call("github_write", {
          method: "POST",
          path: `${project}/actions/workflows/verify.yml/dispatches`,
          body: JSON.stringify({ ref: "main", inputs: { profile: "alpha", perf: true } }),
        });
      }
      const blocked = results[1]?.includes("Cannot call GitHub");
      if (results.length === 2 && !blocked) {
        return call("github_read", { path: runs });
      }
      if (results.length === 3 && !blocked) {
        const runId = JSON.parse(results[2] ?? "{}").body?.workflow_runs?.[0]?.id;
        return call("github_write", {
          method: "POST",
          path: `${project}/actions/runs/${runId}/cancel`,
        });
      }
      if (results.length === 4 && !blocked) {
        return call("github_read", { path: runs });
      }
      if (results.length === (blocked ? 2 : 5)) {
        return call("report", {
          text: `Account-level refusal: ${results[0]}\nDispatch: ${results[1]}\nRuns: ${results[2] ?? "not read"}\nCancellation: ${results[3] ?? "not requested"}\nFinal runs: ${results[4] ?? "not read"}`,
          summary: blocked
            ? "Workflow operations need the app's GitHub sign-in."
            : "The project workflow accepted its ref and inputs, then cancellation.",
        });
      }
      return { text: "Workflow operations reported." };
    }
    if (!isFirstmate && latestUserTail.includes(WORKFLOW_EVIDENCE_MARKER) && wantsStream) {
      const { results } = sinceLastUser(body);
      const call = <N extends ScriptedCall["name"]>(name: N, args: ScriptedArgs<N>) => ({
        calls: [{ name, args } as ScriptedCall],
      });
      // The project the forge-signin stand-in serves; github_read lists
      // the version's runs, the failed attempt's jobs and the artifacts,
      // read_workflow pages the job log and download_artifact saves the ZIP.
      const project = "/repos/octo/meterlab";
      if (!results.length) {
        return call("bash", { command: "git rev-parse HEAD" });
      }
      const blocked = results.findIndex(
        (result) =>
          result.includes("Cannot call GitHub") || result.includes("Cannot read workflow evidence"),
      );
      if (blocked >= 0) {
        if (blocked === results.length - 1)
          return call("report", {
            text: `Evidence blocked: ${results[blocked]}`,
            summary: "Workflow evidence needs the app's GitHub sign-in.",
          });
        return { text: "Evidence blocker reported." };
      }
      const headSha = results[0]?.match(/[0-9a-f]{40}/)?.[0] ?? "";
      if (results.length === 1) {
        return call("github_read", { path: `${project}/actions/runs?head_sha=${headSha}` });
      }
      const run = JSON.parse(results[1] ?? "{}").body?.workflow_runs?.[0];
      const runId = run?.id;
      if (results.length === 2) {
        return call("github_read", {
          path: `${project}/actions/runs/${runId}/attempts/${run?.run_attempt}/jobs`,
        });
      }
      if (results.length === 3) {
        return call("github_read", { path: `${project}/actions/runs/${runId}/artifacts` });
      }
      const jobId = JSON.parse(results[2] ?? "{}").body?.jobs?.[0]?.id;
      const artifactId = JSON.parse(results[3] ?? "{}").body?.artifacts?.[0]?.id;
      if (results.length === 4) {
        return call("read_workflow", { runId, jobId, offset: 2, limit: 2 });
      }
      if (results.length === 5) {
        return call("download_artifact", { runId, artifactId });
      }
      const receipt = JSON.parse(results[5] ?? "{}");
      if (results.length === 6) {
        return call("bash", { command: `unzip -p '${receipt.path}' measurement.json` });
      }
      if (results.length === 7) {
        return call("report", {
          text: `Workflow evidence returned.\nRuns: ${results[1]}\nJobs: ${results[2]}\nArtifacts: ${results[3]}\nJob log: ${results[4]}\nArtifact receipt: ${results[5]}\nMeasurement contents: ${results[6]}`,
          summary:
            "The failed job log and measurement artifact are available through the app's sign-in.",
        });
      }
      return { text: "Evidence returned." };
    }
    return undefined;
  };
