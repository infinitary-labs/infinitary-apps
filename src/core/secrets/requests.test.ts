import { describe, expect, it, vi } from "vitest";
import { type Injection, type PreparedUse, SecretRequests, type SecretsBackend } from "./requests";

// Intent: INF-1085's disposable first piece, amended by INF-1093's operation boundary.
const input: Injection = {
  id: "check-staging",
  reason: "Check the staging service",
  env: { SERVICE_TOKEN: "s1" },
  argv: ["/bin/sh", "check-staging.sh"],
};
function fixture() {
  let now = 1_000;
  const execute = vi.fn(async () => ({ exitCode: 7 }));
  const dispose = vi.fn(async () => {});
  const prepared: PreparedUse = {
    digest: "checked-operation-and-secret-version",
    rule: "ask",
    current: async () => true,
    execute,
    dispose,
  };
  const backend: SecretsBackend = {
    list: async () => [{ ref: "s1", label: "Staging", version: "1" }],
    prepare: vi.fn(async () => prepared),
    authenticate: async (_request, digest, _expires, proof) =>
      digest === prepared.digest && proof === "disposable-authentication",
  };
  const changed = vi.fn();
  return {
    owner: new SecretRequests(backend, () => now, changed),
    prepared,
    backend,
    execute,
    dispose,
    changed,
    advance: () => {
      now += 300_000;
    },
  };
}

describe("Secrets operation authority (disposable adapters only)", () => {
  it("waits without running, authenticates the checked digest, consumes once and returns exit status only", async () => {
    const f = fixture();
    const request = await f.owner.inject(input);
    expect(request.state).toBe("waiting");
    expect(f.execute).not.toHaveBeenCalled();
    expect((await f.owner.approve(request.request, "agent-written-approval"))?.state).toBe(
      "waiting",
    );
    await Promise.all([
      f.owner.approve(request.request, "disposable-authentication"),
      f.owner.approve(request.request, "disposable-authentication"),
    ]);
    expect(f.owner.status(request.request)).toEqual({
      request: request.request,
      state: "completed",
      exitCode: 7,
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(await f.owner.inject(input)).toEqual(f.owner.status(request.request));
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent identical intents but rejects altered arguments under that intent", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.owner.inject(input), f.owner.inject(input)]);
    expect(a).toEqual(b);
    expect(f.backend.prepare).toHaveBeenCalledTimes(1);
    await expect(f.owner.inject({ ...input, argv: ["/bin/sh", "changed.sh"] })).rejects.toThrow(
      "different operation",
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "expired", "invalidated"] as const)(
    "never launches a %s request",
    async (state) => {
      const f = fixture();
      const request = await f.owner.inject(input);
      if (state === "cancelled") await f.owner.cancel(request.request);
      if (state === "expired") f.advance();
      if (state === "invalidated") f.prepared.current = async () => false;
      await f.owner.approve(request.request, "disposable-authentication");
      expect(f.owner.status(request.request)?.state).toBe(state);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it("does not let cancellation claim to undo a sent operation", async () => {
    const f = fixture();
    let finish!: (result: { exitCode: number }) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.prepared.execute = () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      });
    const request = await f.owner.inject(input);
    const approval = f.owner.approve(request.request, "disposable-authentication");
    await began;
    expect((await f.owner.cancel(request.request))?.state).toBe("executing");
    finish({ exitCode: 0 });
    await approval;
    expect(f.owner.status(request.request)?.state).toBe("completed");
  });

  it("keeps backend failures private, marks ambiguous effects unknown and never retries", async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error("invented-credential-must-not-appear"));
    const request = await f.owner.inject(input);
    await f.owner.approve(request.request, "disposable-authentication");
    expect(f.owner.status(request.request)).toEqual({ request: request.request, state: "unknown" });
    expect(JSON.stringify(f.changed.mock.calls)).not.toContain("invented-credential");
    await f.owner.approve(request.request, "disposable-authentication");
    await f.owner.inject(input);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("refuses missing protection before policy and does not infer any task authority", async () => {
    const f = fixture();
    f.backend.prepare = async () => undefined;
    expect((await f.owner.inject(input)).state).toBe("unavailable");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.owner.status("another-task-label")).toBeUndefined();
  });

  it("reports cleanup failure honestly rather than certifying erasure", async () => {
    const f = fixture();
    f.dispose.mockRejectedValue(new Error("cleanup failed"));
    const request = await f.owner.inject(input);
    await f.owner.cancel(request.request);
    expect(f.owner.status(request.request)?.state).toBe("unknown");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("refuses approval when revalidation itself crosses the request expiry", async () => {
    const f = fixture();
    f.prepared.current = async () => {
      f.advance();
      return true;
    };
    const request = await f.owner.inject(input);
    await f.owner.approve(request.request, "disposable-authentication");
    expect(f.owner.status(request.request)?.state).toBe("invalidated");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["PATH", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "INFINITARY_AXI_KEY"])(
    "refuses the %s control mapping before preparing",
    async (name) => {
      const f = fixture();
      await expect(f.owner.inject({ ...input, env: { [name]: "s1" } })).rejects.toThrow(
        "Invalid injection",
      );
      expect(f.backend.prepare).not.toHaveBeenCalled();
    },
  );

  it("denies Never without authentication or execution", async () => {
    const f = fixture();
    f.prepared.rule = "never";
    const request = await f.owner.inject(input);
    expect(request.state).toBe("denied");
    await f.owner.approve(request.request, "disposable-authentication");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it("keeps human denial final for repeated intent submissions", async () => {
    const f = fixture();
    const request = await f.owner.inject(input);
    await f.owner.deny(request.request);
    expect((await f.owner.inject(input)).state).toBe("denied");
    await f.owner.approve(request.request, "disposable-authentication");
    expect(f.execute).not.toHaveBeenCalled();
  });
});
