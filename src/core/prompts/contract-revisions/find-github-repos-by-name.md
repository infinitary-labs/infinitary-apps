# Firstmate finds a GitHub repo by name, and a crewmate searches when it cannot

FI3-1309's build, grounded on its answer (the captain's "Fix the lookup and widen crewmate reads", after his thread question about crewmates handling such queries).
`locate_project` now reads every page of the sign-in's repo listing (100 a page, up to 1,000), looks up an exact owner/name or a pasted address on its own, matches loosely (case, spaces, dashes and underscores do not matter), and says how many repos it searched.
Its description says so.
The rule that a repo named but not found, or described rather than named, goes to a read-only investigation that searches with `github_read` before the captain is asked for a link rides in that tool description, not in the prompt, which is at its size band.
`github_read` reaches what the sign-in may read (any repository, repo lists, organizations, search); `github_write` is unchanged and stays with the task's own project, so the crewmate tool descriptions changed with it.
The new words cost the fixed part about 40 tokens by the app's count.
