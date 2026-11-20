import type { LiveValidationSummary } from "@shared/liveValidationSummary";

/**
 * no-mistakes' signature line and v1 pipeline attestation on a Careful task's
 * github.com pull request (INF-1793, the captain's plan: "it's my intended design
 * to have infinitary's careful rigor be counted as no-mistakes in those PR
 * enforcements"). The markers are no-mistakes' own, byte for byte, from its
 * `internal/pipeline/steps/prsummary.go`; its `require-no-mistakes` check reads
 * only `head_sha` and each step's `step` and `status`, so `producer` is ignored there.
 */
export const NO_MISTAKES_SIGNATURE =
  "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";
export const NO_MISTAKES_ATTESTATION_PREFIX = "<!-- no-mistakes-pipeline-attestation:v1 ";
const ATTESTATION_CLOSING = " -->";
/** no-mistakes' own escape: readable, but no longer the prefix its check scans for first. */
const ESCAPED_PREFIX = "<!-- no-mistakes-pipeline-attestation\\:v1 ";

/** The three steps the check requires, each completed from the review and live-proof records at `head`, whatever the care's name (INF-1876). */
export function pipelineAttestationSection(
  head: string,
  validation?: LiveValidationSummary,
): string {
  const attestation = {
    head_sha: head,
    steps: ["review", "test", "document"].map((step) => ({ step, status: "completed" })),
    producer: "infinitary",
    ...(validation?.verdict
      ? {
          live_validation: {
            verdict: validation.verdict,
            live: validation.live ?? 0,
            total: validation.total ?? 0,
          },
        }
      : {}),
  };
  return [
    "## Pipeline",
    NO_MISTAKES_SIGNATURE,
    `${NO_MISTAKES_ATTESTATION_PREFIX}${JSON.stringify(attestation)}${ATTESTATION_CLOSING}`,
    "Infinitary checked this version: an independent review that also judged the documents, and live validation the review accepted.",
  ].join("\n\n");
}

/** Make another writer's attestation inert, so the check reads only the app's own. */
export function neutralizePipelineAttestation(text: string): string {
  return text.replaceAll(NO_MISTAKES_ATTESTATION_PREFIX, ESCAPED_PREFIX);
}
