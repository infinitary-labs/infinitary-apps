# Measured processor admission

INF-2232 implements the captain's approved INF-2228 processor-only plan.
The one served home remains `CREWMATE_LOAD_LINE` in `src/core/pi/piResources.ts`.
It now explains that processor declarations reserve startup capacity until verified launch and a complete later measurement; memory growth remains reserved until the group exits.
The caller still declares the whole run, including external work, and running work is never killed, paused or slowed for load.
This changes no first mate fixed context and adds about 30 tokens to a supported crewmate.
