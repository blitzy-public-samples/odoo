# Dependencies

## Purpose

What the codebase needs to run and what it may call: the pinned Python
packages, the vendored JavaScript libraries, the PostgreSQL and PDF-engine
requirements, the asset build chain, and the external services CRM can
reach. Repository-wide counts (files, lines, translation mass) live in
[By the numbers](../by-the-numbers.md); secret handling lives in
[Security](../security.md).

## Python dependencies

`requirements.txt` pins every package per Ubuntu/Debian release — the
supported interpreter window is Python 3.12 to 3.14
(`MIN_PY_VERSION`/`MAX_PY_VERSION` in `odoo/release.py`), and most pins are
guarded with markers like `python_version >= '3.12' and python_version <
'3.13'` for Ubuntu 24.04 "Noble", `python_version >= '3.13'` for Debian 13
"Trixie", or `python_version >= '3.14'` for Ubuntu 26.04 "Resolute". The
majors:

| Package | Pin(s) | Role |
| --- | --- | --- |
| `psycopg2` | **2.9.9** (Noble), **2.9.10** (Trixie) | PostgreSQL driver (`odoo/sql_db.py`). |
| `gevent` / `greenlet` | 24.2.1 / 3.0.3 (Noble); 24.11.1 / 3.1.1 (Trixie); greenlet 3.3.2 (Resolute) | Gevent worker: longpolling and the websocket bus. |
| `Werkzeug` | 3.0.1 | WSGI machinery under `odoo/http/`. |
| `lxml` | 5.2.1 (Noble), 5.4.0 (Trixie), 6.0.2 (Resolute) + `lxml-html-clean` | XML/QWeb parsing, views, XML-RPC. |
| `Babel` | 2.10.3 (< 3.13), 2.17.0 (>= 3.13) | Translations and date/number formatting. |
| `Jinja2` / `MarkupSafe` | 3.1.2 / 2.1.5 | Jinja2 renders the module skeletons of `odoo-bin scaffold` (`odoo/cli/scaffold.py`, the only in-tree import); MarkupSafe escapes markup in report rendering (`ir.actions.report`). |
| `cryptography` / `pyopenssl` / `asn1crypto` | 42.0.8 / 24.1.0 / 1.5.1 | Crypto primitives, used for PDF digital signatures (`odoo/tools/pdf/signature.py`); also `passlib` 1.7.4 for password hashing. |
| `requests` / `urllib3` / `idna` | 2.31.0 / 2.0.7 / 3.6 | Outbound HTTP (IAP calls, webhooks). |
| `h11` | 0.16.0 | HTTP/1.1 protocol parsing inside the server itself (`odoo/http/server.py`, `odoo/http/server_log.py`). |
| `Pillow` | 10.2.0 (Noble), 11.1.0 (Trixie), 12.1.1 (Resolute) | Image processing. |
| `reportlab` / `PyPDF2` / `PyPDF` | 4.1.0 / 2.12.1 (< 3.13) / 5.4.0 (>= 3.13) | PDF generation and splitting/merging. |
| `python-stdnum` / `zeep` | 1.19 (→2.2 on 3.14) / 4.2.1 (→4.3.1) | VAT number validation and SOAP (EU VIES). |
| `libsass` / `rjsmin` | 0.22.0 / 1.2.0 | Asset pipeline: SCSS compilation and JS minification. |
| Others | `num2words`, `polib`, `vobject`, `qrcode`, `geoip2`, `openpyxl`, `XlsxWriter`, `xlrd`, `python-dateutil`, `python-magic`, `python-ldap`, `pyserial`, `pyusb`, `psutil`, `freezegun`, `docutils`, `ofxparse`, `cbor2`, `chardet` | Spreadsheets, i18n file formats, calendar (ics), GeoIP, barcode/QR, hardware (serial/USB for POS), tests. |

Notes:

- The dev environment adds two packages `requirements.txt` does not pin:
  `websocket-client` (without it, every browser test skips silently while
  the run stays green) and `phonenumbers` (without it, phone formatting
  assertions fail). `scripts/dev/setup.sh` installs both into `.venv`.
