# Cleanup opportunities

This section maps the maintenance debt in this repository: the deferred-work markers
(TODO/FIXME/HACK) and the complexity hotspots (largest files, deepest dependency
chain, biggest addons). It is a reading guide for maintainers, not a backlog of
approved refactors — nothing listed here should be fixed as a side effect of another
task, and `AGENTS.md` explicitly warns against refactoring code the current task does
not need.

The census date is 2026-10-07, branch `eval/factory-crm-offline` at `30955b57688`.

## The one constraint that shapes all of it

The fork must stay rebasable onto upstream 20.0, so changes belong only inside
`addons/crm/` (see [design decisions](../background/design-decisions.md)). That
splits every finding below into two buckets:

- **Upstream debt** — markers and hotspots in `odoo/`, `addons/web/`, and every other
  addon. Read them for context; do not "clean them up" locally. Where a behavior
  genuinely needs changing, extend it from `addons/crm/` (Python `_inherit`, JS
  `patch()`, XML inheritance).
- **Fork debt** — what the fork itself could act on inside `addons/crm/`. This is the
  smaller bucket by marker count: the census found zero TODO/FIXME/HACK markers in any
  file the fork added. The fork's real maintenance surface is the 22-item "Known
  limits" list in `addons/crm/static/src/mobile/README.md`, which functions as a
  maintained backlog, and the offline test suites the fork added (54 of its 118 changed
  files are tests).

## Sub-pages

| Page | What it covers |
| --- | --- |
| [TODOs and FIXMEs](todos-and-fixmes.md) | The marker census: 2,246 occurrences in 1,468 files, the top files, the notable comments with sampled ages, and the upstream-vs-fork split |
| [Complexity hotspots](complexity-hotspots.md) | The largest files, the deepest addon dependency chain, the biggest addons by lines, and the known-limits list as the fork's maintained backlog |

## The biggest theme

Almost all measurable maintenance debt in this tree is upstream's, and the fork's
design deliberately keeps it that way. The marker census is dominated by vendored
libraries (Fullcalendar alone carries 105 marker lines) and long-lived upstream
compatibility seams (the oldest sampled marker predates 2016); the complexity hotspots
are generated bundles and framework files the scope rule puts out of reach. What the
fork could act on is concentrated in three places: the known-limits list (several of
whose items are actually owned by `addons/web` or `addons/mail` and cannot be closed
inside `addons/crm/`), the CRM files upstream owns that the fork patches around rather
than edits, and the fork's own density — 76% of its added lines are tests, which is a
strength but also a surface that must keep passing under two presets.

## Related pages

- [By the numbers](../by-the-numbers.md) for the size, activity, and bot-attribution
  snapshot this census extends
- [Design decisions](../background/design-decisions.md) for why the scope rule exists
- [Offline CRM](../apps/crm/offline-crm.md) and [mobile CRM](../apps/crm/mobile-crm.md)
  for the code the fork's debt attaches to
- [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md) for the
  extension patterns any fork-side cleanup must use
