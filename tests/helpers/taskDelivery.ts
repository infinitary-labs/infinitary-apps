import type { TaskDelivery } from "../../src/core/storage/taskStore";
import type { TaskService } from "../../src/core/tasks/taskService";
import type { DeliveryObservation, TaskWriter } from "../../src/core/tasks/taskWriter";

/**
 * Deliberate fixture injection of saved facts, including older mixed records.
 * Product code cannot call this private transactional primitive: it uses
 * the evidence, permission, validation and execution operations instead.
 * Keeping fixture injection explicit avoids granting the product a broad writer.
 *
 * The write takes the database's write lock before it reads (`BEGIN
 * IMMEDIATE`), because a journey may age a fact in a running app's database
 * (`e2e-writer-ok`, docs/e2e-contracts.md "One writer once the app runs").
 * A transaction that reads first and writes second is refused at once, with no
 * busy wait, whenever the app holds the write lock at that moment: an alpha's
 * check-refresh journey failed with "database is locked" that way. Taking the
 * lock first waits out the app's write instead. Inside an open transaction it
 * is a savepoint, as before.
 */
export function seedDelivery(
  tasks: TaskService,
  id: string,
  saved: Partial<TaskDelivery>,
  event?: DeliveryObservation,
): void {
  const { writer } = tasks as unknown as { writer: TaskWriter };
  writer.db.transaction(() => writer.writeDeliveryRecords(id, saved, event)).immediate();
}
