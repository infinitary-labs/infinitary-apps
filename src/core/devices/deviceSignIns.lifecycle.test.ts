import type { DeviceSignInEvent, SignInStep } from "@shared/signIns";
import { describe, expect, it, vi } from "vitest";
import type { WorkDeviceContact } from "../connection/connection";
import { DeviceSignIns } from "./deviceSignIns";

// Remote sign-ins must survive Settings remounts and release their work on
// every end, including reconnect and replacement by another caller.
const DEVICE = { id: "work", kind: "work", name: "Work computer", pairedAt: 1 } as const;
const PROMPT = {
  providerId: "openrouter",
  promptId: "key",
  kind: "secret",
  message: "API key",
} as const;
const NOTICE = { providerId: "openrouter", kind: "info", message: "Enter your API key" } as const;

function home() {
  let contact!: (event: WorkDeviceContact) => void;
  let inReach = true;
  const events: DeviceSignInEvent[] = [];
  const feed = vi.fn();
  const ask = vi.fn(
    async (_device: string, _channel: string, _args: unknown[]): Promise<unknown> => ({ ok: true }),
  );
  const signIns = new DeviceSignIns({
    devices: () => [DEVICE, { ...DEVICE, id: "other", name: "Other computer" }],
    work: {
      ask,
      onWorkDevice: (listen) => {
        contact = listen;
        return () => {};
      },
      inReach: () => inReach,
      version: () => undefined,
    },
    emit: (channel, payload) => {
      if (channel === "inf:devices:sign-in") events.push(payload as DeviceSignInEvent);
    },
    broadcastEvent: feed,
  });
  return {
    signIns,
    ask,
    events,
    feed,
    reach: (value: boolean) => {
      inReach = value;
    },
    contact: (state: WorkDeviceContact["contact"]) =>
      contact({ deviceId: DEVICE.id, contact: state }),
  };
}

function step(signIns: DeviceSignIns, signInId: string, value: SignInStep) {
  return signIns.step(DEVICE.id, { signInId, step: value });
}

