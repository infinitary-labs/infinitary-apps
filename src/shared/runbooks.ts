import { z } from "zod";

/** Only closed facts already carried by a task may select prompt guidance. */
export const runbookMatchSchema = z.strictObject({
  kind: z.array(z.string()).optional(),
  place: z.array(z.enum(["project", "personal"])).optional(),
  delivery: z.array(z.string()).optional(),
  care: z.array(z.string()).optional(),
  backend: z.array(z.string()).optional(),
  project: z.array(z.string()).optional(),
});
export type RunbookFacts = {
  kind: string;
  place: "project" | "personal";
  delivery: string;
  care: string;
  backend: string;
  project?: string;
};
export const namingRuleSchema = z.strictObject({ pattern: z.string(), message: z.string() });
export type NamingRule = z.infer<typeof namingRuleSchema>;
export const runbookManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  description: z.string(),
  author: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  panels: z.array(z.string()).optional(),
  firstmate: z.string().optional(),
  crew: z.strictObject({ file: z.string(), when: runbookMatchSchema.optional() }).optional(),
  skills: z.string().optional(),
  parts: z.string().optional(),
  projects: z.array(z.string()).optional(),
  replaces: z.string().optional(),
  naming: namingRuleSchema.optional(),
});
export type RunbookManifest = z.infer<typeof runbookManifestSchema>;
export const runbookViewSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  path: z.string().optional(),
});
export type RunbookView = z.infer<typeof runbookViewSchema>;
export const runbookStateSchema = z.record(z.string(), z.boolean());

/** An absent selector is unrestricted; an empty selector deliberately matches nothing. */
export function runbookMatches(
  when: z.infer<typeof runbookMatchSchema> | undefined,
  facts: RunbookFacts,
): boolean {
  return (
    !when ||
    Object.entries(when).every(([key, values]) =>
      (values as readonly string[]).includes(facts[key as keyof RunbookFacts] ?? ""),
    )
  );
}

/** Plain files travel with the session; no path on the home is assumed to exist on a work computer. */
export const runbookSkillFilesSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  files: z.record(z.string(), z.string()),
});
export type RunbookSkillFiles = z.infer<typeof runbookSkillFilesSchema>;
