import { existsSync, readFileSync } from "node:fs";

type Contract = { major: number; floor: number | null };

export type PhoneReleaseArchive = {
  repository: string;
  lastRun: number;
  builds: { build: string; contract: Contract; confirmed: boolean }[];
};

const file = new URL("../packaging/phone-release-archive.json", import.meta.url);
const source = new URL("../packaging/release-source.json", import.meta.url);

/** A fixed offset for the new workflow, not a live read whose answer could change between jobs. */
export function readPhoneReleaseArchive(repository: string | undefined): PhoneReleaseArchive | null {
  if (!repository) return null;
  const current = (JSON.parse(readFileSync(source, "utf8")) as { repository: string }).repository;
  // Before the cutover the original repository numbers its own live builds as before.
  if (repository === current && current === "infinitary-labs/infinitary") return null;
  if (repository !== current) throw new Error("Only the configured source repository can release Infinitary.");
  if (!existsSync(file)) throw new Error("Pin the archived phone runs before releasing from this repository.");
  const value = JSON.parse(readFileSync(file, "utf8")) as PhoneReleaseArchive;
  if (
    !value ||
    !/^[\w.-]+\/[\w.-]+$/.test(value.repository) ||
    value.repository === current ||
    !Number.isInteger(value.lastRun) || value.lastRun < 1 || value.lastRun >= 9999 ||
    !Array.isArray(value.builds) ||
    new Set(value.builds.map(({ build }) => build)).size !== value.builds.length ||
    value.builds.some(({ build, contract, confirmed }) =>
      !/^[1-9]\d{0,3}\.1$/.test(build) || Number(build.split(".")[0]) > value.lastRun ||
      !Number.isInteger(contract?.major) || contract.major < 1 ||
      (contract.floor !== null && (!Number.isInteger(contract.floor) || contract.floor < 1 || contract.floor > contract.major)) ||
      typeof confirmed !== "boolean"
    )
  ) throw new Error("The archived phone runs are not a valid release record.");
  return value;
}
