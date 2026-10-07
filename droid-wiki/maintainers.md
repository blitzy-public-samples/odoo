# Maintainers

## Purpose

Who owns what in this repository. There is no CODEOWNERS file (verified:
none exists in the tree), so this page is built entirely from git history.
The short version: this is a fork of Odoo 20.0. Everything upstream is
maintained by Odoo SA; the offline/mobile CRM layer on top of it
(`addons/crm`, `scripts/dev/`, this wiki) has a single fork author.

## How to read this table

- This repository is the fork `eval/factory-crm-offline` of
  `github.com/bobbyabbott421-glitch/odoo`, 76 commits ahead of upstream's
  `origin/20.0` (all 76 by one author, 2026-09-30 through 2026-10-05).
- Upstream rows are queried against `origin/20.0`, which carries no record
  of the fork's work. Fork rows are queried against `HEAD` (this branch),
  because the default branch has no history for those paths.
- "Recent contributors" lists the first three names from
  `git log --format='%an' origin/20.0 -- <dir> | sort | uniq -c | sort -rn`
  with translation accounts (`Odoo Translation Bot`, Launchpad
  translations) removed. It is by commit count over the path's entire
  history (the upstream tree carries 211,574 commits), so it names the
  people who shaped the subsystem, not necessarily a current roster.
- "Last activity" is the date of the last commit touching the path
  (`git log -1 --format='%ad' --date=short`). No per-person counts or
  rankings appear beyond this ordering.

## Subsystem ownership

### Core (`odoo/`, maintained by Odoo SA)

| Subsystem | Paths | Recent contributors | Last activity |
| --- | --- | --- | --- |
| ORM | `odoo/orm/` | Krzysztof Magusiak (krma), Chong Wang (cwg), Raphael Collet | 2026-09-22 |
| HTTP layer | `odoo/http/` | Julien Castiaux, Krzysztof Magusiak (krma), thle-odoo | 2026-09-14 |
| Module system | `odoo/modules/` | Christophe Simonis, Raphael Collet, Xavier Morel | 2026-09-21 |
| Asset pipeline | `odoo/addons/base/models/assetsbundle.py` | Xavier-Do, Christophe Simonis, qsm-odoo | 2026-04-23 |
| Test framework | `odoo/tests/` | Xavier Morel, Xavier-Do, Christophe Simonis | 2026-08-31 |

### Business addons (maintained by Odoo SA)

| Subsystem | Paths | Recent contributors | Last activity |
| --- | --- | --- | --- |
| Web client | `addons/web/static/src/` | Aaron Bohy, Xavier Morel, Christophe Simonis | 2026-09-21 |
| Mail | `addons/mail/` | Thibault Delavallée, Alexandre Kühn, Sébastien Theys | 2026-08-13 |
| CRM (upstream base) | `addons/crm/` | Thibault Delavallée, Christophe Simonis, rpa (Open ERP) | 2026-09-19 |
| Accounting | `addons/account/` | Christophe Simonis, Fabien Pinckaers, Mustufa Rangwala | 2026-09-21 |
| Sales | `addons/sale/` | Christophe Simonis, Fabien Pinckaers, Victor Feyens | 2026-09-22 |
| Inventory | `addons/stock/` | Christophe Simonis, Josse Colpaert, Quentin (OpenERP) | 2026-09-21 |
| Website | `addons/website/` | qsm-odoo, Christophe Simonis, Christophe Matthieu | 2026-09-21 |
| HR | `addons/hr/` | Christophe Simonis, Martin Trigaux, Fabien Pinckaers | 2026-09-21 |
| Point of sale | `addons/point_of_sale/` | Christophe Simonis, Frédéric van der Essen, Martin Trigaux | 2026-09-21 |
| Localizations | `addons/l10n_*/` | Christophe Simonis, Martin Trigaux, Maximilien (malb) | 2026-09-22 |

### The fork (single author: bobbyabbott421-glitch)

| Subsystem | Paths | Recent contributors | Last activity |
| --- | --- | --- | --- |
| Offline and mobile CRM layer | `addons/crm/static/src/mobile/`, `addons/crm/static/src/views/view_components/` | bobbyabbott421-glitch | 2026-10-05 |
| Dev environment | `scripts/dev/` | bobbyabbott421-glitch | 2026-09-30 |
| This wiki | `droid-wiki/` | bobbyabbott421-glitch | 2026-09-30 |

## What this means for working here

- For anything under the first two tables, you are changing upstream code
  that Odoo SA maintains. The fork's contract (`AGENTS.md`) is to stay
  rebasable: change files only under `addons/crm/`, and extend other
  addons from there with `_inherit`, controller subclassing, `patch()`,
  or XML inheritance rather than editing them.
- For the offline/mobile CRM layer, every subsystem in the third table has
  exactly one author. `AGENTS.md` and the developer README
  (`scripts/dev/README.md`) carry that author's conventions: no new
  dependencies, no second offline engine, no changes to queue conflict
  semantics, and the `scripts/dev/` wrappers for all test runs. A reviewer
  should treat deviations from those rules as the highest-priority findings.
- The offline layer builds on the framework in `addons/web` ([web client
  page](apps/web/index.md)) and the upstream CRM described in
  [CRM](apps/crm/index.md) — its behavior, not just its author, depends on
  those two subsystems staying as upstream ships them.

## Method

Commands run in this checkout on 2026-10-07 against
`origin/20.0` (upstream) and `HEAD` (the fork branch):

```bash
# upstream rows: top contributors
git log --format='%an' origin/20.0 -- <dir> \
  | grep -viE 'translation|launchpad|\[bot\]' \
  | sort | uniq -c | sort -rn | head -3

# upstream rows: last activity
git log -1 --format='%ad' --date=short origin/20.0 -- <dir>

# fork rows (origin/20.0 has no record of these paths)
git log --format='%an' HEAD -- <dir>
git log -1 --format='%ad' --date=short HEAD -- <dir>
```

## Related pages

- [Reference](reference/index.md)
- [Architecture](overview/architecture.md)
- [CRM](apps/crm/index.md)
- [Web](apps/web/index.md)
- [Development workflow](how-to-contribute/development-workflow.md)
- [By the numbers](by-the-numbers.md)
