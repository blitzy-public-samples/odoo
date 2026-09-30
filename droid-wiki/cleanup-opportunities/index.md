# Cleanup opportunities
Active contributors: Odoo SA (upstream)

## Purpose

This scan maps two kinds of maintenance signal: TODO/FIXME comments and files
large enough that a small change can have a wide effect. It is a reading guide
for maintainers, not a backlog of approved refactors.

The scan deliberately excludes cleanup proposals for upstream Odoo code. The
fork must stay rebasable onto upstream 20.0, so refactoring is safe only inside
`addons/crm/`; changes to `odoo/`, `addons/web/`, or other upstream addons need
an upstream change or an extension from CRM. See [patterns and
conventions](../how-to-contribute/patterns-and-conventions.md) for that
boundary.

## Directory layout

```text
odoo/                         upstream server and base addon
addons/                       upstream business addons
addons/crm/                   fork's permitted cleanup scope
droid-wiki/cleanup-opportunities/
  index.md
  todos-and-fixmes.md
  complexity-hotspots.md
```

## Key abstractions

| Signal | File or scope | Meaning |
|---|---|---|
| Marker density | `odoo/` and `addons/` source files | TODO/FIXME comments identify deferred compatibility, testing, and design work. |
| Size hotspots | `addons/account/models/account_move.py` and other large files | Line count is a risk indicator, not proof that a file needs splitting. |
| Rebasability boundary | `addons/crm/` | The fork's active implementation scope; upstream code is not a local cleanup target. |

## How it works

The two reports use repository scans rather than Git authorship. Marker counts
use `rg` over Python and JavaScript files, while hotspot counts use `wc -l`.
The repository history is shallow and squashed, so it cannot establish which
comment was written first or assign cleanup ownership.

## Integration points

The reports connect to the [size and activity
snapshot](../by-the-numbers.md), the [ORM](../systems/orm.md), and the
[CRM application](../apps/crm/index.md). They also use the fork's contribution
rule that extensions belong in `addons/crm/`, rather than modifying upstream
modules.

## Entry points for modification

Start with the relevant sub-page, then confirm behavior with tests before
touching code. For a permitted fork change, begin in `addons/crm/` and use the
extension patterns documented in [how to contribute](../how-to-contribute/patterns-and-conventions.md).

## Key source files

| File | Purpose |
|---|---|
| `AGENTS.md` | Defines the rebasability and scope rules for this fork. |
| `addons/crm/` | Only addon scope where local cleanup is normally permitted. |
| `odoo/` | Upstream server code included in the scan but excluded from local refactors. |
| `addons/web/` | Upstream web framework, including the offline/PWA framework. |

## Related pages

- [Size and activity](../by-the-numbers.md)
- [Contribution patterns](../how-to-contribute/patterns-and-conventions.md)
- [CRM](../apps/crm/index.md)
- [TODOs and FIXMEs](todos-and-fixmes.md)
- [Complexity hotspots](complexity-hotspots.md)
