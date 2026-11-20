# Fix flaky batch failures forward

The captain required paused-batch repair crewmates to fix flakiness rather than ignore it.
The queue-paused wake now commissions a fix-forward repair including flakiness, not a resume after a flake diagnosis.
The queue-repair skill owns the repair procedure: reproduce the failing ordering, fix the root cause, offer the labelled repair, and keep the pause when evidence or access is missing.
Manual queue recovery remains available; no host rule tries to classify failures or infer whether a repair is sufficient.
The fixed context does not grow: this changes the wake and the on-demand skill only.
