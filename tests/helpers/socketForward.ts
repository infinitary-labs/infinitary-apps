import { createServer, connect as dialTcp, type Socket } from "node:net";
import { join } from "node:path";
import { socketScratchDir } from "./scratchDirs";

/**
 * A private socket that carries each connection to a port on loopback, as
 * OpenSSH's reverse forward does on the Mac it forwards to
 * (docs/helper.md, "Through the home's SSH"): a stand-in for the far end of
 * the home's SSH connection, in a folder only this user may enter. A real
 * OpenSSH forward is src/core/devices/remoteLogin.test.ts's.
 */
export type SocketForward = {
  /** The socket's path. */
  readonly socket: string;
  /** How many connections it carried. */
  carried: () => number;
  /** Cuts every connection it carries now, as a dropped SSH connection does; it still listens. */
  cut: () => void;
  /** Cuts every connection and stops listening. */
  close: () => Promise<void>;
};

/** A forward to `port`, at `socket` when the far end said where, else in a folder of its own. */
export async function forwardSocket(
  port: number,
  socket = join(socketScratchDir("fm-f-"), "h"),
): Promise<SocketForward> {
  const carrying = new Set<Socket>();
  let carried = 0;
  const server = createServer((device) => {
    carried += 1;
    const home = dialTcp(port, "127.0.0.1");
    for (const end of [device, home]) {
      carrying.add(end);
      end.once("close", () => carrying.delete(end));
    }
    device.on("error", () => home.destroy());
    home.on("error", () => device.destroy());
    device.pipe(home).pipe(device);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const cut = () => {
    for (const end of carrying) end.destroy();
  };
  return {
    socket,
    carried: () => carried,
    cut,
    close: () => {
      cut();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
