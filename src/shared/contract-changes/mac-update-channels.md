# Mac update channels

The local app accepts `inf:update:channel` to save a Stable or Alpha subscription and cancel the old channel’s pending download.
Update status optionally carries channel-choice availability, download/install state, progress, errors and no-update explanations; an install offer may declare that it restarts the app.
Older clients ignore the added fields, and a controlling Mac answers these requests for its own installation rather than forwarding them to its home.
The `updates.show` window command opens the available-update notice without consenting to a download or restart.
