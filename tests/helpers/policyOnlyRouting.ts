import type { PreparedRouteOptions, RouteOptions } from "@core/routing/router";

/**
 * Finding A moves history-dependent scoring behind preparation.
 * Policy-only routing stand-ins have no placed work to read: preserve their
 * supplied facts, while real scoring and process isolation keep their own tests.
 */
export async function preparePolicyOnlyRoute(
  options: RouteOptions = {},
): Promise<PreparedRouteOptions> {
  return { ...options, placed: { work: [], samples: [], charges: {} } };
}

export async function orderPolicyOnlyRoute<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}
