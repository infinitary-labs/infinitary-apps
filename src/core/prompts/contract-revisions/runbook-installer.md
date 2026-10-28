# Add and remove runbooks through the existing installer

INF-1482 implements the captain's accepted INF-1177 piece 3.
The existing `install_plugin` tool admits a runbook from a folder, git or npm as pinned guidance only, through the same captain-only host consent card as panels.
Its description owns the runbook contents, declared replacement, separate consent for an included panel and the `remove` action naming an added runbook id.
The core operate paragraph now names both a panel and a runbook, leaving the consent instructions in the tool.
No new tool or card effect is added; the expanded description costs roughly 70 tokens, measured with the fixed-context gate.
