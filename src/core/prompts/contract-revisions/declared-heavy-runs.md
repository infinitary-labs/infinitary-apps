# Caller-declared heavy runs

INF-1621 piece 2, implemented by INF-1630, follows the captain's accepted choices: caller demand, the load command, pressure wakes, and visible undeclared work without containment.
The one served home is `CREWMATE_LOAD_LINE` in `src/core/pi/piResources.ts`, included only when the task's computer supports that command.
It tells the crewmate to declare the whole heavy run, including external work, through the native wrapper and to keep that work within the wrapped run's lifetime.
The host admits only a declared process group, keeps it until the group exits, and never stops or slows running work for load.
The `load-line` entry in `HOLDS` is the typed admission hold; only the existing recorded captain override passes it.
The instruction adds about 170 tokens to a supported crewmate, nothing to the first mate's fixed prompt, and names no project-specific gate.
