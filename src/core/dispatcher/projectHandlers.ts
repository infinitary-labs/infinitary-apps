import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import type { CoreServices } from "../coreServices";
import { renameProject } from "./projectRename";

type ProjectHandlers = {
  [C in Extract<CoreInvokeChannel, `inf:projects:${string}`>]: (
    ...args: InvokeRequest<C>
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/** The core dispatcher validates requests and authority before these calls. */
export function projectHandlers(
  services: Pick<CoreServices, "taskProtocol" | "repos" | "tasks" | "tagging">,
): ProjectHandlers {
  return {
    "inf:projects:list": () => services.taskProtocol.projects(),
    "inf:projects:rename": (projectId, name) => renameProject(services, projectId, name),
    "inf:projects:tags": (change) => services.tasks.changeProjectTags(change),
    // Automatic tagging starts after the record opens; until then no check has counts.
    "inf:projects:tag-checks": (read) => services.tagging?.tagger.views(read) ?? [],
    "inf:projects:tag-check": (change) => {
      if (!services.tagging) throw new Error("Infinitary is still starting.");
      return services.tagging.tagger.change(change);
    },
  };
}
