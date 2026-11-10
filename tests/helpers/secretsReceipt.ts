import { type EndedUseReceipt, SecretRequests } from "../../src/core/secrets/requests";

/** A real completion receipt after disposal, using the Secrets coordinator with a disposable backend. */
export async function secretsReceipt(state: "completed" | "unknown"): Promise<EndedUseReceipt> {
  const owner = new SecretRequests({
    list: async () => [{ ref: "staging-service", label: "Staging", version: "1" }],
    prepare: async () => ({
      digest: "checked-staging-recipient",
      rule: "ask",
      current: async () => true,
      execute: async () => {
        if (state === "unknown")
          throw new Error("The recipient ended without reporting its result.");
        return { exitCode: 0 };
      },
      dispose: async () => {},
    }),
    authenticate: async () => true,
  });
  const request = await owner.inject({
    id: "staging-receipt",
    reason: "Check the staging service",
    env: { SERVICE_TOKEN: "staging-service" },
    argv: ["/bin/sh", "check-staging.sh"],
  });
  await owner.approve(request.request, "disposable-authentication");
  const receipt = owner.settled(request.request);
  if (!receipt || receipt.state !== state)
    throw new Error("The coordinator did not settle the fixture request.");
  return receipt;
}
