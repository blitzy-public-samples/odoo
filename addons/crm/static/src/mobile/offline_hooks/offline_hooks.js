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
 *  pendingActivities: (leadId: number, activityIds?: number[]) => Array<{key: string, kind: "create"|"log_call"|"done", value: object}>,
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

        /**
         * Queued activity-related calls for one lead (architecture.md
         * §3.1 suggested API; first consumer is the offline activity
         * panel, m3-activity-panel): `mail.activity` `create`s whose vals
         * target this lead, `crm.lead` `action_log_call`s on this lead,
         * and `mail.activity` `action_done`s on one of `activityIds`.
         * `action_done([[id]])` carries no lead id of its own, so the
         * caller must pass the set of activity ids it already knows
         * belong to this lead (its already-loaded `activity_ids`); a
         * `create`/`action_log_call` entry is matched directly, since its
         * own args/vals name the lead. Returns `{key, kind, value}`
         * entries, `kind` one of "create", "log_call" or "done".
         */
        pendingActivities(leadId, activityIds = []) {
            const doneIds = new Set(activityIds);
            const entries = [];
            for (const { key, value } of Object.values(offlinePlugin._ormToSync())) {
                const { model, method, args } = value;
                if (model === "mail.activity" && method === "create") {
                    const vals = args[0]?.[0];
                    if (vals?.res_model === "crm.lead" && vals.res_id === leadId) {
                        entries.push({ key, kind: "create", value });
                    }
                } else if (model === "crm.lead" && method === "action_log_call") {
                    if (args[0]?.[0] === leadId) {
                        entries.push({ key, kind: "log_call", value });
                    }
                } else if (model === "mail.activity" && method === "action_done") {
                    if (doneIds.has(args[0]?.[0])) {
                        entries.push({ key, kind: "done", value });
                    }
                }
            }
            return entries;
        },
    };
}
