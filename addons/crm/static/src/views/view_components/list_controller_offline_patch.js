import { ListController } from "@web/views/list/list_controller";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B48 (VAL-DIS-017): `crm.activity.report`'s list arch sets
 * `action="action_open_lead" type="object"` (`crm_activity_report_views.xml`),
 * so a row click's `openRecord()` (`list_controller.js`) runs
 * `actionService.doActionButton()` for that `type="object"` call instead of
 * opening a form -- a server-computed report row navigation, the same
 * report-views DISABLE family as the rest of this view's group controls
 * (offline_inventory.md).
 */
const ROW_ACTION_DISABLED_MODELS = ["crm.activity.report"];

/**
 * B60/B61 (VAL-DIS-017): once `isInlineEditable` is forced false offline for
 * these two models (`list_renderer_offline_patch.js`), `openRecord()`'s own
 * fallback path (no `openAction` on their archs) is what a click or Enter
 * on the row reaches next; neither model's action defines a form view to
 * navigate to, so block the fallback itself rather than let it attempt one.
 */
const READONLY_OFFLINE_MODELS = ["crm.recurring.plan", "crm.lost.reason"];

/**
 * B68 (VAL-DIS-017): `getStaticActionMenuItems()` marks Archive, Unarchive
 * and Delete `availableOffline: true` unconditionally (`list_controller.js`),
 * because `action_archive`/`action_unarchive`/`web_unlink` are three of the
 * framework's four auto-queued producers -- true for *any* model, which is
 * exactly right for B67/B69 (`crm.lead`/`crm.team`, in rule 1's scope).
 * `crm.recurring.plan` and `crm.lost.reason` are the two editable lists this
 * bucket keeps outside that scope (B60/B61), so their selected-record
 * Archive/Unarchive/Delete must not queue either, even though the mechanism
 * itself would otherwise auto-queue them exactly like B67/B69. Overriding
 * the item's own `callback` (not just its `availableOffline` flag) blocks
 * both the mouse path (CSS `pe-none` from `availableOffline: false`) and
 * the keyboard path (`DropdownItem.onClick` calls `onSelected` -> the same
 * `item.callback()` regardless of how it was triggered).
 */
const ACTION_MENU_DISABLED_MODELS = ["crm.recurring.plan", "crm.lost.reason"];
const ACTION_MENU_KEYS_TO_DISABLE = ["archive", "unarchive", "delete"];

patch(ListController.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    /** @override */
    getStaticActionMenuItems() {
        const items = super.getStaticActionMenuItems();
        if (
            this.crmOffline.isOffline() &&
            ACTION_MENU_DISABLED_MODELS.includes(this.props.resModel)
        ) {
            for (const key of ACTION_MENU_KEYS_TO_DISABLE) {
                if (items[key]) {
                    items[key] = { ...items[key], availableOffline: false, callback: () => {} };
                }
            }
        }
        return items;
    },

    /** @override */
    async openRecord(record, ...args) {
        if (
            this.crmOffline.isOffline() &&
            (ROW_ACTION_DISABLED_MODELS.includes(this.props.resModel) ||
                READONLY_OFFLINE_MODELS.includes(this.props.resModel))
        ) {
            return;
        }
        return super.openRecord(record, ...args);
    },

    /**
     * Finding 16 (VAL-DIS-017): `isNewButtonAvailableOffline` checks
     * `isAvailableOffline(actionId, "list_quick_create", resId=false)`
     * for an `editable` list (`list_controller.js`), which the framework
     * sets true the first time *any* row on this action/view was quick-
     * created online (`_visited`'s key has no per-model component) --
     * so once that has happened once, this getter's base value stays
     * true offline too, keeping `data-available-offline` on the New
     * button and leaving the framework's own disabling pass with nothing
     * to do (`SELECTORS_TO_DISABLE` only disables buttons that lack the
     * attribute). Forcing it false here for these two out-of-scope
     * models removes the attribute, so the framework disables the
     * button itself (covering click, keyboard and the `c` hotkey) on
     * top of the handler guard below.
     */
    get isNewButtonAvailableOffline() {
        if (this.crmOffline.isOffline() && READONLY_OFFLINE_MODELS.includes(this.props.resModel)) {
            return false;
        }
        return super.isNewButtonAvailableOffline;
    },

    /**
     * Handler-path half of the same finding: `onClickCreate`
     * (`list_controller.js`) calls this directly, so even a direct call
     * bypassing the (now disabled) DOM button must still add no in-edit
     * row and queue nothing on `crm.recurring.plan`/`crm.lost.reason`.
     */
    async createRecord(...args) {
        if (this.crmOffline.isOffline() && READONLY_OFFLINE_MODELS.includes(this.props.resModel)) {
            return;
        }
        return super.createRecord(...args);
    },
});
