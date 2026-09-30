# How to contribute

Active contributors: bobbyabbott421-glitch (fork), Odoo SA (upstream)

## Purpose

This fork takes changes only under `addons/crm/`, on top of the offline and PWA framework that `addons/web` already provides, and it must stay rebasable onto upstream Odoo 20.0. There is no CI, so a change is finished only when the relevant suites have been run on this machine and their results reported. This page states the rules and the definition of done; the sibling pages cover the edit-and-test cycle, the suites themselves, debugging, and the tooling.

## Work pickup: the fork's rules

`AGENTS.md` at the repo root is the authoritative rule set, and it is untracked in git (it appears as `?? AGENTS.md` in `git status`), so it is not part of what a rebase carries. The rules that decide whether a change is acceptable:

| Rule | What it means in practice |
| --- | --- |
| Change files only under `addons/crm/` | To change behavior owned by another addon, extend it from inside `addons/crm/`: Python `_inherit`, controller subclassing, JS `patch()`, or XML view and template inheritance. Do not edit `odoo/`, `addons/web/`, or any other addon. |
| Stay rebasable onto upstream 20.0 | The upstream branch is `origin/20.0`; the fork lineage is `20.0` to `eval/base`. Keep the diff small and confined to `addons/crm/`. |
| Never build a second offline engine | No new sync queue, IndexedDB wrapper, service worker, cache layer, encryption helper, connectivity detector, or conflict resolver. Everything exists in `addons/web/static/src/core/offline/`, `addons/web/static/src/core/utils/indexed_db.js`, and `addons/web/static/src/core/crypto.js`. |
| No new dependencies | No pip or npm package, no new addon in the manifest's `depends`, `requirements.txt` unchanged, no JS build tooling or bundler. |
| No access-rule, record-rule, or group changes | The offline cache must never widen what a user can see. |
| No new fields on `crm.lead`, `crm.stage`, or `crm.team` | Extend behavior with methods and views instead. |
| No native app project | "Native mobile" means the installable PWA this fork already supports. No React Native, Flutter, Swift, Kotlin, Gradle, Xcode, or Capacitor. |
| New OWL code uses the plugin API | `Plugin`, `usePlugin`, `signal`, registered with `services.add(...)`, not the legacy offline service bridge. |
| Make only the changes the task needs | No refactoring or optimizing code the task does not touch. |

The reasoning behind these rules is on [Patterns and conventions](patterns-and-conventions.md), which also covers Python, XML, JavaScript, offline, and mobile conventions.

## Definition of done

- **The suites ran and their results were reported.** There is no CI: `.github/` holds only `ISSUE_TEMPLATE/` and `PULL_REQUEST_TEMPLATE.md`, with no `workflows/` directory. An unreported run is not evidence.
  - `./scripts/dev/test-py.sh` (all crm Python tests).
  - `./scripts/dev/test-js.sh desktop` and `./scripts/dev/test-js.sh mobile`. New JS tests must pass under **both** presets.
  - `./scripts/dev/test-guard.sh`, which fails if any `.test.js` contains `only(` or `debug(`.
- **Front-end changes were rebuilt.** Run `./scripts/dev/rebuild-assets.sh` after the last js/css/scss/xml edit and before re-testing. A test that fails only because an asset bundle is stale is not a real result.
- **Everything new is wired and imported.** New Python test modules must be imported in `addons/crm/tests/__init__.py`; new model and controller files in their package `__init__.py`; new XML data files in `addons/crm/__manifest__.py` in dependency order. New views must be registered in the view registry *and* bound by a `js_class` in the addon's lead views; new components must be reachable from a rendered parent.
- **Asset globs were verified, not edited.** `crm/static/src/**`, `crm/static/tests/tours/**/*`, and `crm/static/tests/**/*.test.js` already cover new source, tour, and test files in `addons/crm/__manifest__.py`. Add a bundle entry only to exclude or lazily load a file, as the existing `('remove', ...)` plus `web.assets_backend_lazy` pairs do.
- **No existing test was weakened.** Tests are never deleted, skipped, retagged, or otherwise made easier to pass. The only existing test file that may change is `addons/crm/tests/__init__.py`, and only to add imports.
- **Known baseline failures were left alone.** The `scroll loses target` test in `addons/web/static/tests/core/utils/timing.test.js` fails on the untouched baseline (upstream `addons/web`, out of scope). It is not a regression.

