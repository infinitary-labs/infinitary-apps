import { randomUUID } from "node:crypto";
import type { SourceOutput } from "./bringOutput";
import type { BoundSource } from "./bringSource";
import type { ProtectedSecrets, UseDescription } from "./protected";
import { type PreparedUse, validInjection } from "./requests";

export type PreparedBringUnlock = {
  request: string;
  use: PreparedUse;
  described: UseDescription;
  takeOutput(): SourceOutput | undefined;
};

/** Check the mapping by the same credential-variable rules as inject. */
export function validBringUses(uses: Record<string, string>): boolean {
  return validInjection({ id: "bring", reason: "bring", argv: ["bring"], env: uses });
}

/** The checked recipient is bound before showing the card; no key is opened here. */
export async function prepareBringUnlock(
  owner: ProtectedSecrets,
  source: Extract<BoundSource, { kind: "run" }>,
  uses: Record<string, string>,
  reason: string,
  key: string,
  limitMs: number,
  authorized: () => boolean,
): Promise<PreparedBringUnlock | undefined> {
  const request = randomUUID();
  let output: SourceOutput | undefined;
  const use = await owner.prepareBringProgram(
    { id: `bring:${key}`, reason, argv: source.argv, cwd: source.folder, env: uses },
    request,
    {
      limitMs,
      authorized,
      receive: (one) => {
        output = one;
      },
    },
  );
  if (!use) return undefined;
  const described = owner.describe(request);
  if (
    use.rule === "never" ||
    !described ||
    described.facts.executable.path !== source.program.path ||
    described.facts.executable.sha256 !== source.program.sha256 ||
    described.facts.interpreter?.path !== source.interpreter?.path ||
    described.facts.interpreter?.sha256 !== source.interpreter?.sha256 ||
    described.facts.interpreter?.arg !== source.interpreter?.arg ||
    described.facts.cwd !== source.folder
  ) {
    await use.dispose(use.rule === "never" ? "denied" : "invalidated");
    return undefined;
  }
  return {
    request,
    use,
    described,
    takeOutput() {
      const result = output;
      output = undefined;
      return result;
    },
  };
}
