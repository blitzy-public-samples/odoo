# Observability

Active contributors: Odoo SA (upstream)

## Purpose

Odoo 20.0 ships its own observability: a logging pipeline over Python's `logging` module, per-request HTTP access lines that already carry SQL query counts and timings, a database-backed SQL and stack profiler rendered with speedscope, and per-run wall-time and peak-memory measurements from the dev scripts. This section documents those pieces and how to drive them in this fork.

What this repo does *not* have is worth stating plainly, because it explains why this section has only two sub-pages. There is no metrics collection, no distributed tracing, and no alerting infrastructure in the server or in the fork's code: `requirements.txt` pins no Prometheus, OpenTelemetry, statsd, or error-reporting SDK (Sentry and similar are absent), and no exporter code exists in `odoo/` or the fork's addons. The only occurrences of those product names in the tree are inside vendored third-party files such as `addons/web/static/lib/pdfjs/web/debugger.js`. There is also no CI in this repository, so nothing watches logs or profiles for you ([tooling](../how-to-contribute/tooling.md)).

The one monitoring-adjacent endpoint is `/web/health` (`addons/web/controllers/home.py`): unauthenticated JSON `{"status": "pass"}`, with `?db_server_status=1` also probing the PostgreSQL server and returning 500 on failure. It answers "is this worker alive", nothing else.

## What exists

| Capability | Where | Notes |
| --- | --- | --- |
| Structured server logging | `odoo/netsvc.py`, `odoo/logging.py` | Colored and JSON formatters, `--log-handler` per-module levels, `--log-db` writing into the `ir.logging` table |
| Request/access logging | `odoo/http/server_log.py` | One line per request with status, body size, query count, query time, cursor mode |
| SQL query logging | `odoo/sql_db.py` | Every query at DEBUG on the `odoo.sql_db` logger, plus per-table stats at cursor close |
| Profiler + speedscope | `odoo/tools/profiler.py`, `addons/web/controllers/profiling.py` | SQL and async stack collectors, results stored in `ir.profile`, viewed in the browser |
| Per-database log store | `odoo/addons/base/models/ir_logging.py` | `ir.logging` records, fed by the `--log-db` handler or client-side errors |
| Wall time and peak memory | `scripts/dev/_common.sh` | `logs/measure-*.txt` for every scripted run, via GNU `time -v` |

## Sub-pages

| Page | What it covers |
| --- | --- |
| [Logging](logging.md) | The logging pipeline, levels and handlers, `ir.logging`, request and SQL logs, where dev logs land, how to add log statements |
| [Profiling](profiling.md) | The `Profiler` context manager and its collectors, enabling profiling from the debug menu, speedscope, SQL counters, dev measurements |

## Entry points for modification

Most tuning here is configuration rather than code: pick loggers with `--log-handler`, profile from the debug menu, and read what the dev scripts already capture in `logs/`. When something needs a new log statement or a profile around a code path, the sub-pages show the exact places to touch.

## Related pages

- [Debugging](../how-to-contribute/debugging.md) is the hands-on companion to this section, including common errors in the offline stack.
- [Server runtime](../systems/server-runtime.md) and [HTTP server](../systems/http-server.md) cover where requests, workers, and cursors come from.
- [Testing](../how-to-contribute/testing.md) documents how the test wrappers grep the log to catch silent no-op runs.
- [Deployment](../deployment.md) covers running packaged servers; the same logging options apply.
