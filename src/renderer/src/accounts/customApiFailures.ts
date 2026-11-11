import {
  CUSTOM_TOKEN_FAILURE,
  type CustomApiAnswer,
  type CustomApiFailureCategory,
  type CustomNetworkMode,
  customNetworkLabel,
} from "@shared/customApi";
import { HERE } from "@shared/deviceNames";

/** Where a failure is told: beside the field at fault, on a model's row, or above Save. */
export type CustomApiFailurePlace =
  | "address"
  | "http"
  | "key"
  | "headers"
  | "certificates"
  | "models"
  | "row"
  | "save";

export type PlacedFailure = {
  at: CustomApiFailurePlace;
  text: string;
  /** An address the person can take with one press, such as the same one ending in /v1. */
  fix?: string;
  /** The list did not answer: Save goes on without it, and Fetch says the list is unavailable. */
  noList?: boolean;
  /** An organization's own certificate could fix it, so the form offers to add one. */
  askCertificate?: boolean;
};

export type FailureContext = {
  /** The address as entered or canonical; its host and path go into the sentence. */
  address: string;
  /** `address`: preparing or reading the network; `list`: the model list; `check`: a model's test. */
  stage: "address" | "list" | "check";
  /** The model the check was for. */
  model?: string;
  /** Whether the server's model list answered, which makes a 404 the model's. */
  listed?: boolean;
  /** Whether a key goes with the request, typed or kept from the saved connection. */
  keyed?: boolean;
  tokenCommand?: boolean;
  /** The network the address was read as, for where a certificate can be added. */
  network?: CustomNetworkMode;
  /** An operation address's base, offered in its place. */
  suggestion?: string;
  /** `destination`: what DNS answered for the name, read with the live line. */
  answers?: readonly CustomApiAnswer[];
  /** `destination`: whether an exception for this address can be made. */
  exceptionOffered?: boolean;
  /** The computer that reads the address, as the form names it. Absent, this Mac. */
  who?: string;
};

/** The words that show a person's exception for an address, on its line and its connection. */
export const CUSTOM_EXCEPTION_WORDS = {
  line: "Exception made for this address",
  tag: "Address exception",
} as const;

/** One DNS answer and the kind of network it points to, in the form's words. */
function answerWords(answer: CustomApiAnswer, who?: string): string {
  if (answer.kind === "reserved") return `${answer.address} (reserved)`;
  const label = customNetworkLabel(answer.kind, who);
  return `${answer.address} (${label.charAt(0).toLowerCase()}${label.slice(1)})`;
}

