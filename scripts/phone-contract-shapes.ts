/** INF-136 #7: a protocol version is usable only while the native reader can decode its responses. */
type Schema = {
  type?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
};
type ReaderContract = {
  requests: Record<string, { response: Schema }>;
  pushes: Record<string, { payload: Schema }>;
};

export function assertPhoneReaderShapes(contract: ReaderContract): void {
  const cards = { id: "string", title: "string", author: "string" };
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
}