- Vendored Python instead of new pins: `odoo/tools/_vendor/`
  (`send_file.py`, `useragents.py`), `odoo/tools/zeep/`, `odoo/tools/babel/`,
  `odoo/tools/arabic_reshaper/`, `odoo/tools/safe_eval/`, `odoo/tools/pdf/`
  are copies shipped in the tree, not external dependencies.
- One addon ships its own requirements file: `addons/populate/requirements.txt`.

## Vendored JavaScript

There is no npm, bundler, or JS build tooling; browser libraries are
committed under each addon's `static/lib/`. The web client ships them in
`addons/web/static/lib/`:

| Library | Version (as shipped) | Used for |
| --- | --- | --- |
| `owl/` | Owl 3.0.0-alpha.49 (`owl.js`, plus the `owl2/` compat layer in `addons/web/static/src/owl2/`) | The component framework everything is written in. |
| `hoot/`, `hoot-dom/` | — | The JS test framework (`@odoo/hoot`) and its DOM helpers. |
| `bootstrap/`, `popper/` | — | CSS framework and positioned elements. |
| `Chart/`, `chartjs-adapter-luxon/`, `luxon/` | Chart.js 4.5.0, Luxon 3.7.2 | Graph views. |
| `fullcalendar/` | — | Calendar view (core, daygrid, timegrid, list, interaction, luxon3). |
| `ace/` | 1.43.3 | The in-website HTML/JS editor. |
| `dompurify/` | 3.2.7 | HTML sanitization. |
| `diff_match_patch/` | — | Text diffing; shipped in the web bundle (`addons/web/__manifest__.py`) with no first-party importer left in `addons/web/static/src/`. |
| `pdfjs/` | — | PDF preview in the browser. |
| `prismjs/` | — | Syntax highlighting. |
| `signature_pad/` | — | Signature capture. |
| `stacktracejs/` | 3.x | Error reporting stack parsing. |
| `zxing-library/` | 10.x | Barcode scanning in the browser (POS). |
| `odoo_ui_icons/` | — | The Odoo icon font. |

Other addons vendor their own copies: `addons/mail/static/lib/`,
`addons/website/static/lib/`, `addons/spreadsheet/static/lib/`,
`addons/html_editor/static/lib/`, `addons/point_of_sale/static/lib/`,
`addons/partner_autocomplete/static/lib/`, `addons/auth_passkey/static/lib/`,
`addons/pos_imin/static/lib/`, `addons/website_event_track/static/lib/`.

`addons/web/static/src/libs/` holds thin wrappers rather than copies:
`bootstrap.js` (extensions and fixes to Bootstrap applied in one place
"to avoid patching in place"), `luxon.js`, and the `fontawesome/` and
`materialsymbols/` icon adapters.

## PostgreSQL

Minimum version **16** (`MIN_PG_VERSION = 16` in `odoo/release.py`).
`odoo/sql_db.py` warns at connect when `server_version` is lower and the
tree relies on features of newer engines (e.g. the
`Constraint ... _not_null` warning about PostgreSQL 18 naming in
`odoo/orm/table_objects.py`). The dev scripts target the distro cluster
over the `/var/run/postgresql` socket (`scripts/dev/_common.sh`).

## PDF engines (wkhtmltopdf status in 20.0)

QWeb reports render to HTML first; converting HTML to PDF is a pluggable
engine, and **base ships none**: `ir.actions.report._run_pdf_engine` raises
`NotImplementedError` unless a module provides one
(`odoo/addons/base/models/ir_actions_report.py`). Resolution order: the
report's `report_type` (`qweb-pdf-<engine>`), else the
`report.pdf_engine_default` system parameter, else `html` (no conversion).

- **wkhtmltopdf** is not hard-wired anymore. It is provided by
  `addons/base_report_wkhtmltox` (`auto_install: True`), which shells out to
  the external `wkhtmltopdf` binary, detects the patched-Qt build, and
  degrades to state `install` ("you need Wkhtmltopdf to print a pdf") when
  the binary is missing. Without the binary, PDF printing reports an engine
  error rather than crashing the server.
