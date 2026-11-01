import type { ForgeSignInState } from "@shared/forges";
import { INTEGRATION_KIND_NAMES, INTEGRATIONS_SIGN_IN_HOST } from "@shared/integrations";
import { z } from "zod";
import type { GithubReadInput, GithubWriteInput } from "../../forge";
import type { IntegrationActionSpec, IntegrationBinding } from "../binding";
import { GITHUB_RUN_EVENTS, lookForRuns } from "./githubRuns";

/**
 * GitHub as an integration (docs/integrations.md, "GitHub"): the app's own
 * github.com sign-in, made and kept by the forge (`ForgeSignIns`,
 * `docs/forge.md`), seen through the integrations seam. Its actions are
 * the gateway's two calls through that sign-in, behind the integration's
 * per-action approval owner. Project delivery keeps the forge's rules.
 */

const GITHUB_ID = "github";

/** The gateway's calls through the github.com sign-in, whoever asks. */
export type GithubIntegrationGateway = {
  /** A task's read or write, through the github.com sign-in whatever its project is. */
  read: (taskId: string, input: GithubReadInput, through: "account") => Promise<string>;
  write: (taskId: string, input: GithubWriteInput, through: "account") => Promise<string>;
  /** The first mate's read: it has no task, so its calls count as the seat's own. */
  readAsSeat: (input: GithubReadInput) => Promise<string>;
  /**
   * The first mate's change, once the integration's approval let it run
   * (INF-1108): its calls count as the seat's own, under the same guards.
   */
  writeAsSeat: (input: GithubWriteInput) => Promise<string>;
  /**
   * An Automation rule's look at GitHub's events (`readForLook`), which
   * throws when it cannot read; without it the binding tells no events.
   */
  readForLook?: (input: GithubReadInput) => Promise<string>;
};

export type GithubIntegrationOptions = {
  signIns: {
    stateOf: (host: string) => ForgeSignInState | undefined;
    loginOf: (host: string) => string | null;
    checkNow: (host: string) => Promise<void>;
    signOut: (host: string) => void;
  };
  gateway: GithubIntegrationGateway;
  now?: () => number;
};

const pathSchema = z.string().min(1).max(2048);

const ACTIONS: readonly IntegrationActionSpec[] = [
  {
    name: "read",
    label: "Read from GitHub",
    effect: "reads",
    description:
      "GET or HEAD one path of GitHub's REST API through the captain's GitHub sign-in, such as /user/repos?sort=updated&per_page=100 or /search/issues?q=...; it reaches whatever that sign-in may read. JSON only, no GraphQL; the answer's nextPath reads the next page.",
    input: z.strictObject({ path: pathSchema, method: z.enum(["GET", "HEAD"]).optional() }),
  },
  {
    name: "write",
    label: "Change something on GitHub",
    effect: "changes",
    description:
      "POST, PATCH, PUT or DELETE one path through the captain's GitHub sign-in; body is JSON text. The integration approval rule decides when it runs. Merges and default-branch moves are refused; they use the merge card.",
    input: z.strictObject({
      method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
      path: pathSchema,
      body: z
        .string()
        .max(256 * 1024)
        .optional(),
    }),
  },
];

export function githubIntegration(
  options: GithubIntegrationOptions,
  target = {
    host: INTEGRATIONS_SIGN_IN_HOST,
    id: GITHUB_ID,
    name: INTEGRATION_KIND_NAMES.github,
    label: "GitHub",
  },
): IntegrationBinding {
  const { host, id, name, label } = target;
  const actions = ACTIONS.map((action) => ({
    ...action,
    label: action.label.replaceAll("GitHub", label),
    description:
      label === "GitLab"
        ? action.name === "read"
          ? "GET or HEAD one relative GitLab REST API path (the part after /api/v4), such as /projects?membership=true or /user. JSON only; nextPath reads the next page."
          : "POST, PATCH, PUT or DELETE one relative GitLab REST API path, with body as JSON text. The integration approval rule decides when it runs. Merges and default-branch moves require the merge card."
        : action.description.replaceAll("GitHub", label),
  }));
  // GitHub's own runs API: GitLab's pipelines are not these events.
  const readForLook = label === "GitLab" ? undefined : options.gateway.readForLook;
  return {
    kind: "github",
    identity: { id, name },
    connections: () => {
      const health = options.signIns.stateOf(host);
      if (health === undefined) return [];
      return [
        {
          id,
          account: options.signIns.loginOf(host),
          health,
          actions,
          ...(readForLook ? { events: GITHUB_RUN_EVENTS } : {}),
        },
      ];
    },
    ...(readForLook
      ? {
          look: (
            _id: string,
            event: string,
            cursor: string | null,
            filter?: Record<string, string>,
          ) => lookForRuns(readForLook, event, cursor, filter, (options.now ?? Date.now)()),
        }
      : {}),
    check: () => options.signIns.checkNow(host),
    remove: () => options.signIns.signOut(host),
    call: async (_id, action, input, caller) => {
      if (action === "read") {
        const read = input as GithubReadInput;
        return {
          text:
            caller.kind === "task"
              ? await options.gateway.read(caller.taskId, read, "account")
              : await options.gateway.readAsSeat(read),
        };
      }
      return {
        text:
          caller.kind === "task"
            ? await options.gateway.write(caller.taskId, input as GithubWriteInput, "account")
            : await options.gateway.writeAsSeat(input as GithubWriteInput),
      };
    },
  };
}
