import { LONG_SPELLING } from "@shared/codeNames";
import {
  accentFamilyOf,
  isRadiusOnScale,
  nearestColorToken,
  nearestRadiusToken,
  nearestShadowToken,
  nearestTextSizeToken,
} from "@shared/designTokens";
import { undeclaredIntegrationMessage } from "@shared/personal/manifest";
/**
 * The personal-panel adherence lint (the talk-to-personalize plan, section 6
 * layer 5; docs/personal-panels.md).
 *
 * It is the design system's voice at the one boundary where a panel's code
 * is admitted: the crewmate runs it before its report, and the host runs it
 * again when it commits the turn. Three severities, and they mean different
 * things:
 *
 * - REFUSE is for what the app will not carry at all: an emoji, an external
 *   URL in renderer code, a direct reach for the host bridge.
 * - WARN is for a value that has a token: it names the nearest one so the
 *   fix is one substitution, never a scolding.
 * - NOTE is for a shape worth a second thought - a list with no empty state.
 *
 * It REWRITES NOTHING. A lint that edits an agent's file teaches it nothing
 * and hides the rule; this one hands back findings the author reads and
 * fixes, which is the training signal (the card lint's rule, applied to
 * pixels instead of prose).
 *
 * It asks for SHAPE and for VALUES, never for the absence of words: there is
 * no phrase list here and none comes back.
 */

export type PanelLintSeverity = "refuse" | "warn" | "note";

export type PanelLintFinding = {
  /** Stable rule id, so a fix can be pointed at ("raw-color"). */
  rule: string;
  severity: PanelLintSeverity;
  /** Path as the caller gave it, relative to the extension directory. */
  file: string;
  /** 1-based. */
  line: number;
  /** What is wrong and the one fix, in the app's own voice. */
  message: string;
};

export type PanelSourceFile = { path: string; text: string };

/** The server entry, named here so a message can point at it. */
const SERVER_ENTRY_FILE = "server.ts";

/**
 * Server code runs in the core with the core's privilege: it is where an
 * extension's own data comes from, so a URL there is the point. The renderer
 * half loads nothing from the network, ever.
 */
function isServerFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return name === SERVER_ENTRY_FILE || name.endsWith(".server.ts");
}

/** Blanks comments, keeping every newline so line numbers survive. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, lead: string) => lead + " ".repeat(match.length - lead.length),
    );
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let at = 0; at < index; at += 1) if (text[at] === "\n") line += 1;
  return line;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const URL_LITERAL = /https?:\/\/[^\s"'`)]+/g;
/** The window's own bridge, under every spelling's name for it (`@shared/codeNames`). */
const HOST_BRIDGE = new RegExp(
  `\\b(?:window|globalThis)\\s*\\.\\s*(?:${Object.values(LONG_SPELLING).join("|")})\\b`,
  "g",
);
/**
 * A six- or eight-digit hex is a color whatever the context. A three-digit
 * one is ambiguous - `#186` is a pull request as often as a shade - so it
 * counts only where the line is about color. The rule is a warning, but a
 * warning on a PR number is noise, and noise is what gets a lint ignored.
 */
