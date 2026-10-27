import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// INF-816: only a disposable Actions guest, never the physical Mac behind its label.
// The kernel's VM bit is also the project's micPreflight.ts virtual-Mac reading.
export function assertInstallerEnvironment({
  platform = process.platform,
  actions = process.env.GITHUB_ACTIONS,
  runner = process.env.RUNNER_ENVIRONMENT,
  virtual = () =>
    spawnSync("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"], {
      encoding: "utf8",
      timeout: 10_000,
    }),
}: {
  platform?: string;
  actions?: string;
  runner?: string;
  virtual?: () => { status: number | null; stdout: string };
} = {}) {
  if (platform !== "darwin" || actions !== "true")
    throw new Error("Installer verification requires a disposable Actions Mac.");
  if (runner === "github-hosted") return;
  if (runner === "self-hosted") {
    const reading = virtual();
    if (reading.status === 0 && reading.stdout.trim() === "1") return;
  }
  throw new Error(
    "Installer verification refuses the physical Mac; use the placement service's virtual Mac.",
  );
}

// Keep direct launches and LaunchServices restarts on the same isolated values.
// The release fuse strips NODE_EXTRA_CA_CERTS; Node's system-store opt-in is
// separate and requires exactly "1". Only this disposable fixture opts into it.
export function installerAppEnvironment(
  home: string,
  parent: NodeJS.ProcessEnv,
): {
  env: NodeJS.ProcessEnv;
  launch: Record<string, string>;
} {
  const launch = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    INFINITARY_LOCAL_CODESIGN_DIR: join(home, "local-codesign"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    NODE_USE_SYSTEM_CA: "1",
    PI_OFFLINE: "1",
  };
  return {
    env: {
      ...Object.fromEntries(
        ["TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"].flatMap((name) =>
          parent[name] ? [[name, parent[name]]] : [],
        ),
      ),
      ...launch,
    },
    launch,
  };
}

// The feed server repeats admission in its own process. Give only that child
// the actual Actions facts, not the parent's signing environment or a made-up
// hosted identity. The installed application's restricted environment stays separate.
export function installerServerEnvironment(
  appEnv: NodeJS.ProcessEnv,
  runnerEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...appEnv,
    GITHUB_ACTIONS: runnerEnv.GITHUB_ACTIONS,
    RUNNER_ENVIRONMENT: runnerEnv.RUNNER_ENVIRONMENT,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  assertInstallerEnvironment();