describe("remote sign-in lifecycle guardrails", () => {
  it("records early prompts and notices, forwards an answer once and broadcasts one successful end", async () => {
    const h = home();
    h.ask.mockImplementation(async (_device, channel, args) => {
      if (channel === "inf:sign-ins:start") {
        const { signInId } = args[0] as { signInId: string };
        step(h.signIns, signInId, { kind: "notice", notice: NOTICE });
        step(h.signIns, signInId, { kind: "prompt", prompt: PROMPT });
      }
      return { ok: true };
    });
    try {
      const { signInId } = await h.signIns.start(DEVICE.id, "openrouter", "api_key");
      expect(h.events.map((event) => event.step)).toEqual([
        { kind: "notice", notice: NOTICE },
        { kind: "prompt", prompt: PROMPT },
      ]);
      expect(h.signIns.view()[0]?.flows).toEqual([
        {
          signInId,
          deviceId: DEVICE.id,
          providerId: "openrouter",
          target: "account",
          phase: "running",
          prompt: PROMPT,
          notice: NOTICE,
        },
      ]);
      await h.signIns.answer(signInId, PROMPT.promptId, "sk-or-v1-pasted-key");
      expect(h.signIns.view()[0]?.flows?.[0]?.prompt).toBeUndefined();
      await expect(h.signIns.answer(signInId, PROMPT.promptId, "duplicate")).rejects.toThrow(
        "no longer waiting",
      );
      expect(h.ask.mock.calls.at(-1)).toEqual([
        DEVICE.id,
        "inf:sign-ins:answer",
        [{ signInId, promptId: PROMPT.promptId, value: "sk-or-v1-pasted-key" }],
      ]);
      step(h.signIns, signInId, { kind: "ended", outcome: "signed-in", accountId: "account" });
      expect(h.feed).toHaveBeenCalledTimes(1);
      await expect(h.signIns.answer(signInId, PROMPT.promptId, "late")).rejects.toThrow(
        "no longer running",
      );
      await h.signIns.cancel(signInId);
      expect(h.events.filter((event) => event.step.kind === "ended")).toHaveLength(1);
      expect(JSON.stringify(h.signIns.view())).not.toContain("sk-or-v1-pasted-key");
    } finally {
      h.signIns.dispose();
    }
  });

  it("releases a refused start and a cancellation whose computer cannot be reached", async () => {
    const h = home();
    try {
      h.ask.mockRejectedValueOnce(new Error("connection closed"));
      await expect(h.signIns.start(DEVICE.id, "openrouter", "api_key")).rejects.toThrow(
        "connection closed",
      );
      const { signInId } = await h.signIns.start(DEVICE.id, "openrouter", "api_key", "account");
      h.ask.mockRejectedValueOnce(new Error("connection closed"));
      await h.signIns.cancel(signInId);
      await h.signIns.cancel(signInId);
      expect(h.events.at(-1)).toMatchObject({
        signInId,
        accountId: "account",
        step: { kind: "ended", outcome: "cancelled" },
      });
      expect(h.events.filter((event) => event.signInId === signInId)).toHaveLength(1);
    } finally {
      h.signIns.dispose();
    }
  });

  it("ends every running sign-in once when contact goes and never broadcasts a failed sign-in as connected", async () => {
    const h = home();
    try {
      const first = await h.signIns.start(DEVICE.id, "openrouter", "api_key");
      step(h.signIns, first.signInId, {
        kind: "ended",
        outcome: "failed",
        error: "Provider refused sign-in",
      });
      const second = await h.signIns.start(DEVICE.id, "xai", "oauth");
      h.contact("gone");
      h.contact("gone");
      expect(
        h.events.filter((event) => event.step.kind === "ended").map((event) => event.signInId),
      ).toEqual([first.signInId, second.signInId]);
      expect(h.feed).not.toHaveBeenCalled();
    } finally {
      h.signIns.dispose();
    }
  });
  it("ends an old-link sign-in when a replacement connection arrives before gone", async () => {
    const h = home();
    try {
      const { signInId } = await h.signIns.start(DEVICE.id, "openrouter", "api_key");
      h.contact("in-reach");
      expect(h.ask.mock.calls).toContainEqual([DEVICE.id, "inf:sign-ins:cancel", [{ signInId }]]);
      expect(
        h.events.filter((event) => event.signInId === signInId && event.step.kind === "ended"),
      ).toHaveLength(1);
      await expect(h.signIns.answer(signInId, PROMPT.promptId, "late")).rejects.toThrow(
        "no longer running",
      );
    } finally {
      h.signIns.dispose();
    }
  });
  it("publishes a forge's code, retains a failure without its prompt and ignores steps after that end", async () => {
    const h = home();
    try {
      h.signIns.changed(DEVICE.id, {
        providers: [],
        accounts: [],
        quota: null,
        forges: { signIns: [], hosts: [{ host: "github.com", name: "GitHub" }] },
      });
      const { signInId } = await h.signIns.startForge(DEVICE.id, "github.com");
      const notice = {
        providerId: "github.com",
        kind: "device_code",
        message: "Enter this code",
        userCode: "WDJB-MJHT",
        url: "https://github.com/login/device",
      } as const;
      step(h.signIns, signInId, { kind: "notice", notice });
      expect(h.signIns.read()[0]?.flows?.[0]).toMatchObject({
        signInId,
        target: "forge",
        phase: "running",
        notice,
        link: notice.url,
      });
      const ended = { kind: "ended", outcome: "failed", error: "The code expired" } as const;
      step(h.signIns, signInId, ended);
      step(h.signIns, signInId, ended);
      step(h.signIns, signInId, { kind: "prompt", prompt: PROMPT });
      expect(h.signIns.view()[0]?.flows?.[0]).toMatchObject({ phase: "ended", ended });
      expect(h.signIns.view()[0]?.flows?.[0]?.prompt).toBeUndefined();
      expect(h.events.filter((event) => event.step.kind === "ended")).toHaveLength(1);
      await h.signIns.cancel(signInId);
      expect(h.signIns.view()[0]?.flows).toEqual([]);
      expect(h.feed).not.toHaveBeenCalled();
    } finally {
      h.signIns.dispose();
    }
  });

  it("cancels even when no terminal step comes back and cannot let a late prompt revive the flow", async () => {
    const h = home();
    try {
      const { signInId } = await h.signIns.start(DEVICE.id, "openrouter", "api_key");
      step(h.signIns, signInId, { kind: "prompt", prompt: PROMPT });
      await h.signIns.cancel(signInId);
      expect(h.signIns.view()[0]?.flows).toEqual([]);
      expect(() => step(h.signIns, signInId, { kind: "prompt", prompt: PROMPT })).toThrow(
        "No sign-in",
      );
      expect(h.events.filter((event) => event.step.kind === "ended")).toHaveLength(1);
    } finally {
      h.signIns.dispose();
    }
  });
  it("claims an answer before sending it, preserves a newer prompt and restores only a refused send", async () => {
    const h = home();
    try {
      const { signInId } = await h.signIns.start(DEVICE.id, "openrouter", "api_key");
      step(h.signIns, signInId, { kind: "prompt", prompt: PROMPT });
      let finish!: () => void;
      h.ask.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ ok: true });
          }),
      );
      const sending = h.signIns.answer(signInId, PROMPT.promptId, "sk-or-v1-disposable-key");
      await expect(h.signIns.answer(signInId, PROMPT.promptId, "duplicate")).rejects.toThrow(
        "no longer waiting",
      );
      const next = { ...PROMPT, promptId: "next-question" };
      step(h.signIns, signInId, { kind: "prompt", prompt: next });
      finish();
      await sending;
      expect(h.signIns.view()[0]?.flows?.[0]?.prompt).toEqual(next);
      h.ask.mockRejectedValueOnce(new Error("The computer did not accept this answer"));
      await expect(h.signIns.answer(signInId, next.promptId, "answer")).rejects.toThrow(
        "did not accept",
      );
      expect(h.signIns.view()[0]?.flows?.[0]?.prompt).toEqual(next);
      expect(JSON.stringify(h.signIns.view())).not.toContain("sk-or-v1-disposable-key");
    } finally {
      h.signIns.dispose();
    }
  });
  it("publishes preflight refusals through the same end and never sends an order to an unreachable computer", async () => {
    const h = home();
    try {
      h.reach(false);
      await expect(h.signIns.start(DEVICE.id, "openrouter", "api_key")).rejects.toThrow(
        "no sign-in started",
      );
      expect(h.ask).not.toHaveBeenCalled();
      const flow = h.signIns.view()[0]?.flows?.[0];
      expect(flow).toMatchObject({ phase: "ended", ended: { outcome: "failed" } });
      expect(h.events.filter((event) => event.step.kind === "ended")).toHaveLength(1);
      if (!flow) throw new Error("The refusal has no published sign-in");
      await h.signIns.cancel(flow.signInId);
      expect(h.signIns.view()[0]?.flows).toEqual([]);
    } finally {
      h.signIns.dispose();
    }
  });
  it("cancels interrupted work when contact returns after gone, without losing its terminal explanation", async () => {
    const h = home();
    try {
      const { signInId } = await h.signIns.start(DEVICE.id, "openrouter", "api_key");
      h.reach(false);
      h.contact("gone");
      expect(h.ask.mock.calls.filter((call) => call[1] === "inf:sign-ins:cancel")).toEqual([]);
      h.reach(true);
      h.contact("in-reach");
      expect(h.ask.mock.calls).toContainEqual([DEVICE.id, "inf:sign-ins:cancel", [{ signInId }]]);
      expect(h.signIns.view()[0]?.flows?.[0]).toMatchObject({
        signInId,
        phase: "ended",
        ended: { outcome: "failed" },
      });
      expect(
        h.events.filter((event) => event.signInId === signInId && event.step.kind === "ended"),
      ).toHaveLength(1);
    } finally {
      h.signIns.dispose();
    }
  });

  it.each(["account", "forge"] as const)(
    "replaces a %s flow in core even while its start acknowledgement is in flight",
    async (target) => {
      const h = home();
      let acknowledge: (() => void) | undefined;
      try {
        h.signIns.changed(DEVICE.id, {
          providers: [],
          accounts: [],
          quota: null,
          forges: { signIns: [], hosts: [{ host: "github.com", name: "GitHub" }] },
        });
        const other = await h.signIns.start("other", "openrouter", "api_key");
        const independent =
          target === "account"
            ? await h.signIns.startForge(DEVICE.id, "github.com")
            : await h.signIns.start(DEVICE.id, "openrouter", "api_key");
        const channel = target === "account" ? "inf:sign-ins:start" : "inf:sign-ins:forge";
        let holdFirst = true;
        h.ask.mockImplementation(async (_device, asked) => {
          if (asked === channel && holdFirst) {
            holdFirst = false;
            await new Promise<void>((resolve) => {
              acknowledge = resolve;
            });
          }
          return { ok: true };
        });
        const start = () =>
          target === "account"
            ? h.signIns.start(DEVICE.id, "openrouter", "api_key")
            : h.signIns.startForge(DEVICE.id, "github.com");
        const pending = start();
        const predecessor = h.signIns.view()[0]?.flows?.find((flow) => flow.target === target);
        if (!predecessor || !acknowledge)
          throw new Error("The first start did not reach its acknowledgement");
        const replacement = await start();
        acknowledge();
        expect(await pending).toEqual({ signInId: predecessor.signInId });
        expect(h.ask.mock.calls.filter((call) => call[1] === "inf:sign-ins:cancel")).toEqual([
          [DEVICE.id, "inf:sign-ins:cancel", [{ signInId: predecessor.signInId }]],
        ]);
        expect(
          h.signIns
            .view()[0]
            ?.flows?.filter((flow) => flow.target === target)
            .map((flow) => flow.signInId),
        ).toEqual([replacement.signInId]);
        expect(
          h.signIns.view()[0]?.flows?.some((flow) => flow.signInId === independent.signInId),
        ).toBe(true);
        expect(h.signIns.view()[1]?.flows?.map((flow) => flow.signInId)).toEqual([other.signInId]);
        expect(() =>
          step(h.signIns, predecessor.signInId, { kind: "prompt", prompt: PROMPT }),
        ).toThrow("No sign-in");
        await h.signIns.cancel(replacement.signInId);
        expect(
          h.signIns.view()[0]?.flows?.some((flow) => flow.signInId === replacement.signInId),
        ).toBe(false);
      } finally {
        acknowledge?.();
        h.signIns.dispose();
      }
    },
  );
});
