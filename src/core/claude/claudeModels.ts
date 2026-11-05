import { CLAUDE_PROVIDER_ID } from "@shared/providers";

/**
 * Infinitary's shipped Claude catalog: what a Claude account serves until the
 * installed client's own catalog has been read, and again whenever that
 * read fails (docs/model-lists.md). Claude's client resolves aliases to the
 * current build, so the list names families rather than dated snapshots.
 *
 * It names the newest generation of every family the subscription serves,
 * and the live probe (claudeModelProbe.test.ts, docs/claude-model-probe.md)
 * holds it to that: a family whose newest generation is missing here fails
 * (Fable's absence was FI3-74), as does an id the client no longer serves
 * (Fable 5.1 replacing Fable 5 on Claude Code 2.1.278; Opus 5.5 replacing
 * Opus 5 on 2.1.280). Earlier generations the client re-lists - six of them
 * since 2026-09-23 - are not named: they are reachable by name once the
 * runtime read has them, and never listed on their own.
 */
export const CLAUDE_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

/** A Claude model's name in the shipped catalog; undefined for one the catalog does not name. */
export function claudeModelName(id: string | undefined): string | undefined {
  return CLAUDE_MODELS.find((model) => model.id === id)?.name;
}

/** Availability contributed by a connected Claude account, each model by its name. */
export function claudeAvailableModels(): { provider: string; id: string; name: string }[] {
  return CLAUDE_MODELS.map((model) => ({
    provider: CLAUDE_PROVIDER_ID,
    id: model.id,
    name: model.name,
  }));
}
