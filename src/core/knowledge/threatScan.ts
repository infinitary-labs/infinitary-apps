/**
 * Write-boundary injection/exfil scan for durable notes (Hermes' threat
 * patterns, sized to Infinitary). Defense-in-depth behind structural origin:
 * a hit refuses the write and names the pattern. Content scanning cannot
 * catch poisoned facts reliably; origin gating carries the real weight.
 */

export type ThreatHit = {
  pattern: "url-exfil" | "instruction-override" | "credential";
};

type Pattern = {
  name: ThreatHit["pattern"];
  test: (text: string) => boolean;
};

const PATTERNS: readonly Pattern[] = [
  {
    name: "instruction-override",
    test: (text) =>
      /\bignore (all )?(previous|prior|above) (instructions|prompts|rules)\b/i.test(text) ||
      /\bdisregard (your|the) (instructions|system prompt|rules)\b/i.test(text) ||
      /\byou are now (?:a |an )?(?:DAN|jailbroken|unrestricted|evil)\b/i.test(text) ||
      /<\s*\/?\s*system\s*>/i.test(text) ||
      /\[INST\]/i.test(text),
  },
  {
    name: "url-exfil",
    test: (text) =>
      /!\[[^\]]*\]\(\s*https?:\/\/[^)]+\?[^)]+\)/i.test(text) ||
      /\bhttps?:\/\/(?:webhook\.site|ngrok\.(?:io|app)|requestbin\.|pipedream\.net)\b/i.test(
        text,
      ) ||
      /\bhttps?:\/\/[^\s)]+[?&](?:data|payload|token|secret|cookie|key)=/i.test(text),
  },
  {
    name: "credential",
    test: (text) =>
      /\bsk-[a-zA-Z0-9]{10,}\b/.test(text) ||
      /\bghp_[a-zA-Z0-9]{20,}\b/.test(text) ||
      /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/.test(text) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(text) ||
      /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text) ||
      /\b(?:api[_-]?key|secret_key|password)\s*[:=]\s*\S+/i.test(text),
  },
];

/** Scan note content at the write boundary. First hit wins. */
export function scanKnowledgeThreat(content: string): ThreatHit | undefined {
  for (const pattern of PATTERNS) {
    if (pattern.test(content)) return { pattern: pattern.name };
  }
  return undefined;
}
