import type { TaskQueryRow } from "../../src/core/tasks/taskQuery";

/** Read in-result references and verbatim blocks as an agent does; never fetch another record. */
export function readTaskQueryText(text: string): TaskQueryRow[] {
  const at = text.indexOf("\n\nText #/");
  const rows: unknown = JSON.parse(text.slice(text.indexOf("["), at < 0 ? undefined : at));
  const blocks = new Map<string, string>();
  let rest = at < 0 ? "" : text.slice(at);
  while (rest) {
    const header = /^\n\nText (#[^\n ]+) \((\d+) UTF-16 units\):\n/.exec(rest);
    if (!header) throw new Error("Unreadable task text block");
    const length = Number(header[2]);
    blocks.set(header[1]!, rest.slice(header[0].length, header[0].length + length));
    rest = rest.slice(header[0].length + length);
  }
  const expand = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, at) => expand(item, `${path}/${at}`));
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.$text === "number") {
      const block = blocks.get(path);
      if (block?.length !== object.$text) throw new Error("A task text block must stay complete");
      return block;
    }
    if (Object.keys(object).length === 1 && typeof object.$ref === "string") {
      if (!object.$ref.startsWith("#/"))
        throw new Error("A task reference must stay in its result");
      let target: unknown = rows;
      for (const segment of object.$ref.slice(2).split("/")) {
        const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
        target = (target as Record<string, unknown>)[key];
      }
      if (target === undefined) throw new Error("A task reference must name complete content");
      return expand(target, object.$ref);
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [
        key,
        expand(item, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
      ]),
    );
  };
  return expand(rows, "#") as TaskQueryRow[];
}
