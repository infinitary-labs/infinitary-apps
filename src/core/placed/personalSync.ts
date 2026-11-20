import { workOrders } from "@shared/work";
import { contractChange, listsChange } from "../connection/contractChanges";
import type { PersonalFile, PersonalVersion } from "../session/personalSet";
import type { WorkDevices } from "./workDevices";

/** The home sends its personal set, whole, when it changes (`personal-sync.md`). */
export const PERSONAL_SYNC = contractChange("personal-sync");

/** The set carries the skills of the person's Claude Code plugins (`personal-plugins.md`). */
export const PERSONAL_PLUGINS = contractChange("personal-plugins");

/**
 * The home's set as it stands, asked again on each call: its version
 * (`HomePersonalSet.current`), and the whole set only when one is sent
 * (`HomePersonalSet.read`).
 */
export type HomePersonal = {
  enabled: () => boolean;
  /** With `plugins` false, the set as a computer without `personal-plugins` keeps it. */
  current: (plugins?: boolean) => Promise<{ version: PersonalVersion }>;
  read: (plugins?: boolean) => Promise<{ version: PersonalVersion; files: PersonalFile[] }>;
  /** A new version was read: each computer in reach is sent it at once. */
  onChange: (listener: () => void) => () => void;
};

const keepAnswerSchema = workOrders["inf:session:personal"].response;

/**
 * Keeps the home's personal instructions and skills on each computer that
 * runs work (docs/personal-resources.md, "One set, kept on each computer"):
 * each computer's roster says which version it keeps, and the home sends
 * its set only when that is not the version it has now, one send at a time
 * per computer. A task never carries the set; a computer out of reach keeps
 * the version it had and is sent the new one when it is back.
 */
export class PersonalSync {
  /** The version each computer said it keeps, by its roster or a keep's answer. */
  private readonly kept = new Map<string, PersonalVersion | undefined>();
  /** One send at a time to each computer. */
  private readonly sending = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      devices: Pick<WorkDevices, "ask" | "inReach" | "version">;
      personal: HomePersonal;
      log: (line: string) => void;
    },
  ) {}

  /** What a computer's roster said it keeps, read at each contact. */
  heard(deviceId: string, personal: PersonalVersion | undefined): void {
    this.kept.set(deviceId, personal);
  }

  /** It went out of reach: what it keeps is read again at its next contact. */
  forget(deviceId: string): void {
    this.kept.delete(deviceId);
  }

  /** The version a computer last said it keeps. */
  keptOn(deviceId: string): PersonalVersion | undefined {
    return this.kept.get(deviceId);
  }

  /**
   * Brings a computer in reach to the home's set when the switch is on and
   * it keeps another version. A send that fails leaves it the version it
   * had, which its crew reads until a later send arrives.
   */
  bring(deviceId: string): Promise<void> {
    const before = this.sending.get(deviceId) ?? Promise.resolve();
    const next = before.then(() => this.send(deviceId));
    const settled = next.catch((error: unknown) =>
      this.options.log(
        `could not send the personal instructions to ${deviceId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    this.sending.set(deviceId, settled);
    void settled.finally(() => {
      if (this.sending.get(deviceId) === settled) this.sending.delete(deviceId);
    });
    return settled;
  }

  private async send(deviceId: string): Promise<void> {
    if (!this.options.personal.enabled() || !this.options.devices.inReach(deviceId)) return;
    if (!this.kept.has(deviceId)) return;
    const changes = this.options.devices.version(deviceId)?.changes;
    if (!listsChange(changes, PERSONAL_SYNC)) return;
    // A computer that keeps no plugins is sent the set without them, which it accepts.
    const plugins = listsChange(changes, PERSONAL_PLUGINS);
    const now = await this.options.personal.current(plugins);
    if (this.kept.get(deviceId)?.version === now.version.version) return;
    const { version, files } = await this.options.personal.read(plugins);
    const answer = keepAnswerSchema.parse(
      await this.options.devices.ask(deviceId, "inf:session:personal", [
        {
          version: version.version,
          since: version.since,
          files: files.map((file) => ({
            path: file.path,
            data: file.data.toString("base64"),
            ...(file.exec ? { exec: true } : {}),
          })),
        },
      ]),
    );
    this.kept.set(deviceId, answer.personal);
  }
}
