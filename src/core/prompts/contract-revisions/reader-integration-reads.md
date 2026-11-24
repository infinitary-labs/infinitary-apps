# An unsafe data reader reaches the captain's integrations

The second piece of the unsafe data reader's design: a reader task may now call the captain's integrations, through a pair of typed tools, since it has no shell.

What the first mate is now told:

- `spawn_crewmate`'s `unsafe_data_reader` field says the reader reads its own project and the integrations' reads the captain set to Always allow, and that every other call it makes waits for the captain's click.

Home: the field's description on `spawn_crewmate`; no other text repeats it.
The host holds the rule itself: a reader's integration read runs only when the captain set it to Always allow and its connection is not an MCP server, every other call waits on the reader's one approval card, and every answer comes fenced as data from outside.
The fixed context grows by about ten tokens in that one field description.