/** A list in words: one, "a and b", or "a, b and c". */
function listWords(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The refused destination, saying what DNS answered when the name was read:
 * a reserved answer, or answers in more than one kind of network.
 */
export function destinationWords(
  context: Pick<FailureContext, "answers" | "exceptionOffered" | "who">,
): string {
  const answers = context.answers ?? [];
  if (!answers.length)
    return "Infinitary can't send to this address: it points to a reserved address, or to more than one kind of network.";
  const why = answers.some((answer) => answer.kind === "reserved")
    ? "A reserved answer often comes from a proxy app or a DNS filter that answers for every name."
    : "They point to more than one kind of network.";
  const never = context.exceptionOffered
    ? ""
    : ` Infinitary makes no exception for an answer that points to ${context.who ?? HERE.this}, a link-local or a cloud metadata address.`;
  return `Infinitary can't send to this address. DNS answered ${listWords(answers.map((answer) => answerWords(answer, context.who)))}. ${why}${never}`;
}

function hostAndPath(address: string): { host: string; where: string; base: string } {
  try {
    const url = new URL(address.trim());
    const path = url.pathname.replace(/\/+$/, "");
    return { host: url.host, where: `${url.host}${path}`, base: `${url.origin}${path}` };
  } catch {
    const trimmed = address.trim();
    return { host: trimmed, where: trimmed, base: trimmed };
  }
}

/** The same address ending in /v1, when it does not end in a version already. */
function withV1(base: string): string | undefined {
  return /\/v\d+$/i.test(base) ? undefined : `${base}/v1`;
}

/**
 * Turns a typed failure category into a plain sentence at the place it can be
 * fixed. The category is the core's; the words and the place are the form's.
 */
export function placeCustomApiFailure(
  category: CustomApiFailureCategory,
  context: FailureContext,
): PlacedFailure {
  const { host, where, base } = hostAndPath(context.address);
  const model = context.model ?? "This model";
  const check = context.stage === "check";
  const operation = context.stage === "list" ? "models" : "chat/completions";
  switch (category) {
    case "address":
      return context.suggestion
        ? {
            at: "address",
            text: "This is the address of one operation. Use the server's base address.",
            fix: context.suggestion,
          }
        : {
            at: "address",
            text: "Enter the full address, starting with https:// or http://, with no query or sign-in in it.",
          };
    case "destination":
      return {
        at: "address",
        text: destinationWords(context),
      };
    case "network":
      return {
        at: "address",
        text: `Could not reach ${host}. Check that it is running and that you are on its network.`,
      };
    case "timeout":
    case "stalled":
      return check
        ? { at: "row", text: `${model} took too long to answer the test.` }
        : { at: "address", text: `${host} took too long to answer.` };
    case "certificate":
      return context.network === "private"
        ? {
            at: "address",
            text: `${host}'s certificate could not be verified. Add your organization's certificate below.`,
            askCertificate: true,
          }
        : { at: "address", text: `${host}'s certificate could not be verified.` };
    case "redirect":
      return {
        at: "address",
        text: "The server sent the request somewhere else. Enter the address it redirects to.",
      };
    case "not-found": {
      if (check && context.listed)
        return { at: "row", text: `This server doesn't offer ${model}.` };
      const fix = withV1(base);
      // A missing list is no failure on its own: some servers have none. When
      // the address lacks a version, it is offered the one many servers use.
      if (context.stage === "list" && !fix) return { at: "models", text: "", noList: true };
      return {
        at: "address",
        text: fix
          ? `Nothing answered at ${where}/${operation}. Many servers end in /v1.`
          : `Nothing answered at ${where}/${operation}.`,
        ...(fix ? { fix } : {}),
        ...(context.stage === "list" ? { noList: true } : {}),
      };
    }
    case "key-rejected":
      return {
        at: "key",
        text: context.keyed ? "The server refused this key." : "This server needs a key.",
      };
    case "access-refused":
      return {
        at: "key",
        text: "The server refused access. Check what this key is allowed to use.",
      };
    case "credential":
      if (context.tokenCommand)
        return {
          at: "key",
          text: CUSTOM_TOKEN_FAILURE.message,
        };
      return {
        at: "key",
        text: "Enter the key as one line of plain text, with no spaces at either end.",
      };
    case "header":
      return {
        at: "headers",
        text: "Check the extra headers: each name once with a one-line value, and no name Infinitary sets itself. A secret value is entered again for a new address.",
      };
    case "certificate-policy":
      return {
        at: "certificates",
        text: "Choose a valid public CA certificate and approve it for this connection.",
      };
    case "rate-limit":
      return {
        at: "save",
        text: "The server is limiting requests right now. Wait a moment, then press Save again.",
      };
    case "server":
      return {
        at: "save",
        text: "The server could not complete the request. Try again in a moment.",
      };
    case "malformed":
    case "oversized":
      if (check)
        return {
          at: "row",
          text:
            category === "malformed"
              ? `${model} sent a reply Infinitary could not read.`
              : `${model}'s reply was larger than the test allows.`,
        };
      return context.stage === "list"
        ? { at: "models", text: "", noList: true }
        : { at: "save", text: "Your first mate could not prepare this connection. Try again." };
    case "incompatible":
      return check
        ? {
            at: "row",
            text: `${model} didn't finish the test's tool call. Infinitary needs tool calls for work; try another model or the other API protocol.`,
          }
        : { at: "models", text: "Each model can be added once." };
    case "limits":
    case "context-limit":
      return {
        at: "row",
        text: "This server doesn't list this model's sizes. Enter its context and output tokens.",
      };
    case "cancelled":
    case "closed":
      return { at: "save", text: "The check stopped before it finished. Press Save to try again." };
  }
}
