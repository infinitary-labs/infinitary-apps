import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { PlacementFact, PlacementFacts, PlacementFactsRequest } from "@shared/placement";
import { primeClaudeExecutable } from "../claude/claudeCli";
import { gitFound } from "../helper/found";
import { captureLoginPath, hostEnv } from "../hostEnv";
import { hostPlatform, thisDeviceSystem } from "../platform";
import { isExecutable } from "../userBin";
import { git } from "../workspace/git";

/**
 * The computer whose CPU and memory this computer's readings measure, the same
 * for every user of it: a system identity, never a pairing id, username, name
 * or address. A virtual machine is a computer of its own here: its readings
 * measure what its host gave it, and every user inside it reads its identity.
 */
export async function physicalComputerId(): Promise<string | null> {
  try {
    const platform = hostPlatform();
    if (platform === "darwin") {
      // Every user of this Mac, or of this virtual Mac, reads one platform UUID.
      const { stdout } = await promisify(execFile)(
        "/usr/sbin/ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        { env: hostEnv(), timeout: 5_000, maxBuffer: 64 * 1024 },
      );
      return hardwareIdentity(/"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i.exec(stdout)?.[1]);
    }
    if (platform === "linux") {
      // DMI's UUID is common to the machine's users and its containers, but
      // some systems let only root read it, and the app never runs as root.
      // There every user of the system reads its machine id instead.
      const dmi = await readFile("/sys/class/dmi/id/product_uuid", "utf8").catch(() => undefined);
      const hardware = hardwareIdentity(dmi?.trim());
      if (hardware) return hardware;
      const id = (await readFile("/etc/machine-id", "utf8")).trim();
      if (!/^[0-9a-f]{32}$/i.test(id) || /^0+$/.test(id)) return null;
      return identityHash(`fm3000-linux-machine-v1:${id.toLowerCase()}`);
    }
    return null;
  } catch {
    return null;
  }
}

/** A firmware UUID, refusing the placeholders unset firmware reports. */
function hardwareIdentity(uuid: string | undefined): string | null {
  if (!uuid || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid)) return null;
  if (/^[0f-]+$/i.test(uuid)) return null;
  return identityHash(`fm3000-physical-v1:${uuid.toLowerCase()}`);
}

function identityHash(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

/** Read only: exact program identities and the particular project's reachable refs. */
export async function readPlacementFacts(
  request: PlacementFactsRequest,
  cwd: string,
): Promise<PlacementFacts> {
  await captureLoginPath();
  const env = hostEnv();
  const tools: Record<string, PlacementFact> = {};
  await Promise.all(
    request.tools.map(async (tool) => {
      try {
        const found =
          tool === "git"
            ? await gitFound(env)
            : tool === "claude"
              ? (await primeClaudeExecutable(env)) !== undefined
              : (env.PATH ?? "")
                  .split(delimiter)
                  .filter(Boolean)
                  .some((dir) => isExecutable(join(dir, tool)));
        tools[tool] = found ? "available" : "unavailable";
      } catch {
        tools[tool] = "unknown";
      }
    }),
  );
  let projectAccess: PlacementFact = "unknown";
  if (request.origin) {
    try {
      // No clone, fetch, copied sign-ins, or generic signed-in inference.
      // The existing git runner supplies this computer's own forge sign-in.
      // A transport failure remains unknown; it is not proof of lost access.
      await git(cwd, ["ls-remote", "--", request.origin, "HEAD"], {
        timeoutMs: 5_000,
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
      projectAccess = "available";
    } catch {
      /* Unknown is never spare capacity. */
    }
  }
  const platform = thisDeviceSystem();
  return {
    ...(platform.system === "macos" || platform.system === "linux"
      ? { system: platform.system }
      : {}),
    ...(platform.chip ? { chip: platform.chip } : {}),
    physicalComputerId: await physicalComputerId(),
    tools,
    projectAccess,
  };
}
