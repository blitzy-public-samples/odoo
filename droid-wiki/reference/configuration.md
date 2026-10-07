# Configuration

## Purpose

Every knob that changes how the server runs, in one place: process options
(CLI flags, environment variables, the `odoo.conf` file, defaults), the
`odoo-bin` subcommands, the fork's `scripts/dev/` environment overrides
including the `--https` TLS mode, per-database Odoo system parameters, and
the config the browser receives with the web client. For how secrets are
protected, read [Security](../security.md); this page never needs real secret
values and does not print any.

## Precedence: how one option can be set four ways

`odoo/tools/config.py` builds a single `configmanager` whose `options` is a
`collections.ChainMap` resolved at read time in this order
(`odoo/tools/config.py:187-198`):

1. **Runtime values** (`_runtime_options`) — derived checks, not user input.
2. **CLI flags** (`_cli_options`) — parsed from the command line.
3. **Environment variables** (`_env_options`) — per-option `env_name` (see below).
4. **Config file** (`_file_options`) — the `[options]` section of `odoo.conf`.
5. **Defaults** (`_default_options`) — each option's `my_default`.

An option can also be file-only (no CLI flag, e.g. `admin_passwd`) or
CLI-only (`file_loadable=False`, e.g. `--init`, `--update`, `--test-tags`,
`--dev`). Environment names are auto-generated as `ODOO_<DEST>` for
file-loadable options unless the option sets an explicit `env_name`
(`odoo/tools/config.py:133-136`) — database options use libpq's names
(`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`,
`PGAPPNAME`, ...).

## The config file

```ini
[options]
admin_passwd = <database manager master password>
addons_path = /home/factory-user/repos/odoo/addons
data_dir = ~/.local/share/Odoo
db_host = /var/run/postgresql
db_port = 5432
workers = 0
```

- Section is always `[options]`; keys are option destinations (`addons_path`,
  not `--addons-path`). Unknown keys are kept as strings with a warning.
- Search order for the default path (`odoo/tools/config.py:556-575`): the
  user config dir (`.../odoo/odoo.conf`), then `~/.odoorc`, then
  `~/.openerp_serverrc` (deprecated), then the user config path again.
  Override with `-c <file>` or the `ODOO_RC` environment variable
  (`OPENERP_SERVER` still works but is deprecated).
- `odoo-bin --save` writes the current, exportable options back to that file.
- An optional `[colors]` section tunes per-output coloring
  (`pid`, `loglevel`, `session_id`, `http_request_line`,
  `http_response_body`, `perf`, `cursor_mode`, `sql`); each accepts
  `never` / `auto` / `always`.
- File-only options (no CLI flag): `admin_passwd` (default `admin`),
  `bin_path`, `csv_internal_sep`, `websocket_keep_alive_timeout` (3600),
  `websocket_rate_limit_burst` (10), `websocket_rate_limit_delay` (0.2),
  `reportgz`, `publisher_warranty_url`, `proxy_access_token`,
  `import_file_maxbytes` (10 MiB), `import_file_timeout` (3),
  `import_url_regex`, `default_productivity_apps`.

## `odoo-bin` CLI

`odoo-bin <command> [options]` — commands are discovered from
`odoo/cli/*.py` and any addon's `cli/` directory (`odoo/cli/command.py`).
Core commands: `server`, `start` (quick start with dev defaults), `shell`
(interactive REPL), `db` (create/dump/restore), `deploy`, `duplicate`,
`scaffold`, `i18n`, `module`, `neutralize`, `obfuscate`, `upgrade_code`,
`cloc`, `help`. `odoo-bin server` accepts all the options below; the dev
scripts in `scripts/dev/` wrap it.

### Common and startup options

| Option | Default | Effect |
| --- | --- | --- |
| `-c`, `--config` | searched path (see above); env `ODOO_RC` | Config file to read. |
| `--save` | off | Write the effective options to the config file. |
| `-i`, `--init` / `-u`, `--update` / `--reinit` | empty | Install / update / reinitialize modules; requires `-d`. CLI-only. |
| `--with-demo` / `--without-demo` | no demo | Install demo data in new databases. |
| `--skip-auto-install` | off | Skip modules marked `auto_install`. |
| `--addons-path` | empty | Extra addon directories (comma-separated). |
| `--upgrade-path`, `--pre-upgrade-scripts` | empty | Extra upgrade script locations for `-u` runs. |
| `--load` | `base,rpc,web` | Server-wide modules loaded before any database. |
| `-D`, `--data-dir` | platform data dir (e.g. `~/.local/share/Odoo`) | Filestore and sessions directory. |
| `-P`, `--import-partial` | empty | State file to resume interrupted large imports. |
| `--pidfile` | empty | Where the server writes its pid. |
| `--unsafe-policy` | `log` | Policy on unsafe objects in safe_eval: `disable`, `log`, `raise`, `terminate`. |

