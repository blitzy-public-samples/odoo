# Features

Active contributors: Pierre, qsm-odoo, Christophe

The pages in this section describe capabilities, not codebases. A page in [Apps](../apps/index.md) answers "what does this addon add?"; a page here answers "how does this capability work?", wherever its pieces live. All three features cross that line: the offline and PWA stack lives in `addons/web` but exists for the CRM, the small-screen behavior is one reactive signal that every view and popover consults, and onboarding tours are an addon (`addons/web_tour`) whose content is contributed by business apps. Where a feature is implemented in one place and consumed in another, the feature page describes the mechanism and links to the app pages that use it.

| Page | What it covers |
| --- | --- |
| [Offline and PWA](offline-and-pwa/index.md) | The stack at a glance: the secure-context requirement, what works offline (visited views, queued writes, cached many2x searches, service-worker pages), and what the queue cannot take. |
| [Sync queue](offline-and-pwa/sync-queue.md) | `OfflinePlugin.scheduleORM()`, the `orm-to-sync` entry format and keys, the queue producers in the relational model, timestamp-ordered replay, error parking, and last-write-wins conflict semantics. |
| [Local store](offline-and-pwa/local-store.md) | The `IndexedDB` wrapper (per-tab mutex, wipe on registry-hash change), AES-GCM encryption from `browser_cache_secret`, the no-op degradation outside a secure context, the many2x cache, and the `db-sync` Web Lock. |
| [Service worker and install](offline-and-pwa/service-worker-and-install.md) | `service_worker.js` (session-info masking, network-first navigation, the offline page), the web-manifest controller routes, install prompts, scoped apps, and the CRM share target. |
| [Offline UI](offline-and-pwa/offline-ui.md) | The `data-available-offline` attribute and the button-disabling pass, visited-UI tracking behind `isAvailableOffline`, the offline systray, the offline action helper, and the offline error handlers. |
| [Mobile web](mobile-web.md) | `UIPlugin`'s reactive `isSmall`/`size` signals, the rule that every mobile behavior gates on them, bottom sheets as the mobile alternative to popovers, the mobile kanban arch convention, and the desktop/mobile test presets. |
| [Onboarding tours](onboarding-tours.md) | The `web_tour` framework (tour registry, pointer, interactive and automatic runners), the `crm_tour` onboarding record, and test tours driven by `start_tour`, including this fork's offline end-to-end tour. |

## Related pages

- [Offline CRM](../apps/crm/offline-crm.md) and [Mobile CRM](../apps/crm/mobile-crm.md) — how `addons/crm` consumes the framework and the small-screen signal.
- [Web](../apps/web/index.md) — the addon the offline/PWA and mobile stacks live in.
- [Testing](../how-to-contribute/testing.md) — the commands behind the test presets and the tours.
- [Glossary](../overview/glossary.md) — secure context, sync queue, bottom sheet, mobile pipeline, presets.
