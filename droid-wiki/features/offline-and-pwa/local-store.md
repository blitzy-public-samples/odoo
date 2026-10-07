# Local store

Active contributors: Jorge, Aaron, Romain

## Purpose

The local store is the `offline` IndexedDB database behind the whole offline stack: every queued write, visited-UI marker and cached relational name lands here, encrypted. It is built from two small pieces, the `IndexedDB` wrapper and the `Crypto` helper, and it wipes itself whenever the asset registry or the encryption algorithm changes. This page covers both pieces, the degradation outside secure contexts, the cross-tab locking, and the many2x relational cache that shares the database.

## Key abstractions

| Name | File | Description |
| --- | --- | --- |
| `IndexedDB` | `addons/web/static/src/core/utils/indexed_db.js` | Wrapper: per-tab `Mutex`, lazy table creation, `invalidate()`, `deleteDatabase()` |
| `__DBVersion__` | `addons/web/static/src/core/utils/indexed_db.js` | Version record that wipes the database when its value changes |
| `Crypto` | `addons/web/static/src/core/crypto.js` | AES-GCM (`CRYPTO_ALGO`) with a fresh random IV per value |
| `offline` database | `addons/web/static/src/core/offline/offline_plugin.js` | `new IndexedDB("offline", session.registry_hash + CRYPTO_ALGO)` |
| `FakeIndexedDB` | `addons/web/static/src/core/offline/offline_plugin.js` | No-op store used outside a secure context |
| `orm-to-sync` | `addons/web/static/src/core/offline/offline_plugin.js` | Sync-queue table (see [Sync queue](sync-queue.md)) |
| `visited-ui-items` | `addons/web/static/src/core/offline/offline_plugin.js` | Visited action/view/record markers, with a `-debug` variant |
| `many2x_<model>` | `addons/web/static/src/core/offline/offline_plugin.js` | Encrypted display names per relational model |
| `db-sync` lock | `addons/web/static/src/core/offline/offline_plugin.js` | `navigator.locks.request("db-sync", ...)`, cross-tab replay serialization |

## How it works

### The wrapper

`new IndexedDB(name, version)` in `addons/web/static/src/core/utils/indexed_db.js` tracks the set of tables it has seen (`this._tables`) and serializes every operation through a per-tab `Mutex` from `addons/web/static/src/core/utils/concurrency.js`, so within one tab all reads and writes are ordered. `_execute()` opens the database, creates missing object stores in `onupgradeneeded`, and when a brand new table shows up it reopens with `db.version + 1` so the store can be added. Public API: `read`, `write` (single or batched items in one transaction), `delete`, `search`, `getAllEntries`, `getAllKeys`, `invalidate(tables)`, `deleteDatabase()`. `search` walks the table in batches of 2000 records (`BATCH_SIZE`), pre-fetching the next batch while the async `searchFn` runs on the current one, and stops at the first batch that comes back short; it uses the `getAllRecords` fast path where the browser supports it.

### The version wipe

The first table of every database is `__DBVersion__` with the single record key `__version__`. On construction, `_checkVersion(version)` writes the version when it is absent, and when the stored version differs it deletes the entire database (`_deleteDatabase`) and writes the new one. The offline database's version string is `session.registry_hash + CRYPTO_ALGO`, so two things wipe it: an asset-registry change (a new `registry_hash`, see [Assets](../../systems/assets.md)) or a change of encryption algorithm. Both values come from `odoo.__session_info__`, read by `addons/web/static/src/session.js`; `registry_hash` is computed server-side in `addons/web/models/ir_http.py`.

### `invalidate()` and quota handling

`invalidate(tables)` accepts an exact table name, a `RegExp`, an array of either, or nothing (then every table except `__DBVersion__` is cleared). `OfflinePlugin` uses it on `RPC:CLEAR-CACHES` to clear both visited-UI tables and all `many2x_` tables at once, and to reset the in-memory `_visited` map (`addons/web/static/src/core/offline/offline_plugin.js`). Writes run with `durability: "relaxed"` and an explicit `transaction.commit()` for speed; a `QuotaExceededError` logs the `navigator.storage.estimate()` usage and rejects with `IDBQuotaExceededError` so callers can react (the RPC cache deletes its whole database on that error, see `addons/web/static/src/core/network/rpc_cache.js`).

### Encryption

`Crypto` in `addons/web/static/src/core/crypto.js` imports the hex string `session.browser_cache_secret` with `crypto.subtle.importKey` as an AES-GCM key, then encrypts each value with a fresh random 12-byte IV (`crypto.getRandomValues(new Uint8Array(12))`, 64-bit counter length) after JSON-stringifying it. `decrypt()` reverses that and JSON-parses the plaintext. A new IV is drawn per value because an IV must never be reused with a given key. The secret is generated server-side as an HMAC over the user's session-token fields in `addons/web/controllers/home.py` and injected only into the bootstrap page, which carries `Cache-Control: no-store`; the key therefore rotates when a security event such as a password or 2FA change alters those fields.

### Tables of the `offline` database

| Table | Key | Value |
| --- | --- | --- |
| `visited-ui-items` (+ `visited-ui-items-debug`) | `JSON.stringify({action, viewType, resId})` | `true` for form and quick-create visits, else a map `searchKey -> {count, search}` |
| `orm-to-sync` | caller `options.id` or payload hash | JSON-stringified `{model, method, args, kwargs, extras}` |
| `many2x_<model>` | record id | encrypted display name |

The visited-UI table is chosen by a computed on the debug plugin, so debug sessions do not pollute the normal table (`addons/web/static/src/core/offline/offline_plugin.js`). While online, every search state stored by `setAvailableOffline` is deleted and re-added to mark recency, and its `count` is incremented, which is what "most-visited first" ordering reads back (`getAvailableSearches`, see [Offline UI](offline-ui.md)).