- **paper-muncher** is the second shipped engine
  (`addons/base_report_paper_muncher`), an external headless-Chromium-based
  binary it looks for at `/opt/paper-muncher/bin/paper-muncher`.
- Neither binary is a Python dependency; both are deployment concerns (see
  [Deployment](../deployment.md)).

## Asset build chain

No node, no npm, no webpack — the asset pipeline
(`odoo/addons/base/models/assetsbundle.py`, details in
[Assets](../systems/assets.md)) uses Python: SCSS compiles through
`libsass` (falling back to an external `sass` binary with
`-r bootstrap-sass --compass` if the module is missing), and JS minifies
with `rjsmin`. `scripts/dev/rebuild-assets.sh` regenerates the bundles after
front-end changes.

## External services CRM can call

All optional and selected by settings; all credits go through
`iap.account` records, and each endpoint is overridable by a system
parameter (see [Configuration](configuration.md)):

| Service | Default endpoint | Parameter | Entered through |
| --- | --- | --- | --- |
| IAP (generic, lead mining `crm_iap_mine`) | `https://iap.odoo.com` | `iap.endpoint` | `addons/iap/tools/iap_tools.py` |
| Lead/company enrichment | `https://iap-services.odoo.com` | `enrich.endpoint` | `addons/iap/models/iap_enrich_api.py` |
| Partner autocomplete | `https://partner-autocomplete.odoo.com` | `iap.partner_autocomplete.endpoint` | `addons/partner_autocomplete/models/iap_autocomplete_api.py` |
| EU VAT validation (VIES SOAP) | EU VIES service (via `python-stdnum` + `zeep`) | — | `addons/partner_autocomplete/models/res_partner.py` (`stdnum.eu.vat.check_vies`) |

The offline/mobile CRM itself has no server dependency beyond the fork's own
Odoo: the service worker, IndexedDB store, and crypto use browser-native
APIs only — see [Offline and PWA](../features/offline-and-pwa/index.md).

## The fork's hard rule

`AGENTS.md` (section "Security and dependencies") forbids adding
dependencies to this fork: no new Python or JS package, no new addon in a
manifest's `depends`, `requirements.txt` unchanged, no npm/bundler/JS build
tooling, and no native mobile project (the "native mobile" target is the
installable PWA the fork already ships). Anything new must be implemented in
`addons/crm/` with the primitives already vendored or browser-native.

## Key source files

| File | Purpose |
| --- | --- |
| `requirements.txt` | All pinned Python dependencies, per release markers. |
| `odoo/release.py` | `MIN_PY_VERSION`, `MAX_PY_VERSION`, `MIN_PG_VERSION`. |
| `odoo/sql_db.py` | PostgreSQL connection layer and version warning. |
| `addons/web/static/lib/` | Vendored browser libraries. |
| `addons/web/static/src/libs/` | Wrappers around vendored libraries. |
| `odoo/addons/base/models/assetsbundle.py` | libsass/rjsmin asset compilation. |
| `odoo/addons/base/models/ir_actions_report.py` | PDF engine resolution. |
| `addons/base_report_wkhtmltox/models/ir_actions_report.py` | wkhtmltopdf engine. |
| `addons/base_report_paper_muncher/paper_muncher.py` | paper-muncher engine. |
| `addons/iap/tools/iap_tools.py` | IAP JSON-RPC client and default endpoint. |
| `scripts/dev/setup.sh` | Installs requirements.txt plus `websocket-client` and `phonenumbers`. |

## Related pages

- [Reference](index.md)
- [Assets](../systems/assets.md)
- [Architecture](../overview/architecture.md)
- [Offline and PWA](../features/offline-and-pwa/index.md)
- [CRM](../apps/crm/index.md)
- [Security](../security.md)
- [By the numbers](../by-the-numbers.md)
