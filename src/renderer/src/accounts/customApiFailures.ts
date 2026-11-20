import {
  CUSTOM_TOKEN_FAILURE,
  type CustomApiAnswer,
  type CustomApiFailureCategory,
  type CustomNetworkMode,
  customNetworkLabel,
} from "@shared/customApi";
import { HERE } from "@shared/deviceNames";
import { formatList } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

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
  get line() {
    return m.accountsCustomApiExceptionLine();
  },
  get tag() {
    return m.accountsCustomApiExceptionTag();
  },
} as const;

/** One DNS answer and the kind of network it points to, in the form's words. */
function answerWords(answer: CustomApiAnswer, who?: string): string {
  if (answer.kind === "reserved")
    return m.accountsCustomApiAnswerReserved({ address: answer.address });
  const label = customNetworkLabel(answer.kind, who);
  return m.accountsCustomApiAnswerKind({
    address: answer.address,
    kind: `${label.charAt(0).toLowerCase()}${label.slice(1)}`,
  });
}

/**
 * The refused destination, saying what DNS answered when the name was read:
 * a reserved answer, or answers in more than one kind of network.
 */
export function destinationWords(
  context: Pick<FailureContext, "answers" | "exceptionOffered" | "who">,
): string {
  const answers = context.answers ?? [];
  if (!answers.length) return m.accountsCustomApiDestinationRefused();
  const reserved = answers.some((answer) => answer.kind === "reserved");
  const answered = formatList(answers.map((answer) => answerWords(answer, context.who)));
  if (context.exceptionOffered)
    return reserved
      ? m.accountsCustomApiDestinationReserved({ answered })
      : m.accountsCustomApiDestinationMixed({ answered });
  const here = context.who ?? HERE.this;
  return reserved
    ? m.accountsCustomApiDestinationReservedNever({ answered, here })
    : m.accountsCustomApiDestinationMixedNever({ answered, here });
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
  const model = context.model ?? m.accountsCustomApiThisModel();
  const check = context.stage === "check";
  const operation = context.stage === "list" ? "models" : "chat/completions";
  switch (category) {
    case "address":
      return context.suggestion
        ? {
            at: "address",
            text: m.accountsCustomApiOperationAddress(),
            fix: context.suggestion,
          }
        : {
            at: "address",
            text: m.accountsCustomApiFullAddress(),
          };
    case "destination":
      return {
        at: "address",
        text: destinationWords(context),
      };
    case "network":
      return {
        at: "address",
        text: m.accountsCustomApiUnreachable({ host }),
      };
    case "timeout":
    case "stalled":
      return check
        ? { at: "row", text: m.accountsCustomApiTestSlow({ model }) }
        : { at: "address", text: m.accountsCustomApiHostSlow({ host }) };
    case "certificate":
      return context.network === "private"
        ? {
            at: "address",
            text: m.accountsCustomApiCertificateAdd({ host }),
            askCertificate: true,
          }
        : { at: "address", text: m.accountsCustomApiCertificate({ host }) };
    case "redirect":
      return {
        at: "address",
        text: m.accountsCustomApiRedirect(),
      };
    case "not-found": {
      if (check && context.listed)
        return { at: "row", text: m.accountsCustomApiNotOffered({ model }) };
      const fix = withV1(base);
      // A missing list is no failure on its own: some servers have none. When
      // the address lacks a version, it is offered the one many servers use.
      if (context.stage === "list" && !fix) return { at: "models", text: "", noList: true };
      return {
        at: "address",
        text: fix
          ? m.accountsCustomApiNothingAnsweredV1({ where, operation })
          : m.accountsCustomApiNothingAnswered({ where, operation }),
        ...(fix ? { fix } : {}),
        ...(context.stage === "list" ? { noList: true } : {}),
      };
    }
    case "key-rejected":
      return {
        at: "key",
        text: context.keyed ? m.accountsCustomApiKeyRefused() : m.accountsCustomApiKeyNeeded(),
      };
    case "access-refused":
      return {
        at: "key",
        text: m.accountsCustomApiAccessRefused(),
      };
    case "credential":
      if (context.tokenCommand)
        return {
          at: "key",
          text: CUSTOM_TOKEN_FAILURE.message,
        };
      return {
        at: "key",
        text: m.accountsCustomApiKeyFormat(),
      };
    case "header":
      return {
        at: "headers",
        text: m.accountsCustomApiHeaders(),
      };
    case "certificate-policy":
      return {
        at: "certificates",
        text: m.accountsCustomApiCertificatePolicy(),
      };
    case "rate-limit":
      return {
        at: "save",
        text: m.accountsCustomApiRateLimit(),
      };
    case "server":
      return {
        at: "save",
        text: m.accountsCustomApiServer(),
      };
    case "malformed":
    case "oversized":
      if (check)
        return {
          at: "row",
          text:
            category === "malformed"
              ? m.accountsCustomApiMalformed({ model })
              : m.accountsCustomApiOversized({ model }),
        };
      return context.stage === "list"
        ? { at: "models", text: "", noList: true }
        : { at: "save", text: m.accountsCustomApiPrepareFailed() };
    case "incompatible":
      return check
        ? {
            at: "row",
            text: m.accountsCustomApiIncompatible({ model }),
          }
        : { at: "models", text: m.accountsCustomApiModelOnce() };
    case "limits":
    case "context-limit":
      return {
        at: "row",
        text: m.accountsCustomApiLimits(),
      };
    case "cancelled":
    case "closed":
      return { at: "save", text: m.accountsCustomApiCancelled() };
  }
}
