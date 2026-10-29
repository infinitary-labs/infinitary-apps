/** What leads a merge card's required actions (`RequiredActions.tsx`, and the phone's card). */
export const REQUIRED_ACTIONS_LEAD = "After merging, you need to…";

/** The folded list's summary when there is more than one. */
export function requiredActionsCount(count: number): string {
  return `${count} required actions`;
}
