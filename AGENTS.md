# AGENTS.md

## Development Principles

- Identify the root cause before proposing or implementing a fix: observe, isolate, then change.
- Preserve user work. Do not revert unrelated changes unless explicitly asked.
- Keep changes scoped to the issue at hand and follow the existing extension patterns.
- Verify behavior after changes with the smallest practical check, and use the browser when the change affects extension UI or page behavior.
