# Features

Active contributors: bobbyabbott421-glitch (fork), Odoo SA (upstream)

The pages in this section describe capabilities that cut across the server, the web client, and individual addons, so they do not belong to any single directory. The offline/PWA stack lives in `addons/web` but exists for `addons/crm`; the small-screen behavior is a shared signal that every view and popover consults; onboarding tours are an addon (`addons/web_tour`) whose payload is contributed by business apps. Where a feature is implemented in one place and consumed in another, the feature page describes the mechanism and links to the app pages that use it.

| Page | What it covers |
| --- | --- |
| [Offline and PWA](offline-and-pwa/index.md) | The stack at a glance: secure-context requirement, what works offline (visited views, queued writes, cached relational searches, service-worker pages) and what cannot be queued. |
| [Sync queue](offline-and-pwa/sync-queue.md) | `OfflinePlugin.scheduleORM()`, the `orm-to-sync` entry format and keys, queue producers in the relational model, timestamp-ordered replay, error parking, last-write-wins conflict semantics. |
| [Local store](offline-and-pwa/local-store.md) | The `IndexedDB` wrapper (per-tab mutex, version wipe on registry-hash change), AES-GCM encryption from `browser_cache_secret`, the no-op degradation off a secure context, the many2x cache, the `db-sync` Web Lock. |
| [Service worker and install](offline-and-pwa/service-worker-and-install.md) | `service_worker.js` (session-info masking, network-first navigation, offline page), the web-manifest controller routes, the PWA install prompts, scoped apps, and the CRM share target. |
| [Offline UI](offline-and-pwa/offline-ui.md) | The `data-available-offline` attribute and button-disabling pass, visited-UI tracking and `isAvailableOffline`, the offline systray, the offline action helper, the offline error handlers. |
| [Mobile web](mobile-web.md) | The small-screen signal on `UIPlugin`, the rule that mobile behavior gates on it, bottom sheets as the mobile alternative to popovers, the CRM mobile kanban, and the desktop/mobile test presets. |
| [Onboarding tours](onboarding-tours.md) | The `web_tour` framework (tour registry, pointer, interactive and automatic runners), the `crm_tour` onboarding tour, test tours driven by `start_tour`, and how tours are persisted, consumed, and skipped. |

## Related pages

- [Offline and mobile CRM](../apps/crm/offline-and-mobile-crm.md): how `addons/crm` consumes the offline framework.
- [Test framework](../systems/test-framework.md): how the browser suites and tours are collected and run.
- [Testing](../how-to-contribute/testing.md): the commands and the false-green modes to guard against.
- [Glossary](../overview/glossary.md): secure context, sync queue, visited-UI, bottom sheet, share target, PWA.
