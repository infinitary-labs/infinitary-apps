/** What started the run, as each job name leads with it (scripts/ci-job-names.mjs). */
export declare const TRIGGERS: readonly string[];
/** One level of a job name split into its trigger and purpose, or null when it leads with no known trigger. */
export declare function splitLevel(level: string): { trigger: string; purpose: string } | null;
/** The name a job had before the trigger-first rename; an older name comes back as it was. */
export declare function legacyJobName(name: string): string;
