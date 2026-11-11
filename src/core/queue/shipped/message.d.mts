export const NAMING_DECISION: Readonly<{ checked: "checked"; off: "off" }>;

export function commitMessage(story: {
  whatChanged: readonly string[];
  projectText: string;
}): string;
export function commitEnvelope(
  head: string,
  body: string,
  title: string,
  policy: { naming: "checked" | "off" },
): string;
export function readCommitEnvelope(comment: string, head: string, title: string): string;

export type ApprovalRecord = {
  id: number;
  kind: "approval" | "revocation";
  head: string;
  body: string;
};
export type ApprovalComment = { id: number; body?: string | null; system?: boolean };
export function revocationEnvelope(head: string): string;
export function newestTrustedApproval<T extends ApprovalComment>(
  comments: readonly T[],
  head: string,
  mayMerge: (comment: T) => boolean | Promise<boolean>,
): Promise<ApprovalRecord | undefined>;
