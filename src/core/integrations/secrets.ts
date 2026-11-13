import type { BrokeredUse, SecretBroker } from "../secrets/brokers";
import type { UseState } from "../secrets/requests";

/**
 * Where an integration keeps a sign-in's key (docs/integrations.md, "Keys"):
 * in Secrets (docs/secrets.md, "App services"), as a hidden entry the
 * crew's catalog never lists, used only through a broker the binding
 * registers - so a value is applied to one checked request inside the
 * protected owner and never returns to the binding. The captain's one
 * saved decision on that broker's first use covers every later one (their
 * choice on INF-785: "One approval covers the Google sign-in").
 * `SecretsSettings` implements it; a run without Secrets keeps no key.
 */
export interface IntegrationKeys {
  /** Whether this run keeps Secrets at all; it never opens the storage to answer. */
  shown(): boolean;
  /** A fresh reference for a key about to be kept, so a move can record it first. */
  reference(label: string): Promise<string | undefined>;
  /** Keep a key under its reference (a fresh one without), answering it; undefined when Secrets cannot now. */
  keepHidden(input: { ref?: string; label: string; value: Buffer }): Promise<string | undefined>;
  /** Forget a key the integration kept; answers whether it is gone. */
  forgetHidden(ref: string): Promise<boolean>;
  /** Code registered once at composition; never data from an agent or a renderer. */
  registerBroker(broker: SecretBroker): void;
  /** One use through a registered broker, awaited to its end, with the broker's private result. */
  use(input: BrokeredUse): Promise<{ state: UseState; result?: unknown }>;
}

/** The words a key is replaced with wherever it might leave. */
export const REDACTED = "[a kept key]";
