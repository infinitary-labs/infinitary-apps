# Pull request checks wake on the first failure

Piece 4 of the captain's approved FI3-1657 plan.
`check_change`'s description tells the crewmate the app wakes it once when the first check fails and once when the checks finish, and to end the turn instead of reading again.
The Claude backend note says the same.
The finish wake, the green rule, repair counts and merges are unchanged.
The Firstmate persona prompt is unchanged, and its tool count stays 25.
The captain chose no new tests: verification is a disposable hand check and the existing gates.
