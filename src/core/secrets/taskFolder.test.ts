import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ProtectedSecrets } from "./protected";
import { SecretRequests, validInjection } from "./requests";

it("recognizes a fully qualified drive folder even when the request owner runs elsewhere", () => {
  const input = {
    id: "check",
    reason: "Check a folder",
    env: { EXAMPLE: "example" },
    argv: ["node"],
  };
  for (const cwd of ["C:\\task folder", "d:/task folder", "/task folder"]) {
    expect(validInjection({ ...input, cwd })).toBe(true);
  }
  for (const cwd of ["C:task", "\\task", "\\\\server\\share", "C:\\bad\0folder"]) {
    expect(validInjection({ ...input, cwd })).toBe(false);
  }
});

it("checks the exact program from a native task folder and waits before use", async () => {
  const cwd = realpathSync(scratchDir("secret-task-"));
  const program = realpathSync(process.execPath);
  const backend = await ProtectedSecrets.open({
    dir: scratchDir("secret-owner-"),
    custody: disposableCustody(),
    initialize: true,
    environment: () => ({ PATH: dirname(program) }),
  });
  await backend.putSecret("example", "Example", Buffer.from("invented"), { discoverable: true });
  const requests = new SecretRequests(backend);
  const input = { cwd, argv: [program, "--version"], env: { EXAMPLE: "example" } };
  for (const executable of [basename(program), program]) {
    expect(await requests.check({ ...input, argv: [executable, "--version"] })).toMatchObject({
      decision: "ask",
      folder: cwd,
      program,
    });
  }
  for (const folder of ["relative", "C:relative", "C:\\bad\0folder"]) {
    await expect(requests.check({ ...input, cwd: folder })).rejects.toThrow(
      "Invalid check request",
    );
  }
  expect(await requests.check({ ...input, cwd: join(cwd, "missing") })).toEqual({
    problem: "folder",
  });
  expect(await requests.check({ ...input, argv: [join(cwd, "missing")] })).toEqual({
    problem: "program",
  });
  expect(await requests.check({ ...input, env: { EXAMPLE: "absent" } })).toEqual({
    problem: "secret",
  });
  expect(await requests.check({ ...input, env: { LANG: "example" } })).toEqual({
    problem: "variable",
  });
  expect(requests.receipts()).toEqual([]);
  const receipt = await requests.inject({
    ...input,
    id: "example",
    reason: "Check the task folder",
  });
  expect(receipt.state).toBe("waiting");
  await requests.cancel(receipt.request);
});
