/**
 * How a demo recording is answered (docs/card-authoring.md "Demo
 * recordings"): a `<video>` asks for its file a range at a time, to start
 * playing before it has every byte and to seek without reading from the
 * start, so the answer honours one byte range - 206 with the part asked for,
 * 416 for a range past the end - and the whole file otherwise. Several
 * ranges in one request are answered with the whole file, which HTTP allows
 * and no media player asks for.
 */

/** The part of a file one request asks for, inclusive at both ends. */
export type ByteRange = { start: number; end: number };

/**
 * What a `Range` header asks of a file of `size` bytes: the one range,
 * `unsatisfiable` for a range that starts past the end, or `undefined` for
 * no header, a malformed one or several ranges - each answered whole.
 */
export function requestedRange(
  header: string | null | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    // The last N bytes.
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return undefined;
  return { start, end };
}

/** The headers every answer for a recording carries. */
function mediaHeaders(contentType: string, length: number): Record<string, string> {
  return {
    "content-type": contentType,
    "content-length": String(length),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    // Read from its file each time, never kept in the browser's cache: a
    // recording is up to 16 MB, and the task's folder already keeps it.
    "cache-control": "no-store",
  };
}

/**
 * The answer for one request of a recording of `size` bytes: `read` gives
 * the bytes of the range to send (a stream, so a file is never held whole)
 * and is called only once the range is known to be in the file.
 */
export async function mediaResponse(
  rangeHeader: string | null | undefined,
  size: number,
  contentType: string,
  read: (range: ByteRange) => Promise<BodyInit>,
): Promise<Response> {
  const range = requestedRange(rangeHeader, size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${size}`, "x-content-type-options": "nosniff" },
    });
  }
  if (!range) {
    return new Response(size === 0 ? null : await read({ start: 0, end: size - 1 }), {
      status: 200,
      headers: mediaHeaders(contentType, size),
    });
  }
  return new Response(await read(range), {
    status: 206,
    headers: {
      ...mediaHeaders(contentType, range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}
