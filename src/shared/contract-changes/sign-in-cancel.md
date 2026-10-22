# A sign-in can be cancelled, and its code says when it expires

The new `inf:auth:cancel` request ends every running sign-in at once and answers any open sign-in question as cancelled (INF-842).
`inf:accounts:add` admits an optional third argument, `{ enterpriseHost }`, the GitHub Enterprise address a Copilot sign-in uses instead of asking for it.
The `device_code` auth notice admits an optional `expiresAt`, the time the code expires, so a view can say the code expired rather than show a failure.
An older home refuses the cancel request, so its sign-in runs until it ends on its own; it refuses an add that carries an Enterprise address, while an add with none works as before; and an older view ignores `expiresAt`.
