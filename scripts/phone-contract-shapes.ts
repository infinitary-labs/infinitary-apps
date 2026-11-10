/** INF-136 #7: a protocol version is usable only while the native reader can decode its responses. */
type Schema = {
  type?: string;
  const?: unknown;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  oneOf?: Schema[];
};
type ReaderContract = {
  requests: Record<string, { response: Schema }>;
  pushes: Record<string, { payload: Schema }>;
};

export function assertPhoneReaderShapes(contract: ReaderContract): void {
  const cards = { id: "string", title: "string", author: "string", body: "string", actions: "array" };
  const feed = { kind: "string", text: "string", at: "number" };
  const requireRows = (name: string, schema: Schema | undefined, fields: Record<string, string>) => {
    if (schema?.type !== "array" || schema.items?.type !== "object")
      throw new Error(`${name} must return an array of objects for the phone`);
    const row = schema.items;
    for (const [field, type] of Object.entries(fields)) {
      if (!row.required?.includes(field) || row.properties?.[field]?.type !== type)
        throw new Error(`${name} must require ${field}: ${type} for the phone decoder`);
    }
  };
  requireRows("inf:cards:list", contract.requests["inf:cards:list"]?.response, cards);
  requireRows("inf:feed:recent", contract.requests["inf:feed:recent"]?.response, feed);
  requireRows("inf:cards", contract.pushes["inf:cards"]?.payload, cards);

  // INF-64 piece 5: every required native field is guarded at the published boundary.
  const object = (schema: Schema | undefined): Schema | undefined =>
    schema?.type === "object" ? schema : schema?.anyOf?.find((part) => part.type === "object");
  const requireFields = (name: string, schema: Schema | undefined, fields: Record<string, string>) => {
    const row = object(schema);
    for (const [field, type] of Object.entries(fields)) {
      if (!row?.required?.includes(field) || row.properties?.[field]?.type !== type)
        throw new Error(`${name} must require ${field}: ${type} for the phone decoder`);
    }
  };
  const task = { id: "string", key: "string", projectId: "string", kind: "string", title: "string", status: "string", createdAt: "number", blockedBy: "array" };
  for (const [name, schema] of [
    ["inf:tasks:board", contract.requests["inf:tasks:board"]?.response],
    ["inf:tasks", contract.pushes["inf:tasks"]?.payload],
  ] as const) {
    requireFields(name, schema, { seq: "number", tasks: "array", projects: "array" });
    requireRows(name, schema?.properties?.tasks, task);
    requireRows(`${name} projects`, schema?.properties?.projects, { id: "string", name: "string" });
  }
  // INF-1854: the phone folds a board delta onto the board it holds rather than re-reading the whole board.
  const delta = contract.pushes["inf:tasks:delta"]?.payload;
  requireFields("inf:tasks:delta", delta, { baseSeq: "number", seq: "number", upserts: "array", removed: "array", projects: "array", links: "object" });
  requireRows("inf:tasks:delta upserts", delta?.properties?.upserts, task);
  requireRows("inf:tasks:delta projects", delta?.properties?.projects, { id: "string", name: "string" });
  for (const side of ["added", "removed"]) {
    requireRows(`inf:tasks:delta links ${side}`, delta?.properties?.links?.properties?.[side], { fromId: "string", toId: "string", type: "string" });
  }
  requireRows("inf:tasks:search", contract.requests["inf:tasks:search"]?.response, task);
  const detail = contract.requests["inf:tasks:detail"]?.response;
  requireFields("inf:tasks:detail", detail, task);
  requireRows("task events", detail?.properties?.events, { id: "number", at: "number", actor: "string", kind: "string", text: "string" });
  // INF-82: the character follows the first mate's real busy event, never task or socket traffic.
  const event = contract.pushes["inf:event"]?.payload;
  const busy = (event?.anyOf ?? event?.oneOf)?.find((part) => part.properties?.type?.const === "firstmate_state");
  requireFields("firstmate_state", busy, { busy: "boolean" });
  requireFields("inf:conversation:state", contract.requests["inf:conversation:state"]?.response, { busy: "boolean" });
  requireRows("inf:computers:presence", contract.requests["inf:computers:presence"]?.response, { id: "string", name: "string" });
  requireRows("inf:computers:presence push", contract.pushes["inf:computers:presence"]?.payload, { id: "string", name: "string" });
  const last = object(contract.requests["inf:conversation:last-turn"]?.response);
  requireFields("last turn", last, { you: "string" });
  requireFields("last reply", last?.properties?.reply, { text: "string" });
  const crew = contract.requests["inf:tasks:crewmate"]?.response;
  requireFields("crewmate", crew, { taskId: "string", earlier: "integer", lines: "array" });
  const line = crew?.properties?.lines?.items;
  for (const variant of line?.anyOf ?? line?.oneOf ?? [line]) requireFields("crew line", variant, { id: "string", kind: "string" });
  requireFields("live crewmate", contract.requests["inf:tasks:crewmate:live"]?.response, { text: "string" });
  requireFields("crew result", contract.requests["inf:tasks:crewmate:result"]?.response, { text: "string", cut: "integer" });
  // INF-1109: the phone's approval names each requested secret by its label, environment, reference and version.
  const approvals = contract.requests["inf:secrets:approvals"]?.response;
  requireFields("inf:secrets:approvals", approvals, { availability: "string", offered: "boolean", waiting: "array" });
  const use = { request: "string", digest: "string", expires: "number", reason: "string", recipient: "string", secrets: "array", facts: "array" };
  requireRows("waiting uses", approvals?.properties?.waiting, use);
  requireRows("requested secrets", approvals?.properties?.waiting?.items?.properties?.secrets, { ref: "string", label: "string", version: "number", environment: "string" });
  requireRows("use facts", approvals?.properties?.waiting?.items?.properties?.facts, { name: "string", value: "string" });
}
