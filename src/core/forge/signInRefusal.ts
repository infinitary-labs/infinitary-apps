import type { OpenEffect } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import { notSignedInText } from "@shared/forges";

/**
 * "Not signed in to <host>" as an OUTCOME with ways out (git integration
 * PR 1.2), the way a close refusal (`SettleRefusal`) and a crew hold
 * (`orchestrator/holds.ts`) are: the host does not raise a card for it -
 * the Firstmate raises one decision in its own words - but the host names
 * the typed ways, so the card carries them as they are:
 *
 * - sign in: an `open` effect that lands on Settings -> Projects with the
 *   host's sign-in already started, so the code is on screen;
 * - keep it on this Mac: `app_change project-settings delivery local-only`, the
 *   captain's standing other way out - a forge is never required, and once
 *   a project is kept here nothing asks for a sign-in for it again. Only
 *   offered where there is a project to keep.
 */

export type SignInWay = { label: string } & (
  | { effect: OpenEffect }
  | { tool: "app_change"; args: Record<string, unknown> }
);

export type SignInRefusal = {
  refused: "not-signed-in";
  host: string;
  ways: SignInWay[];
  text: string;
};

export function signInWays(input: { host: string; name: string; repoId?: string }): SignInWay[] {
  return [
    {
      label: `Sign in to ${input.name}`,
      effect: { kind: "open", target: "projects", signIn: input.host },
    },
    ...(input.repoId
      ? [
          {
            label: `Keep it on ${HERE.this}`,
            tool: "app_change" as const,
            args: {
              action: "project-settings",
              value: { repoId: input.repoId, changes: { delivery: "local-only" } },
              evidence: `Keep it on ${HERE.this}`,
            },
          },
        ]
      : []),
  ];
}

export function signInRefusal(input: {
  host: string;
  name: string;
  repoId?: string;
  /** What could not be done without it, after the fact. */
  context?: string;
}): SignInRefusal {
  const fact = notSignedInText(input.name, input.host);
  return {
    refused: "not-signed-in",
    host: input.host,
    ways: signInWays(input),
    text: input.context ? `${fact}: ${input.context}` : `${fact}.`,
  };
}

/** Carries the same sign-in fact to callers without replacing their surface's words. */
export class SignInRequiredError extends Error {
  constructor(
    message: string,
    readonly refusal: SignInRefusal,
  ) {
    super(message);
    this.name = "SignInRequiredError";
  }
}

/**
 * The refusal as it rides a tool result or a wake: the sentence, then the
 * ways as a fenced JSON block - the one format every refusal with ways uses
 * (`renderHold`, `wakeOnSettle`).
 */
export function renderSignInRefusal(refusal: SignInRefusal): string {
  const { text, ...structured } = refusal;
  return `${text}\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``;
}
