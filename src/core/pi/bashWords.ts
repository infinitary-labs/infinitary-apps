/**
 * The bash tool's answer to a command that ran past the shell's limit
 * (`bashTool.ts`): the job's receipt, not the command's output, which reaches
 * the owner later as the job's exit wake. A plain module, so a scripted
 * stand-in reads the same words (docs/e2e-contracts.md, "Words come from
 * their owner").
 */
export function backgroundJobReceipt(jobId: string, tail?: string): string {
  return `Still running as background job ${jobId}; you will receive the result when it exits.${
    tail ? ` Output so far:\n${tail}` : ""
  }`;
}
