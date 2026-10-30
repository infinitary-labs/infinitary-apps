import type { LiveValidationInput } from "../../../src/shared/liveValidation";
import { type Scenario, type ScriptedCall, sinceLastUser } from "../mockProvider";

/**
 * INF-1824: a version's gaps reach the captain on one checklist card. FIRS-3
 * recorded four gaps at one version and the app showed four cards, which
 * the captain accepted within 13 seconds. The crewmate here records that
 * task's four checks, a run where none could run, a gap request for each,
 * and one card that names them all. It first reads the commit its working
 * copy holds, which every record names.
 */
export const GAP_CHECKLIST_MARKER = "gap checklist";
export const GAP_CHECKLIST_TITLE = "Four checks cannot run without test pull requests";
export const GAP_CHECKLIST_ACCEPT = { id: "accept-checked", label: "Accept the checked gaps" };
export const GAP_CHECKLIST_HOLD = { id: "keep-held", label: "Keep all held" };
/** FIRS-3's four checks, as its record named them. */
export const GAP_CHECKS = [
  ["outside-prs", "Outside pull requests run quick checks"],
  ["full-ci-label", "The full-ci label starts the full suite"],
  ["other-labels", "Other labels start and cancel nothing"],
  ["main-newest", "Main runs only the newest merge"],
] as const;
const MISSING = "Test pull requests on the real repository";
const WHY = "Opening them would be visible to your collaborators.";

function steps(head: string): ScriptedCall[] {
  const record = (text: string, validation: LiveValidationInput): ScriptedCall => ({
    name: "report",
    args: { text, validation },
  });
  return [
    record("Each check needs the real repository's workflows.", {
      kind: "plan",
      previousRevision: 0,
      reason: "You asked which workflows each pull request starts.",
      scenarios: GAP_CHECKS.map(([id, action]) => ({
        id,
        source: "Prove which workflows each pull request starts.",
        importance: "required",
        action,
        expected: "Only the named workflows start.",
        adverse: "A workflow that starts unasked is a failure.",
        environment: "The project's repository on GitHub",
        signal: "The workflow runs listed for the pull request.",
        boundary: "GitHub Actions on the real repository",
      })),
    }),
    record("None of the checks can run without test pull requests.", {
      kind: "run",
      id: "first-run",
      head,
      scenarioRevision: 1,
      completion: "complete",
      verdict: "inconclusive",
      reason: "Proving them needs pull requests others can see.",
      observations: GAP_CHECKS.map(([id]) => ({
        scenario: id,
        result: "untested",
        live: false,
        actual: "Not run.",
        evidence: [],
        standIns: ["The workflow files, read by hand"],
        unproven: ["The real trigger"],
        attempted: ["Reading the workflow files cannot prove what GitHub starts."],
        missingCapability: MISSING,
        reason: WHY,
      })),
      evidence: [],
    }),
    ...GAP_CHECKS.map(([id, action]) =>
      record(`${action}: that gap needs your answer.`, {
        kind: "request",
        request: {
          kind: "gap",
          id: `gap-${id}`,
          head,
          scenario: id,
          missingCapability: MISSING,
          reason: WHY,
          alternatives: [
            { attempted: "Reading the workflow files", result: "It cannot prove the trigger." },
          ],
          remedies: ["Allow one test pull request on the repository."],
        },
      }),
    ),
    {
      name: "emit_card",
      args: {
        title: GAP_CHECKLIST_TITLE,
        body: "<p>I could not run these four checks without opening test pull requests your collaborators would see.</p><p>Tick the checks that may go ahead without live proof; the rest stay held.</p>",
        validation_request: {
          request: `gap-${GAP_CHECKS[0][0]}`,
          action: GAP_CHECKLIST_ACCEPT.id,
          gaps: GAP_CHECKS.slice(1).map(([id]) => `gap-${id}`),
        },
        actions: [{ ...GAP_CHECKLIST_ACCEPT, default: true }, GAP_CHECKLIST_HOLD],
      },
    },
  ];
}

export const gapChecklist: Scenario =
  () =>
  ({ isFirstmate, wantsStream, body }) => {
    if (!wantsStream || isFirstmate) return undefined;
    const turn = sinceLastUser(body);
    if (!turn.user.includes(GAP_CHECKLIST_MARKER)) return undefined;
    if (!turn.results.length)
      return { calls: [{ name: "bash", args: { command: "git rev-parse HEAD" } }] };
    const head = turn.results[0]?.match(/[0-9a-f]{40}/)?.[0];
    if (!head) throw new Error("The scripted crewmate needs its working copy's commit.");
    const next = steps(head)[turn.results.length - 1];
    return next ? { calls: [next] } : { text: "The four gaps wait on your answer." };
  };