The mechanics of the cycle are on [Development workflow](development-workflow.md); why each command is the shape it is is on [Testing](testing.md).

## Branches and commits

The fork's current branch is `eval/base`, one commit ahead of `20.0`: `[ADD] scripts/dev: reproducible local dev environment`. History is squashed, so `git log` shows the whole codebase as a single upstream commit (`[FIX] mail: duplicate notifications`, carrying an `X-original-commit` trailer) with the fork's offline framework already fused into it. Per-person history is therefore not recoverable, and commit messages follow the convention visible in that log, `[TAG] module: description`.

Upstream Odoo contributions go through GitHub pull requests against the correct version and require a signed CLA; `doc/cla/` holds the signatory lists, and `CONTRIBUTING.md` points at Odoo's own contribution wiki. Fork work happens on a branch of this repository and is not submitted upstream.

## Pages in this section

| Page | What it covers |
| --- | --- |
| [Development workflow](development-workflow.md) | The edit, rebuild, test cycle, and the `odoo-bin` commands the wrappers run. |
| [Testing](testing.md) | The three false-green modes and their guards, Python/JS/tour conventions, offline coverage. |
| [Debugging](debugging.md) | Where logs go, `--dev` and client debug mode, the fork's specific errors, DevTools. |
| [Patterns and conventions](patterns-and-conventions.md) | Python, ORM, XML, JavaScript, offline, and mobile patterns. |
| [Tooling](tooling.md) | `scripts/dev/`, the `skills/` rule packs, ruff, packaging, maintenance commands. |

## Integration points

- The rule set is `AGENTS.md`, backed by the rule packs in `skills/`.
- The dev scripts are the only supported way to run the suites: `scripts/dev/test-py.sh`, `scripts/dev/test-js.sh`, `scripts/dev/test-guard.sh` each guard against a false-green test run that raw `./odoo-bin` would hide.
- The offline rules exist because the framework is owned by `addons/web`: see [Offline and PWA](../features/offline-and-pwa/index.md) and [Local store](../features/offline-and-pwa/local-store.md).

## Key source files

| File | Purpose |
| --- | --- |
| `AGENTS.md` | The fork's project rules, test commands, and known baseline failures. |
| `scripts/dev/README.md` | Usage of the dev wrappers and the notes on the test runner's false-green modes. |
| `scripts/dev/_common.sh` | Shared configuration, database checks, and the `assert_tests_selected` / `assert_no_skips` result guards. |
| `addons/crm/__manifest__.py` | Asset globs, data file order, and the dependency list. |
| `addons/crm/tests/__init__.py` | The list of Python test modules that actually get collected. |
| `addons/crm/models/__init__.py` | Imports every CRM model file. |
| `addons/crm/controllers/__init__.py` | Imports the webmanifest controller subclass. |
| `addons/crm/views/crm_lead_views.xml` | Where `js_class` binds every custom CRM view. |
| `.github/PULL_REQUEST_TEMPLATE.md` | The upstream PR template, the only file left in `.github/` besides issue templates. |
| `CONTRIBUTING.md` | Upstream Odoo's contribution pointers. |

## Related pages

- [Patterns and conventions](patterns-and-conventions.md)
- [Development workflow](development-workflow.md)
- [Testing](testing.md)
- [Getting started](../overview/getting-started.md)
- [Offline and PWA](../features/offline-and-pwa/index.md)
- [Pitfalls](../background/pitfalls.md)
