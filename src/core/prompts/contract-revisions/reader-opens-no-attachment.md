# An unsafe data reader opens no attachment

INF-6749's audit, finding 2, which the captain chose to start.
The captain asked for a read of agreements attached to an email.
The first mate started an unsafe data reader, which has no folder for files, so the app refused its save of the attachment; its card answered from the email's text alone, and its list of actions showed the save as `never`, which the reader and the first mate both took for the captain's setting.
A second task, an ordinary one, saved and read both files: two tasks and fourteen minutes for one read.

What the first mate is now told:

- `spawn_crewmate`'s `unsafe_data_reader` parameter says the reader has no folder for files, so it can never open an email's attachment or any other file an integration saves, and a brief that needs one is not a reader's.

Home: the `unsafe_data_reader` parameter's description, the rule the first mate reads when it chooses the shape; nothing else says it.
The first mate still chooses the shape; the host reads no word of the request.
The reader's own words change beside it, outside this contract: its list shows a file-saving action as `closed`, not `never`, and the refusal says no setting changes it and that an ordinary task can do it.
The fixed context grows by about 35 tokens.
