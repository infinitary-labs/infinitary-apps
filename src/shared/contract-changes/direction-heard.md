# Direction heard

A standing direction's rows, and each revision in its history, add the optional `heard`: where the captain's own words for that revision were heard, from this turn, a card by id and title, a task's Crewmate tab or standing reply by key, or the captain's own change in the window.
A row or revision without it was not heard, so it approves nothing on its own.
`inf:knowledge:direction:set` accepts an optional `heard` too, but the core sets it from who asked and drops whatever a side sends.
An older side does not read it and shows a direction's history as before.
