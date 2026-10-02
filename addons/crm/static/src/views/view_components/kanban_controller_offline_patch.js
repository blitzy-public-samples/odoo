import { KanbanController } from "@web/views/kanban/kanban_controller";
import {
    ConfirmationDialog,
    deleteConfirmationMessage,
} from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B19 (VAL-DIS-009): a lead/team kanban card's menu "Delete"
 * (`<a role="menuitem" type="delete">`) is compiled into
 * `KanbanRecord.triggerAction({type:'delete'})`, already guarded offline by
 * `kanban_record_offline_patch.js` for the open-while-offline and
 * already-open-dropdown cases. That guard runs once, when the item is
 * clicked, and `triggerAction` then calls `KanbanController.deleteRecord`,
 * which opens `web.ConfirmationDialog` through `useDeleteRecords`. That
 * dialog's own Confirm button carries `data-available-offline` (same as
 * every `web.ConfirmationDialog`) and stays clickable; its `confirm`
 * callback -- `() => model.root.deleteRecords(records)` -- is a closure
 * created at dialog-open time, so a card menu opened and confirmed while
 * online, left open, then confirmed again *after* disconnecting (the
 * dialog never closed) reaches that closure directly, with no further
 * `triggerAction` call to intercept: it queues `web_unlink` offline. Same
 * deferred-confirmation gap `group_config_menu_patch.js`'s `deleteGroup`
 * closes for the group config menu. Rebuild the dialog here instead of
 * going through `useDeleteRecords`, re-checking offline inside `confirm`,
 * scoped to crm.lead/crm.team so every other model's kanban card Delete is
 * untouched, online or offline.
 */
patch(KanbanController.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    /** @override */
    deleteRecord(record) {
        if (!["crm.lead", "crm.team"].includes(record.resModel)) {
            return super.deleteRecord(...arguments);
        }
        if (this.crmOffline.isOffline()) {
            return;
        }
        this.dialog.add(ConfirmationDialog, {
            body: deleteConfirmationMessage,
            cancel: () => {},
            cancelLabel: _t("No, keep it"),
            confirm: () => {
                if (this.crmOffline.isOffline()) {
                    return;
                }
                return this.model.root.deleteRecords([record]);
            },
            confirmLabel: _t("Delete"),
            confirmClass: "btn-danger",
            title: _t("Bye-bye, record!"),
        });
    },
});
