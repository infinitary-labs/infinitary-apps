import type { PlacedSecretBringAnswer, PlacedSecretBringInput } from "@shared/workSecrets";
import {
  boundFrom,
  type SecretBringCommand,
  type SecretBringRequest,
  type SecretBringStarted,
  type SecretBringStatus,
  validSecretBring,
} from "../secrets/bring";
import { readBrought } from "../secrets/bringRead";
import { bindSource } from "../secrets/bringSource";
import { SECRET_BRING_WORDS } from "../secrets/commandWords";
import { SECRET_REQUEST_LIFETIME_MS } from "../secrets/requests";

/** How this computer reaches the home's brings for one task: the work request, nothing else. */
export type SecretBringsHome = (input: PlacedSecretBringInput) => Promise<PlacedSecretBringAnswer>;

export type SecretBringsThereOptions = {
  home: SecretBringsHome;
  /** The environment a source starts from; only the recipient's base variables are kept (`hostEnv`). */
  environment: () => NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** How long a source may run; the request lifetime by default. */
  lifetimeMs?: number;
};

type Run = Extract<PlacedSecretBringAnswer, { run: unknown }>["run"];
type Delivered = Extract<PlacedSecretBringInput, { op: "deliver" }>["result"];

/**
 * A task's bring on a computer that runs work (docs/secrets.md, "Bringing
 * secrets from another tool"; INF-4718's plan, piece 4). The source is bound
 * here, where the other tool is; the home raises its own card naming this
 * computer. Once the captain presses, the home answers what to run and which
 * names to read, and this computer runs or reads the source the home's card
 * showed, checking every digest again, reads only those names through a pipe
 * into this process, and delivers them to the home once over the work route.
 * Every buffer is filled with zeros, and nothing is written to disk.
 */
export class SecretBringsThere implements Required<SecretBringCommand> {
  /** Brings this computer follows to their press, by the asker's id. */
  private readonly following = new Set<string>();
  private readonly lifetime: number;

  constructor(private readonly options: SecretBringsThereOptions) {
    this.lifetime = options.lifetimeMs ?? SECRET_REQUEST_LIFETIME_MS;
  }

  async bring(input: SecretBringRequest, cwd?: string): Promise<SecretBringStarted> {
    const copied: SecretBringRequest = structuredClone(input);
    if (!validSecretBring(copied)) throw new Error("Invalid bring.");
    const unavailable = (help: string): SecretBringStarted => ({
      bring: copied.id,
      state: "unavailable",
      help,
    });
    if (copied.from.uses) return unavailable(SECRET_BRING_WORDS.usesNotThere);
    const bound = await bindSource(copied.from.source, this.options.environment(), cwd).catch(
      () => "program" as const,
    );
    if (typeof bound === "string") return unavailable(SECRET_BRING_WORDS.refused[bound]);
    const { source: _source, uses: _uses, ...from } = copied.from;
    const answer = await this.options.home({
      op: "bring",
      id: copied.id,
      reason: copied.reason,
      from,
      source: bound,
    });
    if (!("bring" in answer)) throw new Error("The home answered a bring with something else.");
    if (answer.bring.state === "waiting") this.follow(copied.id);
    return answer.bring;
  }

  async bringStatus(id: string): Promise<SecretBringStatus | undefined> {
    const answer = await this.options.home({ op: "status", id });
    return "status" in answer ? (answer.status ?? undefined) : undefined;
  }

  async cancelBring(id: string): Promise<boolean> {
    const answer = await this.options.home({ op: "cancel", id });
    return "withdrawn" in answer && answer.withdrawn;
  }

  /** Waits for the captain's press on the home, then runs and delivers, until the bring ends. */
  private follow(id: string): void {
    if (this.following.has(id)) return;
    this.following.add(id);
    void (async () => {
      const ran = new Set<string>();
      try {
        for (;;) {
          const answer = await this.options.home({ op: "next", id });
          if ("over" in answer) return;
          if (!("run" in answer) || ran.has(answer.run.run)) continue;
          ran.add(answer.run.run);
          const result = await this.read(answer.run);
          await this.options.home({ op: "deliver", id, run: answer.run.run, result });
        }
      } catch {
        // The home was not reached: its press ends the bring when no delivery arrives.
        // i18n-exempt: a log line, never shown
        this.options.log?.("a Secrets bring could not reach the home");
      } finally {
        this.following.delete(id);
      }
    })();
  }

  /**
   * Runs or reads the source the home's card showed, once, and encodes only
   * the names the home asked for. The base64 strings cannot be filled with
   * zeros; every buffer behind them is.
   */
  private async read(run: Run): Promise<Delivered> {
    const read = await readBrought(
      boundFrom(run.source),
      this.options.environment(),
      this.lifetime,
      {
        reads: run.reads,
        ...(run.trim ? { trim: run.trim } : {}),
        names: run.names,
      },
    ).catch(() => ({ failed: {} }) as const);
    if (!("values" in read)) return read;
    const values: Extract<Delivered, { values: unknown }>["values"] = {};
    for (const [name, value] of read.values) {
      if (Buffer.isBuffer(value)) {
        values[name] = { value: value.toString("base64") };
        value.fill(0);
      } else values[name] = { cannot: value };
    }
    return { values };
  }
}
