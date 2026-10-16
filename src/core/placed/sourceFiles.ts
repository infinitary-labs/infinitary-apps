import { closeSync, openSync, readSync, statSync } from "node:fs";
import { PLACED_COPY_CHUNK_BYTES, workOrders } from "@shared/work";
import { sha256Of } from "../workspace/bundles";
import type { WorkDevices } from "./workDevices";

/** Send a file outside the working copy, and name it only after the destination verifies it. */
export async function sendSourceFile(
  devices: WorkDevices,
  machine: string,
  task: string,
  name: string,
  file: string,
): Promise<string> {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  const bytes = Buffer.alloc(PLACED_COPY_CHUNK_BYTES);
  try {
    const sha256 = await sha256Of(file);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
      if (!read) throw new Error("The source file changed while being sent.");
      const answer = workOrders["inf:session:source-file"].response.parse(
        await devices.ask(machine, "inf:session:source-file", [
          {
            task,
            name,
            size,
            sha256,
            offset,
            data: bytes.subarray(0, read).toString("base64"),
          },
        ]),
      );
      offset += read;
      if (answer.complete) return answer.file;
    }
    throw new Error("The source file did not arrive whole.");
  } finally {
    closeSync(fd);
  }
}
