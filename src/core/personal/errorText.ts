/** An error's own words, for a log line or a refusal. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
