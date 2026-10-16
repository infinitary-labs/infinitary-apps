# The app watches a named CI run

Piece 2 of the captain's approved FI3-1657 plan adds a saved minute watch to the short `read_workflow` run reading.
The tool description and shared crewmate instructions tell both Pi and Claude crewmates to find the run, take that short read, and end the turn instead of sleeping or looping.
A typed `run-watch` wake names the first failed job while the run goes on, and another names the end; a short read of an outcome the crewmate already knows suppresses its matching wake.
The Firstmate reads the existing checks-watched witness while either kind of watch stands, never watches a run itself, and still uses the unchanged pull request green gate.
No new Firstmate tool or fixed context block is added; the shared crewmate paragraph adds about 95 tokens and the workflow reader description about 85.
The captain chose no new tests: verification is disposable manual probing and existing gates, with no retained coverage added.
