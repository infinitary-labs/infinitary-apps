import type { ForgeSignInState } from "@shared/forges";
import { INTEGRATIONS_SIGN_IN_HOST } from "@shared/integrations";
import { z } from "zod";
import type { GithubReadInput, GithubWriteInput } from "../../forge";
import type { IntegrationActionSpec, IntegrationBinding } from "../binding";

/**
 * GitHub as an integration (docs/integrations.md, "GitHub"): the app's own
 * github.com sign-in, made and kept by the forge (`ForgeSignIns`,
 * `docs/forge.md`), seen through the integrations seam. Its actions are
 * the gateway's two calls through that sign-in: a read runs, and a write
 * asks the captain - a crewmate's is kept on its task as an ask its card
 * carries, the way a write to another project is today. Pull requests,
 * checks and merges stay the forge's and the project's.
 */

const GITHUB_ID = "github";

/** The gateway's calls through the github.com sign-in, whoever asks. */
export type GithubIntegrationGateway = {
  /** A task's read or write, through the github.com sign-in whatever its project is. */
  read: (taskId: string, input: GithubReadInput, through: "account") => Promise<string>;
  write: (taskId: string, input: GithubWriteInput, through: "account") => Promise<string>;
  /** The first mate's read: it has no task, so its calls count as the seat's own. */
  readAsSeat: (input: GithubReadInput) => Promise<string>;
};

export type GithubIntegrationOptions = {
  signIns: {
    stateOf: (host: string) => ForgeSignInState | undefined;
    loginOf: (host: string) => string | null;
    checkNow: (host: string) => Promise<void>;
    signOut: (host: string) => void;
  };
  gateway: GithubIntegrationGateway;
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
      "POST, PATCH, PUT or DELETE one path through the captain's GitHub sign-in; body is JSON text. Every write asks the captain: a crewmate's is kept as an ask, which it puts on a card as an action whose effect is request_write. Merges and default-branch moves are refused; they use the merge card.",
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

export function githubIntegration(options: GithubIntegrationOptions): IntegrationBinding {
  const host = INTEGRATIONS_SIGN_IN_HOST;
  return {
    kind: "github",
    actions: ACTIONS,
    keepsAsks: true,
    connections: () => {
      const health = options.signIns.stateOf(host);
      if (health === undefined) return [];
      return [{ id: GITHUB_ID, account: options.signIns.loginOf(host), health }];
    },
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
      if (caller.kind !== "task")
        return {
          text: "Not sent: a change on GitHub asks the captain on a card, and only a crewmate's card can carry the exact call. Start a crewmate whose brief names the call.",
          refused: "refused",
        };
      return {
        text: await options.gateway.write(caller.taskId, input as GithubWriteInput, "account"),
      };
    },
  };
}
