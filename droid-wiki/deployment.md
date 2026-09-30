# Deployment
Active contributors: Odoo SA (upstream)

## Purpose

This page is about running the server outside the dev scripts: which process model `odoo-bin` starts, which options matter for a real deployment, where data and sessions live on disk, what the packaging in `debian/` and `setup/` produces, and what this repository does and does not automate. Configuration options are listed in full in the [configuration reference](reference/configuration.md); this page covers the operational shape.

## Directory layout

```text
odoo-bin                  # 4-line launcher for odoo.cli.main()
odoo/cli/server.py        # the "server" command: preflight checks, config, server.start()
odoo/service/server.py    # ThreadedServer, PreforkServer, GeventServer, WorkerHTTP/Cron
odoo/tools/config.py      # option definitions, data_dir, filestore(), session_dir
requirements.txt          # pins aligned with Ubuntu 24.04 and Debian 12 packages
debian/
├── control               # Depends on python3-* distro packages; Recommends postgresql
├── odoo.service          # systemd unit (User=odoo, ExecStart=/usr/bin/odoo --config ...)
├── init                  # SysV init script (start-stop-daemon)
├── odoo.conf             # sample /etc/odoo/odoo.conf
├── rules                 # pybuild build; copies addons/ into odoo/addons/
└── README.Debian         # wkhtmltopdf header/footer caveat
setup/
├── odoo-wsgi.example.py  # root + application.initialize(), gunicorn settings
├── package.py            # build/publish deb, rpm, src, exe, iot packages
├── requirements-check.py # verifies requirements.txt against installed packages
├── docker/               # dfdebian, dffedora, dfsrc, dfwine
├── rpm/odoo.spec
├── win32/                # NSIS installers (setup.nsi, setup-iot.nsi)
└── iot_box_builder/iot_box_builder.py
scripts/dev/start.sh      # dev server, --https mode terminates TLS with socat
.github/                  # issue and PR templates only, no workflows
```

## Key abstractions

| Name | File | Description |
| --- | --- | --- |
| `main()` | `odoo/cli/server.py` | Root/postgres-user checks, database auto-creation, `server.start()`. |
| `start()` | `odoo/service/server.py` | Chooses the server class from `odoo.evented` and `--workers`. |
| `PreforkServer` | `odoo/service/server.py` | Master process spawning HTTP, cron and gevent workers, with a watchdog. |
| `GeventServer` | `odoo/service/server.py` | Greenlet server for websockets, one greenlet per connection, port 8072. |
| `ThreadedServer` | `odoo/service/server.py` | Default single-process server with a thread per request. |
| `config.filestore()` | `odoo/tools/config.py` | `data_dir/filestore/<dbname>`, where attachments live. |

## How it works

`./odoo-bin` only calls `odoo.cli.main()`. The default `server` command in `odoo/cli/server.py` refuses to run as root, exits if the configured database user is `postgres`, creates any empty database passed with `-d` when it has the rights, writes a pidfile when `--pidfile` is set, and hands control to `server.start()`. That function picks `GeventServer` when `odoo.evented` is set, `PreforkServer` when `--workers` is greater than zero, and `ThreadedServer` otherwise, which is the default of `--workers 0`.

The HTTP service listens on `--http-interface` (default `127.0.0.1`) and `--http-port` (8069); the websocket worker listens on `--gevent-port` (8072) and shares the interface. `--no-http` disables both. Behind a reverse proxy, `--proxy-mode` enables `ProxyFix` so `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For` are honoured, and it must only be enabled when a trusted proxy sets those headers; `--db-filter` restricts which databases the web interface will resolve, accepting `%h` for the host and `%d` for its first label, and `--no-database-list` removes the database manager and selector entirely. `--logfile` and `--log-level` route the server log; `setup/logger_conf` holds upstream logging configurations.

Resource limits are per worker: `--limit-memory-soft` (2048 MiB default) makes a worker finish its current request and exit, `--limit-memory-hard` (2560 MiB) makes further allocation fail, `--limit-time-cpu` (60 s) and `--limit-time-real` (120 s) bound a request, and `--limit-request` (65536) recycles a worker after that many requests. `--max-cron-threads` (2) controls how many cron workers the prefork master spawns. The prefork master restarts dead workers, monitors them through pipes, and can reload on SIGHUP using `ODOO_HTTP_SOCKET_FD` so the listening socket stays open.

Database connections are pooled per process. `--db_maxconn` (64) caps the physical connections for the threaded and prefork servers, `--db_maxconn_gevent` caps them for the gevent worker separately, and the pool is what a burst of requests consumes, so the useful worker count depends on it. Read-only routes can be served from a replica with `--db_replica_host` and `--db_replica_port`, or simulated locally with `--dev=replica`.

Persistent state lives under `--data-dir`. On Linux without a resolvable home directory the default is `/var/lib/Odoo`; otherwise it is the platform user data directory. Attachments are stored in `data_dir/filestore/<dbname>` through `config.filestore()`, sessions in `data_dir/sessions` (created with mode 0700, scattered over 4096 subdirectories, written atomically with `os.replace` and chmod 0644), and module data in `data_dir/addons/<series>`. The database stays the source of truth for everything except filestore blobs, so a filestore and a dump must be backed up together.

