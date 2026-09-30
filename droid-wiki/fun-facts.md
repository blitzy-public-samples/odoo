# Fun facts

Active contributors: bobbyabbott421-glitch (fork), Odoo SA (upstream)

Seven things in this tree that will make you look twice. Each one was checked against the file it names.

## `odoo` is a namespace package with no `__init__.py`

`import odoo` works, but there is no `odoo/__init__.py`. The bootstrap lives in `odoo/init.py`, one letter and one convention away, and every entry point imports it explicitly (`odoo/orm/__init__.py` opens with `import odoo.init  # noqa: F401`, commented "import first for core setup"). That file is also where the server refuses to start under `python -O` and where it raises the garbage-collector threshold from the CPython default to `(12_000, 20, 25)`, on the grounds that "handling requests can sometimes allocate over 5k new objects". A `.py` file that looks optional turns out to configure the GC for the whole server.

## OWL 3 lives in a directory called `owl2/`

The vendored framework at `addons/web/static/lib/owl/owl.js` is OWL 3, but the shim that lets the existing client run on it sits in `addons/web/static/src/owl2/owl3_compatibility_layer.js`. The header calls it "a temporary bridge to ease incremental migration from Owl 2 to Owl 3" and lists the renames it papers over: `t-portal` becomes `t-custom-portal`, `t-model` becomes `t-custom-model`, every `useEffect` becomes `useLayoutEffect`. The directory is named for the code being migrated away from, not the library it contains.

## The service worker redacts your session with a literal magic string

`addons/web/static/src/service_worker.js` caches the `/odoo` homepage so the client can boot offline, but that HTML contains `odoo.__session_info__`. Rather than parse it out, the worker does a string replace before caching (line 50) and the inverse replace when serving (line 67), using the token `@@@session_info_secret@@@`. The fresh session data is kept in worker memory and re-injected on the way out, so the cached copy on disk never holds it. Three at-signs on each side, because one apparently was not enough.

## `doc/` contains no documentation

Nothing in this repository explains how to develop for it. The `doc/` directory holds exactly one thing: `doc/cla/`, the contributor license agreements. Under it are 286 signed corporate CLAs and 753 signed individual ones, plus the agreement templates `doc/cla/ccla-1.0.md` and `doc/cla/icla-1.0.md` and a `doc/cla/stats.py`. A thousand-plus signatures and not one page of developer docs. The nearest substitute in-tree is `skills/`, four agent rule packs written for code review rather than for onboarding.

## The biggest Python file is accounting, not the ORM

You would expect the heart of an ERP framework to be its largest file. It is not. `addons/account/models/account_move.py` is 8,339 lines, the largest tracked Python file in the repository. `odoo/orm/models.py`, which defines `BaseModel` and the entire recordset API that all 642 addons are built on, is 6,617. The runner-up is not framework code either: `addons/stock/tests/test_move.py` at 7,043 lines. Two of the three largest Python files in an ERP are about moving things, one kind financial and one kind physical.

## A code comment addressed to a person, in the offline storage layer

`addons/web/static/src/core/utils/indexed_db.js:266`, inside the `_write` method that every offline write funnels through, opens with:

```js
// AAB: do we care about write performance?
// Relaxed durability improves the write performances
```

followed by the answer, a transaction opened with `{ durability: "relaxed" }` and two reference links. The initials survived the review that resolved the question; the decision is now load-bearing for every queued lead edit made offline.

## A CRM pipeline screenshot in the gitignored logs directory

`logs/` is gitignored (`.gitignore:57` is `/logs/`) and holds the dev scripts' run output: `odoo.log`, per-suite `test-*.log` files, and `measure-*.txt` timing files. It also holds `logs/crm-pipeline.png`, a 1280x633 screenshot of the CRM kanban at desktop width showing the demo pipeline (New / Qualified / Proposition / Won, with the progress bars and per-column revenue totals), captured 2026-09-30. Next to it, `logs/offline-spike/` holds nine more, named for the offline QA steps they document: `01-offline-pipeline.png`, `02-offline-reload.png`, `04-offline-action-helper.png`, `06-cdp-bottomsheet.png`, `09-no-touch-popover.png`. A manual offline QA session, preserved by accident in a directory git was told to ignore.

## Related pages

- [Lore](lore.md)
- [By the numbers](by-the-numbers.md)
- [Architecture](overview/architecture.md)
