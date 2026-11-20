import { describe, expect, it } from "vitest";
import { HEAD, PR, settleWorld, TASK } from "../../../tests/helpers/settleHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { forgeLocationOf } from "../forge";
import { createChangeDelivery } from "./changeDelivery";

// Prepared-task routing: a project's first contribution choice must not redirect an approval or its cleanup.
describe("a prepared task's publication identity through its merge click", () => {
  it.each([
    { order: "before", review: false },
    { order: "after", review: false },
    { order: "before", review: true },
    { order: "after", review: true },
  ])(
    "keeps the saved target when clicked $order the choice (stored review: $review)",
    async ({ order, review }) => {
      const world = settleWorld({
        reviews: true,
        removeQueuedApproval: (taskId, removal) =>
          delivery.merges.removeQueuedApproval(taskId, removal),
      });
      const delivery = createChangeDelivery({
        tasks: world.tasks,
        repos: world.repos,
        // This project has no queue: removal must finish without reaching the host.
        forgeFor: () => {
          throw new Error("queue cleanup must not reach a host without a queue");
        },
      });
      const record = world.tasks.get(TASK);
      const repo = record?.repoId ? world.repos.get(record.repoId) : undefined;
      if (!record || !repo?.origin) throw new Error("the prepared project is missing");
      const location = forgeLocationOf(repo);
      if (!location.host || !location.owner || !location.name)
        throw new Error("the project has no host identity");
      const offer = { cardId: "card-prepared", offerId: "offer-prepared", actionId: "merge" };
      const reviewed = {
        id: "review-prepared",
        kind: "github" as const,
        host: location.host,
        owner: location.owner,
        name: location.name,
        number: PR,
        headSha: HEAD,
        base: "main",
        branch: record.branch,
        method: "squash" as const,
        title: record.title,
        at: 1,
      };
      seedDelivery(world.tasks, TASK, {
        publicationOrigin: repo.origin,
        completionOffers: [
          {
            ...offer,
            headSha: HEAD,
            prNumber: PR,
            at: 1,
            destination: { repoId: repo.id, origin: repo.origin, branch: record.branch },
          },
        ],
        ...(review ? { mergeReviews: [reviewed] } : {}),
      });
      const click = () =>
        expect(
          world.approvals.authorizeMerge(TASK, offer, false, review ? reviewed.id : undefined),
        ).toBe("standing");
      if (order === "before") click();
      const upstream = {
        id: 1,
        fullName: "examples/original",
        origin: "https://github.com/examples/original.git",
      };
      world.repos.configure(repo.id, { origin: upstream.origin });
      world.repos.setContribution(repo.id, {
        upstream,
        fork: { id: 2, fullName: `${location.owner}/${location.name}`, origin: repo.origin },
        destination: "upstream",
      });
      if (order === "after") click();
      const fresh = world.tasks.get(TASK);
      const approval = fresh?.delivery?.mergeAuthorization;
      if (!fresh || !approval) throw new Error("the merge click did not keep its approval");
      expect(approval.target).toMatchObject({
        host: location.host,
        owner: location.owner,
        name: location.name,
        prNumber: PR,
        branch: record.branch,
      });
      expect(world.approvals.preflight(fresh, approval)).toBeUndefined();
      expect(world.approvals.holdForGuidance(TASK)).toBe(1);
      await expect(world.approvals.queueMarksSettled(TASK)).resolves.toBeUndefined();
      expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization).toMatchObject({
        status: "standing",
      });
      expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization?.queueRemovals).toBeUndefined();
    },
  );
});
