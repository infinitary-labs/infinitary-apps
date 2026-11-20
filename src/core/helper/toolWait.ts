/** Whole-callback deadline for either provider, below Claude's maximum tool wait. */
export const PLACED_REQUEST_WAIT_MS = 24 * 24 * 60 * 60 * 1000;

/**
 * Claude's longest supported tool timer, above our callback deadline.
 * Keep both limits dependency-free: checking their relationship must not
 * load a model runtime or its process-wide initialization.
 */
export const PLACED_TOOL_WAIT_MS = 2 ** 31 - 1;
