import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integrationIdSchema, integrationSecretNameSchema } from "@shared/integrations";
import { z } from "zod";

/**
 * The keys integrations sign in with (docs/integrations.md, "Keys"): the
 * secret-slot interface every binding and the service use, and the bridge
 * that keeps the values until the secret manager takes them over (INF-775,
 * the captain's q3: "Bridge now with the forge's own 0600 store pattern so
 * Gmail can be tried sooner, and move every value when the secret manager
 * lands"). Nothing outside this file reads a value back: a binding uses
 * one through the two ways the saved secret plan names - applied to one
 * request (brokered use), or handed to a program it starts (protected
 * launch) - so the secret manager can replace `FileIntegrationSecrets`
 * behind the same interface.
 */
export interface IntegrationSecrets {
  /** The slots of one integration that hold a value; never the values. */
  kept(id: string): string[];
  /** Keep a value the captain entered for a slot, replacing any earlier one. */
  put(id: string, slot: string, value: string): void;
  /** Forget one slot's value, or every value of the integration. */
  forget(id: string, slot?: string): void;
  /**
   * Brokered use: send one request with the slot's value applied as a
   * header (`prefix` before it, such as "Bearer "), or as one field of a
   * form body (a sign-in's renewal), and give back the answer. The value
   * never comes back.
   */
  request(id: string, slot: string, url: string, init: SecretRequestInit): Promise<Response>;
  /**
   * Protected launch: the environment a program the integration starts
   * receives, each named variable from its slot. The program is the
   * reviewed recipient; the caller hands this only to that program's spawn.
   */
  launchEnv(id: string, variables: Record<string, string>): Record<string, string>;
  /** Text with every kept value replaced, for every answer that leaves the seam. */
  redact(text: string): string;
}

/** One request a slot's value is applied to: in a header, or in a form body's field. */
export type SecretRequestInit = Omit<RequestInit, "headers" | "body"> & {
  headers?: Record<string, string>;
} & (
    | {
        /** The header the value goes in, such as `authorization`. */
        header: string;
        prefix?: string;
        body?: RequestInit["body"];
      }
    | {
        /** The form field the value goes in, such as `refresh_token`. */
        field: string;
        /** The form's other fields; the body is sent as `application/x-www-form-urlencoded`. */
        form: Record<string, string>;
      }
  );

/** The words a kept value is replaced with. */
export const REDACTED = "[a kept key]";

/** A refusal a caller reads as the reason: no value is kept for the slot. */
export class MissingSecret extends Error {}

const SECRETS_FILE = "secrets.json";
const fileSchema = z.record(integrationSecretNameSchema, z.string().min(1));

/**
 * The bridge: one 0700 folder per integration under
 * `userData/integrations/secrets/`, one 0600 file in it, written whole -
 * the forge's own sign-in store pattern (`ForgeSignIns`, `docs/forge.md`).
 */
export class FileIntegrationSecrets implements IntegrationSecrets {
  constructor(
    readonly root: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  kept(id: string): string[] {
    return Object.keys(this.read(id)).sort();
  }

  put(id: string, slot: string, value: string): void {
    integrationSecretNameSchema.parse(slot);
    this.write(id, { ...this.read(id), [slot]: value });
  }

  forget(id: string, slot?: string): void {
    if (slot === undefined) {
      rmSync(this.dirFor(id), { recursive: true, force: true });
      return;
    }
    const all = this.read(id);
    if (!(slot in all)) return;
    delete all[slot];
    if (Object.keys(all).length === 0) rmSync(this.dirFor(id), { recursive: true, force: true });
    else this.write(id, all);
  }

  async request(id: string, slot: string, url: string, init: SecretRequestInit): Promise<Response> {
    const value = this.valueOf(id, slot);
    if ("field" in init) {
      const { field, form, headers, ...rest } = init;
      return this.fetchImpl(url, {
        ...rest,
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...form, [field]: value }),
      });
    }
    const { header, prefix, headers, ...rest } = init;
    return this.fetchImpl(url, {
      ...rest,
      headers: { ...headers, [header]: `${prefix ?? ""}${value}` },
    });
  }

  launchEnv(id: string, variables: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(variables).map(([name, slot]) => [name, this.valueOf(id, slot)]),
    );
  }

  redact(text: string): string {
    let out = text;
    for (const value of this.everyValue()) out = out.split(value).join(REDACTED);
    return out;
  }

  private valueOf(id: string, slot: string): string {
    const value = this.read(id)[slot];
    if (value === undefined) throw new MissingSecret(`no key is kept for ${slot}`);
    return value;
  }

  /** Every kept value, longest first so one inside another is still replaced whole. */
  private everyValue(): string[] {
    let ids: string[];
    try {
      ids = readdirSync(this.root);
    } catch {
      return [];
    }
    return ids
      .filter((id) => integrationIdSchema.safeParse(id).success)
      .flatMap((id) => Object.values(this.read(id)))
      .sort((a, b) => b.length - a.length);
  }

  private dirFor(id: string): string {
    return join(this.root, integrationIdSchema.parse(id));
  }

  /** One integration's values; an unreadable file reads as none, with a warning. */
  private read(id: string): Record<string, string> {
    let raw: string;
    try {
      raw = readFileSync(join(this.dirFor(id), SECRETS_FILE), "utf8");
    } catch {
      return {};
    }
    try {
      return fileSchema.parse(JSON.parse(raw));
    } catch {
      console.warn(`[integrations] the keys of ${id} could not be read; treating them as none`);
      return {};
    }
  }

  /** Write the one file whole, never readable by anyone else even mid-write. */
  private write(id: string, all: Record<string, string>): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const dir = this.dirFor(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, SECRETS_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}
