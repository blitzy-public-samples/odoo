# Deployment
Active contributors: Julien, Christophe, Xavier

## Purpose

This page covers running the server outside the dev loop in `scripts/dev/`: which process model `odoo-bin` starts, the options that matter for a real deployment, how databases and modules are provisioned, how assets reach the browser, how to put TLS in front, how to run it as a service, and how to back the data up. The full option list lives in the [configuration reference](reference/configuration.md); this page is the operational shape around it.

This fork changes nothing about deployment. Everything here is upstream Odoo 20.0; the only fork-specific fact is that the offline and PWA features in `addons/crm` require a secure context, which ties into TLS and is called out below.

## Key options

Defined in `odoo/tools/config.py`, overridable from the command line, a config file, or environment variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `ODOO_DEV`, ...).

| Option | Default | Controls |
| --- | --- | --- |
| `-d`, `--database` | none | Database(s) to serve, comma-separated. Also drives `preload`. |
| `--db_host`, `--db_port`, `--db_user`, `--db_password` | libpq defaults | PostgreSQL connection. |
| `--db_maxconn` | 64 | Physical connections per process; `--db_maxconn_gevent` caps the gevent worker separately. |
| `--http-interface` / `--http-port` | `127.0.0.1` / `8069` | HTTP listener. |
| `--gevent-port` | `8072` | Websocket listener (shared by the gevent server). |
| `--no-http` | off | Disable HTTP and websockets. |
| `--workers` | 0 | 0 selects the threaded server; >0 selects the prefork master. |
| `--gevent-workers` | 1 | Gevent workers spawned by the prefork master. |
| `--max-cron-threads` | 2 | Cron workers spawned by the prefork master. |
| `--limit-memory-soft` / `--limit-memory-hard` | 2048 / 2560 MiB | Soft recycles the worker after the current request; hard makes further allocation fail. |
| `--limit-time-cpu` / `--limit-time-real` | 60 s / 120 s | Per-request CPU and wall-clock bounds. |
| `--limit-request` | 65536 | Requests a worker serves before it is recycled. |
| `--limit-time-worker-cron` | 0 | Max age of a cron worker before it restarts; 0 disables. |
| `--addons-path` | discovered | Where modules are found. |
| `-D`, `--data-dir` | platform data dir | Filestore, sessions, and downloaded module data. |
| `--proxy-mode` | off | Honour `X-Forwarded-Proto`/`-Host`/`-For` from a trusted reverse proxy. |
| `--db-filter` | empty | Regex (with `%h`/`%d`) limiting which databases the web interface resolves. |
| `--no-database-list` | off | Hides the database manager and selector. |
| `-i` / `-u` | none | Install / update modules at startup, then continue. |
| `--with-demo` / `--without-demo` | off | Demo data on database creation. |
| `--stop-after-init` | off | Exit after initialization instead of serving. |
| `--logfile`, `--log-level`, `--log-config` | stderr, `info` | See [Logging](how-to-monitor/logging.md). |

## How it works

### Entry point and process model

`./odoo-bin` is a four-line launcher for `odoo.cli.main()`. The default command is `server` in `odoo/cli/server.py`. Its `main()` warns when run as root, refuses to run with a database user of `postgres`, creates any named database that does not exist yet, sets `init = {'base': True}` so the base module is installed, optionally writes a pidfile (`--pidfile`), and calls `server.start(preload=db_name, stop=stop_after_init)`.

`odoo/service/server.py:start()` picks the server class:

- `GeventServer` when `odoo.evented` is set (websockets in-process, one greenlet per connection).
- `PreforkServer` when `--workers` is greater than 0: a master that spawns `WorkerHTTP` and `WorkerCron` processes, watches them through pipes, restarts dead ones, and reloads on `SIGHUP` while keeping the listening socket open via `ODOO_HTTP_SOCKET_FD`.
- `ThreadedServer` otherwise, the `--workers 0` default: one process, one thread per request, plus cron threads (`--max-cron-threads`).

Resource limits are enforced per worker: the soft memory limit recycles the worker after the current request, the hard limit makes allocation fail, and the CPU/wall-clock limits bound each request. `addons/*` behaviour is documented further in [Server runtime](systems/server-runtime.md) and [HTTP server](systems/http-server.md).

### Database and module provisioning

Odoo only creates an empty database and installs modules during initialization; the dev database is built exactly this way:

```bash
./odoo-bin -d crm_offline -i crm,mail --with-demo --stop-after-init
```

