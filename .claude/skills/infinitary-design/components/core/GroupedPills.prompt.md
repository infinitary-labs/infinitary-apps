Equal pills in a grouped track.
Selected and unselected share height, padding, radius, and a 1px border; only fill and color change.
```jsx
<GroupedPills name="Delivery" htmlName="delivery-nimbus" value="direct-pr" options={[{value:"direct-pr",label:"direct PR"},{value:"local-only",label:"local only"}]} onChange={setDelivery}/>
```

Several at once: `GroupedChecks` draws the same track with a checkbox in each pill, any number chosen, as Automation's weekdays are.
```jsx
<GroupedChecks name="Days" values={["0"]} options={[{value:"1",label:"Mon",ariaLabel:"Monday"},{value:"0",label:"Sun",ariaLabel:"Sunday"}]} onChange={setDays}/>
```
