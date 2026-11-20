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
  it("pauses an unfinished preparation before an automatic rule can launch it", async () => {
    // INF-1109 recovery must drain the coordinator before snapshotting its history.
    const f = fixture();
    let finish!: () => void;
    let begin!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const preparation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.prepared.rule = "allow";
    f.backend.prepare = async () => {
      begin();
      await preparation;
      return f.prepared;
    };
    const submission = f.owner.inject(input);
    await began;
    const pausing = f.owner.pauseForRecovery();
    expect((await f.owner.inject({ ...input, id: "during-pause" })).state).toBe("unavailable");
    finish();
    const receipt = await submission;
    const resume = await pausing;
    expect(resume).toBeTypeOf("function");
    expect(f.owner.status(receipt.request)?.state).toBe("invalidated");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledWith("invalidated");
    resume?.();
    f.prepared.rule = "ask";
    expect((await f.owner.inject({ ...input, id: "after-pause" })).state).toBe("waiting");
  });

  it("drains an already-started authentication without starting its effect during recovery", async () => {
    const f = fixture();
    let finish!: (allowed: boolean) => void;
    let begin!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const confirmation = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    f.backend.authenticate = async () => {
      begin();
      return confirmation;
    };
    const receipt = await f.owner.inject(input);
    const approving = f.owner.approve(receipt.request, "disposable-authentication");
    await began;
    let acquired = false;
    const pausing = f.owner.pauseForRecovery().then((resume) => {
      acquired = true;
      return resume;
    });
    expect(acquired).toBe(false);
    finish(true);
    await approving;
    const resume = await pausing;
    expect(acquired).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.owner.status(receipt.request)?.state).toBe("invalidated");
    resume?.();
  });

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
  it("publishes the terminal wake only after cleanup can no longer change its outcome", async () => {
    // INF-1109: the task's completion wake must not claim success before private cleanup settles.
    const f = fixture();
    let began!: () => void;
    const disposing = new Promise<void>((resolve) => {
      began = resolve;
    });
    let fail!: () => void;
    const cleanup = new Promise<void>((_resolve, reject) => {
      fail = () => reject(new Error("disposable cleanup failure"));
    });
    f.dispose.mockImplementation(async () => {
      began();
      await cleanup;
    });
    const requested = await f.owner.inject(input);
    const approval = f.owner.approve(requested.request, "disposable-authentication");
    await disposing;
    expect(f.owner.settled(requested.request)).toBeUndefined();
    expect(f.changed.mock.calls.at(-1)?.[0].state).toBe("executing");
    fail();
    await approval;
    expect(f.owner.settled(requested.request)?.state).toBe("unknown");
    expect(f.changed.mock.calls.at(-1)?.[0]).toEqual(f.owner.settled(requested.request));
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
