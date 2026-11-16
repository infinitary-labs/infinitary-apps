/**
 * Stable identities for the task record's detail facts (`data-record-fact`).
 * Labels are presentation vocabulary, never the identity a reader selects.
 */
export type RecordFact =
  | "deliverable"
  | "crewmate"
  | "project"
  | "branch"
  | "delivery"
  | "merging"
  | "care"
  | "runs-on"
  | "computer-choice"
  | "personal"
  | "parent"
  | "blocked-by"
  | "blocks"
  | "children";
