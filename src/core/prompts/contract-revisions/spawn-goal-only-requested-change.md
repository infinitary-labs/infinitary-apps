# Spawn goals name only the requested change

The captain's spawn-goal choice on INF-1366 requires the first mate's goal to name only the change the captain asked for.
The one home is `spawn_crewmate`'s top-level `goal` parameter description, which `create_task` already references.
Anything that must stay the same goes in `constraints` as “leave … as it is”, never in the goal as a description of how the system works now.
This keeps a mistaken description of existing behavior from becoming an extra requested change.
The fixed context grows by about 6 tokens; the tool's introduction leaves the one-sentence requirement to the goal parameter.
No host parser judges a goal's meaning.
