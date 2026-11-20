# Working in this repository

- This repository's code runs inside a task container, not on this machine. Build, run and test only through `{{BRIDGE}} <command>`: it copies your working copy's changes into the container and runs `<command>` there. Do not install toolchains or run the project's own commands on this machine.
- Do not use the web: no searches, no fetches, no package downloads beyond what `{{BRIDGE}}` does inside the container.
