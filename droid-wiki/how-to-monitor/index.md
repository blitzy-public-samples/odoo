# Monitoring
Active contributors: Christophe, Xavier, Krzysztof

## Purpose

Odoo 20.0 ships its own observability, and this section documents it as it exists in this fork. There is substantially more than a bare server log: a structured logging pipeline over Python's `logging`, per-request access lines that already carry SQL query counts and timings, and a database-backed SQL and stack profiler rendered with speedscope.

What the tree does **not** have is also worth stating plainly, because it sets the expectations for this section: no metrics collection, no distributed tracing, and no alerting infrastructure in the server or in the fork. There is no CI either, so nothing watches logs or profiles for you.

## What exists

| Capability | Where | Notes |
| --- | --- | --- |
| Structured server logging | `odoo/netsvc.py`, `odoo/logging.py` | Colored or JSON formatters, per-module levels, optional writing into `ir.logging`. |
| Request/access logging | `odoo/http/server_log.py` | One line per request with status, body size, query count, query time, cursor mode. |
| SQL query logging | `odoo/sql_db.py` | Every query at DEBUG on `odoo.sql_db`, plus per-table statistics at cursor close. |
| Profiler + speedscope | `odoo/tools/profiler.py`, `addons/web/controllers/profiling.py` | SQL and periodic stack collectors, results stored in `ir.profile`, viewed in the browser. |
| Per-database log store | `odoo/addons/base/models/ir_logging.py` | `ir.logging` records, fed by `--log-db` or client-side errors. |
| Wall time and peak memory | `scripts/dev/_common.sh` | `logs/measure-<script>.txt` for every measured dev run, via GNU `time -v`. |
| Liveness endpoint | `addons/web/controllers/home.py` | `/web/health`, unauthenticated JSON. |

## What does not exist

- **No metrics.** `requirements.txt` pins no Prometheus, OpenTelemetry, statsd, or Grafana client, and no exporter code exists in `odoo/` or the fork's addons.
- **No distributed tracing.** The profiler is per-process and per-request; nothing correlates work across workers or services.
- **No alerting.** Nothing in the tree watches logs or thresholds and notifies anyone.
- **No server-side error reporting.** `requirements.txt` pins no Sentry or comparable SDK and `odoo/` has no integration. The one Sentry call site in the tree is `addons/iot_drivers/tools/helpers.py`, which runs on IoT box devices, not the server, and `sentry_sdk` is not in `requirements.txt`.
- **No CI.** `.github/` holds only issue and PR templates, so no job runs tests, reads logs, or reports results ([Tooling](../how-to-contribute/tooling.md)).

The closest thing to a monitoring endpoint is `/web/health` (`addons/web/controllers/home.py`): it returns `{"status": "pass"}` as JSON, and with `?db_server_status=1` it also probes the PostgreSQL server and returns HTTP 500 when that fails. It answers "is this worker alive", nothing more.

## How it works

Logging and profiling are the two halves of the story and they share surfaces:

- Logging is assembled once at startup by `init_logger()` in `odoo/netsvc.py`, which installs a `LogRecord` factory, warning capture, and a single root handler (stderr, `--logfile`, or syslog), plus an optional PostgreSQL handler for `--log-db`. Verbosity is selected by `--log-level` and `--log-handler`.
- Profiling is opt-in per user through the debug menu, gated by the `base.profiling_enabled_until` config parameter, and wraps request dispatch in `odoo/http/router.py` with the `Profiler` context manager. Results are stored in `ir.profile` and rendered at `/web/speedscope/<ids>`.
- The dev scripts write every measured run's wall time and peak RSS to `logs/measure-<script>.txt`, which is often enough to answer "did this regress" without turning the profiler on.

## Sub-pages

| Page | What it covers |
| --- | --- |
| [Logging](logging.md) | The logging pipeline, `--log-level`/`--log-handler`, `ir.logging`, request and SQL logs, where dev logs land, how to add log statements. |
| [Profiling](profiling.md) | The `Profiler` context manager and its collectors, SQL counters, the debug-menu workflow, speedscope, and the dev-script measurements. |

## Key source files

| File | Purpose |
| --- | --- |
| `odoo/netsvc.py` | `init_logger()`, handler and level configuration. |
| `odoo/logging.py` | `ColoredFormatter`, `JSONFormatter`, `PostgreSQLHandler`. |
| `odoo/http/server_log.py` | Per-request access line with SQL counters. |
| `odoo/sql_db.py` | Per-query DEBUG logging and per-table statistics. |
| `odoo/tools/profiler.py` | `Profiler` context manager and collectors. |
| `addons/web/controllers/profiling.py` | `/web/set_profiling`, `/web/speedscope/<ids>`, `/web/profile_config/<id>`. |
| `scripts/dev/_common.sh` | `run_measured`, writes `logs/measure-<script>.txt`. |
| `addons/web/controllers/home.py` | `/web/health` liveness endpoint. |

## Related pages

- [Logging](logging.md) and [Profiling](profiling.md) — the two sub-pages.
- [Deployment](../deployment.md) — where `--logfile`, workers, and the service unit fit.
- [Debugging](../how-to-contribute/debugging.md) — reading logs and profiles against a real symptom.
- [HTTP server](../systems/http-server.md) — the request cycle the access line and profiler wrap.
- [Tooling](../how-to-contribute/tooling.md) — the dev scripts and the absence of CI.
