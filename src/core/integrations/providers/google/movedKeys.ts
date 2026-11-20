import { readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The file an earlier version kept the Google sign-in's keys in
 * (`userData/integrations/secrets/google/secrets.json`, 0600 in a 0700
 * folder), read once to move its lasting key into Secrets and then removed
 * (docs/integrations.md, "Keys"). Nothing writes it any more; its access
 * key is not moved, since the first renewal makes a new one.
 */
export class MovedGoogleKeys {
  constructor(private readonly integrationsDir: string) {}

  private get folder(): string {
    return join(this.integrationsDir, "secrets", "google");
  }

  /** Whether the earlier file, or its folder, is still there. */
  present(): boolean {
    try {
      readFileSync(join(this.folder, "secrets.json"));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  /** The lasting key the earlier file holds, or undefined when it holds none or cannot be read. */
  lastingKey(): string | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.folder, "secrets.json"), "utf8"));
      const value =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).refresh_token
          : undefined;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Remove the earlier file and its folders once Secrets holds the key, or it held none. */
  remove(): void {
    rmSync(this.folder, { recursive: true, force: true });
    try {
      rmdirSync(join(this.integrationsDir, "secrets"));
    } catch {
      // Another kind's folder, or none: only an empty parent goes.
    }
  }
}
