# Development workflow

The edit-rebuild-test-report cycle of this fork: which branch to work on, how commits are written, how a milestone's work is structured, what every change must carry with it, and the list of things that never change. There is no CI, so the cycle's last step — reporting what ran, including what was skipped and why — is part of the work, not optional bookkeeping.

## Branches

The fork's work branch is `eval/factory-crm-offline`, sitting on top of `origin/20.0`, the upstream default branch (`origin/HEAD` points at it). The 76 commits between them are all authored by `bobbyabbott421-glitch`, September 30 to October 5, 2026, and all confined to `addons/crm/` plus the dev scripts, the offline QA skill, the root `AGENTS.md`, and this wiki. A second local branch, `eval/base`, holds the earlier round that only added `scripts/dev/`.

Practical rules:

- Fork work continues on `eval/factory-crm-offline`; a new line of work starts from a branch off `origin/20.0` so it stays rebasable.
- Keep the diff confined to `addons/crm/`. That is what keeps the fork rebasable onto upstream 20.0 — the scope rule `AGENTS.md` states outright.
- Upstream Odoo contributions are a separate flow: `CONTRIBUTING.md` points at Odoo's own contribution guide (pull requests against the correct version, restrictions on stable-series changes), and `doc/cla/` holds the contributor license agreements and their signatory lists. Fork work is not submitted upstream.

## Commit messages

Format: `[TAG] module: short description`, optionally with validation codes in parentheses. The tags seen in `git log --oneline -20`:

```text
[ADD] crm: developer README for the offline and mobile CRM
[FIX] crm: bypass user.hasGroup's poisoned cache on team-switcher reconnect
[IMP] crm: PWA shortcuts "My Pipeline" and "New Lead" (VAL-PWA-001..007)
[ADD] crm: offline E2E tour, pipeline to reconnect (VAL-E2E-001/002)
[FIX] crm: mobile pipeline scrutiny round-1 blockers 1-6
[IMP] crm: mobile quick create (VAL-MOBILE-009/010/011/013)
[ADD] crm: milestone-3 close-out tests (VAL-DATA-017, VAL-CROSS-001)
[FIX] crm: close M4 user-testing round-1 evidence gaps (m4-fix-ut-evidence)
```

Conventions the history makes visible:

- `ADD` for new files or features, `IMP` for improvements to existing behavior, `FIX` for bug fixes. The module part is the addon or area: `crm:` for nearly everything, also `scripts/dev:` and `wiki:`.
- Scrutiny fixes name the round and the finding numbers: `scrutiny round-1 fixes 8,9,10,20,21,27,28 (chatter followers, ...)`.
- User-testing fixes name the round and carry the `VAL-*` codes being closed: `close M5 user-testing round-1 online-guard gaps (m5-fix-online-guards)`.
- One commit per coherent unit (a feature, a round of findings, a close-out), with the tests that prove it in the same commit.

## The milestone loop

The fork's five milestones all follow the same loop, and it is the template for new work:

1. **Foundation** — one `[ADD]` commit laying the base: `[ADD] crm: lay milestone-2 offline-fixes foundation`, `[IMP] crm: extend the mobile offline hooks module (VAL-MOBILE-001)`.
2. **A run of feature or fix commits**, each carrying its proof: `[ADD] crm: offline mark-won (VAL-DATA-005/006/007)` landed with the mark-won tests.
3. **Close-out** — wiring proofs, cross-cutting coverage, and QA in one commit: `[ADD] crm: milestone-2 close-out (cross-cutting re-enable test, QA, wiring)`.
4. **Scrutiny rounds** — internal review, numbered findings, batched fixes: `[FIX] crm: scrutiny round-1 fixes 2,3,4,5,6,7,11 (switcher, MRR, lead-gen, PLS tooltip, Restore)`, then round 2, round 3.
5. **User-testing rounds** — validation runs producing `VAL-*` codes, closed by commits like `[FIX] crm: close M3 user-testing round-1 evidence gaps (VAL-DATA-002/004/005, VAL-FIX-007)`.
6. **Stabilization** — de-flaking commits when the suites expose races: `[FIX] crm: stabilize mobile-preset flakes in crm_offline_cold_start/config_list_guards`, `[FIX] crm: restore crm_test_helpers.js, move mockCrmOffline (VAL-REPO-005)`.

