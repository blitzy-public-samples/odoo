import { usePlugin } from "@odoo/owl";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";

/**
 * Shared offline predicates and actions for addons/crm.
 *
 * Every value below is read live from the existing `OfflinePlugin` on each
 * call (`isOffline()`, `isAvailableOffline()`, `_ormToSync()` via
 * `scheduleORM()`); this hook keeps no state of its own, so it can never
 * drift from the plugin it wraps (architecture.md §3.1). New crm
 * offline-aware code -- mobile or not -- reads the framework through this
 * hook instead of calling `usePlugin(OfflinePlugin)` directly, so there is
 * one place to check for crm's offline rules.
 *
 * @returns {{
 *  isOffline: () => boolean,
 *  isRecordAvailableOffline: (actionId: number, resId: number|false) => boolean,
 *  queueCall: (model: string, method: string, args: any[], kwargs?: object, extras?: object) => string|number,
 * }}
 */
export function useCrmOffline() {
    const offlinePlugin = usePlugin(OfflinePlugin);

    return {
        /** Whether the client currently has no connection to the server. */
        isOffline() {
            return offlinePlugin.isOffline();
        },

        /**
         * Whether a record is safe to open offline: either we are online
         * (nothing is restricted), or the form was visited before going
         * offline and is therefore cached. `OfflinePlugin.isAvailableOffline`
         * is only meaningful while offline (architecture.md §2), so every
         * caller must go through this guard rather than call it directly.
         */
        isRecordAvailableOffline(actionId, resId) {
            return (
                !offlinePlugin.isOffline() ||
                offlinePlugin.isAvailableOffline(actionId, "form", resId)
            );
        },

        /**
         * Schedules a verbatim ORM call for replay once the connection
         * returns (e.g. the Won/Restore buttons), tagging it with the
         * extras the offline systray and the sync loop need. `timeStamp` is
         * mandatory: it orders the replay and the systray reads it to group
         * and sort entries (see offline_plugin.js). Returns the queue key,
         * like `OfflinePlugin.scheduleORM`.
         */
        queueCall(model, method, args, kwargs = {}, extras = {}) {
            return offlinePlugin.scheduleORM(model, method, args, kwargs, {
                extras: { timeStamp: Date.now(), ...extras },
            });
        },
    };
}