### HTTP and web

| Option | Default | Effect |
| --- | --- | --- |
| `--http-interface` | `127.0.0.1` | Listen address for HTTP. |
| `-p`, `--http-port` | `8069` | Main HTTP port. |
| `--gevent-port` | `8072` | Port of the gevent worker (longpolling/bus). |
| `--no-http` | off | Disable HTTP and longpolling entirely. |
| `--proxy-mode` | off | Trust reverse-proxy headers (`X-Forwarded-*`). Only behind a trusted proxy. |
| `--x-sendfile` | off | Delegate big file delivery to the web server (`X-Sendfile` / `X-Accel-Redirect`). |
| `--db-filter` | empty | Regex filtering which databases the web UI offers; `%d` and `%h` placeholders. |

### Database

| Option | Default | Effect |
| --- | --- | --- |
| `-d`, `--database` | empty; env `PGDATABASE` | Database(s) to act on. |
| `-r`, `--db_user` / `-w`, `--db_password` | empty; env `PGUSER` / `PGPASSWORD` | PostgreSQL credentials. |
| `--db_host` / `--db_port` | socket / 5432; env `PGHOST` / `PGPORT` | PostgreSQL endpoint (`PGHOST` may be a socket directory). |
| `--db_sslmode` | `prefer`; env `PGSSLMODE` | `disable` ... `verify-full`. |
| `--db_maxconn` | `64` | Max physical connections per process. |
| `--db_maxconn_gevent` | unset | Separate pool size for the gevent worker. |
| `--db-template` | `template0`; env `PGDATABASE_TEMPLATE` | Template for new databases. |
| `--db_app_name` | `odoo-{pid}`; env `PGAPPNAME` | Application name in PostgreSQL. |
| `--db_replica_host` / `--db_replica_port` | unset; env `PGHOST_REPLICA` / `PGPORT_REPLICA` | Read replica endpoint (see `--dev=replica`). |
| `--db-system` | `postgres`; env `PGDATABASE_SYSTEM` | Shared database for bus and maintenance. |
| `--pg_path` | empty; env `PGPATH` | Directory holding `psql` and friends. |
| `--no-database-list` | off | Hide the database list and the database manager. |

### Workers and limits (multiprocessing)

| Option | Default | Effect |
| --- | --- | --- |
| `--workers` | `0` | `0` = threaded mode; positive = prefork workers. |
| `--gevent-workers` | `1` | Gevent workers in prefork mode (needs `SO_REUSEPORT`). |
| `--limit-memory-soft` | 2048 MiB | Worker recycled after the request that crosses it. |
| `--limit-memory-hard` | 2560 MiB | Allocations above it fail. |
| `--limit-memory-soft-gevent` / `--limit-memory-hard-gevent` | unset | Per-gevent-worker overrides. |
| `--limit-time-cpu` | `60` | CPU seconds per request. |
| `--limit-time-real` | `120` | Wall-clock seconds per request. |
| `--limit-time-real-cron` | `-1` | Wall-clock per cron job (`-1` follows `--limit-time-real`, `0` = no limit). |
| `--limit-request` | `65536` | Requests per worker before recycling. |
| `--max-cron-threads` | `2` | Concurrent cron threads. |
| `--limit-time-worker-cron` | `0` | Cron thread/worker lifetime; `0` disables the check. |
| `--osv-memory-count-limit` | `0` | Max records in TransientModel tables (`0` = no limit). |
| `--transient-age-limit` | `1.0` | Hours a TransientModel record is kept. |

### Testing, logging, SMTP, i18n, advanced

| Option | Default | Effect |
| --- | --- | --- |
| `--test-enable` | off | Run tests; implies `--stop-after-init`. CLI-only. |
| `-t`, `--test-tags` | empty | Tag/module/class/method filter, e.g. `/crm:TestCrmOffline`; implies test mode. CLI-only. |
| `--test-file` | empty | Run a single Python test file. |
| `--screenshots` / `--screencasts` | `$TMPDIR/odoo_tests` | Where browser-test captures land. |
| `--logfile`, `--log-level` | empty / `info` | Log sink and verbosity (`debug`, `test`, `runbot`, ...). |
| `--log-handler` | `:INFO` | Per-module log levels, repeatable (`odoo.orm:DEBUG`); `--log-web` and `--log-sql` are shortcuts. |
| `--log-db`, `--log-db-level` | empty / `warning` | Log into a database. |
| `--log-config` | empty | JSON dictConfig logging file. |
| `--smtp`, `--smtp-port`, `--smtp-user`, `--smtp-password`, `--smtp-ssl` | `localhost`, `25`, empty, empty, off | Outgoing mail server. |
| `--email-from`, `--from-filter` | empty | From address and which address may use the SMTP config. |
| `--load-language`, `--i18n-overwrite` | — | Load translations at init; overwrite existing terms on update. |
| `--dev` | empty; env `ODOO_DEV` | Dev features: `access`, `qweb`, `reload`, `replica`, `xml`; `all` enables `access`, `qweb`, `reload`, `xml`. CLI-only. |
| `--stop`, `--stop-after-init` | off | Exit after initialization. CLI-only. |
| `--unaccent` | off | Enable the PostgreSQL `unaccent` extension on new databases. |
| `--geoip-city-db`, `--geoip-country-db` | `/usr/share/GeoIP/GeoLite2-*.mmdb` | MaxMind database paths. |

