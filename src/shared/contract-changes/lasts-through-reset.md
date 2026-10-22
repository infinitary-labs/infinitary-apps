# A catalog model says whether it lasts through its resets

A model in the models catalog admits an optional `lastsThroughReset`: true when every window bounding its scope is projected, at its observed burn, to last until its reset, false when one runs out first (INF-898).
Routing prefers a model that lasts over one with a higher spend priority that runs out.
An older side ignores the field, and a catalog without it ranks by spend priority alone, as before.
