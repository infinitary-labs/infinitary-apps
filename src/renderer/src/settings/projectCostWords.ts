export const PROJECT_COST_WORDS = {
  title: "Cost limit",
  description:
    "Estimated dollars for each task and all its parts. Follow the app’s limit in Intelligence, set an amount, or choose no limit.",
  choices: [
    { value: "follow", label: "Follow app" },
    { value: "amount", label: "Own amount" },
    { value: "none", label: "No limit" },
  ],
  amount: "Project cost limit in estimated dollars",
} as const;
