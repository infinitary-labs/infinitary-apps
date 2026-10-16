import { HERE } from "@shared/deviceNames";
import { type Forge, type ForgeChange, ForgeError, type ForgeLocation } from "../forge";

/**
 * A project kept only on this Mac (`none`): there is nowhere to send a
 * change, so there is never an open one, and putting work in is the local
 * land that already exists (`WorkspaceService.landTaskWork`), reached through
 * the local-only posture rather than through this seam. Every question has
 * a quiet answer; only an ask to send something up is refused, as a typed
 * `unsupported`.
 */
export class NoHostForge implements Forge {
  readonly kind = "none" as const;
  readonly host = null;
  readonly place = null;
  readonly hasChecks = false;

  constructor(readonly location: ForgeLocation) {}

  async listProjects() {
    return [];
  }

  async defaultBranch(): Promise<string> {
    throw nowhere();
  }

  async openChange(): Promise<ForgeChange> {
    throw nowhere();
  }

  async changeFor(): Promise<ForgeChange | null> {
    return null;
  }

  async checks() {
    return { overall: "green" as const, items: [] };
  }

  async putIn(): Promise<undefined> {
    throw nowhere();
  }

  async close(): Promise<void> {}

  label(change: ForgeChange): string {
    return change.branch;
  }

  url(): string | null {
    return null;
  }
}

function nowhere(): ForgeError {
  return new ForgeError(
    "unsupported",
    `this project is kept on ${HERE.this}; there is nowhere to send a change`,
  );
}
