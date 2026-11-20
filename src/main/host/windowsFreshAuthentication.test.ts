import { describe, expect, it } from "vitest";
import {
  accountOf,
  createWindowsFreshAuthentication,
  HELLO_AVAILABILITY,
  parameterizedIid,
  type WindowsAuthenticationApi,
} from "./windowsFreshAuthentication";

// Intent: the captain's answers on INF-4260: "Add Secrets on Windows first"
// and Take over confirmed "with Windows Hello on that PC, or your Windows
// password when Hello is off". A dismissed Hello approves nothing and never
// falls back to the password (docs/secrets.md, "Trusted approvals").

/** Records which of Windows' dialogs a confirmation asked, answering as each case names. */
function windows(answers: {
  availability: number | undefined;
  hello?: number | "unstarted";
  password?: boolean;
}) {
  const asked: string[] = [];
  const api: WindowsAuthenticationApi = {
    helloAvailability: async () => answers.availability,
    helloVerify: async (reason, window) => {
      asked.push(`hello:${reason}:${window ? "window" : "alone"}`);
      return answers.hello ?? -1;
    },
    passwordConfirm: async (reason) => {
      asked.push(`password:${reason}`);
      return answers.password ?? false;
    },
  };
  return { api, asked };
}

const VERIFIED = 0;
const CANCELED = 6;
const window = () => Buffer.alloc(8, 1);

describe("Windows fresh authentication", () => {
  it("confirms with Windows Hello, in the app's window, when Hello is set up", async () => {
    const { api, asked } = windows({ availability: HELLO_AVAILABILITY.available, hello: VERIFIED });
    const confirm = createWindowsFreshAuthentication({ window }, api);
    expect(await confirm?.available()).toBe(true);
    expect(await confirm?.confirm("Allow Deploy key")).toBe(true);
    expect(asked).toEqual(["hello:Allow Deploy key:window"]);
  });

  it("never falls back to the password after a dismissed Hello", async () => {
    const { api, asked } = windows({
      availability: HELLO_AVAILABILITY.available,
      hello: CANCELED,
      password: true,
    });
    expect(await createWindowsFreshAuthentication({}, api)?.confirm("Allow")).toBe(false);
    expect(asked).toEqual(["hello:Allow:alone"]);
  });

  it.each([
    HELLO_AVAILABILITY.notConfiguredForUser,
    HELLO_AVAILABILITY.disabledByPolicy,
    HELLO_AVAILABILITY.deviceNotPresent,
    undefined,
  ])("asks for the Windows password where Hello answers %s", async (availability) => {
    const { api, asked } = windows({ availability, password: true });
    expect(await createWindowsFreshAuthentication({}, api)?.confirm("Allow")).toBe(true);
    expect(asked).toEqual(["password:Allow"]);
    const refused = windows({ availability, password: false });
    expect(await createWindowsFreshAuthentication({}, refused.api)?.confirm("Allow")).toBe(false);
  });

  it("asks for the password when Windows could not show Hello at all, and refuses while it is busy", async () => {
    const unstarted = windows({
      availability: HELLO_AVAILABILITY.available,
      hello: "unstarted",
      password: true,
    });
    expect(await createWindowsFreshAuthentication({}, unstarted.api)?.confirm("Allow")).toBe(true);
    expect(unstarted.asked).toEqual(["hello:Allow:alone", "password:Allow"]);

    const busy = windows({ availability: HELLO_AVAILABILITY.deviceBusy, password: true });
    expect(await createWindowsFreshAuthentication({}, busy.api)?.confirm("Allow")).toBe(false);
    expect(busy.asked).toEqual([]);
  });

  it("asks one confirmation at a time, and a failed one still lets the next ask", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const api: WindowsAuthenticationApi = {
      helloAvailability: async () => HELLO_AVAILABILITY.available,
      helloVerify: async (reason) => {
        order.push(`start:${reason}`);
        if (reason === "first") await new Promise<void>((resolve) => (release = resolve));
        if (reason === "second") throw new Error("Hello went away");
        order.push(`end:${reason}`);
        return VERIFIED;
      },
      passwordConfirm: async () => false,
    };
    const confirm = createWindowsFreshAuthentication({}, api);
    const first = confirm?.confirm("first");
    const second = confirm?.confirm("second");
    const third = confirm?.confirm("third");
    while (order.length === 0) await new Promise((resolve) => setImmediate(resolve));
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(await third).toBe(true);
    expect(order).toEqual(["start:first", "end:first", "start:second", "start:third", "end:third"]);
  });
});

describe("the Windows Runtime ids", () => {
  it("derives a parameterized interface's id as Windows does", () => {
    // IAsyncOperation<bool>, as windows.foundation.h publishes it.
    expect(parameterizedIid("pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};b1)")).toBe(
      "cdb5efb3-5788-509d-9be1-71ccb8a3362a",
    );
  });
});

describe("accountOf", () => {
  it("splits the name Windows' dialog answers into the account LogonUserW takes", () => {
    expect(accountOf("MicrosoftAccount\\sam@example.com", "")).toEqual([
      "sam@example.com",
      "MicrosoftAccount",
    ]);
    expect(accountOf("DESKTOP-4F2\\sam", "")).toEqual(["sam", "DESKTOP-4F2"]);
    expect(accountOf("sam@corp.example", "")).toEqual(["sam@corp.example", null]);
    expect(accountOf("sam", "")).toEqual(["sam", "."]);
    expect(accountOf("sam", "CORP")).toEqual(["sam", "CORP"]);
  });
});
