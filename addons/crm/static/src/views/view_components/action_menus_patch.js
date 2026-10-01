import { ActionMenus } from "@web/search/action_menus/action_menus";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B66/C23, B83, B84, B70 (VAL-DIS-018/024). `action_menus.xml`/`cog_menu.xml`
 * already grey an item out and apply `pe-none` offline when it lacks
 * `availableOffline` -- but that is CSS only: it stops a real pointer
 * click (`pointer-events: none` is only ever consulted while hit-testing
 * an actual pointer event) but not `DropdownItem.onClick`, which
 * `Navigator.select()` still invokes directly via `target.click()` on
 * Enter (`core/navigation/navigation.js`), bypassing pointer-events
 * entirely -- the same gap `group_config_menu_patch.js` closes for the
 * group config menu. So, offline, every item without `availableOffline`
 * still fires by keyboard today:
 *  - Duplicate (B66) -- `record.duplicate()`/`list.root.duplicateRecords()`
 *    call `orm.call(model, "copy", ids)`, landing on `copy_data` (C23) and
 *    a server-created id the UI then navigates to or reloads around --
 *    chained-id, can't be queued (architecture.md §3.7);
 *  - every binding-model item (B84: mass mail, followers, the merge and
 *    Lost wizards) -- these have no `callback`, only an `action` to
 *    `doAction`, and never carry `availableOffline` at all;
 *  - the Properties field's "Edit Properties" (B83,
 *    `addPropertyFieldValue` in `form_controller.js`), which triggers
 *    `checkDefinitionWriteAccess()`'s `user.checkAccessRight` RPC.
 *
 * `archive`/`unarchive`/`delete` are deliberately exempted by key: list and
 * form controllers already mark them `availableOffline: true` (they are
 * the B67/B69 QUEUE rows, proven in `crm_offline_queue_semantics.test.js`,
 * a different feature); kanban's own copies of those three don't carry the
 * flag at all (a pre-existing asymmetry with list/form -- KNOWN-LIMIT,
 * left alone here, see this feature's handoff). Excluding them by key
 * keeps that already-working path untouched everywhere, not just where
 * the flag happens to be set, instead of this guard silently narrowing it.
 *
 * B70's second half: `_duplicateRecords`/`_deleteRecords`/`_toggleArchive`
 * (`dynamic_list.js`) all call `getResIds(true)`, which -- whenever
 * `isDomainSelected` is true -- issues a live `orm.search` with no
 * `ConnectionLostError` handling around that specific call (unlike the
 * producer call that follows it). A domain selected before going offline
 * would otherwise surface that as an uncaught error the moment any
 * action-menu operation ran, so every operation is blocked outright while
 * a domain selection is in effect offline, regardless of `availableOffline`.
 * (The "Select all N records" button itself is a plain `<button>` without
 * `data-available-offline`, so the framework's own button-disable pass
 * already keeps a *new* domain selection from starting offline -- proven
 * by a DOM test, not by this guard.)
 *
 * Scoped by `resModel` to crm's own models so every other addon's action
 * menu (contacts, sale orders, ...) is untouched, online or offline.
 */
const CRM_SCOPED_MODELS = [
    "crm.lead",
    "crm.stage",
    "crm.team",
    "crm.recurring.plan",
    "crm.lost.reason",
];
const ALWAYS_AVAILABLE_OFFLINE_KEYS = ["archive", "unarchive", "delete"];

patch(ActionMenus.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    get isCrmView() {
        return CRM_SCOPED_MODELS.includes(this.props.resModel);
    },

    async onItemSelected(item) {
        if (this.isCrmView && this.crmOffline.isOffline()) {
            if (this.props.isDomainSelected) {
                return;
            }
            if (!item.availableOffline && !ALWAYS_AVAILABLE_OFFLINE_KEYS.includes(item.key)) {
                return;
            }
        }
        return super.onItemSelected(...arguments);
    },
});
