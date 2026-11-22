import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import {
  PLACEMENT_FACTS_ANSWER_MS,
  PLACEMENT_FACTS_ORDER,
  type PlacementFact,
  type PlacementFacts,
  type PlacementFactsRequest,
} from "@shared/placement";
import type { ComputerSignIns } from "@shared/signIns";
import { type WorkOrderResponse, workOrders } from "@shared/work";
import { primeClaudeExecutable } from "../claude/claudeCli";
import { gitFound } from "../helper/found";
import { captureLoginPath, hostEnv } from "../hostEnv";
import { hostPlatform, thisDeviceSystem } from "../platform";
import { onSearchPath } from "../userBin";
import { git } from "../workspace/git";

/** Where Windows keeps its MachineGuid, which every account may read. */
const WINDOWS_CRYPTOGRAPHY_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";

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
    if (platform === "win32") {
      // Every account on this PC reads the one MachineGuid Windows wrote at
      // install, with no administrator; the firmware's UUID needs WMI there,
      // and some boards report one UUID shared by many PCs.
      const env = hostEnv();
      const reg = win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "reg.exe");
      const { stdout } = await promisify(execFile)(
        reg,
        ["query", WINDOWS_CRYPTOGRAPHY_KEY, "/v", "MachineGuid", "/reg:64"],
        { env, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
      );
      return windowsMachineIdentity(stdout);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A Windows PC's identity from `reg query`'s answer for its MachineGuid,
 * refusing an answer that holds none, or an all-zero or all-F one.
 */
export function windowsMachineIdentity(regAnswer: string): string | null {
  const guid = /^\s*MachineGuid\s+REG_SZ\s+(\S+)\s*$/im.exec(regAnswer)?.[1];
  if (!guid || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(guid)) return null;
  if (/^[0f-]+$/i.test(guid)) return null;
  return identityHash(`infinitary-windows-machine-v1:${guid.toLowerCase()}`);
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

/**
 * Read only: exact program identities and the particular project's reachable refs.
 *
 * Each check is read on its own, side by side, and `signal` ends the read:
 * once it aborts, the read answers at once with what it has, and a check
 * still waiting reads unknown on its own. A slow project host then costs
 * only the project-access check, never the facts already read (INF-3150:
 * the caller's limit used to drop the whole read, so every check read
 * unknown).
 */
export async function readPlacementFacts(
  request: PlacementFactsRequest,
  cwd: string,
  options: { signal?: AbortSignal } = {},
): Promise<PlacementFacts> {
  const { signal } = options;
  const ended = signal ? aborted(signal) : undefined;
  const until = <T>(work: Promise<T>): Promise<T | undefined> =>
    ended ? Promise.race([work, ended]) : work;
  const identity = until(physicalComputerId());
  await until(captureLoginPath());
  const env = hostEnv();
  const tools: Record<string, PlacementFact> = {};
  const read = async () => {
    await Promise.all(
      request.tools.map(async (tool) => {
        try {
          const found =
            tool === "git"
              ? await gitFound(env)
              : tool === "claude"
                ? (await primeClaudeExecutable(env)) !== undefined
                : onSearchPath(tool, env, hostPlatform());
          tools[tool] = found ? "available" : "unavailable";
        } catch {
          tools[tool] = "unknown";
        }
      }),
    );
  };
  const access = async (): Promise<PlacementFact> => {
    if (!request.origin || signal?.aborted) return "unknown";
    try {
      // No clone, fetch, copied sign-ins, or generic signed-in inference.
      // The existing git runner supplies this computer's own forge sign-in.
      // A transport failure remains unknown; it is not proof of lost access.
      await git(cwd, ["ls-remote", "--", request.origin, "HEAD"], {
        timeoutMs: 5_000,
        env: { GIT_TERMINAL_PROMPT: "0" },
        ...(signal ? { signal } : {}),
      });
      return "available";
    } catch {
      /* Unknown is never spare capacity. */
      return "unknown";
    }
  };
  const [projectAccess] = await Promise.all([until(access()), until(read())]);
  const platform = thisDeviceSystem();
  return {
    // A phone is no computer that runs work.
    ...(platform.system && platform.system !== "ios" ? { system: platform.system } : {}),
    ...(platform.chip ? { chip: platform.chip } : {}),
    physicalComputerId: (await identity) ?? null,
    // A copy, so a check that answers after the read ended changes nothing.
    tools: Object.fromEntries(request.tools.map((tool) => [tool, tools[tool] ?? "unknown"])),
    projectAccess: projectAccess ?? "unknown",
  };
}

function aborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

/**
 * What a computer that runs work answers the home's placement ask
 * (`PLACEMENT_FACTS_ORDER`): its facts and its own sign-ins, read side by side.
 *
 * It ends the read at `PLACEMENT_FACTS_ANSWER_MS`, the home's limit less the
 * ask's travel, and answers with what it has: a check still waiting, such as
 * a slow project host, reads unknown on its own, and sign-ins not yet listed
 * read as none known. INF-3164: nothing ended this read, and its
 * project-access check's own 5 s limit outlived the home's, so the home
 * dropped the whole answer and every check of that computer read unknown.
 */
export async function answerPlacementFacts(
  args: unknown,
  cwd: string,
  signIns: () => Promise<ComputerSignIns | null>,
): Promise<WorkOrderResponse<typeof PLACEMENT_FACTS_ORDER>> {
  const [request] = workOrders[PLACEMENT_FACTS_ORDER].request.parse(args);
  const signal = AbortSignal.timeout(PLACEMENT_FACTS_ANSWER_MS);
  const [facts, accounts] = await Promise.all([
    readPlacementFacts(request, cwd, { signal }),
    Promise.race([signIns().catch(() => null), aborted(signal).then(() => null)]),
  ]);
  return { ...facts, signIns: accounts };
}
