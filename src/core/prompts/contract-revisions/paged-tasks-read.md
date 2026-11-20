# A long task read pages by field and offset

INF-416 piece K, from the captain's Approve and build on the audit plan.
The by-key `tasks` read compressed a long record with `$ref` pointers and `$text` blocks, a format only that read used.
The first mate has no file read, so a result the client saves to a file is a result it cannot finish.
Workflow logs already continue from an offset, and a GitHub read already continues from the next page.
This read now does the same.

The task query view carries the newest card body once.
A closing card or offer body identical to that body is omitted from `resolution`, while its action, answers and other metadata stay there.
A differing historical body is retained, and stored records never change.
A by-key read whose view fits 50,000 characters keeps its heading and indented JSON.
A longer one keeps the fields that fit and names each remaining field and its length.
`field` and `offset` read one named field from a 1-based character offset, and `nextOffset` continues it.
A string field is its own text.
Any other field is JSON.
Each page fits that same band, in characters and in UTF-8 bytes.
The 100,000-token cap stays the outer limit.

Each rule this revision adds names its one home:

- That a long by-key read names the remaining fields is the `tasks` description.
- What `field` reads, and that it applies only with a key, is the `field` parameter.
- What `offset` counts, and that `nextOffset` continues, is the `offset` parameter.
- That identical closing bodies appear only in `card` is the `tasks` description.
- Reading remaining fields before acting is the page index's answer.
- A queued update's declaration, including `[]` for none, is its own `blocked_by` parameter rather than a reference to another tool.
- The same declaration in a refused call is explained in that refusal's answer.
