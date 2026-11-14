import { KEY_FORMATS } from "../keyFormats.ts";

const SYSTEM_PROMPT_MARKERS = [
  "You are the first mate aboard Infinitary, the user's calm desktop first officer",
  "You are a crewmate: a background worker aboard Infinitary",
  "You are Firstmate 3000, the user's calm desktop first officer",
  "You are a crewmate: a background worker aboard Firstmate 3000",
];

// Explicit best-effort enumeration, not a completeness claim. Values under
// these structural names are always redacted; adding names remains a judgment.
const SENSITIVE_NAMES = [
  { normalized: "apikey", words: ["api", "key"], suffix: true },
  { normalized: "authorization", words: ["authorization"], suffix: true },
  { normalized: "accesstoken", words: ["access", "token"], suffix: true },
  { normalized: "refreshtoken", words: ["refresh", "token"], suffix: true },
  { normalized: "personalaccesstoken", words: ["personal", "access", "token"], suffix: true },
  { normalized: "csrftoken", words: ["csrf", "token"], suffix: true },
  { normalized: "xsrftoken", words: ["xsrf", "token"], suffix: true },
  { normalized: "token", words: ["token"], suffix: true },
  { normalized: "secretkey", words: ["secret", "key"], suffix: true },
  { normalized: "secret", words: ["secret"], suffix: true },
  { normalized: "password", words: ["password"], suffix: true },
  { normalized: "passwd", words: ["passwd"], suffix: true },
  { normalized: "passphrase", words: ["passphrase"], suffix: true },
  { normalized: "credential", words: ["credential"], suffix: true },
  { normalized: "credentials", words: ["credentials"], suffix: true },
  { normalized: "cookie", words: ["cookie"], suffix: true },
  { normalized: "sessionid", words: ["session", "id"], suffix: true },
  { normalized: "session", words: ["session"], suffix: true },
  { normalized: "privatekey", words: ["private", "key"], suffix: true },
  { normalized: "accesskey", words: ["access", "key"], suffix: true },
  { normalized: "signingkey", words: ["signing", "key"], suffix: true },
  { normalized: "connectionstring", words: ["connection", "string"], suffix: true },
  { normalized: "sshkey", words: ["ssh", "key"], suffix: true },
  { normalized: "encryptionkey", words: ["encryption", "key"], suffix: true },
  { normalized: "serviceaccountkey", words: ["service", "account", "key"], suffix: true },
  { normalized: "recoverycode", words: ["recovery", "code"], suffix: true },
  { normalized: "authentication", words: ["authentication"], suffix: false },
  { normalized: "oauth", words: ["oauth"], suffix: false },
  { normalized: "jwt", words: ["jwt"], suffix: false },
  { normalized: "otp", words: ["otp"], suffix: false },
  { normalized: "totp", words: ["totp"], suffix: false },
  { normalized: "auth", words: ["auth"], suffix: false },
  { normalized: "bearer", words: ["bearer"], suffix: false },
  { normalized: "csrf", words: ["csrf"], suffix: false },
  { normalized: "xsrf", words: ["xsrf"], suffix: false },
  { normalized: "dsn", words: ["dsn"], suffix: false },
  { normalized: "pat", words: ["pat"], suffix: false },
] as const;

const sensitiveNamePattern = (suffix: boolean): string =>
  SENSITIVE_NAMES.filter((name) => name.suffix === suffix)
    .map((name) => name.words.join("[\\s_.-]*"))
    .join("|");
const SUFFIX_NAME_PATTERN = sensitiveNamePattern(true);
const WHOLE_NAME_PATTERN = sensitiveNamePattern(false);
const KEY_CHARACTERS = "A-Za-z0-9._\\-";
const B64TOKEN_CHARACTERS = `${KEY_CHARACTERS}~+/`;
const BEARER_TOKEN_PATTERN = `[${B64TOKEN_CHARACTERS}]+=*`;
const BEARER_VALUE_PATTERN = `Bearer\\s+${BEARER_TOKEN_PATTERN}`;
const SENSITIVE_KEY_PATTERN =
  `(?<![${KEY_CHARACTERS}])["']?(?:` +
  `[A-Za-z0-9_.-]*(?:${SUFFIX_NAME_PATTERN})|` +
  `(?:[A-Za-z0-9]+[_.-])*(?:${WHOLE_NAME_PATTERN})` +
  `)["']?`;
