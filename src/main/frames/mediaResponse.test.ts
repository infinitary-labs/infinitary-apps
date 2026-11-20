import { describe, expect, it } from "vitest";
import { mediaResponse, requestedRange } from "./mediaResponse";

const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
const answer = (range: string | null) =>
  mediaResponse(range, bytes.length, "video/mp4", async ({ start, end }) =>
    bytes.slice(start, end + 1),
  );

describe("requestedRange", () => {
  it("reads one range in each of its three forms", () => {
    expect(requestedRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(requestedRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(requestedRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    // A range past the end is cut to the file; a suffix longer than it is the whole file.
    expect(requestedRange("bytes=95-500", 100)).toEqual({ start: 95, end: 99 });
    expect(requestedRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("answers a range that starts past the end as unsatisfiable", () => {
    expect(requestedRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(requestedRange("bytes=-0", 100)).toBe("unsatisfiable");
  });

  it("answers no header, a malformed one and several ranges whole", () => {
    for (const header of [
      null,
      "",
      "bytes=",
      "bytes=-",
      "items=0-1",
      "bytes=5-2",
      "bytes=0-1,4-5",
    ]) {
      expect(requestedRange(header, 100), String(header)).toBeUndefined();
    }
  });
});

describe("mediaResponse", () => {
  it("answers the whole file with 200 and says ranges are welcome", async () => {
    const response = await answer(null);
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("answers one range with 206 and exactly its bytes", async () => {
    const response = await answer("bytes=10-19");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(response.headers.get("content-length")).toBe("10");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(10, 20));
  });

  it("answers a range past the end with 416 and the file's size, reading nothing", async () => {
    let read = false;
    const response = await mediaResponse("bytes=200-", 100, "video/mp4", async () => {
      read = true;
      return new Uint8Array();
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
    expect(read).toBe(false);
  });
});
