# Background

Active contributors: bobbyabbott421-glitch (fork), Odoo SA (upstream)

## Purpose

Some choices in this codebase are reasoned decisions that a reader will otherwise re-litigate, and some are traps that bite even careful contributors. This section records both: the reasoning behind the sync queue's conflict semantics, the verbatim-replay constraint, the secure-context degradation, and the upstream architecture moves (the `odoo/orm/` extraction, OWL 3 behind a compatibility layer, the `ir.access` unification), plus the pitfalls that waste real time here, from silently green test runs to documentation naming classes that do not exist.

## Sub-pages

| Page | What it covers |
| --- | --- |
| [Design decisions](design-decisions.md) | The reasoned choices a reader will otherwise re-litigate, fork and upstream, with the files that record them |
| [Pitfalls](pitfalls.md) | The traps, each with a symptom, a fix, and a file pointer |

## How to read this section

Two caveats keep these pages honest:

- Where the repository records the reasoning (a comment, a docstring, the rules in `AGENTS.md`), the decision page quotes or cites it. Where it does not, the page says the reasoning is unrecorded rather than inventing one. Most of the fork's offline stack arrived inside a single squashed base commit (see [lore](../lore.md)), so git history cannot date or attribute it either.
- Several of these decisions are rules, not preferences. `AGENTS.md` section 4 makes them binding for changes to this fork: no second offline stack, no change to the queue's conflict semantics, no new dependencies, no native app project. If a task seems to require breaking one of them, the right move is to raise it, not to work around it quietly.

## Related pages

- [Lore](../lore.md) for the fork's history and the squashed-base story
- [How to contribute](../how-to-contribute/index.md) for the working rules
- [Offline and PWA](../features/offline-and-pwa/index.md), the subsystem most of the fork decisions concern
