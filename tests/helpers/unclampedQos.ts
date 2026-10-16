import type * as UtilityQos from "../../src/core/utilityQos";

/**
 * `src/core/utilityQos.ts` as on a Mac without `taskpolicy`, for the
 * `vi.mock` of a test file that chains real git (docs/test-cohorts.md,
 * "Budgets").
 *
 * On a Mac the product runs every git below the UI (`taskpolicy -c
 * utility`), where it yields to every busier process, so a case that runs
 * git after git on a Mac loaded by other runs waits on that load rather than
 * its own work and runs past its budget. A file that is not about that clamp
 * (`src/core/utilityQos.test.ts` holds it) runs its git at the test run's
 * own priority instead:
 *
 * ```ts
 * vi.mock("../utilityQos", async (importOriginal) =>
 *   (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
 * );
 * ```
 */
export async function unclampedQos(
  importOriginal: <T>() => Promise<T>,
): Promise<typeof UtilityQos> {
  const real = await importOriginal<typeof UtilityQos>();
  const host: UtilityQos.QosHost = { platform: process.platform, hasTaskpolicy: () => false };
  return { ...real, atUtilityQos: (file, args) => real.atUtilityQos(file, args, host) };
}
