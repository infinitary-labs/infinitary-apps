# Linux automatic startup capability

A computer's hello and device view optionally report `automaticStartup`, independent of work reachability.
The values are `available`, `at-login`, `failed`, `unavailable` and `unknown`; the SSH status may carry the latest controller observation in the same optional field.
A command join reports its setup outcome with a name-only hello before exiting without a worker.
An older home ignores the hello field, and an older view ignores the optional device field.
The worker's internal join and SSH controller protocols distinguish unsupported startup from a genuine next-login start and an unreadable check.
An unavailable SSH controller first publishes a route with the legacy `unknown` agent value, then reports `unavailable` separately.
An older home can ignore that newer agent reading while retaining the route for explicitly started work.
