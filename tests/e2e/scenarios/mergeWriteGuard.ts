import { API_WRITE_GUARD_MARKER, mergeWriteCases } from "../apiWriteCases";
import { GITLAB_STUB_PROJECT } from "../gitlabStub";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * The merge API guard: the crewmate tries each merge and default-branch
 * write on GitHub or GitLab, then one ordinary branch write, and reports
 * what the host refused and what it sent.
 */
export const mergeWriteGuard: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream || !latestUserTail.includes(API_WRITE_GUARD_MARKER))
      return undefined;
    const { results } = sinceLastUser(body);
    const gitlab = latestUserTail.includes("guard-gitlab");
    const project = gitlab
      ? `/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`
      : "/repos/octo/meterlab";
    const calls = mergeWriteCases(gitlab ? "gitlab" : "github", project);
    const next = calls[results.length];
    if (next) return { calls: [{ name: "github_write", args: next }] };
    if (results.length === calls.length) {
      return { calls: [{ name: "bash", args: { command: "git rev-parse HEAD" } }] };
    }
    if (results.length === calls.length + 1) {
      const sha = results.at(-1)?.match(/\b[0-9a-f]{40}\b/)?.[0];
      return {
        calls: [
          {
            name: "github_write",
            args: gitlab
              ? { method: "DELETE", path: `${project}/repository/branches/topic` }
              : {
                  method: "PATCH",
                  path: `${project}/git/refs/heads/topic`,
                  body: JSON.stringify({ sha, force: false }),
                },
          },
        ],
      };
    }
    if (results.length === calls.length + 2) {
      return {
        calls: [
          {
            name: "report",
            args: {
              text: results.join("\n"),
              summary:
                "Merge and default-branch writes were refused; another branch write reached the host.",
            },
          },
        ],
      };
    }
    return { text: "Merge API guard reported." };
  };
