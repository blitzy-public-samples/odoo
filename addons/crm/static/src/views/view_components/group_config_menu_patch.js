import { GroupConfigMenu } from "@web/views/view_components/group_config_menu";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B57/B62/B71-73/B89 (VAL-DIS-015/016): `editGroup()` opens a
 * `FormViewDialog` on the group's own record (e.g. a `crm.stage` or
 * `crm.team`) and `deleteGroup()` opens a confirmation whose "Delete"
 * confirms into `orm.webUnlink` -- neither is one of the framework's four
 * auto-queued producers (architecture.md §3.7), so both stay DISABLE, not
 * queued.
 *
 * The menu's own toggler is a plain `<button>`, already auto-disabled by
 * the framework's `SELECTORS_TO_DISABLE` (section 2 of this file's
 * AGENTS.md) once offline, which covers *opening* the menu offline. But
 * "Edit"/"Delete" are `DropdownItem`s -- `<span>`/`<a role="menuitem">`,
 * never `<button>` -- so a dropdown already open *before* going offline is
 * left fully clickable: the toggler-disable pass can't reach items of a
 * menu that's already open. Guard the handlers themselves so that case is
 * covered too, scoped to crm's own views so every other addon's
 * list/kanban group menu (e.g. contacts grouped by company) is untouched,
 * online or offline.
 */
patch(GroupConfigMenu.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    get isCrmView() {
        return ["crm.lead", "crm.activity.report"].includes(this.props.list.resModel);
    },

    editGroup() {
        if (this.isCrmView && this.crmOffline.isOffline()) {
            return;
        }
        return super.editGroup(...arguments);
    },

    /**
     * Guarding only the method's entry (as `editGroup` does above) is not
     * enough here: selecting "Delete" while online opens
     * `web.GroupConfigMenu`'s own confirmation dialog, whose "Delete"
     * button carries `data-available-offline` and stays clickable, and
     * its `confirm` callback (`this.props.deleteGroup(this.group)`) is a
     * closure created at dialog-open time -- it runs later, outside this
     * method, so an entry guard that already passed online can't stop it.
     * Re-check offline at confirm time instead; everything else is the
     * same dialog `super.deleteGroup()` would have opened.
     */
    deleteGroup() {
        if (!this.isCrmView) {
            return super.deleteGroup(...arguments);
        }
        if (this.crmOffline.isOffline()) {
            return;
        }
        this.dialog.add(ConfirmationDialog, {
            body: _t("Are you sure you want to delete this column?"),
            confirm: () => {
                if (this.crmOffline.isOffline()) {
                    return;
                }
                return this.props.deleteGroup(this.group);
            },
            confirmLabel: _t("Delete"),
            cancel: () => {},
        });
    },
});