M1 is the precedent for document-shaped work: the offline surface inventory landed as one `[ADD]`, then absorbed five scrutiny rounds and two user-review rounds as `[FIX] crm: close round-N scrutiny gaps ...` commits — before any product code changed.

## The cycle, concretely

```bash
# after any js/css/scss/xml change, before testing:
./scripts/dev/rebuild-assets.sh

# the suites (all must be run and reported; see Testing for details):
./scripts/dev/test-py.sh                 # all crm Python tests
./scripts/dev/test-py.sh TestCrmOffline   # one test class
./scripts/dev/test-js.sh desktop          # crm JS unit tests, desktop preset
./scripts/dev/test-js.sh mobile           # same suite, 375x667 touch preset
./scripts/dev/test-guard.sh               # no only( / debug( in .test.js
```

Before committing, walk the wiring checklist — the items that silently fail when missed:

| What you added | What it must have |
| --- | --- |
| A Python test module | An import in `addons/crm/tests/__init__.py`; otherwise it is silently never collected. |
| A model or controller file | An import in `addons/crm/models/__init__.py` or `addons/crm/controllers/__init__.py`. |
| An XML data file | An entry in the `data` list of `addons/crm/__manifest__.py`, in dependency order. |
| A custom view | A registration in `registry.category("views")` **and** a `js_class` binding in `addons/crm/views/crm_lead_views.xml`. |
| A component | A rendered parent template that reaches it, plus a test proving the reach. |
| A server touchpoint (button, entry point) | A row in `addons/crm/static/src/mobile/offline_inventory.md` classified QUEUE / SKIP / DISABLE. |
| Any js/css/scss/xml file | Nothing in the manifest: the existing globs (`crm/static/src/**`, `crm/static/tests/**/*.test.js`, ...) already cover it. Add a bundle entry only to exclude or lazily load a file, in the existing `('remove', ...)` + `web.assets_backend_lazy` pair style. |

## What never changes

From `AGENTS.md` section 4, the list every change is checked against:

- No files outside `addons/crm/`. Other addons are extended, not edited: `_inherit`, controller subclassing, JS `patch()`, XML inheritance.
- No second offline engine: no new sync queue, IndexedDB wrapper, service worker, cache layer, encryption helper, connectivity detector, offline-state store, or conflict resolver. `addons/web` owns all of it.
- No change to queue semantics: timestamp-ordered replay, last write wins, failed calls parked in the systray. No conflict detection, no `write_date` comparison, no field-level merge, no conflict dialog. The queue replays model, method, args, and kwargs verbatim — anything needing a server onchange, a transient-model wizard, or an id from another call is disabled offline, never queued.
- No new dependencies: no Python or JS package, no new addon in `depends`, `requirements.txt` unchanged, no npm/bundler/JS build tooling.
- No new or changed access rule, record rule, or group.
- No new fields on `crm.lead`, `crm.stage`, or `crm.team`.
- Every mobile behavior gated on the small-screen signal (`usePlugin(UIPlugin).isSmall()`); desktop behavior must not change. "Native mobile" means the installable PWA; no React Native, Flutter, Swift, Kotlin, Gradle, Xcode, Capacitor.
- New OWL code uses the plugin API (`Plugin`, `usePlugin`, `signal`), not the legacy `"offline"` service bridge.
- Only the changes the task needs: no refactoring or optimizing code the task does not touch.

## Key source files

| File | Purpose |
| --- | --- |
| `AGENTS.md` | The authoritative rules this page narrates. |
| `addons/crm/__manifest__.py` | Asset globs, bundle exclusions, data file order. |
| `addons/crm/tests/__init__.py` | Which Python test modules get collected. |
| `addons/crm/views/crm_lead_views.xml` | Where every `js_class` binds. |
| `addons/crm/static/src/mobile/offline_inventory.md` | The QUEUE / SKIP / DISABLE classification new entry points join. |
| `CONTRIBUTING.md` | Upstream Odoo's contribution pointers (CLA, PR flow). |

## Related pages

- [How to contribute](index.md) — the scope rule, the definition of done, the review culture
- [Patterns and conventions](patterns-and-conventions.md) — how code is written, not just committed
- [Testing](testing.md) — what the commands above actually run and guard
- [Tooling](tooling.md) — what each script wraps
- [Getting started](../overview/getting-started.md) — setup and the quick command view
- [Offline surface inventory](../apps/crm/offline-surface-inventory.md) — the classification a new entry point joins
