# How to contribute

How work happens in this fork: one hard scope rule, a task pipeline modeled on the fork's own milestone history, a definition of done that no CI will enforce for you, and a review culture of scrutiny and user-testing rounds. `AGENTS.md` at the repo root is the authoritative rule set; this section of the wiki is its narrative companion, one page per topic.

## The scope rule

Changes go only under `addons/crm/`, and the fork must stay rebasable onto upstream Odoo 20.0 (`origin/20.0`). To change behavior owned by another addon, extend it from inside `addons/crm/` with Python `_inherit`, controller subclassing, JS `patch()`, or XML view/template inheritance — never by editing `addons/web/`, `odoo/`, or any other addon directly. The offline and PWA framework belongs to `addons/web`; crm only consumes it.

That single rule explains most of the rest: no second sync queue, no new encryption or storage layer, no new dependencies (nothing added to `requirements.txt`, `depends`, or npm), no changes to access rules or groups (the offline cache must never widen what a user can see), and no new fields on `crm.lead`, `crm.stage`, or `crm.team`. The full list, with the reasoning, is on [Patterns and conventions](patterns-and-conventions.md).

## Where tasks come from

The fork's own history is the model for how work is picked up and structured. The branch `eval/factory-crm-offline` sits 76 commits ahead of `origin/20.0` (September 30 to October 5, 2026), and those commits organize into five milestones, each visible in `git log --oneline origin/20.0..HEAD`:

| Milestone | What it delivered | Representative commits |
| --- | --- | --- |
| M1 — inventory | `addons/crm/static/src/mobile/offline_inventory.md`: every crm entry point that needs a server, classified QUEUE / SKIP / DISABLE (26 QUEUE, 9 SKIP, 115 DISABLE, 150 rows). No product code. | `[ADD] crm: offline surface inventory`, then five rounds of `[FIX] crm: close ... scrutiny gaps in offline surface inventory` |
| M2 — offline fixes | Queue semantics, offline guards (disable or skip what the framework cannot queue), the cross-cutting re-enable proof, close-out tests. | `[ADD] crm: lay milestone-2 offline-fixes foundation`, `[ADD] crm: queue-semantics tests ...`, `[ADD] crm: milestone-2 close-out ...` |
| M3 — data coverage | Offline mark won, the activity panel on the lead form, offline contact lookup through the many2x cache, `action_log_call`. | `[ADD] crm: offline mark-won (VAL-DATA-005/006/007)`, `[ADD] crm: milestone-3 framework data-coverage proofs ...` |
| M4 — evidence and PWA | Proof tests for the framework data path, PWA shortcuts ("My Pipeline", "New Lead"), the offline E2E tour. | `[IMP] crm: PWA shortcuts "My Pipeline" and "New Lead" (VAL-PWA-001..007)`, `[ADD] crm: offline E2E tour, pipeline to reconnect (VAL-E2E-001/002)` |
| M5 — mobile | The small-screen pipeline (one stage at a time), the mobile lead card, the bottom-sheet quick create, pending-create cards. | `[IMP] crm: mobile pipeline, one stage at a time (VAL-MOBILE-003/006)`, `[IMP] crm: mobile quick create (VAL-MOBILE-009/010/011/013)` |

A new task today follows the same shape: find the gap (a row in `addons/crm/static/src/mobile/offline_inventory.md`, or a "Known limits" entry in `addons/crm/static/src/mobile/README.md`), decide its disposition (QUEUE, SKIP, or DISABLE — see [Offline surface inventory](../apps/crm/offline-surface-inventory.md)), implement it inside `addons/crm/`, and prove it with tests. Anything that needs a server onchange, a transient-model wizard, or an id produced by another call is disabled offline, never queued.

## What "done" means

There is no CI: `.github/` holds only issue templates and `PULL_REQUEST_TEMPLATE.md`, with no `workflows/` directory. A change is finished only when the work itself and its evidence are complete:

