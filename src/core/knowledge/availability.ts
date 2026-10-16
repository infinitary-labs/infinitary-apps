/** Knowledge is available in every build, including stable. */
export function knowledgeEnabled(_build: { packaged: boolean; version: string }): boolean {
  return true;
}