`-i crm,mail` installs CRM (mail is its dependency and is listed explicitly), `--with-demo` loads demo data, and `--stop-after-init` exits once done. Without `-i`, a plain `./odoo-bin -d crm_offline` serves the database as-is and installs nothing.

For upgrades, `-u MODULE,...` runs the module's migration in place before serving, which is how an installed database picks up changed models, data files, and views:

```bash
./odoo-bin -d crm_offline -u crm --stop-after-init
```

`odoo-bin module install` and `odoo-bin module upgrade` (in `odoo/cli/module.py`) do the same thing through a dedicated command.

### Assets in production

Front-end bundles are generated at module install or upgrade time and stored as attachments, so a deployment that changes any js/css/scss/xml in a module ships by upgrading that module, not by copying files. In this fork's dev loop the helper `./scripts/dev/rebuild-assets.sh` deletes generated asset attachments and calls `env['ir.attachment'].regenerate_assets_bundles()` and `env['ir.qweb']._pregenerate_assets_bundles()` in a shell; in production the equivalent is a module upgrade plus a restart. See [Assets](systems/assets.md).

### TLS and a reverse proxy

The dev reference setup is `./scripts/dev/start.sh --https`: `socat OPENSSL-LISTEN` terminates TLS on port 8069 with a self-signed certificate generated into `var/tls/` (`openssl req -x509`, CN `localhost`, SAN `localhost`/`127.0.0.1`) and proxies to Odoo on loopback port 8070. The reason is the browser secure-context rule: the offline and PWA stack is disabled on a plain `http://` origin that is not `localhost`, so any access through another hostname or a forwarded port needs TLS even in development. See [Getting started](overview/getting-started.md).

A real deployment does the same thing with a proper certificate: Odoo listens on loopback (the default `--http-interface`), a TLS proxy (nginx, Caddy, HAProxy) terminates HTTPS and forwards to 8069, and Odoo is started with `--proxy-mode` so it trusts `X-Forwarded-Proto`/`-Host`/`-For` from that proxy. Because the CRM offline features require a secure context, HTTPS is not optional for this fork in production, not just cosmetic. Keep the websocket port 8072 reachable through the proxy for the realtime bus.

### Service management

The repository ships package/service files but does not install anything itself:

- `debian/odoo.service` is a systemd unit: `Type=simple`, `User=odoo`, `Group=odoo`, `ExecStart=/usr/bin/odoo --config /etc/odoo/odoo.conf --logfile /var/log/odoo/odoo-server.log`, `KillMode=mixed`, `WantedBy=multi-user.target`.
- `debian/init` is the SysV equivalent, starting `/usr/bin/odoo` with `start-stop-daemon`, pidfile `/var/run/odoo.pid`, log `/var/log/odoo/odoo-server.log`.
- `debian/logrotate` rotates `/var/log/odoo/*.log` with `copytruncate`.
- `debian/control` declares the dependencies as `python3-*` distribution packages, recommends `postgresql`, and conflicts with the old `openerp` packages.
- `debian/rules` builds with `dh ... --buildsystem=pybuild` and, in `override_dh_auto_build`, copies `addons/*` into `odoo/addons/` so the installed tree is one package directory.

The same pattern applies to any service manager: run `odoo-bin --config /etc/odoo/odoo.conf`, point it at the database and data directory, and let the service manager restart it. The shipped systemd unit uses `KillMode=mixed`; running the server under the service manager (or an equivalent) is the supported shape rather than backgrounding `odoo-bin` by hand.

### Backup and restore

`odoo-bin db` (`odoo/cli/db.py`) is the filestore-aware command-line database manager, and it is the right tool because the database alone is not a complete backup: attachments live in `data_dir/filestore/<dbname>`, outside PostgreSQL.

| Subcommand | What it does |
| --- | --- |
| `db dump <db> [path] [--format zip\|dump] [--no-filestore]` | Dump the database, by default as a zip that includes the filestore. |
| `db load [db] <dumpfile> [-f/--force] [-n/--neutralize] [--move]` | Restore a zip; `--neutralize` disables outgoing mail, `--move` keeps the UUID. |
| `db init <db> [--with-demo] [--force] [--language] [--username] [--password] [--country]` | Create and initialize an empty database. |
| `db duplicate <source> <target> [-f] [-n]` | Copy a database and its filestore. |
| `db rename <source> <target> [-f]` | Rename, moving the filestore too. |
| `db drop <db>` | Drop a database and its filestore. |

`db load` only accepts the zipped format; raw `pg_dump` output must be restored with `pg_restore`/`psql`, as the command says when handed a non-zip file. A backup taken with `pg_dump` alone is incomplete for a filestore-backed deployment.

