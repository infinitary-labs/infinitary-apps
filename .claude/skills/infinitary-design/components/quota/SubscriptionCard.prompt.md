An added AI subscription: provider + plan, live quota windows, discovered models with buckets. ✱ marks a user override.
```jsx
<SubscriptionCard provider="Claude" plan="Max 20x" status="fresh"
  windows={[{label:"session",percentRemaining:74,pace:"behind",resetText:"resets 3pm"}]}
  models={[{label:"opus 5",bucket:"high",override:true}]}/>
```
When the account's windows form a combined bound (quota-axi's effective availability), lead the windows with a headline row: the effective percent (min across bounding windows) labeled by the LIMITING window ("34% weekly"), plus the runway verdict - "on pace ✓" when every bound reaches its own reset, "empty in 7h 21m" when cycle-average burn exhausts one first.
