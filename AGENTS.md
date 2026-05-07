# AGENTS.md

## Development Principles

- Identify the root cause before proposing or implementing a fix: observe, isolate, then change.
- Preserve user work. Do not revert unrelated changes unless explicitly asked.
- Keep changes scoped to the issue at hand and follow the existing extension patterns.
- Verify behavior after changes with the smallest practical check, and use the browser when the change affects extension UI or page behavior.
- For user-facing UI, check the full user flow before adding guidance. Show extension panels only when they fit the user's current task.
- Prefer user-facing labels and next actions over internal states such as cache misses, tab messaging, tokens, or API details.
