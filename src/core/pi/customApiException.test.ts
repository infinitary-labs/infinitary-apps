import { join } from "node:path";
import type { CustomApiConnectInput } from "@shared/customApi";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CustomApiAccountOwner } from "./customApiAccounts";
import { CustomApiError } from "./customApiPolicy";

// INF-3100: a proxy app answered opencode.ai with a 198.18.0.0/15 stand-in, and
// the form refused it with no reason. The captain asked that the form say what
// DNS answered and let the person make an exception for that one address,
// shown on the connection afterwards, the default staying refused.

beforeEach(() => {
  const home = scratchDir("custom-api-exception-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("INFINITARY_LOCAL_CODESIGN_DIR", join(home, "signing"));
});
afterEach(() => vi.unstubAllEnvs());

const address = "https://opencode.example.test/inference/v1";
/** What a fake-IP proxy answered for opencode.ai in INF-3100's reproduction. */
const proxied = ["198.18.0.42", "2606:4700:10::6814:2011"];

function form(extra: Partial<CustomApiConnectInput> = {}): CustomApiConnectInput {
  return {
    label: "Behind a proxy app",
    baseUrl: address,
    approvedDestination: address,
    protocol: "openai-completions",
    key: "opaque-synthetic-secret",
    noKey: false,
    headers: [],
    unencryptedLocalApproved: false,
    allowStorageDefault: false,
    storageApproved: false,
    models: [{ id: "deepseek-chat", context: 64000, output: 8000 }],
    ...extra,
  };
}

it("tells the live line what DNS answered and offers an exception only where one may be made", async () => {
  let answers = proxied;
  const owner = new CustomApiAccountOwner(async () => answers);
  expect(await owner.address(address)).toEqual({
    destination: address,
    failure: "destination",
    answers: [
      { address: "198.18.0.42", kind: "reserved" },
      { address: "2606:4700:10::6814:2011", kind: "public" },
    ],
    exceptionOffered: true,
  });
  answers = ["104.20.32.17", "127.0.0.1"];
  expect(await owner.address(address)).toMatchObject({
    failure: "destination",
    answers: [
      { address: "104.20.32.17", kind: "public" },
      { address: "127.0.0.1", kind: "local" },
    ],
    exceptionOffered: false,
  });
  // A literal address was never answered by DNS: refused as before, with no exception.
  expect(await owner.address("https://198.18.0.42/v1")).toEqual({ failure: "destination" });
});

it("refuses by default and connects only with the person's exception for that one address", async () => {
  const resolved: string[] = [];
  let calls = 0;
  // The address and its network read the proxy's answers; the model list's own
  // request then answers this computer too, which no exception reaches.
  const owner = new CustomApiAccountOwner(async (hostname) => {
    resolved.push(hostname);
    calls += 1;
    return calls <= 1 ? proxied : [...proxied, "127.0.0.1"];
  });
  expect(await owner.connect(form())).toEqual({
    failure: { category: "destination", stage: "address" },
  });
  calls = 0;
  expect(
    await owner.connect(form({ addressException: "https://other.example.test/inference/v1" })),
  ).toEqual({ failure: { category: "destination", stage: "address" } });
  calls = 0;
  const excepted = await owner.connect(form({ addressException: address }));
  expect(excepted.view).toMatchObject({ baseUrl: address, mode: "public", addressException: true });
  expect(excepted.failure).toEqual({ category: "destination", stage: "list" });
  expect(new Set(resolved)).toEqual(new Set(["opencode.example.test"]));
});

it("binds an exception to the address it was made for, and to a name", () => {
  const owner = new CustomApiAccountOwner(async () => proxied);
  const prepared = owner.prepare({ ...form({ addressException: address }), mode: "public" });
  expect(prepared).toMatchObject({ addressException: true });
  expect(owner.prepare({ ...form(), mode: "public" }).addressException).toBeUndefined();
  expect(() =>
    owner.prepare({ ...form({ addressException: `${address}/other` }), mode: "public" }),
  ).toThrow(CustomApiError);
  const literal = "https://93.184.216.34/v1";
  expect(() =>
    owner.prepare({
      ...form({ baseUrl: literal, approvedDestination: literal, addressException: literal }),
      mode: "public",
    }),
  ).toThrow(CustomApiError);
});