- **The suites ran and their results were reported**, including the runs you skipped and why. `./scripts/dev/test-py.sh` (all crm Python tests), `./scripts/dev/test-js.sh desktop` and `./scripts/dev/test-js.sh mobile` — new JS tests must pass under **both** presets — and `./scripts/dev/test-guard.sh`.
- **Assets were rebuilt** after the last js/css/scss/xml change and before re-testing. A test that fails only because an asset bundle is stale is not a real result.
- **New entry points got a row in the offline inventory** (`addons/crm/static/src/mobile/offline_inventory.md`), classified QUEUE / SKIP / DISABLE.
- **Everything new is wired and proven reachable**: new Python test modules imported in `addons/crm/tests/__init__.py`, new model and controller files in their package `__init__.py`, new XML data files in the manifest's data list; new views registered in the view registry *and* bound by a `js_class`; new components reachable from a rendered parent — a component reachable solely from its own unit test does not count. A component that exists but is never reached is the most common failure.
- **Asset globs were verified, not edited**: the manifest's existing globs (`crm/static/src/**`, `crm/static/tests/**/*.test.js`, ...) already cover new files. Add a bundle entry only to exclude or lazily load a file.
- **No existing test was weakened.** Tests are never deleted, skipped, retagged, or made easier; the only existing file that may change is `addons/crm/tests/__init__.py` (to add imports).

The command details are on [Testing](testing.md); the cycle and commit conventions are on [Development workflow](development-workflow.md).

## The review culture

Each milestone closed under two review loops, both visible in the commit history:

- **Scrutiny rounds** — an internal review that produces numbered findings, fixed in batches: `[FIX] crm: scrutiny round-1 fixes 1,12,14,22,23,24 (card menu, column delete, progress bar, send mail, calendar single click, team configuration)`. M1 alone absorbed five rounds on the inventory document itself before any product code was written.
- **User-testing rounds** — validation runs whose findings carry `VAL-*` codes, traced into fix commits: `VAL-DATA-*` (M3 data coverage), `VAL-PWA-*` (shortcuts), `VAL-MOBILE-*` (M5), `VAL-E2E-*` (the tour), `VAL-REPO-*` (repository hygiene), e.g. `[FIX] crm: close M5 user-testing round-1 online-guard gaps (m5-fix-online-guards)`.
- **Close-out commits** — each milestone ends with one: `[ADD] crm: milestone-2 close-out (cross-cutting re-enable test, QA, wiring)`, `[ADD] crm: milestone-3 close-out tests ...`. Close-out is where wiring proofs and cross-cutting coverage land, not an afterthought.

Treat review findings as first-class work: the fix commit names the finding, and the tests that prove the fix land with it.

## Key source files

| File | Purpose |
| --- | --- |
| `AGENTS.md` | The authoritative rule set: commands, the offline framework's API, crm conventions, project rules, known baseline failures. |
| `scripts/dev/README.md` | Every dev command, the exact `odoo-bin` invocations the wrappers run, and the test runner's three silent-success modes. |
| `addons/crm/static/src/mobile/README.md` | Developer notes for the offline and mobile CRM: what was built, how to run it, known limits. |
| `addons/crm/static/src/mobile/offline_inventory.md` | The QUEUE / SKIP / DISABLE classification of every crm server touchpoint. |
| `addons/crm/__manifest__.py` | Asset globs, bundle exclusions, data file order, dependencies. |
| `addons/crm/tests/__init__.py` | The Python test modules that actually get collected. |

## Related pages

- [Patterns and conventions](patterns-and-conventions.md) — the coding and offline rules in detail
- [Development workflow](development-workflow.md) — branches, commits, the milestone loop
- [Testing](testing.md) — the suites, the wrappers, offline test conventions
- [Debugging](debugging.md) — logs, devtools, the fork's specific failure modes
- [Tooling](tooling.md) — the dev scripts, the QA skill, the `droid` CLI
- [Getting started](../overview/getting-started.md) — setup and the command quick view
- [Offline CRM](../apps/crm/offline-crm.md) and [Mobile CRM](../apps/crm/mobile-crm.md) — what the fork built
- [Offline surface inventory](../apps/crm/offline-surface-inventory.md) — the QUEUE / SKIP / DISABLE classification
