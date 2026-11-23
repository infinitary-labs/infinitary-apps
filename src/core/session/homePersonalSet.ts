import { homedir } from "node:os";
import { type EnabledClaudePlugins, readEnabledClaudePlugins } from "../claude/claudePlugins";
import {
  type PersonalDigests,
  type PersonalFile,
  type PersonalVersion,
  personalFingerprint,
  personalSetFiles,
  personalSetVersion,
} from "./personalSet";

/**
 * The home's personal instructions and skills as one versioned set
 * (docs/personal-resources.md, "One set, kept on each computer"): listed
 * again from this user's home folder whenever it is asked, so an edit counts
 * from the next time anything asks, and read only where a file changed since
 * it last looked. A new fingerprint is a new version, since the moment it
 * was first seen, kept in Settings so a restart keeps it. Which Claude Code
 * plugins are on is read again with every version, before it is taken, so no
 * version is ever taken without that setting.
 */
export class HomePersonalSet {
  private readonly listeners = new Set<() => void>();
  /** Each file's fingerprint by what its listing saw, so an unchanged file is not read again. */
  private readonly digests: PersonalDigests = new Map();
  /** The skills last left out for their size, named in the log once each time they change. */
  private left = "";
  /** The plugin setting as last read, kept when a later read fails. */
  private pluginSetting: EnabledClaudePlugins | undefined;

  constructor(
    private readonly options: {
      enabled: () => boolean;
      saved: {
        get: () => { version: string; since: number } | undefined;
        set: (seen: { version: string; since: number }) => void;
      };
      now: () => number;
      home?: string;
      /** Reads which Claude Code plugins are on (`claudePlugins.ts`); none without it. */
      plugins?: () => Promise<EnabledClaudePlugins | undefined>;
      log?: (line: string) => void;
    },
  ) {}

  enabled(): boolean {
    return this.options.enabled();
  }

  /**
   * The version now; a fingerprint not seen before is a new version, which
   * listeners hear. Without `plugins`, the version of the set as a computer
   * that keeps no plugins is sent it, since when the home has had its set.
   */
  async current(plugins = true): Promise<{ version: PersonalVersion }> {
    const enabled = await this.plugins();
    const { version, files, left } = personalSetVersion(this.home(), this.digests, enabled);
    const seen = this.seen(version, files, left);
    if (plugins) return { version: seen };
    const part = personalSetVersion(this.home(), this.digests, undefined);
    return { version: { ...seen, version: part.version, files: part.files } };
  }

  /** The set now, read whole, with the version its bytes make: what is sent. */
  async read(plugins = true): Promise<{ version: PersonalVersion; files: PersonalFile[] }> {
    if (!plugins) {
      const { since } = (await this.current()).version;
      const { files } = personalSetFiles(this.home(), undefined);
      return {
        version: { version: personalFingerprint(files), since, files: files.length },
        files,
      };
    }
    const { files, left } = personalSetFiles(this.home(), await this.plugins());
    return { version: this.seen(personalFingerprint(files), files.length, left), files };
  }

  /** A new version was read; the computers are sent it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async plugins(): Promise<EnabledClaudePlugins | undefined> {
    this.pluginSetting = (await this.options.plugins?.()) ?? this.pluginSetting;
    return this.pluginSetting;
  }

  private home(): string {
    return this.options.home ?? homedir();
  }

  private seen(version: string, files: number, left: string[]): PersonalVersion {
    const saved = this.options.saved.get();
    const changed = saved?.version !== version;
    const since = !changed && saved ? saved.since : this.options.now();
    if (changed) this.options.saved.set({ version, since });
    const named = left.join(", ");
    if (named !== this.left && named.length > 0)
      this.options.log?.(`personal skills too large to send to other computers: ${named}`);
    this.left = named;
    if (changed) for (const listener of [...this.listeners]) listener();
    return { version, since, files };
  }
}

export function homePersonalSetOver(
  settings: {
    getPersonalResourcesEnabled(): boolean;
    getPersonalVersion(): { version: string; since: number } | undefined;
    setPersonalVersion(seen: { version: string; since: number }): void;
  },
  options: {
    now: () => number;
    home?: string;
    plugins?: () => Promise<EnabledClaudePlugins | undefined>;
    log?: (line: string) => void;
  },
): HomePersonalSet {
  return new HomePersonalSet({
    plugins: () => readEnabledClaudePlugins(),
    enabled: () => settings.getPersonalResourcesEnabled(),
    saved: {
      get: () => settings.getPersonalVersion(),
      set: (seen) => settings.setPersonalVersion(seen),
    },
    log: (line) => console.warn(`[personal] ${line}`),
    ...options,
  });
}
