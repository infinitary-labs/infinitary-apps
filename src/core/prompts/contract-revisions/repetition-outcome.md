# Whether a repeated call worked

INF-5123's finding 2, which the captain chose to build: the possible-repetition wake said a tool "returned identical content and error status", and the first mate read that as a failure even when every repeated call had worked.
The wake now says whether the repeated calls worked, failed with the same error, or, from a work computer that does not say, that it is not known.
It no longer says "error status".
INF-1996's count of three is unchanged.
Its one home is the `possible-repetition` wake in `turnWakes.ts`.
This adds no fixed-context words; the words are served only with the relevant wake.
