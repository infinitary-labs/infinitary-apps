# Heavy run time limit

INF-2490 and INF-2225 each lost a queued heavy run when their Claude client stopped the command at its background time limit while it still waited in the computer's line.
The captain chose design C on the task's decision card: raise the longest limit a Claude crewmate's command may ask for to 3 days, and tell crewmates to give a heavy run the longest limit their shell allows.
The one served home remains `CREWMATE_LOAD_LINE` in `src/core/pi/piResources.ts`.
It now says that when the shell stops a command after a time limit, a heavy run gets the longest limit it allows, because its wait in line counts against that limit.
This changes no first mate fixed context and adds about 35 tokens to a supported crewmate.
