import type {
  HostBrowserOpen,
  HostBrowserPage,
  HostChromeFallback,
  InstalledBrowser,
} from "@core/host";

/** Internal launch override: ordinary journeys pin built-in; Chrome trials pin Chrome. */
export const ENGINE_SWITCH = "INFINITARY_TASK_BROWSER_ENGINE";

export function installedEngineOrder(env: NodeJS.ProcessEnv): readonly InstalledBrowser[] {
  switch (env[ENGINE_SWITCH]) {
    case "built-in":
      return [];
    case "chrome":
      return ["chrome"];
    default:
      return ["chrome", "edge"];
  }
}

type Open = (input: HostBrowserOpen) => Promise<HostBrowserPage>;

export async function openInEngine(
  input: HostBrowserOpen,
  engines: {
    installed: readonly { kind: InstalledBrowser; open: Open }[];
    builtIn: Open;
    declined: (error: unknown) => { reason: HostChromeFallback } | undefined;
    log: (line: string) => void;
  },
): Promise<HostBrowserPage> {
  let fallback: HostChromeFallback | undefined;
  for (const { kind, open } of engines.installed) {
    try {
      return await open(input);
    } catch (error) {
      const declined = engines.declined(error);
      if (!declined) throw error;
      fallback = declined.reason;
      engines.log(`[task-browser] ${kind} declined (${fallback}): ${String(error)}`);
    }
  }
  const page = await engines.builtIn(input);
  page.engine = { kind: "built-in", ...(fallback ? { fallback } : {}) };
  return page;
}
