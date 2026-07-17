# Docs

Working notes for design decisions and planned work, tracked alongside the code so they survive between sessions.

- **[issues/](issues/)** — open design questions, scaling concerns, bugs worth writing down before fixing. One file per issue, numbered.
- **[features/](features/)** — write-ups for planned features: what it does, rough shape of the change, open questions.

## Conventions

Each doc has a status line near the top:

- `Proposed` — written up, not yet decided
- `Decided` — approach chosen, not yet implemented
- `In progress` — being implemented
- `Done` — implemented (kept for history rather than deleted)
- `Rejected` — considered and dropped, reason noted

Number issues and features independently, sequentially, zero-padded to 4 digits (`0001-...`). Don't renumber when one is closed — the number is a stable reference, not a priority order.