### The many2x cache

`Many2XAutocomplete.search()` in `addons/web/static/src/views/fields/relational_utils.js` feeds every successful `web_name_search` result to `cacheMany2XSearch`, and `onSearchMore` feeds its `name_search` results the same way. Loaded view data feeds it too: `_cacheMany2X` in `addons/web/static/src/model/relational_model/relational_model.js` walks the many2one and many2many values of every loaded record. Only the first line of a multi-line display name is kept (`display_name.split("\n")[0]`). Offline, `searchMany2XRecords` decrypts candidate values and matches a normalized substring (`normalize` from `addons/web/static/src/core/l10n/utils.js`, limit 8 by default); `readMany2XRecords` serves ids already set on the record, used by `StaticList` in `addons/web/static/src/model/relational_model/static_list.js` when a record load fails with `ConnectionLostError`.

```mermaid
graph TD
    OP["OfflinePlugin"] -->|"read / write under Mutex"| W["IndexedDB wrapper"]
    MS["menu_service.js"] -->|"webclient_menu db"| W
    LP["localization_plugin.js"] -->|"localization db"| W
    RC["rpc_cache.js"] -->|"rpc db, encrypted entries"| W
    W -->|"first open"| VT[("__DBVersion__ record")]
    VT -->|"version changed: registry_hash or CRYPTO_ALGO"| WIPE["deleteDatabase"]
    W -->|"read keys, write searches"| T1[("visited-ui-items and -debug")]
    W -->|"write / delete entries"| T2[("orm-to-sync")]
    W -->|"write names, search, read ids"| T3[("many2x_ tables")]
    OP -->|"encrypt display names"| CR["Crypto AES-GCM, fresh IV"]
    T3 -->|"decrypt to match"| CR
```

### Non-secure degradation

Outside a secure context the degradation is total, never partial. `OfflinePlugin` instantiates `FakeIndexedDB` (defined at the top of `addons/web/static/src/core/offline/offline_plugin.js`): `read` resolves `{}`, `getAllKeys` and `getAllEntries` resolve `[]`, and `write`, `delete` and `invalidate` do nothing. `_crypto` stays falsy unless both `window.isSecureContext` and `session.browser_cache_secret` hold, and every many2x cache method returns early without it. Queueing throws `NonSecureContextError` instead of silently writing (see [Sync queue](sync-queue.md)).

### Cross-tab locking

Two locks cooperate. Within a tab, the wrapper's `Mutex` orders all operations. Across tabs, replay of the `orm-to-sync` table runs under `navigator.locks.request("db-sync", ...)` (Web Locks API, secure context only), so only one tab syncs at a time; the rest see the entries move as `_updateScheduledORMList` reloads them.

### Security stance

Values are encrypted at rest with the per-session secret, and the database name plus version string are user-independent. The cache only ever stores data the user already received from the server; it never widens what a user can see, which is a project rule in `AGENTS.md`.

## Integration points

- Consumers of the wrapper besides the offline stack: `addons/web/static/src/webclient/menus/menu_service.js` (`webclient_menu`), `addons/web/static/src/core/l10n/localization_plugin.js` (`localization`), `addons/web/static/src/core/network/rpc_cache.js` (`rpc`, its entries encrypted with the same `Crypto`, and a 2 GB `MAX_STORAGE_SIZE` self-check that deletes its database).
- The offline database is opened once at plugin construction in `addons/web/static/src/core/offline/offline_plugin.js`, versioned on `session.registry_hash + CRYPTO_ALGO`.
- Session values (`registry_hash`, `browser_cache_secret`) come from `odoo.__session_info__`, read by `addons/web/static/src/session.js`.
- `RPC:CLEAR-CACHES` (triggered for instance when the service worker takes control after a hard refresh) invalidates the visited-UI and many2x tables.

## Entry points for modification

Table behavior changes (keys, values, new tables) go through the calls in `addons/web/static/src/core/offline/offline_plugin.js`; the wrapper in `addons/web/static/src/core/utils/indexed_db.js` should stay generic. Never add a second IndexedDB wrapper or encryption helper; both are project rules in `AGENTS.md`, and a parallel store would miss the version wipe, the mutex and the quota handling.

## Key source files

| File | Purpose |
| --- | --- |
| `addons/web/static/src/core/utils/indexed_db.js` | The wrapper: mutex, version wipe, invalidate, quota, batched search |
| `addons/web/static/src/core/crypto.js` | AES-GCM `Crypto` and `CRYPTO_ALGO` |
| `addons/web/static/src/core/offline/offline_plugin.js` | The `offline` database, its tables, `FakeIndexedDB` |
| `addons/web/static/src/views/fields/relational_utils.js` | Feeds and reads the many2x cache |
| `addons/web/static/src/model/relational_model/relational_model.js` | `_cacheMany2X` from loaded view data |
| `addons/web/static/src/model/relational_model/static_list.js` | `readMany2XRecords` fallback on record loads |
| `addons/web/static/src/session.js` | `registry_hash` and `browser_cache_secret` source |
| `addons/web/controllers/home.py` | Server-side generation of `browser_cache_secret` |
| `addons/web/static/src/core/utils/concurrency.js` | The `Mutex` used by the wrapper |
| `addons/web/static/src/core/network/rpc_cache.js` | Sibling `rpc` database on the same wrapper |

## Related pages

- [Offline and PWA](index.md)
- [Sync queue](sync-queue.md)
- [Offline UI](offline-ui.md)
- [Assets](../../systems/assets.md)
- [Web client platform](../../apps/web/index.md)
- [Offline CRM](../../apps/crm/offline-crm.md)
- [Debugging](../../how-to-contribute/debugging.md)