The `scripts/dev/` wrappers pass the relevant subset of these themselves —
see [CLI and maintenance](../systems/cli-and-maintenance.md) for the exact
commands each wrapper runs.

## The `scripts/dev/` environment overrides

The fork's dev environment layers its own variables on top
(`scripts/dev/_common.sh:10-20`). These belong to the scripts, not to
`configmanager`:

| Variable | Default | Used for |
| --- | --- | --- |
| `ODOO_DB` | `crm_offline` | Dev/test database everywhere. |
| `ODOO_PORT` | `8069` | Public port: plain HTTP, or HTTPS with `start.sh --https`. |
| `ODOO_HTTPS_BACKEND_PORT` | `8070` | Loopback port Odoo binds in `--https` mode. |
| `ODOO_ADMIN_LOGIN` / `ODOO_ADMIN_PASSWORD` | `admin` / `admin` | Dev login (printed by `start.sh`). |
| `PGHOST` | `/var/run/postgresql` | Socket dir so plain `./odoo-bin -d <db>` needs no DB flags. |
| `PGPORT` | `5432` | PostgreSQL port. |
| `ODOO_RC` | (from config.py) | If set, points the server at a config file. |

Everything the scripts produce lands in the gitignored `logs/`
(`logs/odoo.log`, `logs/test-*.log`, `logs/measure-*.txt`) and `var/`
(`var/tls/`). See [Getting started](../overview/getting-started.md).

### The `--https` TLS mode

`./scripts/dev/start.sh --https` exists because offline features need a
[secure context](../features/offline-and-pwa/index.md): a plain `http://`
origin that is not `localhost` disables service workers, IndexedDB crypto,
and the whole offline layer. What the mode does (`scripts/dev/start.sh`):

- generates a self-signed certificate on first run in `var/tls/`
  (`odoo-dev.crt` / `odoo-dev.key`, CN `localhost`, SAN
  `DNS:localhost,IP:127.0.0.1`, RSA 2048, valid 10 years);
- starts Odoo itself on the loopback-only port `8070`
  (`--http-interface=127.0.0.1`);
- runs `socat OPENSSL-LISTEN:8069,fork,reuseaddr,verify=0,cert=...,key=...`
  as a TLS proxy from port `8069` (any interface) to `127.0.0.1:8070`;
- the browser shows a certificate warning that must be accepted once.

Use it whenever the page is opened through a port forward or from another
machine. On plain `localhost`, the default mode is already a secure
context. The default `start.sh` mode binds `127.0.0.1` only; the TLS port
accepts connections from any interface — do not expose it past the dev
machine.

## Odoo system parameters (`ir.config_parameter`)

Process options configure the server; system parameters configure the
database. They are key/value rows in the `ir_config_parameter` table with
typed accessors (`get_bool`, `get_int`, `get_float`, `get_str` /
`set_*`), readable through Settings > Technical > System Parameters.
Defaults initialized at database creation
(`odoo/addons/base/models/ir_config_parameter.py:33-41`):

| Key | Default | Effect |
| --- | --- | --- |
| `database.secret` | random UUID | HMAC key for session tokens and derived secrets; protected from rename/delete. |
| `database.uuid` / `database.create_date` | random / now | Database identity and birth date. |
| `web.base.url` | `http://localhost:<http_port>` | Base URL for links and assets. |
| `base.login_cooldown_after` / `base.login_cooldown_duration` | `10` / `60` | Login rate limiting. |

Other parameters read by the code paths this wiki covers:

