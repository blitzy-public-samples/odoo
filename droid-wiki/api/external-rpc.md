# External RPC
Active contributors: Odoo SA (upstream)

## Purpose

External programs reach Odoo through the same HTTP application as the web client, but through a different set of routes. The `rpc` addon (`addons/rpc`) ships them: `/xmlrpc/<service>`, `/xmlrpc/2/<service>` and `/jsonrpc` are the historical entry points, and `/json/2/<model>/<method>` is the one the codebase points new clients at. This page documents what actually exists in this repository, including the deprecation state of the older endpoints, the authentication flows, and what method visibility and access rules apply to a remote call.

## Directory layout

```text
addons/rpc/
├── __manifest__.py           # auto_install, depends: ["base"]
├── controllers/
│   ├── __init__.py           # RPC controller: /web/version, /json/version, deprecation notice
│   ├── xmlrpc.py             # /xmlrpc/<service>, /xmlrpc/2/<service>, OdooMarshaller
│   ├── jsonrpc.py            # /jsonrpc
│   └── json2.py              # /json/2/<model>/<method>
└── tests/test_xmlrpc.py      # TestExternalAPI, TestXMLRPC (HttpCase)
odoo/service/
├── common.py                 # login / authenticate / version, exp_* functions
└── model.py                  # dispatch(), execute_cr(), call_kw()
odoo/orm/models.py            # get_public_method(), the visibility rule
addons/web/controllers/json.py  # /json and /json/1/<subpath>, read-only view JSON
```

## Key abstractions

| Name | File | Description |
| --- | --- | --- |
| `XMLRPC` | `addons/rpc/controllers/xmlrpc.py` | Controller with the two `/xmlrpc` services; marshals return values. |
| `JSONRPC` | `addons/rpc/controllers/jsonrpc.py` | `/jsonrpc`, same dispatcher as the browser's JSON-RPC. |
| `WebJson2Controller` | `addons/rpc/controllers/json2.py` | `/json/2/<model>/<method>`, bearer-authenticated model calls. |
| `dispatch_rpc()` | `odoo/http/router.py` | Maps a service name to `common` or `object` dispatch. |
| `call_kw()` | `odoo/service/model.py` | Invokes one public model method with `args` and `kwargs`. |
| `get_public_method()` | `odoo/orm/models.py` | Rejects private and unsafe method names. |
| `_check_uid_passwd()` | `odoo/addons/base/models/res_users.py` | Validates the `(uid, passwd)` pair sent by `execute_kw`. |

## How it works

`addons/rpc/controllers/xmlrpc.py` declares `/xmlrpc/<service>` (fault codes returned as strings) and `/xmlrpc/2/<service>` (fault codes as integers), both `auth='none'`, `methods=['POST']`, `csrf=False`, `save_session=False`. Each handler parses the XML body with `xmlrpc.client.loads(..., use_datetime=True)`, calls `dispatch_rpc(service, method, params)` and marshals the result through `OdooMarshaller`, which serializes `date`/`datetime` as ISO strings, `bytes` as decoded strings, `markupsafe.Markup` as `str`, `Command` as `int`, `Domain` as `list`, and strips XML-illegal control characters. `addons/rpc/controllers/__init__.py` also holds `_check_request()`, which closes the read-only cursor that `serve_db()` opened for the `auth='none'` route before the RPC opens its own.

`dispatch_rpc()` accepts only `common` and `object`; anything else raises `ValueError`, even though its docstring still lists a `db` service. `common` maps `login`, `authenticate` and `version` to the `exp_*` functions in `odoo/service/common.py`. `authenticate(db, login, password, user_agent_env)` returns the uid or `False` and marks the attempt `interactive: False`, which is what lets an API key be passed where a password is expected. `object` maps to `odoo/service/model.py:dispatch()`, which takes `(db, uid, passwd, model, method, *args)` for `execute` and `(args, kwargs)` for `execute_kw`, opens a cursor with `Registry(db).cursor()`, validates the pair with `res.users._check_uid_passwd()` (itself ormcached on `uid` and `passwd`), then calls `execute_cr()` with an `Environment(cr, uid, {})` built from the real uid, never from the arguments.

`call_kw()` resolves the method with `get_public_method()` from `odoo/orm/models.py`. Names starting with `_`, names in `_UNSAFE_ATTRIBUTES`, non-callables and unbound class or static methods raise `AccessError` or `AttributeError`, and methods decorated `@api.private` are refused as well, so `execute_kw` can only reach the public API. For `@api.model` methods the whole model is passed; otherwise `args[0]` is the id list and is browsed. A `context` key in `kwargs` replaces the environment context. The return value is adapted: `create` returns a single id when its argument was a mapping, other recordsets are returned as id lists. `execute_cr()` runs the call inside `retrying()` and forces lazy values to evaluate before the cursor closes.

### Deprecation state

`RPC_DEPRECATION_NOTICE` in `addons/rpc/controllers/__init__.py` states that `/xmlrpc`, `/xmlrpc/2` and `/jsonrpc` are deprecated as of Odoo 19 and scheduled for removal in Odoo 22, and points to the migration section of the external API documentation. Every request to those endpoints logs a warning; the message itself suggests muting it with `--log-handler odoo.addons.rpc.controllers.xmlrpc:ERROR`. `addons/rpc/tests/test_xmlrpc.py` still exercises them, so they work in this revision, but new integrations should use the JSON API below.

### The current JSON API

`addons/rpc/controllers/json2.py` publishes `POST /json/2/<__model__>/<__method__>`, with `type='json2'`, `auth='bearer'`, `bearer_scope='rpc'`, `save_session=False`, and `readonly` as a callable that inspects the target method's `_readonly` attribute so a read-only method can run on the replica cursor. The `Json2Dispatcher` merges the JSON body with the path parameters, so a call sends `ids`, an optional `context`, and the method's keyword arguments:

```bash
curl -X POST "https://odoo.example/json/2/crm.lead/search_read" \
  -H "Authorization: bearer $ODOO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": [["type", "=", "opportunity"]], "fields": ["name"], "limit": 5}'
```

The method must be public (`get_public_method()` again), its signature is bound with `inspect.signature().bind(records, **kwargs)` and a mismatch returns `UnprocessableEntity`, an `@api.model` method cannot be called with ids, a model name that does not exist returns `NotFound`, and a returned recordset is reduced to its ids. A catch-all on `/json/2` answers 404 with "Did you mean POST /json/2/<model>/<method>?". `addons/web/controllers/json.py` adds a separate read-only route, `/json/1/<subpath>`, which returns the JSON a view would show; it also uses bearer scope `rpc`, requires `base.group_allow_export`, and is disabled unless the database is in demo mode or the `web.json.enabled` parameter is set.

Bearer authentication is implemented by `_auth_method_bearer()` in `odoo/addons/base/models/ir_http.py`. It reads the token from an `Authorization: bearer <key>` header and validates it with `res.users.apikeys._check_credentials(scope='rpc', key=token)`; keys are stored hashed (pbkdf2-sha512), the scope is fixed to `rpc` in the UI, and an unknown or expired key raises `Unauthorized` with a `WWW-Authenticate: bearer` header. If a session exists and its uid differs from the key's user, the request is rejected with `AccessDenied`. With no key, an existing interactive session is accepted only if the browser-style `Sec-Fetch-*` headers are present.

| Client | Authentication | Result |
| --- | --- | --- |
| XML-RPC | `common.authenticate(db, login, password)` then `execute_kw(db, uid, password, ...)` | uid, then the method result; `False` on bad credentials |
| JSON-RPC (`/jsonrpc`) | none at the route level; the `service`/`method`/`args` triple decides | the service result |
| `/json/2` | API key in a bearer header | the method result as JSON |

### `sudo()` and `with_user()` implications

None of these paths elevate privileges. `dispatch()` builds its environment from `(cr, uid)` where `uid` comes from the `passwd`-validated arguments; `call_kw()` never calls `sudo()`, and `/json/2` uses `request.env[__model__]`, the environment of the key's user. Access rules therefore apply in full to a remote caller, and `with_user()` is the only way to narrow them further. A method that needs elevation must call `sudo()` itself, and models such as `ir.access`, `ir.config_parameter` and `res.users.apikeys` set `_allow_sudo_commands = False` so that even a sudoed caller cannot write them without an explicit choice. The practical consequence for integrations is that a public method exposed remotely is exactly as powerful as the user behind the API key makes it.

## Integration points

- `odoo/http/router.py:dispatch_rpc()` is shared by the XML-RPC and JSON-RPC controllers, so both services behave identically.
- `odoo/service/model.py:call_kw()` is also what `/web/dataset/call_kw` calls, which is why the web client and external clients hit the same visibility rule.
- The controllers are ordinary `@route` controllers: `addons/web/controllers/json.py` and `addons/rpc/controllers/json2.py` both use the same decorator options described in [Web controllers](web-controllers.md).
- `addons/rpc/__manifest__.py` sets `auto_install: True` with `depends: ["base"]`, so the routes exist in every database without an explicit install.

## Entry points for modification

Read `addons/rpc/controllers/json2.py` first: it is the smallest complete example of a model-call endpoint, and the pattern to copy when a fork needs a new programmatic route. For XML-RPC behaviour changes, the marshalling lives in `OdooMarshaller` in `addons/rpc/controllers/xmlrpc.py`, and the service semantics in `odoo/service/`. Keep new endpoints in `addons/crm/` as required by this fork's scope rules.

## Key source files

| File | Purpose |
| --- | --- |
| `addons/rpc/controllers/__init__.py` | `RPC` controller, `/web/version`, `RPC_DEPRECATION_NOTICE`, `_check_request()`. |
| `addons/rpc/controllers/xmlrpc.py` | XML-RPC endpoints, fault codes, `OdooMarshaller`. |
| `addons/rpc/controllers/jsonrpc.py` | `/jsonrpc`. |
| `addons/rpc/controllers/json2.py` | `/json/2/<model>/<method>` and its readonly resolver. |
| `addons/rpc/__manifest__.py` | Auto-installed `rpc` addon. |
| `addons/rpc/tests/test_xmlrpc.py` | `TestExternalAPI`, `TestXMLRPC`. |
| `odoo/http/router.py` | `dispatch_rpc()` service selection. |
| `odoo/service/common.py` | `login`, `authenticate`, `version`. |
| `odoo/service/model.py` | `dispatch()`, `execute_cr()`, `call_kw()`. |
| `odoo/orm/models.py` | `get_public_method()`, `_UNSAFE_ATTRIBUTES`. |
| `odoo/addons/base/models/res_users.py` | `_check_uid_passwd()`, `authenticate()`, `res.users.apikeys`. |
| `odoo/addons/base/models/ir_http.py` | `_auth_method_bearer()`. |
| `addons/web/controllers/json.py` | `/json` and `/json/1/<subpath>` read-only view JSON. |

## Related pages

- [APIs](index.md)
- [Web controllers](web-controllers.md)
- [Security](../security.md)
- [Users, groups and access](../primitives/users-groups-and-access.md)
- [ORM](../systems/orm.md)
- [HTTP server](../systems/http-server.md)
- [Configuration reference](../reference/configuration.md)
