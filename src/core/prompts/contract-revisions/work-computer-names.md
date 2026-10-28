# Work computer names

INF-1582's accepted computer-by-name fix lets the first mate place work using a computer's name without first looking up its identifier.
The update_task runs_on parameter and the project-runs-on and project-setup action descriptions own the guidance: names and device IDs are both accepted, and duplicate names need an ID.
The core resolves names once against computers that run work and stores only IDs, preserving placement and offline waits.