### Versions and dependencies

`requirements.txt` states that its pinned versions are the `python3-*` equivalents distributed in Ubuntu 24.04 and Debian 12, with per-Python-version conditionals. `odoo/release.py` sets `MIN_PY_VERSION` 3.12, `MAX_PY_VERSION` 3.14, and `MIN_PG_VERSION` 16; the server logs a warning when Python is newer than the maximum. `setup/requirements-check.py` compares the pins with what is installed. `setup/package.py` builds and publishes the deb/rpm/src/exe/iot packages, and `setup/odoo-wsgi.example.py` is a gunicorn/uwsgi sample that calls `application.initialize()` and exports `odoo.http.router.root`; websockets still need the Odoo gevent worker, so a WSGI-only deployment loses the realtime bus.

### What is not automated

There is no CI in this repository. `.github/` holds only `ISSUE_TEMPLATE/` and `PULL_REQUEST_TEMPLATE.md` — no workflows, no scheduled jobs, no release automation. Tests run manually through `scripts/dev/test-py.sh` and `scripts/dev/test-js.sh`, packaging is a manual `setup/package.py` run, and any deployment pipeline has to be supplied around the repository.

## Integration points

- `odoo/service/server.py` owns process lifetime and also drives `ir.cron` and the registry signalling that keeps per-database caches consistent across workers; see [Cron and scheduled actions](primitives/cron-and-scheduled-actions.md).
- Asset generation runs on install/upgrade, so the deploy step for a front-end change is a module upgrade ([Assets](systems/assets.md)).
- `--test-enable` / `-t` imply `--stop-after-init` and reuse the same initialization path; see [Test framework](systems/test-framework.md).
- The offline/PWA secure-context requirement is a deployment constraint, not a code switch; the dev TLS pattern is in [Getting started](overview/getting-started.md).
- Logging and profiling are configured with the same options surfaced here; see [Monitoring](how-to-monitor/index.md).

## Entry points for modification

Read `odoo/tools/config.py` for the authoritative option list, then `odoo/service/server.py:start()` to see how an option becomes a process model, and `odoo/cli/server.py:main()` for the startup preflight and database auto-creation. Nothing in this fork's scope changes packaging or the process model: if the CRM app needed a different deployment story it would belong in a deployment repository, not in `addons/crm/`.

## Key source files

| File | Purpose |
| --- | --- |
| `odoo-bin` | Launcher for `odoo.cli.main()`. |
| `odoo/cli/command.py` | Command registry and dispatch. |
| `odoo/cli/server.py` | Server command: preflight checks, database auto-creation, `server.start()`. |
| `odoo/cli/db.py` | Filestore-aware `db dump`/`load`/`init`/`duplicate`/`rename`/`drop`. |
| `odoo/cli/module.py` | `module install` / `module upgrade`. |
| `odoo/service/server.py` | `ThreadedServer`, `GeventServer`, `PreforkServer`, `WorkerHTTP`, `WorkerCron`. |
| `odoo/tools/config.py` | Every option, `data_dir`, `session_dir`, `filestore()`. |
| `odoo/http/session.py` | Session file layout and atomic writes. |
| `odoo/release.py` | Version, supported Python and PostgreSQL minimums, product name. |
| `requirements.txt` | Pinned dependencies with per-Python-version conditionals. |
| `scripts/dev/start.sh` | Dev server and the `--https` socat TLS proxy. |
| `scripts/dev/_common.sh` | Dev ports, log paths, `ODOO_HTTPS_BACKEND_PORT`. |
| `scripts/dev/rebuild-assets.sh` | Regenerates asset bundles in the dev database. |
| `debian/odoo.service` | systemd unit. |
| `debian/init` | SysV init script. |
| `debian/logrotate` | Log rotation. |
| `debian/control`, `debian/rules` | Package dependencies and build rules. |
| `setup/odoo-wsgi.example.py` | WSGI/gunicorn deployment sample. |
| `setup/package.py` | Package build and publish tooling. |
| `setup/requirements-check.py` | Dependency verification. |

## Related pages

- [Monitoring](how-to-monitor/index.md), [Logging](how-to-monitor/logging.md), [Profiling](how-to-monitor/profiling.md)
- [Server runtime](systems/server-runtime.md) and [HTTP server](systems/http-server.md)
- [Assets](systems/assets.md)
- [Configuration reference](reference/configuration.md)
- [Getting started](overview/getting-started.md)
- [Debugging](how-to-contribute/debugging.md)
- [Security](security.md)
