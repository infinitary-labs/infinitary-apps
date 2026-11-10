import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import type { CoreServices } from "../coreServices";

type SecretHandlers = {
  [C in Extract<CoreInvokeChannel, `inf:secrets:${string}`>]: (
    ...args: InvokeRequest<C>
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/** The core dispatcher validates requests and authority before these controller calls. */
export function secretsHandlers(services: Pick<CoreServices, "secrets">): SecretHandlers {
  return {
    "inf:secrets:view": () => services.secrets.view(),
    "inf:secrets:entry": (input) => services.secrets.put(input),
    "inf:secrets:action": (input) => services.secrets.action(input),
    "inf:secrets:rehearse": (input) => services.secrets.rehearse(input),
    "inf:secrets:history": async () => (await services.secrets.exportHistory()) ?? null,
    "inf:secrets:approvals": ({ device }) => services.secrets.approvals(device),
    "inf:secrets:enroll": (input) => services.secrets.enroll(input),
    "inf:secrets:decide": (input) => services.secrets.decideRemotely(input),
  };
}
