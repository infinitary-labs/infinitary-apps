import { type SignInKind, serverFactsAt } from "@shared/forgeKinds";
import type { ForgeSignInState } from "@shared/forges";
import { INTEGRATION_KIND_NAMES, INTEGRATIONS_SIGN_IN_HOST } from "@shared/integrations";
import { z } from "zod";
import type { GithubReadInput, GithubWriteInput } from "../../forge";
import type { IntegrationActionSpec, IntegrationBinding } from "../binding";
import { forgeScope } from "../scopes";
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
   * A panel's read and change (docs/integrations.md, "Panels"): a panel is
   * no task and no seat, so its calls spend no allowance. Without them a
   * panel's call is refused.
   */
  readAsPanel?: (panel: string, input: GithubReadInput) => Promise<string>;
  writeAsPanel?: (panel: string, input: GithubWriteInput) => Promise<string>;
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

/**
 * Each kind's own REST API in the actions' words, and whether its runs are
 * the events an Automation rule looks at: GitHub's runs API, which GitLab's
 * pipelines are not, nor Bitbucket's (`docs/integrations.md`, "Bitbucket").
 */
const KIND_API: Record<
  SignInKind,
  {
    description: (action: IntegrationActionSpec, label: string) => string;
    runEvents: boolean;
  } | null
> = {
  github: {
    description: (action, label) => action.description.replaceAll("GitHub", label),
    runEvents: true,
  },
  gitlab: {
    description: (action) =>
      restDescription(action, "GitLab", "/api/v4", "/projects?membership=true"),
    runEvents: false,
  },
  bitbucket: {
    description: (action) =>
      // i18n-exempt: the product's name
      restDescription(action, "Bitbucket Cloud", "/2.0", "/repositories/{workspace}?role=member"),
    runEvents: false,
  },
};

/**
 * A host's own REST API action in one sentence shape, by its name, the part
 * of the address its paths follow and an example list.
 */
function restDescription(
  action: IntegrationActionSpec,
  name: string,
  after: string,
  example: string,
): string {
  return action.name === "read"
    ? `GET or HEAD one relative ${name} REST API path (the part after ${after}), such as ${example} or /user. JSON only; nextPath reads the next page.`
    : `POST, PATCH, PUT or DELETE one relative ${name} REST API path, with body as JSON text. The integration approval rule decides when it runs. Merges and default-branch moves require the merge card.`;
}

export function githubIntegration(
  options: GithubIntegrationOptions,
  target: { host: string; id: string; name: string; label: string; kind: SignInKind } = {
    host: INTEGRATIONS_SIGN_IN_HOST,
    id: GITHUB_ID,
    name: INTEGRATION_KIND_NAMES.github,
    label: "GitHub",
    kind: "github",
  },
): IntegrationBinding {
  const { host, id, name, label, kind } = target;
  // A server running another product than the kind's public host (Bitbucket
  // Data Center) offers no actions until its own REST API is reached.
  const api = serverFactsAt(kind, host) ? null : KIND_API[kind];
  // Allow for the rest of this task covers one kind of request to one repository or project.
  const scope = api ? forgeScope(kind) : undefined;
  const actions =
    api && scope
      ? ACTIONS.map((action) => ({
          ...action,
          scope,
          label: action.label.replaceAll("GitHub", label),
          description: api.description(action, label),
        }))
      : [];
  const readForLook = api?.runEvents ? options.gateway.readForLook : undefined;
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
      if (!api) throw new Error(`${label} offers no actions yet.`);
      if (caller.kind === "panel") {
        const { readAsPanel, writeAsPanel } = options.gateway;
        if (!readAsPanel || !writeAsPanel) throw new Error("panels cannot reach GitHub here.");
        return {
          text:
            action === "read"
              ? await readAsPanel(caller.panel.key, input as GithubReadInput)
              : await writeAsPanel(caller.panel.key, input as GithubWriteInput),
        };
      }
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