The checked-in `requirements.txt` says explicitly that the supported versions of its packages are their `python3-*` equivalents in Ubuntu 24.04 and Debian 12, and pins conditionals per Python version. `odoo/release.py` declares `MIN_PY_VERSION` 3.12, `MAX_PY_VERSION` 3.14 and `MIN_PG_VERSION` 16; `odoo/cli/server.py` logs a warning when the running Python is newer than the maximum. `setup/requirements-check.py` compares the file with what is installed.

### Packaging

`debian/control` pulls the dependencies as `python3-*` distribution packages rather than from PyPI, recommends `postgresql`, and conflicts with the old `openerp` packages. `debian/odoo.service` is a systemd unit running `/usr/bin/odoo --config /etc/odoo/odoo.conf --logfile /var/log/odoo/odoo-server.log` as user and group `odoo` with `KillMode=mixed`, and `debian/init` provides the SysV equivalent through `start-stop-daemon`. `debian/rules` builds with `pybuild` and copies `addons/*` into `odoo/addons/` so the installed tree is a single package directory. `setup/rpm/odoo.spec` covers Fedora, `setup/docker/` holds the four Dockerfiles, `setup/win32/` the NSIS installers, and `setup/iot_box_builder/iot_box_builder.py` the IoT box image. `setup/package.py` drives the whole thing and smoke-tests a package by installing `base` and counting modules through XML-RPC.

Deployment behind a WSGI server is supported but partial. `setup/odoo-wsgi.example.py` exports `odoo.http:root` after calling `application.initialize()`, with gunicorn `bind`, `workers`, `timeout` and `max_requests` settings. Websocket upgrades are handled by the gevent worker, so a gunicorn/uwsgi deployment that does not run `odoo-bin --workers N` loses the realtime bus.

### The dev `--https` trick

`scripts/dev/start.sh --https` terminates TLS on port 8069 with `socat OPENSSL-LISTEN` using a self-signed certificate generated into `var/tls/`, and runs Odoo itself on loopback port 8070 (`ODOO_HTTPS_BACKEND_PORT` in `scripts/dev/_common.sh`). The reason is the browser's secure-context rule: the offline and PWA stack is disabled on a plain HTTP origin that is not `localhost`, so any access through a hostname or a forwarded port needs TLS even in development. See [Getting started](overview/getting-started.md).

### What is not automated

There is no CI in this repository. `.github/` contains an issue template directory and a pull request template, and nothing else: no workflows, no scheduled jobs, no release automation. Test execution is manual through `scripts/dev/test-py.sh` and `scripts/dev/test-js.sh`, which guard against the test runner's silent-success modes, and packaging is a manual `setup/package.py` run. Any deployment process built on this repository has to supply its own pipeline.

## Integration points

- `odoo/service/server.py` is the file to read before changing anything about process lifetime; it also drives `ir.cron` (see [Cron and scheduled actions](primitives/cron-and-scheduled-actions.md)) and the registry signalling that keeps per-database caches in sync across workers.
- Asset bundles are generated at install or upgrade time and stored as attachments, so a deployment that changes front-end files needs `./scripts/dev/rebuild-assets.sh` in dev or a module upgrade in production; see [Assets](systems/assets.md).
- `--test-tags`, `--dev` and the transactional test framework are covered in [Test framework](systems/test-framework.md).

## Entry points for modification

Read `odoo/tools/config.py` for the authoritative option list, then `odoo/service/server.py:start()` to see how an option turns into a process model. Nothing in this fork's scope changes packaging; if the CRM app needs a different deployment story, that belongs in a deployment repository, not in `addons/crm/`.

## Key source files

| File | Purpose |
| --- | --- |
| `odoo-bin` | Entry point script. |
| `odoo/cli/server.py` | Server command, preflight checks, `server.start()`. |
| `odoo/service/server.py` | Threaded, Gevent and Prefork servers, `WorkerHTTP`, `WorkerCron`. |
| `odoo/tools/config.py` | All options, `data_dir`, `filestore()`, `session_dir`. |
| `odoo/http/session.py` | Session file store layout and atomic writes. |
| `odoo/release.py` | Version, supported Python and PostgreSQL minimums. |
| `requirements.txt` | Dependency pins with per-version conditionals. |
| `setup/odoo-wsgi.example.py` | WSGI and gunicorn deployment sample. |
| `setup/package.py` | Package build and publish tooling. |
| `setup/requirements-check.py` | Dependency verification. |
| `debian/control` | Debian dependencies and metadata. |
| `debian/odoo.service` | systemd unit. |
| `debian/init` | SysV init script. |
| `debian/rules` | Build rules and `addons/` relocation. |
| `setup/rpm/odoo.spec` | RPM spec. |
| `setup/docker/package.dfdebian` | Docker build definition. |
| `setup/win32/setup.nsi` | Windows installer. |
| `scripts/dev/_common.sh` | Dev paths, ports, `ODOO_HTTPS_BACKEND_PORT`. |
| `scripts/dev/start.sh` | Dev server, including the `--https` socat proxy. |

## Related pages

- [Security](security.md)
- [Configuration reference](reference/configuration.md)
- [Server runtime](systems/server-runtime.md)
- [Getting started](overview/getting-started.md)
- [Tooling](how-to-contribute/tooling.md)
- [Testing](how-to-contribute/testing.md)
- [Dependencies reference](reference/dependencies.md)
