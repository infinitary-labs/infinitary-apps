# Update panel on a paused panel

INF-2470's build, grounded on its plan (the captain's "Approve and build", direction A, "Start the update at once", and "No, the line on the panel is enough" for a notice after an app update).
A panel of the captain's whose `server.ts` is written for a panel API the app no longer serves now shows that its background work is paused, with an Update panel button.
The new `panel-update-asked` wake owns the rule: the captain pressed Update panel, so the first mate starts one personal-workspace task at once, with no card first, to update that panel's code, and starts nothing when a task is already updating it.
The surfaces context marks a paused panel on its row, and whether the captain pressed Update panel.
The wake costs about 150 tokens per press; the surfaces row grows only while a panel is paused, and the fixed context does not grow.
