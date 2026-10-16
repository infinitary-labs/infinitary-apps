/**
 * Words of a project's policy rows in Settings -> Projects (`ProjectsTab`),
 * in a plain module so an e2e spec reads them from their owner
 * (docs/e2e-contracts.md, "Words come from their owner").
 */
export const PROJECT_POLICY_WORDS = {
  /** What "Where changes go" says on every project but the personal workspace. */
  delivery:
    "Offered as a pull request where the project lives, or merged locally with no pull request.",
} as const;

/** The badge on a project's row saying how it joined: cloned, created or linked in place. */
export const PROJECT_SETUP_WORDS = {
  clone: "cloned",
  init: "created",
  adopt: "linked",
} as const satisfies Record<string, string>;
