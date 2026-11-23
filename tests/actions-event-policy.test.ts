import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadYamlFile, read } from "./helpers/releaseWorkflows";

// GitHub blocks pull_request_target in every public project unless an
// Actions event policy allows it, and the policy is an allowlist: a workflow
// it targets runs only on the events it names, and any other start fails at
// GitHub with nothing in the file to show why. .github/actions-event-policy.json
// is the project's policy as GitHub keeps it (docs/public-ci.md, "The pull
// request event policy"), so these hold the workflows and the policy to each
// other before either reaches GitHub.

type Policy = {
  enforcement: string;
  conditions: { workflow_path: { include: string[]; exclude: string[] } };
  rules: { type: string; parameters: { allowed_events: string[] } }[];
};

const policy = JSON.parse(read(".github/actions-event-policy.json")) as Policy;
const targeted = policy.conditions.workflow_path.include;
const allowed = policy.rules.flatMap((rule) =>
  rule.type === "restrict_action_events" ? rule.parameters.allowed_events : [],
);

const workflowDir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const triggers = (file: string) =>
  Object.keys(loadYamlFile(`.github/workflows/${file}`).on as Record<string, unknown>);
const workflows = readdirSync(workflowDir).filter((file) => file.endsWith(".yml"));

describe("the pull request event policy", () => {
  it("is on, with one event rule and no excluded paths", () => {
    expect(policy.enforcement).toBe("active");
    expect(policy.rules.map((rule) => rule.type)).toEqual(["restrict_action_events"]);
    expect(policy.conditions.workflow_path.exclude).toEqual([]);
  });

  it("targets every workflow that starts on pull_request_target, and no other", () => {
    const fromMain = workflows
      .filter((file) => triggers(file).includes("pull_request_target"))
      .map((file) => `.github/workflows/${file}`);
    expect(fromMain.length).toBeGreaterThan(0);
    expect(targeted.toSorted()).toEqual(fromMain.toSorted());
  });

  it("allows every event a targeted workflow starts on, and none it does not use", () => {
    const used = new Set(targeted.flatMap((path) => triggers(path.replace(/^.*\//, ""))));
    expect(allowed.toSorted()).toEqual([...used].toSorted());
  });
});
