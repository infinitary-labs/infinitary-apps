A paired view may ask every request of a task's browser: `inf:browser:watch`, `inf:browser:unwatch`, `inf:browser:size` and `inf:browser:input` become core requests, and `inf:browser:stop`, `inf:browser:reopen`, `inf:browser:take`, `inf:browser:return` and `inf:cards:open-page` move from the home's own to any view's.
The home sends a watched page's pictures as `inf:browser:frame` in a new frame, `{"t":"live","channel":...,"payload":...}`, to the connection that watches alone, never numbered, journaled or replayed.
A view whose connection drops asks to watch again once it is back.
An older home refuses these requests, and a view that knows its home does not list this change says to update Infinitary there instead of asking.
An older device ignores a `live` frame, and never asks to watch.
