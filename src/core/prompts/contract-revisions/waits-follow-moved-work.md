# Waits follow moved work

INF-1826, Finding 4 of INF-1810 (the captain's "File it and start now"), built on the captain's Approve and build of the plan "Plan: waits that follow moved work and wake at its merge".
INF-1641 replaced INF-1550, but the wait INF-1688 recorded stayed on INF-1550, so nothing woke it when the replacement's work merged.
Writing a `replaced-by` link now moves the live waits on the old task, and the old task's own waits on live work, to the task that does the work.
`link_tasks`'s description now says replaced-by means "`to` does `from`'s work now" and tells the Firstmate to link it on every move of work to another task (a drop, a takeover, a fresh task), since the move of the waits rides on that link.
Its home is that one tool description.
A crewmate waiting on the moved work hears the close of the task carrying it, with its pull request and the task whose work it took over, and a crewmate already told the old task was dropped hears once that the work goes on; neither wake is the Firstmate's.
