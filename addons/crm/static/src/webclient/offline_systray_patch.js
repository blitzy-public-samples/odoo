import { computed } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { patch } from "@web/core/utils/patch";
// Side-effect import: `OfflineSystray` isn't exported by
// `offline_systray.js` (addons/web keeps it a private class, only
// registering its instance via the systray registry); this import only
// guarantees that module has already registered "offline" there before
// the `registry.category("systray").get(...)` lookup below runs,
// regardless of each file's position in the asset bundle (ESM import
// order between two modules is deterministic; the order two unrelated
// bundle entries happen to be concatenated/loaded in is not).
import "@web/webclient/offline_systray/offline_systray";

/**
 * architecture.md §3.2 item 11 / offline_inventory.md Notes #1
 * (VAL-QUEUE-004): `offline_systray.js`'s `groupEntries` only assigns
 * `item.status` for `web_save`/`web_unlink`/`action_archive`/
 * `action_unarchive` (the `STATUS` map at the top of that file); any other
 * queued method leaves `item.status` undefined, and the dropdown template
 * crashes at `element.status.color` the moment it opens. This is an
 * addons/web gap -- listed in the PR's known limits, never fixed there --
 * so crm supplies the missing labels for every method it queues itself:
 * `action_set_won`/`action_restore` from this milestone, and the
 * `mail.activity` ones queued starting milestone 3 (added here already
 * since the patch is one module, per architecture.md §3.2 item 11).
 *
 * `groupEntries` is an owl class field
 * (`groupEntries = computed(() => {...})` in offline_systray.js), so every
 * `OfflineSystray` instance gets its own copy assigned directly by the
 * constructor itself, before `setup()` ever runs
 * (addons/web/static/lib/owl/owl.js: `this.component = new C(this); ...;
 * this.component.setup();`) -- patching the prototype's `groupEntries`
 * would never reach it. So this patches `setup()` instead and reassigns
 * `this.groupEntries` there, wrapping the original computed with a pass
 * that only fills in the labels the base implementation left blank.
 */
const CRM_STATUS = {
    "crm.lead": {
        action_set_won: { label: _t("Won"), color: 5 },
        action_restore: { label: _t("Restored"), color: 6 },
        action_log_call: { label: _t("Call logged"), color: 7 },
    },
    "mail.activity": {
        create: { label: _t("Activity scheduled"), color: 8 },
        action_done: { label: _t("Activity done"), color: 9 },
    },
};

const OfflineSystray = registry.category("systray").get("offline").Component;

patch(OfflineSystray.prototype, {
    setup() {
        super.setup();
        const superGroupEntries = this.groupEntries;
        this.groupEntries = computed(() => {
            const sections = superGroupEntries();
            for (const [, items] of sections) {
                for (const item of items) {
                    if (item.status) {
                        continue; // one of the four built-in statuses
                    }
                    const entry = this.offlinePlugin._ormToSync()[item.id];
                    const status =
                        entry && CRM_STATUS[entry.value.model]?.[entry.value.method];
                    if (status) {
                        item.status = status;
                    }
                }
            }
            return sections;
        });
    },
});
