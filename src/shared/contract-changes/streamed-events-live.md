The home sends a streamed piece of a reply or its thinking (`assistant_delta`, `thinking_delta`) and a tool's start or an end that reports no usage (`tool_start`, `tool_end`) on `inf:event` as a `live` frame, `{"t":"live","channel":...,"payload":...}`, to each view whose hello lists this change: never numbered, journaled or replayed.
A tool's end that reports usage stays a numbered push.
A phone is sent none of them, since it never reads them.
A view whose hello does not list this change is sent each of them as a `push` under the newest number already sent, which moves its cursor nowhere, so it reads them as before; the next major removes that.
A view of an older home receives them as numbered pushes, as before.
