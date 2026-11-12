The home sends the computers' live processor and memory readings (`inf:computers:resources`) as a `live` frame, `{"t":"live","channel":...,"payload":...}`, to each view whose hello lists this change: never numbered, journaled or replayed.
Each reading is whole and the next one replaces it, so one a view missed leaves nothing behind.
A phone is sent none of them, since it never shows them.
A view whose hello does not list this change is sent each of them as a `push` under the newest number already sent, which moves its cursor nowhere, so it reads them as before; the next major removes that.
A view of an older home receives them as numbered pushes, as before.
