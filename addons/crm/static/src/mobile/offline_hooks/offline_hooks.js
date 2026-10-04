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
 *  isLeadAvailableOffline: (actionId: number, resId: number|false) => boolean,
 *  queueCall: (model: string, method: string, args: any[], kwargs?: object, extras?: object) => string|number,
 *  pendingForLead: (leadId: number) => Array<{key: string, value: object}>,
 *  pendingLeadCreates: (stageId?: number) => Array<{key: string, value: object}>,
 *  pendingActivities: (leadId: number, activityIds?: number[]) => Array<{key: string, kind: "create"|"log_call"|"done", value: object}>,
 *  cachedMany2XRecords: (resModel: string) => Promise<Array<{id: number, display_name: string}>>,
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
         * Whether a lead's form is safe to open offline: either we are
         * online (nothing is restricted), or the form was visited before
         * going offline and is therefore cached. `OfflinePlugin.
         * isAvailableOffline` is only meaningful while offline
         * (architecture.md §2), so every caller must go through this guard
         * rather than call it directly.
         */
        isLeadAvailableOffline(actionId, resId) {
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
         * Every queued entry that targets one *existing* lead (first
         * consumer: the mobile card's pending-sync badge, architecture.md
         * §3.4 / VAL-MOBILE-008). Every producer that writes to an id'd
         * `crm.lead` -- `web_save`, `action_set_won`, `action_restore`,
         * `web_unlink`, `action_archive`/`action_unarchive`,
         * `action_log_call` -- puts that id in `args[0]` as an array
         * (`[leadId]` or `[leadId, ...]`), so a plain `includes` check
         * covers all of them without naming each method. A queued
         * `mail.activity` `create` names the lead in its vals instead of
         * `args[0]`, so it is matched the same way `pendingActivities`
         * does. A queued `mail.activity` `action_done` carries only the
         * activity id, not the lead id, so it is intentionally not
         * reflected here: a caller that also needs that coverage uses
         * `pendingActivities(leadId, activityIds)` with the lead's known
         * activity ids.
         */
        pendingForLead(leadId) {
            const entries = [];
            for (const { key, value } of Object.values(offlinePlugin._ormToSync())) {
                const { model, method, args } = value;
                if (model === "crm.lead" && Array.isArray(args[0]) && args[0].includes(leadId)) {
                    entries.push({ key, value });
                } else if (model === "mail.activity" && method === "create") {
                    const vals = args[0]?.[0];
                    if (vals?.res_model === "crm.lead" && vals.res_id === leadId) {
                        entries.push({ key, value });
                    }
                }
            }
            return entries;
        },

        /**
         * Queued `crm.lead` `web_save` creates -- `args[0] = []`, the
         * producer's shape for a brand-new record (`record.js`
         * `_offlineSave`) -- optionally narrowed to those whose vals set
         * `stage_id` to `stageId` (first consumer: the mobile pipeline's
         * per-stage pending-create cards, architecture.md §3.4). Pass no
         * `stageId` to get every queued lead create regardless of stage.
         */
        pendingLeadCreates(stageId) {
            const entries = [];
            for (const { key, value } of Object.values(offlinePlugin._ormToSync())) {
                const { model, method, args } = value;
                if (
                    model === "crm.lead" &&
                    method === "web_save" &&
                    Array.isArray(args[0]) &&
                    args[0].length === 0
                ) {
                    const vals = args[1] || {};
                    if (stageId === undefined || vals.stage_id === stageId) {
                        entries.push({ key, value });
                    }
                }
            }
            return entries;
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

        /**
         * Every row the framework's many2x cache already holds for
         * `resModel` (`OfflinePlugin.cacheMany2XSearch`/
         * `searchMany2XRecords`, architecture.md §2 "Relational-field
         * cache"): a blank name matches every cached row
         * (`searchMany2XRecords`'s own `!normalizeSearch` branch), so this
         * is a pure IndexedDB read of whatever an earlier online
         * `Many2XAutocomplete` search already stored -- never a fresh
         * RPC, online or offline, and never a second cache (first
         * consumer: the offline activity panel's assignee choice,
         * VAL-DATA-010). Resolves to `[]` outside a secure context, where
         * the plugin's store is a no-op.
         */
        async cachedMany2XRecords(resModel) {
            return (await offlinePlugin.searchMany2XRecords(resModel, "")) || [];
        },
    };
}
