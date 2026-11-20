import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type HandleRead, windowsStdin } from "./windowsStdin";

/**
 * The typed yes of `work join` on Windows (INF-4260's piece 10): the
 * installed app's join on a fresh Windows 11 PC read no answer, since
 * Electron ends `process.stdin` there, so it reads the input handle itself.
 * Review INF-4743: a read at a console waits for the person's next Enter,
 * and the first reader read the handle on the main thread and again before
 * and after the answer, so the second account's join stalled after "yes".
 */
describe("what a person types into the work mode on Windows", () => {
  /**
   * The handle as it answers: each piece in turn, an EAGAIN where a pipe has
   * nothing yet, then its end; a console instead waits for the next line,
   * which never comes, once its pieces are read.
   */
  function handle(answers: readonly (string | "EAGAIN")[], console = false) {
    const left = [...answers];
    const asked = { count: 0, waiting: 0 };
    const read: HandleRead = (into, done) => {
      asked.count += 1;
      const next = left.shift();
      setImmediate(() => {
        if (next === undefined) {
          if (console) asked.waiting += 1;
          else done(null, 0);
        } else if (next === "EAGAIN")
          done(Object.assign(new Error("EAGAIN"), { code: "EAGAIN" }), 0);
        else done(null, into.write(next));
      });
    };
    return { read, asked };
  }

  /** The join's ask, as the work mode asks it (`terminalIO`, src/core/helper/cli.ts). */
  function ask(read: HandleRead): Promise<string> {
    return new Promise((resolve) => {
      const reader = createInterface({
        input: windowsStdin(read, true),
        output: new PassThrough(),
      });
      let answered = false;
      reader.question("Join? ", (answer) => {
        answered = true;
        reader.close();
        resolve(answer);
      });
      reader.once("close", () => {
        if (!answered) resolve("");
      });
    });
  }

  it("answers the yes a person typed at a console, and asks the console for nothing more", async () => {
    const { read, asked } = handle(["ye", "s\r\n"], true);
    expect(await ask(read)).toBe("yes");
    await new Promise((settled) => setTimeout(settled, 20));
    expect(asked).toEqual({ count: 2, waiting: 0 });
  });

  it("waits through a pipe that has nothing yet", async () => {
    expect(await ask(handle(["EAGAIN", "EAGAIN", "yes\n"]).read)).toBe("yes");
  });

  it("ends with no answer when nothing came in", async () => {
    expect(await ask(handle([]).read)).toBe("");
    expect(
      await ask((_into, done) =>
        setImmediate(() => done(Object.assign(new Error("EBADF"), { code: "EBADF" }), 0)),
      ),
    ).toBe("");
  });
});
