import { KanbanRecord } from "@web/views/kanban/kanban_record";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * C21 (VAL-DIS-026): the team dashboard's kanban root carries
 * `action="action_primary_channel_button" type="object"`, inherited
 * unchanged from `sales_team.crm_team_view_kanban_dashboard`. Clicking the
 * card body (anywhere not caught by `CANCEL_GLOBAL_CLICK`) reaches
 * `KanbanRecord.onGlobalClick`'s `openAction` branch, which calls
 * `this.action.doActionButton(...)` directly -- a different path from the
 * `<a type=...>` menu links (`kanban_action_button_patch.js`): it is not a
 * `ViewButton`, so `KanbanController.beforeExecuteActionButton` is never
 * consulted for it.
 *
 * No dedicated `js_class` exists for `crm.team`'s kanban (it uses the plain
 * "kanban" view, same as `kanban_action_button_patch.js`), so this patches
 * the shared `KanbanRecord` instead of subclassing, scoped to `crm.team` so
 * every other addon's kanban card-root click is untouched, online or
 * offline.
 */
patch(KanbanRecord.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    onGlobalClick(ev, newWindow) {
        const { forceGlobalClick, openAction, record } = this.props;
        if (
            !forceGlobalClick &&
            openAction &&
            record.resModel === "crm.team" &&
            this.crmOffline.isOffline()
        ) {
            return;
        }
        return super.onGlobalClick(ev, newWindow);
    },

    /**
     * B18/B19 (VAL-DIS-009) and B77 (VAL-DIS-026): "Edit"/"Delete" on a
     * lead card and "Configuration" on a team card (both `type="open"` or
     * `type="delete"` `<a role="menuitem">`s, never a `<button>`) are
     * compiled into this one `triggerAction` choke point
     * (`card_compiler.js`). The framework's `SELECTORS_TO_DISABLE` pass
     * only reaches the menu's own toggler `<button>`, so a dropdown opened
     * online and still open when the connection drops leaves these items
     * fully clickable -- `onGlobalClick`'s guard above (and
     * `CrmKanbanController.openRecord`'s uncached-lead check for a fresh
     * open) never runs for them. Guard the handler itself, scoped to
     * crm.lead/crm.team so every other model's kanban card menu is
     * untouched, online or offline.
     */
    triggerAction(params) {
        const { record } = this.props;
        if (
            ["crm.lead", "crm.team"].includes(record.resModel) &&
            this.crmOffline.isOffline() &&
            ["open", "delete"].includes(params.type)
        ) {
            return;
        }
        return super.triggerAction(...arguments);
    },
});
