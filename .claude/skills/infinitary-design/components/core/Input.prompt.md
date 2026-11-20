Standard bordered text input for settings (hosts, names, overrides).
```jsx
<Input placeholder="user@host" mono/>
```
mono for machine addresses/ids.
For the main prompt surface use VoiceInput, not Input.
For a secret's value use SecretField: a password Input that keeps the line breaks of a pasted key, which a plain password input drops.
