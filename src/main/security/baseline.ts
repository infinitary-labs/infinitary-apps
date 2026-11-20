import { buildCsp } from "@shared/csp";
import type { BrowserWindow, Session, WebPreferences } from "electron";
import { isAppRendererSource, type RendererSourceOptions } from "./rendererSource";

/**
 * The non-negotiable BrowserWindow flags (docs/architecture.md section 4).
 * Passed to the window constructor and re-verified by the dev startup
 * assertion so a drive-by config edit cannot silently weaken the baseline.
 */
export const REQUIRED_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
} as const;

export function verifyWebPreferences(prefs: WebPreferences): string[] {
  const violations: string[] = [];
  for (const [key, expected] of Object.entries(REQUIRED_WEB_PREFERENCES)) {
    const actual = prefs[key as keyof WebPreferences];
    // Absent means the Electron default, which matches the baseline for every
    // flag above except sandbox - sandbox must be explicitly on.
    const effective = actual === undefined ? (key === "sandbox" ? false : expected) : actual;
    if (effective !== expected) {
      violations.push(`webPreferences.${key} must be ${expected}, found ${String(actual)}`);
    }
  }
  return violations;
}

type BaselineProbe = {
  nodeGlobalsAbsent: boolean;
  bridgePresent: boolean;
};

export function probeViolations(probe: BaselineProbe): string[] {
  const violations: string[] = [];
  if (!probe.nodeGlobalsAbsent) {
    violations.push("node globals reachable from the page (nodeIntegration or sandbox off)");
  }
  if (!probe.bridgePresent) {
    violations.push("window.infinitary bridge missing (preload or contextIsolation broken)");
  }
  return violations;
}

/**
 * Dev-build startup assertion, probing observable renderer behavior rather
 * than configuration: node globals must be unreachable and the bridge must
 * exist. CSP enforcement is proven by the e2e suite against the built app
 * (executeJavaScript runs through the devtools protocol, which is exempt from
 * page CSP, so an eval probe here would be meaningless). Throws in dev;
 * packaged builds log so a regression is never silent.
 */
export async function assertSecurityBaseline(win: BrowserWindow, isDev: boolean): Promise<void> {
  const probe = (await win.webContents.executeJavaScript(
    `({
      nodeGlobalsAbsent: typeof process === "undefined" && typeof require === "undefined",
      bridgePresent: typeof window.infinitary === "object" && window.infinitary !== null,
    })`,
  )) as BaselineProbe;
  const violations = probeViolations(probe);
  if (violations.length === 0) return;
  const message = `Security baseline violated:\n- ${violations.join("\n- ")}`;
  if (isDev) throw new Error(message);
  console.error(message);
}

/**
 * Injects the CSP into every response for our own renderer document via
 * onHeadersReceived; index.html carries the same policy as a meta fallback in
 * packaged builds (file:// responses bypass webRequest in some paths).
 */
export function installCsp(session: Session, options: RendererSourceOptions): void {
  const csp = buildCsp(
    options.devServerUrl ? { devServerOrigin: new URL(options.devServerUrl).origin } : undefined,
  );
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === "mainFrame" && isAppRendererSource(details.url, options)) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
      return;
    }
    callback({ responseHeaders: details.responseHeaders });
  });
}