const QUOTED_VALUE_PATTERN = `"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'`;
const SHELL_QUOTED_VALUE_PATTERN = `\\$(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`;
const UNQUOTED_VALUE_PATTERN = `(?:\\\\.|[^\\s,'"}\\\\])+`;
const SENSITIVE_HEADER_PATTERN = new RegExp(
  `${SENSITIVE_KEY_PATTERN}\\s*:\\s*(?:${QUOTED_VALUE_PATTERN}|[^\\r\\n]*)`,
  "gi",
);
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `${SENSITIVE_KEY_PATTERN}\\s*=\\s*` +
    `(?:${BEARER_VALUE_PATTERN}|${SHELL_QUOTED_VALUE_PATTERN}|${QUOTED_VALUE_PATTERN}|${UNQUOTED_VALUE_PATTERN})`,
  "gi",
);
const BEARER_PATTERN = new RegExp(`\\b${BEARER_VALUE_PATTERN}`, "gi");

// The issuer formats come from their one owner, in the order this list has
// always had: a label's pattern run before or after them writes other words.
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [KEY_FORMATS.anthropic, "[redacted api key]"],
  [KEY_FORMATS.openai, "[redacted api key]"],
  [KEY_FORMATS.xai, "[redacted api key]"],
  [KEY_FORMATS.github, "[redacted token]"],
  [KEY_FORMATS.githubPat, "[redacted token]"],
  [KEY_FORMATS.gitlab, "[redacted token]"],
  [SENSITIVE_HEADER_PATTERN, "[redacted credential]"],
  [BEARER_PATTERN, "Bearer [redacted]"],
  [SENSITIVE_ASSIGNMENT_PATTERN, "[redacted credential]"],
  [KEY_FORMATS.privateKey, "[redacted key]"],
  [KEY_FORMATS.awsKeyId, "[redacted api key]"],
  [KEY_FORMATS.slack, "[redacted token]"],
];

/**
 * Strip secrets and system prompts before anything Observe-shaped crosses
 * IPC. In-place replacements keep surrounding transcript readable.
 */
export function redactObserveText(text: string): string {
  if (!text) return text;
  for (const marker of SYSTEM_PROMPT_MARKERS) {
    if (text.includes(marker)) return "[system prompt redacted]";
  }
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * The same redaction, applied to every string ANYWHERE in a value: nested
 * objects, arrays, and object keys alike.
 *
 * The offline exporters compose their output out of joined strings (an
 * evidence line, a rationale, a tally key), so redacting each input on its
 * way in cannot be the whole story - a credential can be assembled by the
 * join itself. Running this over a finished record is what makes "no
 * credential survives in any output field" a property of the output rather
 * than a claim about every call site. Key order is preserved so a record
 * still round-trips through JSON unchanged apart from the redaction.
 */
export function redactDeep<T>(value: T): T {
  return redactUnknown(value, false) as T;
}

const SENSITIVE_KEYS: ReadonlySet<string> = new Set(SENSITIVE_NAMES.map((name) => name.normalized));

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (SENSITIVE_KEYS.has(normalized)) return true;
  const finalSegment = key
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .at(-1);
  return SENSITIVE_NAMES.some((name) =>
    name.suffix ? normalized.endsWith(name.normalized) : finalSegment === name.normalized,
  );
}

function redactUnknown(value: unknown, sensitive: boolean): unknown {
  if (sensitive) return "[redacted credential]";
  if (typeof value === "string") return redactObserveText(value);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, false));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[redactObserveText(key)] = redactUnknown(entry, sensitive || isSensitiveKey(key));
    }
    return out;
  }
  return value;
}
