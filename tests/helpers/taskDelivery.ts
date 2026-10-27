import type { TaskDelivery } from "../../src/core/storage/taskStore";
import type { DeliveryObservation, TaskService } from "../../src/core/tasks/taskService";

/**
 * Deliberate fixture injection of saved facts, including older mixed records.
 * Product code cannot call this private transactional primitive: it uses
 * the evidence, permission, validation and execution operations instead.
 * Keeping fixture injection explicit avoids granting the product a broad writer.
 */
export function seedDelivery(
  tasks: TaskService,
  id: string,
  saved: Partial<TaskDelivery>,
  event?: DeliveryObservation,
): void {
  const fixture = tasks as unknown as {
    writeDeliveryRecords(
      id: string,
      saved: Partial<TaskDelivery>,
      event?: DeliveryObservation,
    ): void;
  };
  fixture.writeDeliveryRecords(id, saved, event);
}
