import type { ServerResponse } from "node:http";

/**
 * Synthetic fixtures exercise the wire dialect, not a copy of the parser. A
 * reply given as pieces streams one delta per piece, as servers send tokens.
 */
export function customChatText(
  text: string | readonly string[],
  usage?: { input: number; output: number },
): string {
  const pieces = typeof text === "string" ? [text] : text;
  return (
    pieces.map((content) => chatFrame({ content })).join("") +
    chatFrame({}, "stop") +
    (usage
      ? `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } })}\n\n`
      : "") +
    "data: [DONE]\n\n"
  );
}

export function customChatCall(name: string, args: string, id = "check_call"): string {
  const midpoint = Math.floor(args.length / 2);
  return (
    chatFrame({
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: args.slice(0, midpoint) } },
      ],
    }) +
    chatFrame({ tool_calls: [{ index: 0, function: { arguments: args.slice(midpoint) } }] }) +
    chatFrame({}, "tool_calls") +
    "data: [DONE]\n\n"
  );
}

export function chatFrame(delta: object, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}

export function customResponsesText(
  text: string | readonly string[],
  usage?: { input: number; output: number },
): string {
  const pieces = typeof text === "string" ? [text] : text;
  const item = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: pieces.join("") }],
  };
  return responsesFrames(
    item,
    pieces.map((delta) => ({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta,
    })),
    usage,
  );
}

export function customResponsesCall(name: string, args: string, id = "check_call"): string {
  const item = {
    type: "function_call",
    id: "fc_1",
    call_id: id,
    name,
    arguments: args,
    status: "completed",
  };
  const midpoint = Math.floor(args.length / 2);
  return responsesFrames(item, [
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: args.slice(0, midpoint),
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: args.slice(midpoint),
    },
  ]);
}

function responsesFrames(
  item: { type: string; id: string },
  deltas: object[],
  usage?: { input: number; output: number },
): string {
  return [
    { type: "response.created", response: { id: "resp_synthetic", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    ...deltas,
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_synthetic",
        status: "completed",
        output: [item],
        ...(usage ? { usage: { input_tokens: usage.input, output_tokens: usage.output } } : {}),
      },
    },
  ]
    .map(responseFrame)
    .join("");
}

export function responseFrame(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function sendCustomStream(response: ServerResponse, stream: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  // Deliberately split JSON/arguments/UTF-8/SSE lines across socket chunks.
  const bytes = Buffer.from(stream);
  for (let offset = 0; offset < bytes.length; offset += 17)
    response.write(bytes.subarray(offset, offset + 17));
  response.end();
}