| Key | Where it is read | Effect |
| --- | --- | --- |
| `web.web_app_name` | `addons/web/controllers/webmanifest.py:43` | Name in the PWA manifest; falls back to `Odoo`. Declared as a setting in `addons/web/models/res_config_settings.py`. |
| `web.max_file_upload_size` | `addons/web/models/ir_http.py` | Upload size cap in session info. |
| `web.quick_login` | `addons/web/models/ir_http.py` | Quick-login signal in session info. |
| `web.active_ids_limit` | `addons/web/models/ir_http.py` | Cap on active ids sent to the client (default 20000). |
| `base.session_check_device` | `addons/web/models/ir_http.py` | Enables the per-device salt for session security. |
| `base.default_max_email_size` | `odoo/addons/base/data/ir_config_parameter_data.xml` | Max email size (MB), default 20. |
| `report.pdf_engine_default` | `odoo/addons/base/models/ir_actions_report.py:799` | Default PDF engine for reports; `html` means no binary engine. |
| `iap.endpoint` | `addons/iap/tools/iap_tools.py` | Base URL for IAP calls, default `https://iap.odoo.com`. |

### CRM settings and parameters

`addons/crm/models/res_config_settings.py` writes these parameters from the
CRM settings panel:

| Key / setting | Effect |
| --- | --- |
| `crm.lead.auto.assignment` | Enables rule-based lead assignment; the settings form also syncs the `crm.ir_cron_crm_lead_assign` cron (active, interval, next run). |
| `crm.iap.lead.enrich.setting` | `manual` or `auto` — when IAP lead enrichment runs. |
| `crm.lead_mining_in_pipeline` | Shows lead-mining requests directly in the pipeline. |
| `crm.pls_start_date` | Start date for predictive lead scoring (stored as a string; malformed values fall back to "8 days ago"). |
| `crm.pls_fields` | Comma-separated `crm.lead` field names used by lead scoring. |
| `sales_team.membership_multi` | Multi-team membership. |
| Groups `crm.group_use_lead`, `crm.group_use_recurring_revenues` | Toggle leads vs opportunities-only, and recurring revenues UI. |

The same panel toggles optional modules (`module_crm_iap_mine`,
`module_crm_iap_enrich`, `module_website_crm_iap_reveal`, ...) which pull in
the IAP-dependent addons described in [Dependencies](dependencies.md).

## Browser-side config: session info and the cache secret

The web client page (`/odoo`) carries a JSON `session_info` object built by
`addons/web/models/ir_http.py` (`session_info()`) and extended by
`addons/web/controllers/home.py`. The client reads configuration from it:
user context and identity flags, `db`, `server_version`,
`web.base.url`, `currencies`, user settings, tour flags — and two values
the offline stack depends on:

- **`registry_hash`** — an HMAC (scope `webclient-cache`) over the asset
  registry sequence. The offline IndexedDB stores a version record keyed on
  `registry_hash + CRYPTO_ALGO` and wipes the whole database when the
  registry changes (`addons/web/static/src/core/utils/indexed_db.js`).
- **`browser_cache_secret`** — an HMAC with scope `browser_cache_key` over
  the user's session-token values, keyed by the `database.secret` system
  parameter (`addons/web/controllers/home.py:72-78`, helper in
  `odoo/tools/misc.py`). It is added only to the webclient page, which is
  served with `Cache-Control: no-store`, so it never lands in a shared HTTP
  cache. A password or 2FA change rotates it, which re-keys the offline
  encrypted store (`addons/web/static/src/core/crypto.js` derives AES-GCM
  keys from it).

Never print, log, or commit real values of `admin_passwd`,
`db_password`, `smtp_password`, `proxy_access_token`, or
`browser_cache_secret` — see [Security](../security.md).

## Key source files

| File | Purpose |
| --- | --- |
| `odoo/tools/config.py` | Option declarations, precedence, file and environment loading. |
| `odoo/cli/command.py` | Subcommand discovery for `odoo-bin`. |
| `odoo/addons/base/models/ir_config_parameter.py` | System parameter storage, typed accessors, protected defaults. |
| `odoo/addons/base/data/ir_config_parameter_data.xml` | `base.default_max_email_size` default. |
| `addons/web/models/res_config_settings.py` | `web.web_app_name` setting. |
| `addons/web/controllers/webmanifest.py` | PWA manifest built from `web.web_app_name`. |
| `addons/web/models/ir_http.py` | `session_info()` contents. |
| `addons/web/controllers/home.py` | `browser_cache_secret` derivation, no-store caching. |
| `addons/crm/models/res_config_settings.py` | CRM settings and `crm.*` parameters. |
| `scripts/dev/_common.sh` | Dev environment variable defaults. |
| `scripts/dev/start.sh` | Plain and `--https` server startup, TLS proxy. |

## Related pages

- [Reference](index.md)
- [Server runtime](../systems/server-runtime.md)
- [HTTP server](../systems/http-server.md)
- [CLI and maintenance](../systems/cli-and-maintenance.md)
- [Offline and PWA](../features/offline-and-pwa/index.md)
- [Security](../security.md)
- [Deployment](../deployment.md)
