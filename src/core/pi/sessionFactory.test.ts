import { beforeEach, expect, it, vi } from "vitest";
import { fakeBinding, fakeSession, fakeSessionFactory } from "../../../tests/helpers/fakeSession";
import { questionSessionSpec } from "../session/questionSession";

const calls = vi.hoisted(() => ({ loads: 0, create: vi.fn(), open: vi.fn() }));
vi.mock("./session", () => {
  calls.loads++;
  return { createPiSessionFactory: calls.create };
});

beforeEach(() => {
  vi.resetModules();
  calls.loads = 0;
  calls.create.mockReset().mockReturnValue({ ...fakeSessionFactory("pi"), open: calls.open });
  calls.open.mockReset().mockImplementation(async () => fakeSession());
});

const spec = () =>
  questionSessionSpec({
    homeDir: "/unused-fixture-home",
    binding: fakeBinding(),
    model: { provider: "fake", id: "fake" },
    instruction: "Answer the fixture question.",
  });

it("loads no backend until opened, shares only the factory, and forwards every spec unchanged", async () => {
  const { createPiSessionFactory } = await import("./sessionFactory");
  const deps = { agentDir: "/unused-fixture-store" };
  const factory = createPiSessionFactory(deps);
  expect(factory.backend).toBe("pi");
  expect(factory.controlProfile).toMatchObject({ steer: "native", backgroundWork: "host" });
  expect(calls.loads).toBe(0);
  expect(calls.create).not.toHaveBeenCalled();
  const firstSpec = spec();
  const secondSpec = spec();
  const expectedFirst = fakeSession();
  const expectedSecond = fakeSession();
  calls.open.mockResolvedValueOnce(expectedFirst).mockResolvedValueOnce(expectedSecond);
  const [first, second] = await Promise.all([factory.open(firstSpec), factory.open(secondSpec)]);
  expect(calls.loads).toBe(1);
  expect(calls.create).toHaveBeenCalledExactlyOnceWith(deps);
  expect(calls.open.mock.calls).toEqual([[firstSpec], [secondSpec]]);
  expect(calls.open.mock.calls[0]?.[0]).toBe(firstSpec);
  expect(first).toBe(expectedFirst);
  expect(second).toBe(expectedSecond);
  first.dispose();
  await first.closed();
  expect(expectedFirst.disposed).toBe(true);
  expect(expectedSecond.disposed).toBe(false);
  second.dispose();
  await second.closed();
});

it("propagates an open refusal without poisoning the factory's next open", async () => {
  const { createPiSessionFactory } = await import("./sessionFactory");
  const factory = createPiSessionFactory({ agentDir: "/unused-fixture-store" });
  const refused = new Error("The real factory refused the spec");
  calls.open.mockRejectedValueOnce(refused);
  await expect(factory.open(spec())).rejects.toBe(refused);
  const session = await factory.open(spec());
  expect(calls.create).toHaveBeenCalledTimes(1);
  expect(calls.open).toHaveBeenCalledTimes(2);
  session.dispose();
  await session.closed();
});
