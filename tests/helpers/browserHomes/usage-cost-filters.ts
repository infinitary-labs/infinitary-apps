import { seedCostPerTaskLedger } from "../../e2e/usage";
import type { HomeRead } from "../browserFreshHome";

/** Cost per task's read is one every home answers (`ASKED`); the tab sends no other. */
export const asked: HomeRead[] = [];

/** Five weeks of finished work across two projects, as the Usage journey seeds it. */
export default function seed(userDataDir: string): void {
  seedCostPerTaskLedger(userDataDir);
}
