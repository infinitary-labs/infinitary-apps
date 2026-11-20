/** Do not let an inherited AWS sign-in turn a non-Bedrock session into Bedrock. */
export function withoutAwsEnvironment<T extends Record<string, string | undefined>>(env: T): T {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("AWS_") || upper === "CLAUDE_CODE_USE_BEDROCK") delete clean[name];
  }
  return clean;
}
