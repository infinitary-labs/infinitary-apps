import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  PlacedSecretTakeAnswer,
  PlacedSecretUseAnswer,
  PlacedSecretUseInput,
} from "@shared/workSecrets";
import { type LaunchResult, type PreparedRecipient, prepareRecipient } from "../secrets/recipient";
import {
  type Injection,
  inputDigest,
  type SecretReference,
  type SecretsCommand,
  type UseCheck,
  type UseCheckInput,
  type UseReceipt,
  validInjection,
} from "../secrets/requests";

/** How this computer reaches the home's Secrets for one task: the work requests, nothing else. */
export type SecretUsesHome = {
  list(): Promise<SecretReference[]>;
  use(input: PlacedSecretUseInput): Promise<PlacedSecretUseAnswer>;
  take(request: string): Promise<PlacedSecretTakeAnswer>;
};

export type SecretUsesThereOptions = {
  home: SecretUsesHome;
  /** This app's own folder for the private copies each run binds, never a task's folder. */
  runsDir: string;
  /** The environment a recipient keeps its few variables from (`hostEnv`). */
  environment: () => NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

type Ended = Extract<PlacedSecretUseInput, { op: "ended" }>["result"];

/**
 * A task's Secrets command on a computer that runs work (docs/secrets.md, "On
 * a computer that runs work"). The program, its interpreter and its file
 * arguments are bound here, where they run; the home checks the secrets,
 * meets the saved decisions, raises the approval and journals the use. Once
 * the use starts, the home hands its values here once, and the program starts
 * from this run's private copies with them in its environment; how it ended
 * goes back to the home. No value is written to disk or kept after the start.
 */
export class SecretUsesThere implements SecretsCommand {
  private readonly receiptsSeen = new Map<string, UseReceipt>();
  /** Each intent's input digest and its first answer, so asking again answers the same use. */
  private readonly intents = new Map<string, { digest: string; receipt: Promise<UseReceipt> }>();
  /** The recipient each use bound here, until the use ends. */
  private readonly running = new Map<string, PreparedRecipient>();

  constructor(private readonly options: SecretUsesThereOptions) {}

  list(): Promise<SecretReference[]> {
    return this.options.home.list();
  }

  receipts(): UseReceipt[] {
    return [...this.receiptsSeen.values()].map((receipt) => ({ ...receipt }));
  }

  /** The same checks a request meets, here and at the home, with nothing recorded, approved or run. */
  async check(input: UseCheckInput): Promise<UseCheck> {
    const copied: UseCheckInput = structuredClone(input);
    if (!validInjection({ ...copied, id: "check", reason: "Check before asking" }))
      throw new Error("Invalid check request.");
    if (!copied.cwd) return { problem: "folder" };
    const runDir = join(this.options.runsDir, `check-${randomUUID()}`);
    try {
      const recipient = await this.bind(copied, runDir);
      if (!recipient) return { problem: "unavailable" };
      if ("refused" in recipient) return { problem: recipient.refused };
      const { facts } = recipient;
      const answer = await this.options.home.use({ op: "check", facts });
      if (!("check" in answer)) return { problem: "unavailable" };
      if ("problem" in answer.check) return { problem: answer.check.problem };
      return {
        decision: answer.check.decision,
        program: facts.executable.path,
        ...(facts.interpreter ? { interpreter: facts.interpreter.path } : {}),
        files: facts.inputs.map((file) => file.path),
        folder: facts.cwd,
      };
    } catch {
      // An answer's text may name what it could not reach; none crosses here.
      return { problem: "unavailable" };
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  async inject(input: Injection): Promise<UseReceipt> {
    // Copy before awaiting: the requesting program cannot change what is asked.
    const copied: Injection = structuredClone(input);
    if (!validInjection(copied)) throw new Error("Invalid injection request.");
    const digest = inputDigest(copied);
    const known = this.intents.get(copied.id);
    if (known) {
      if (known.digest !== digest)
        throw new Error("This intent already names a different operation.");
      const receipt = await known.receipt;
      return this.receiptsSeen.get(receipt.request) ?? receipt;
    }
    const asked = this.ask(copied);
    this.intents.set(copied.id, { digest, receipt: asked });
    // A use that could not be asked may be asked again under the same intent.
    asked.catch(() => this.intents.delete(copied.id));
    return asked;
  }

  async status(request: string): Promise<UseReceipt | undefined> {
    const answer = await this.options.home.use({ op: "status", request });
    return this.seen("receipt" in answer ? answer.receipt : null);
  }

  async cancel(request: string): Promise<UseReceipt | undefined> {
    const answer = await this.options.home.use({ op: "cancel", request });
    return this.seen("receipt" in answer ? answer.receipt : null);
  }

  private async ask(input: Injection): Promise<UseReceipt> {
    if (!input.cwd) return { request: input.id, state: "unavailable" };
    const runDir = join(this.options.runsDir, randomUUID());
    const recipient = await this.bind(input, runDir).catch(() => undefined);
    if (!recipient || "refused" in recipient) {
      await rm(runDir, { recursive: true, force: true });
      return { request: input.id, state: "unavailable" };
    }
    let answer: PlacedSecretUseAnswer;
    try {
      answer = await this.options.home.use({
        op: "inject",
        id: input.id,
        reason: input.reason,
        facts: recipient.facts,
      });
    } catch (error) {
      await recipient.dispose().catch(() => undefined);
      throw error;
    }
    const receipt = this.seen("receipt" in answer ? answer.receipt : null) ?? {
      request: input.id,
      state: "unavailable" as const,
    };
    if (
      (receipt.state !== "waiting" && receipt.state !== "executing") ||
      this.running.has(receipt.request)
    ) {
      await recipient.dispose().catch(() => undefined);
      return receipt;
    }
    this.running.set(receipt.request, recipient);
    void this.follow(receipt.request, recipient);
    return receipt;
  }

  /**
   * Take the use's values once the home starts it, start the program with
   * them, and tell the home how it ended; or end here with the state the use
   * reached without them.
   */
  private async follow(request: string, recipient: PreparedRecipient): Promise<void> {
    try {
      const taken = await this.options.home.take(request);
      if ("state" in taken) {
        // Values another ask already took may have reached a program: unknown.
        if (taken.state === "taken") await this.end(request, { outcome: "lost" });
        else this.seen({ request, state: taken.state });
        return;
      }
      const values = Object.fromEntries(
        Object.entries(taken.values).map(([name, value]) => [name, Buffer.from(value, "base64")]),
      );
      this.seen({ request, state: "executing" });
      let ended: Ended;
      try {
        // The home checked the saved decisions as it handed the values over.
        const result: LaunchResult = await recipient.launch(
          values,
          this.options.environment(),
          () => true,
        );
        ended = result === "changed" || result === "undeliverable" ? { outcome: result } : result;
      } catch {
        ended = { outcome: "failed" };
      } finally {
        for (const value of Object.values(values)) value.fill(0);
      }
      await this.end(request, ended);
    } catch {
      // The home was not reached: it ends the use itself when no take arrives.
      this.options.log?.("a Secrets use's values did not arrive from the home");
    } finally {
      this.running.delete(request);
      await recipient.dispose().catch(() => undefined);
      await this.status(request).catch(() => undefined);
    }
  }

  private async end(request: string, result: Ended): Promise<void> {
    await this.options.home.use({ op: "ended", request, result });
  }

  private bind(input: UseCheckInput, runDir: string) {
    return prepareRecipient(
      { argv: input.argv, cwd: input.cwd ?? "", env: input.env },
      runDir,
      this.options.environment().PATH ?? "",
    );
  }

  private seen(receipt: UseReceipt | null): UseReceipt | undefined {
    if (!receipt) return undefined;
    const kept = { ...receipt };
    this.receiptsSeen.set(kept.request, kept);
    return { ...kept };
  }
}