const HEX_COLOR = /#[0-9a-f]{6}(?:[0-9a-f]{2})?\b/gi;
const SHORT_HEX_COLOR = /#[0-9a-f]{3,4}\b/gi;
const COLOR_CONTEXT = /color|background|border|outline|fill|stroke|shadow|gradient/i;
const RGB_COLOR = /\brgba?\(\s*\d[^)]*\)/gi;
const FONT_SIZE = /font-?[sS]ize\s*:\s*["']?(\d+(?:\.\d+)?)(px)?["']?/g;
const BORDER_RADIUS = /border-?[rR]adius\s*:\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/g;
const BOX_SHADOW = /box-?[sS]hadow\s*:\s*["'`]([^"'`]+)["'`]/g;
const CSS_VAR = /var\(\s*(--[a-z0-9-]+)/gi;
const MAP_CALL = /\.map\s*\(/g;

/** Every match of a global regex, with its 1-based line. */
function matches(text: string, pattern: RegExp): { value: string; line: number; index: number }[] {
  const found: { value: string; line: number; index: number }[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    found.push({ value: match[0], line: lineOf(text, index), index });
  }
  return found;
}

function lintFile(file: PanelSourceFile): PanelLintFinding[] {
  const findings: PanelLintFinding[] = [];
  const source = withoutComments(file.text);
  const at = (line: number, rule: string, severity: PanelLintSeverity, message: string) =>
    findings.push({ rule, severity, file: file.path, line, message });

  // --- refusals -----------------------------------------------------------
  for (const line of source.split("\n").entries()) {
    const [index, text] = line;
    if (EMOJI.test(text)) {
      at(
        index + 1,
        "emoji",
        "refuse",
        "Emoji never appear in this app. Say it in words, or use a StatusDot for state.",
      );
    }
  }

  if (!isServerFile(file.path)) {
    for (const url of matches(source, URL_LITERAL)) {
      at(
        url.line,
        "external-url",
        "refuse",
        `A panel loads nothing from the network, so "${url.value}" cannot be reached from here. Fetch it in ${SERVER_ENTRY_FILE}, write the result to the store, and let the panel render the store.`,
      );
    }
  }

  for (const bridge of matches(source, HOST_BRIDGE)) {
    at(
      bridge.line,
      "host-bridge",
      "refuse",
      `Extension code never reaches for "${bridge.value}". The panel is handed what it needs as props (store, invoke, placement); privileged work belongs in ${SERVER_ENTRY_FILE}.`,
    );
  }

  // --- warnings, each naming the nearest token ----------------------------
  const lines = source.split("\n");
  const shortHex = matches(source, SHORT_HEX_COLOR).filter((found) =>
    COLOR_CONTEXT.test(lines[found.line - 1] ?? ""),
  );
  for (const color of [...matches(source, HEX_COLOR), ...shortHex, ...matches(source, RGB_COLOR)]) {
    const nearest = nearestColorToken(color.value);
    at(
      color.line,
      "raw-color",
      "warn",
      nearest
        ? `Raw color "${color.value}": use var(${nearest}), the nearest token, so the panel follows both themes.`
        : `Raw color "${color.value}": use a color token via var(), so the panel follows both themes.`,
    );
  }

  for (const size of matches(source, FONT_SIZE)) {
    const px = Number.parseFloat(/(\d+(?:\.\d+)?)/.exec(size.value)?.[1] ?? "0");
    at(
      size.line,
      "raw-font-size",
      "warn",
      `Raw font size ${px}px: use var(${nearestTextSizeToken(px)}), the nearest step on the type scale.`,
    );
  }

  for (const radius of matches(source, BORDER_RADIUS)) {
    const px = Number.parseFloat(/(\d+(?:\.\d+)?)/.exec(radius.value)?.[1] ?? "0");
    if (px === 0 || isRadiusOnScale(px)) continue;
    at(
      radius.line,
      "off-scale-radius",
      "warn",
      `Radius ${px}px is off the scale (3 / 6 / 10 / 16 / pill): use var(${nearestRadiusToken(px)}).`,
    );
  }

  for (const shadow of matches(source, BOX_SHADOW)) {
    if (shadow.value.includes("var(--")) continue;
    at(
      shadow.line,
      "off-scale-shadow",
      "warn",
      `Hand-written shadow: use var(${nearestShadowToken(shadow.value)}). Shadows are for depth only, and the scale has three steps.`,
    );
  }

  return findings;
}

/**
 * One accent per panel (design skill, VISUAL FOUNDATIONS): the ice-cyan
 * accent OR the ember OR the captain's violet lights the one current thing.
 * Two families in one panel means two things claiming to be the most
 * important. Counted across the whole extension, because a panel is read as
 * one thing however many files it is written in.
 */
function lintAccentBudget(files: PanelSourceFile[]): PanelLintFinding[] {
  const families = new Map<string, { file: string; line: number; token: string }>();
  for (const file of files) {
    if (isServerFile(file.path)) continue;
    const source = withoutComments(file.text);
    for (const used of matches(source, CSS_VAR)) {
      const token = /(--[a-z0-9-]+)/i.exec(used.value)?.[1];
      if (!token) continue;
      const family = accentFamilyOf(token);
      if (!family || families.has(family)) continue;
      families.set(family, { file: file.path, line: used.line, token });
    }
  }
  if (families.size <= 1) return [];
  const used = [...families.entries()];
  const [, second] = used[1] as [string, { file: string; line: number; token: string }];
  const names = used.map(([, where]) => `var(${where.token})`).join(" and ");
  return [
    {
      rule: "two-accents",
      severity: "warn",
      file: second.file,
      line: second.line,
      message: `This panel lights ${names}. One accent per panel: keep the family that marks the current thing and use neutral tokens (--fg-1/2/3) for the rest; --ok/--warn/--danger stay for real state.`,
    },
  ];
}

/**
 * A rendered list says what it means when it is empty. `Empty` is one quiet
 * line and costs nothing; a list that silently renders nothing reads as a
 * broken panel. A note, never a refusal: some lists genuinely cannot be
 * empty, and the author knows which.
 */
function lintEmptyStates(files: PanelSourceFile[]): PanelLintFinding[] {
  const findings: PanelLintFinding[] = [];
  for (const file of files) {
    // A list is a rendered thing, so only a file that renders can have one:
    // a `.ts` helper mapping one shape to another is not a list with no
    // empty state, and saying so would teach the author to ignore the lint.
    if (!file.path.endsWith(".tsx")) continue;
    const source = withoutComments(file.text);
    const maps = matches(source, MAP_CALL);
    if (maps.length === 0) continue;
    const guarded =
      /\bEmpty\b/.test(source) ||
      /\.length\s*===?\s*0/.test(source) ||
      /\.length\s*>\s*0/.test(source) ||
      /\.length\s*\?/.test(source);
    if (guarded) continue;
    const first = maps[0] as { line: number };
    findings.push({
      rule: "list-without-empty",
      severity: "note",
      file: file.path,
      line: first.line,
      message:
        "This list renders nothing when it is empty. Say so in one line - <Empty>No open PRs</Empty> - so an empty panel reads as calm rather than broken.",
    });
  }
  return findings;
}

/** A literal call on a panel's integrations: `integrations.call("GitHub", "read"`, `.on(`, `.show(`. */
const INTEGRATION_CALL =
  /\bintegrations\s*\.\s*(call|on|show)\s*\(\s*(["'`])([^"'`]+)\2(?:\s*,\s*(["'`])([^"'`]+)\4)?/g;

/** What a manifest names under `integrations`, by the connection's name in lowercase. */
function declaredIntegrations(
  files: PanelSourceFile[],
): Map<string, { actions: Set<string>; events: Set<string> }> | null {
  const manifest = files.find((file) => file.path === "manifest.json");
  // A panel with no manifest names no integration.
  if (!manifest) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.text);
  } catch {
    return null;
  }
  const uses = (parsed as { integrations?: unknown } | null)?.integrations;
  const declared = new Map<string, { actions: Set<string>; events: Set<string> }>();
  if (!Array.isArray(uses)) return declared;
  for (const use of uses as { integration?: unknown; actions?: unknown; events?: unknown }[]) {
    if (typeof use?.integration !== "string") continue;
    const strings = (value: unknown) =>
      new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
    declared.set(use.integration.toLowerCase(), {
      actions: strings(use.actions),
      events: strings(use.events),
    });
  }
  return declared;
}

/**
 * A literal call on an integration, action or event the manifest does not
 * name (docs/integrations.md, "Panels"): the app refuses it when it runs, in
 * these same words, so the lint says so before it does. A name the code
 * builds at run time is the app's to check.
 */
function lintIntegrations(files: PanelSourceFile[]): PanelLintFinding[] {
  const declared = declaredIntegrations(files);
  if (!declared) return [];
  const findings: PanelLintFinding[] = [];
  for (const file of files) {
    if (!/\.tsx?$/.test(file.path)) continue;
    const source = withoutComments(file.text);
    INTEGRATION_CALL.lastIndex = 0;
    for (const match of source.matchAll(INTEGRATION_CALL)) {
      const [, verb, , name = "", , second] = match;
      const use = declared.get(name.toLowerCase());
      const what: { action: string } | { event: string } | undefined =
        verb === "call" && second !== undefined
          ? { action: second }
          : verb === "on" && second !== undefined
            ? { event: second }
            : undefined;
      const named =
        use !== undefined &&
        (what === undefined ||
          ("action" in what ? use.actions.has(what.action) : use.events.has(what.event)));
      if (named) continue;
      findings.push({
        rule: "undeclared-integration",
        severity: "refuse",
        file: file.path,
        line: lineOf(source, match.index ?? 0),
        message: undeclaredIntegrationMessage(name, use === undefined ? undefined : what),
      });
    }
  }
  return findings;
}

/** Every finding for one extension, refusals first, then by file and line. */
export function lintPanelSources(files: PanelSourceFile[]): PanelLintFinding[] {
  const order: Record<PanelLintSeverity, number> = { refuse: 0, warn: 1, note: 2 };
  const findings = [
    ...files.flatMap(lintFile),
    ...lintAccentBudget(files),
    ...lintEmptyStates(files),
    ...lintIntegrations(files),
  ];
  return findings.sort(
    (left, right) =>
      order[left.severity] - order[right.severity] ||
      left.file.localeCompare(right.file) ||
      left.line - right.line,
  );
}

/** A refused extension is not mounted: the author fixes it and runs again. */
export function panelLintRefused(findings: readonly PanelLintFinding[]): boolean {
  return findings.some((finding) => finding.severity === "refuse");
}

/** The findings as the crewmate's tool reads them back. */
export function formatPanelLint(findings: readonly PanelLintFinding[]): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map(
      (finding) =>
        `${finding.severity}: ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`,
    )
    .join("\n");
}
