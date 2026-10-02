import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    mockOffline,
    models,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    switchView,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";

/**
 * Uncached lead opened offline (architecture.md §3.2 item 10 /
 * offline_inventory.md rows B18-B20): opening a lead from the CRM kanban or
 * list that was never visited online must render `OfflineActionHelper`
 * instead of an empty form, an error, or a silent no-op. Before this fix,
 * `CrmKanbanController`/`CrmListController.openRecord` always delegated to
 * `selectRecord`, which switches to the form view; offline, that view's
 * `web_read` misses the disk cache, throws `ConnectionLostError`, and the
 * action manager silently restores the kanban/list (architecture.md §2) --
 * exactly the "silent no-op" this fix replaces.
 *
 * "Visited" leads are genuinely visited online first (click the card,
 * `web_read` populates the real RPC disk cache, then navigate back), the
 * same idiom as window_action.test.js's "[Offline] navigate through window
 * actions" and crm_offline_team_switcher.test.js. Faking
 * `OfflinePlugin.isAvailableOffline` only lies to the UI gating -- it would
 * leave the lead "available" per the check this fix adds, while its form
 * data was never actually fetched, so opening it offline would still throw.
 * A genuinely cached record's `web_read` is still attempted while offline
 * (and still fails, racing the disk-cache hit) rather than skipped, which is
 * why every "cached lead" assertion below declares and verifies that one
 * `ConnectionLostError`.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();

    _records = [
        { id: 1, name: "Visited Lead" },
        { id: 2, name: "Never Visited Lead" },
    ];

    _views = {
        // The "menu" template matches the real pipeline card's "Edit" /
        // "Delete" entries (kanban_record.xml:26) closely enough to prove
        // the toggler is unreachable offline (VAL-DIS-009 / B18-B20):
        // without it `KanbanRecord.showMenu` is false and the toggler
        // wouldn't even be in the DOM to test against.
        kanban: `
            <kanban js_class="crm_kanban">
                <templates>
                    <t t-name="menu">
                        <a role="menuitem" type="open" class="dropdown-item">Edit</a>
                        <a role="menuitem" type="delete" class="dropdown-item">Delete</a>
                    </t>
                    <t t-name="card"><field name="name"/></t>
                </templates>
            </kanban>`,
        list: `<list js_class="crm_list"><field name="name"/></list>`,
        form: `<form><field name="name"/></form>`,
        search: `<search/>`,
    };
}

defineModels([Lead]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "kanban"],
            [false, "list"],
            [false, "form"],
        ],
    },
]);

const HELPER_TEXT = "There is no data to display offline for the given filters";
const WEB_READ_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/web_read" couldn't be established or was interrupted`;
// Returning to an already-visited kanban/list root also genuinely retries
// its own reload (window_action.test.js's "[Offline] navigate through
// window actions" and crm_offline_team_switcher.test.js declare the same
// kind of error for a revisited list); unrelated to this fix, which only
// changes what happens when *opening a record*.
const WEB_SEARCH_READ_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/web_search_read" couldn't be established or was interrupted`;

// ---------------------------------------------------------------------------
// VAL-UNCACHED-001: the CRM kanban
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, the crm kanban opens a cached lead and shows the helper for an uncached one (desktop)", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Genuinely visit "Visited Lead"'s form online so its data lands in the
    // real RPC disk cache, then come back to the kanban before going
    // offline.
    await contains(".o_kanban_record:contains('Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_kanban_view").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    expect.errors(1); // web_read is genuinely attempted; it loses the race to the disk-cache hit
    await contains(".o_kanban_record:contains('Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Visited Lead");
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(0);
    expect.verifyErrors([WEB_READ_ERROR]);

    expect.errors(2); // cumulative: 1 verified above + this one
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_kanban_view").toHaveCount(1);
    expect.verifyErrors([WEB_SEARCH_READ_ERROR]);

    await contains(".o_kanban_record:contains('Never Visited Lead')").click();
    expect(".o_form_view").toHaveCount(0);
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    // Still the kanban controller: no navigation happened, no breadcrumb
    // pushed, no empty form, no silent no-op, and no RPC at all (the guard
    // short-circuits before `openRecord` would ever call `web_read`).
    expect(".o_kanban_view").toHaveCount(1);
    expect(".o_last_breadcrumb_item:contains('Pipeline')").toHaveCount(1);
    expect(".o_notification").toHaveCount(0);
});

test.tags("mobile");
test("offline, the crm kanban opens a cached lead and shows the helper for an uncached one (mobile)", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await contains(".o_kanban_record:contains('Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_kanban_view").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    expect.errors(1);
    await contains(".o_kanban_record:contains('Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    expect.verifyErrors([WEB_READ_ERROR]);

    expect.errors(2); // cumulative: 1 verified above + this one
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_kanban_view").toHaveCount(1);
    expect.verifyErrors([WEB_SEARCH_READ_ERROR]);

    await contains(".o_kanban_record:contains('Never Visited Lead')").click();
    expect(".o_form_view").toHaveCount(0);
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    expect(".o_kanban_view").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// VAL-UNCACHED-002: the CRM list
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, the crm list opens a cached lead and shows the helper for an uncached one (desktop)", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await contains(".o_kanban_record:contains('Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    // Visit the list view once online too, so the offline switch below
    // exercises "uncached lead" behavior, not the unrelated "a view never
    // visited before shows the whole-view offline fallback" behavior.
    await switchView("list");
    expect(".o_list_view").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    expect.errors(1);
    await contains(".o_data_row:contains('Visited Lead') .o_data_cell").click();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Visited Lead");
    expect.verifyErrors([WEB_READ_ERROR]);

    expect.errors(2); // cumulative: 1 verified above + this one
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_list_view").toHaveCount(1);
    expect.verifyErrors([WEB_SEARCH_READ_ERROR]);

    await contains(".o_data_row:contains('Never Visited Lead') .o_data_cell").click();
    expect(".o_form_view").toHaveCount(0);
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    expect(".o_list_view").toHaveCount(1);
    expect(".o_notification").toHaveCount(0);
});

test.tags("mobile");
test("offline, the crm list opens a cached lead and shows the helper for an uncached one (mobile)", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await contains(".o_kanban_record:contains('Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    await switchView("list");
    expect(".o_list_view").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    expect.errors(1);
    await contains(".o_data_row:contains('Visited Lead') .o_data_cell").click();
    expect(".o_form_view").toHaveCount(1);
    expect.verifyErrors([WEB_READ_ERROR]);

    expect.errors(2); // cumulative: 1 verified above + this one
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_list_view").toHaveCount(1);
    expect.verifyErrors([WEB_SEARCH_READ_ERROR]);

    await contains(".o_data_row:contains('Never Visited Lead') .o_data_cell").click();
    expect(".o_form_view").toHaveCount(0);
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    expect(".o_list_view").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// VAL-UNCACHED-003 / VAL-DIS-009: the card menu toggler of an uncached
// lead's card stays disabled (B18-B20), while its body shows the helper.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, an uncached lead's card menu toggler is disabled and its body shows the helper (desktop)", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    const setOffline = mockOffline();
    await setOffline(true);

    const uncachedCard = ".o_kanban_record:contains('Never Visited Lead')";
    // kanban_record.xml:26: the dropdown toggler is a plain `<button>` with
    // no `data-available-offline`, so `OfflinePlugin.SELECTORS_TO_DISABLE`
    // disables it on its own; crm does not add the attribute to it.
    expect(`${uncachedCard} .o_dropdown_kanban button`).toHaveAttribute("disabled");
    expect(`${uncachedCard} .o_dropdown_kanban button`).toHaveClass("o_disabled_offline");

    await contains(`${uncachedCard} .o_dropdown_kanban button`).click();
    expect(".o-dropdown--menu").toHaveCount(0); // unreachable: no menu opened, no Edit/Delete item

    await contains(uncachedCard).click();
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    expect(".o_form_view").toHaveCount(0);
});

test.tags("mobile");
test("offline, an uncached lead's card menu toggler is disabled and its body shows the helper (mobile)", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    const setOffline = mockOffline();
    await setOffline(true);

    const uncachedCard = ".o_kanban_record:contains('Never Visited Lead')";
    expect(`${uncachedCard} .o_dropdown_kanban button`).toHaveAttribute("disabled");
    expect(`${uncachedCard} .o_dropdown_kanban button`).toHaveClass("o_disabled_offline");

    await contains(uncachedCard).click();
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    expect(".o_form_view").toHaveCount(0);
});

// ---------------------------------------------------------------------------
// VAL-DIS-009 (B18/B19, scrutiny finding 1): a card menu opened online and
// still open when the connection drops does nothing on Edit or Delete.
// `DropdownItem`s are `<span>`/`<a role="menuitem">`, never `<button>`, so
// the framework's own `SELECTORS_TO_DISABLE` pass (which only reaches the
// toggler) cannot catch this; only a handler-level guard on
// `KanbanRecord.triggerAction` can (`kanban_record_offline_patch.js`).
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, a card menu opened online can't Edit afterward; online it still can (desktop)", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const card = ".o_kanban_record:contains('Visited Lead')";
    await contains(`${card} .o_dropdown_kanban button`).click();
    expect(".dropdown-item:contains('Edit')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".dropdown-item:contains('Edit')").click();
    expect(".o_form_view").toHaveCount(0); // unreachable: no navigation, no RPC at all
    expect(".o-dropdown--menu").toHaveCount(0); // the item click still closes the dropdown itself

    await setOffline(false);
    await contains(`${card} .o_dropdown_kanban button`).click();
    await contains(".dropdown-item:contains('Edit')").click();
    expect(".o_form_view").toHaveCount(1);
});

test.tags("mobile");
test("offline, a card menu opened online can't Edit afterward (mobile)", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const card = ".o_kanban_record:contains('Visited Lead')";
    await contains(`${card} .o_dropdown_kanban button`).click();
    expect(".dropdown-item:contains('Edit')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".dropdown-item:contains('Edit')").click();
    expect(".o_form_view").toHaveCount(0);
    expect(".o-dropdown--menu").toHaveCount(0);
});

test.tags("desktop");
test("offline, a card menu opened online can't Delete afterward; online it still asks to delete (desktop)", async () => {
    onRpc("crm.lead", "web_unlink", () => expect.step("web_unlink"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const card = ".o_kanban_record:contains('Visited Lead')";
    await contains(`${card} .o_dropdown_kanban button`).click();
    expect(".dropdown-item:contains('Delete')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".dropdown-item:contains('Delete')").click();
    expect(".o_dialog").toHaveCount(0); // no confirmation dialog opened
    expect.verifySteps([]); // no web_unlink issued or queued
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2); // neither record was deleted

    await setOffline(false);
    await contains(`${card} .o_dropdown_kanban button`).click();
    await contains(".dropdown-item:contains('Delete')").click();
    expect(".o_dialog:contains('Bye-bye, record!')").toHaveCount(1);
    await contains(".o_dialog footer button:contains('No, keep it')").click();
});

test.tags("mobile");
test("offline, a card menu opened online can't Delete afterward (mobile)", async () => {
    onRpc("crm.lead", "web_unlink", () => expect.step("web_unlink"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const card = ".o_kanban_record:contains('Visited Lead')";
    await contains(`${card} .o_dropdown_kanban button`).click();
    expect(".dropdown-item:contains('Delete')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".dropdown-item:contains('Delete')").click();
    expect(".o_dialog").toHaveCount(0);
    expect.verifySteps([]);
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2);
});

// ---------------------------------------------------------------------------
// Online guard: `isRecordAvailableOffline` short-circuits to `true` while
// online, so a never-visited lead still opens normally -- the fix only
// changes offline behavior.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("online, the crm kanban still opens every lead regardless of offline cache state (desktop)", async () => {
    patchWithCleanup(OfflinePlugin.prototype, {
        isAvailableOffline(actionId, viewType, resId) {
            return false; // nothing is "visited"; must not matter online
        },
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    await contains(".o_kanban_record:contains('Never Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Never Visited Lead");
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(0);
});
