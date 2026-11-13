import { canonical, sha256 } from "./custody";

/** JSON inputs only. The trusted adapter owns validation, transport and result handling. */
export type BrokerInput =
  | null
  | boolean
  | number
  | string
  | BrokerInput[]
  | { [key: string]: BrokerInput };

/** References and checked facts, never values or a full request body. */
export type BrokerFacts = {
  broker: string;
  label: string;
  destination: string;
  operation: string;
  inputDigest: string;
  /** A trusted adapter's declaration, never a requester's flag or an HTTP-method guess. */
  read: boolean;
  result: string;
  secrets: Record<string, string>;
};

export type BrokeredUse = {
  id: string;
  reason: string;
  broker: string;
  input: BrokerInput;
};

/**
 * Registered code only, injected at composition by the consumer's owner.
 * Neither a command, an IPC request nor a saved file registers an adapter.
 * The prepared closure binds the same checked inputs its facts describe.
 * Its result is for its trusted consumer, not the agent/receipt/UI surface.
 */
export type SecretBroker = {
  id: string;
  /**
   * The adapter spends a sign-in the person made in the app itself, at an
   * address its own code names (docs/secrets.md, "App sign-ins"). That sign-in
   * is the consent: a use naming only hidden entries runs with no question.
   */
  signIn?: true;
  prepare(input: BrokerInput): Promise<PreparedBroker | undefined>;
};

export type PreparedBroker = {
  facts: BrokerFacts;
  run(values: Readonly<Record<string, Buffer>>): Promise<unknown>;
  dispose?(): Promise<void>;
};

/** A changed submitted body under the same intent never executes a second operation. */
export function brokerInputDigest(input: BrokeredUse): string {
  return sha256(
    canonical({ kind: "broker", broker: input.broker, reason: input.reason, input: input.input }),
  );
}

export function validBrokeredUse(input: BrokeredUse): boolean {
  return (
    !!input &&
    Object.keys(input).every((key) => ["id", "reason", "broker", "input"].includes(key)) &&
    typeof input.id === "string" &&
    input.id.length > 0 &&
    typeof input.reason === "string" &&
    input.reason.trim().length > 0 &&
    typeof input.broker === "string" &&
    input.broker.length > 0 &&
    jsonInput(input.input)
  );
}

function jsonInput(value: unknown): value is BrokerInput {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonInput);
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(jsonInput)
  );
}
