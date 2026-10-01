import { GroupConfigMenu } from "@web/views/view_components/group_config_menu";
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

    deleteGroup() {
        if (this.isCrmView && this.crmOffline.isOffline()) {
            return;
        }
        return super.deleteGroup(...arguments);
    },
});
