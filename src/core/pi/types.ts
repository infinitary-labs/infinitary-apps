/**
 * Types other modules may reference without touching Pi directly - the
 * adapter seam re-exports them so `@earendil-works/pi-coding-agent` imports
 * stay confined to src/main/pi/ (lint-enforced).
 */
export type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
