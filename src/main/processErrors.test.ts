import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { installMainProcessErrorHandlers } from "./processErrors";

it("owns uncaught exceptions and unhandled rejections without throwing", () => {
  const processEvents = new EventEmitter();
  const log = vi.fn();
  installMainProcessErrorHandlers(
    { on: (event, listener) => processEvents.on(event, listener) },
    log,
  );
  const exception = new Error("boom");
  const rejection = new Error("nope");

  expect(() => processEvents.emit("uncaughtException", exception)).not.toThrow();
  expect(() =>
    processEvents.emit("unhandledRejection", rejection, Promise.resolve()),
  ).not.toThrow();
  expect(log).toHaveBeenNthCalledWith(1, "uncaught main-process exception", exception);
  expect(log).toHaveBeenNthCalledWith(2, "unhandled main-process rejection", rejection);
});
