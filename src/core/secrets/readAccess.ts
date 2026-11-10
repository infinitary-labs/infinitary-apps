import { randomUUID } from "node:crypto";
import { SHORT_READ_SECONDS, SHORT_READ_USES } from "@shared/secrets";

export { SHORT_READ_SECONDS, SHORT_READ_USES } from "@shared/secrets";

export type ReadPermission = {
  id: string;
  key: string;
  label: string;
  destination: string;
  secrets: string[];
  expires: number;
  remaining: number;
};

/**
 * Volatile exact-operation permission, owned by ProtectedSecrets.
 * The key includes home, protected policy revision, operation facts and secret versions.
 * Task/project labels never create authority; this is not a protected per-task ACL.
 * Consumption is synchronous before any effect or await, so racing reads share one count.
 * Nothing survives restart, restore, a version/policy change or End access.
 */
export class ReadAccess {
  private readonly permissions = new Map<string, ReadPermission>();

  constructor(private readonly now: () => number) {}

  grant(facts: Pick<ReadPermission, "key" | "label" | "destination" | "secrets">): string {
    this.endKey(facts.key);
    const id = randomUUID();
    this.permissions.set(id, {
      ...structuredClone(facts),
      id,
      expires: this.now() + SHORT_READ_SECONDS * 1000,
      remaining: SHORT_READ_USES,
    });
    return id;
  }

  find(key: string): ReadPermission | undefined {
    return this.list().find((permission) => permission.key === key);
  }

  consume(id: string, key: string): boolean {
    const permission = this.permissions.get(id);
    if (
      !permission ||
      permission.key !== key ||
      this.now() >= permission.expires ||
      permission.remaining <= 0
    )
      return false;
    permission.remaining -= 1;
    return true;
  }

  list(): ReadPermission[] {
    for (const [id, permission] of this.permissions) {
      if (this.now() >= permission.expires || permission.remaining <= 0)
        this.permissions.delete(id);
    }
    return [...this.permissions.values()].map((permission) => structuredClone(permission));
  }

  end(id?: string): void {
    if (id === undefined) this.permissions.clear();
    else this.permissions.delete(id);
  }

  private endKey(key: string): void {
    for (const permission of this.permissions.values()) {
      if (permission.key === key) this.permissions.delete(permission.id);
    }
  }
}
