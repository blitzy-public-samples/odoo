import { defineMailModels, start, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import { press } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    models,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * Defect 7 (architecture.md §3.2 item 7 / offline_inventory.md rows A1/A2):
 * `ActivityMenu.openActivityGroup` for a `crm.lead` group calls
 * `this.action.loadAction("crm.crm_lead_action_my_activities")` then
 * `this.action.doAction(...)`, with no `isOffline()` guard and no `.catch`
 * on the promise. The group row is rendered as a `<div t-custom-click>`
 * (`@mail/core/web/activity_menu.xml`), not a `<button>`, so the
 * framework's `SELECTORS_TO_DISABLE` never reaches it: `activity_menu_patch.js`
 * must guard the handler itself (VAL-FIX-011, VAL-DIS-011).
 *
 * The group div carries no `tabindex` and `t-custom-click` only binds
 * "click"/"auxclick" (`addons/web/static/src/env.js`'s `customDirectives`),
 * and the Dropdown's keyboard navigation only drives elements matching
 * `.o-navigable, .o-dropdown` (`core/dropdown/dropdown.js`), a class this
 * div never gets -- so, both before and after this fix, "Enter" cannot
 * reach `openActivityGroup` at all. The Enter assertions below document
 * that framework fact instead of exercising a crm code path.
 *
 * `mockCrmOffline()` (crm_test_helpers.js) is used instead of the raw
 * `mockOffline()`: going offline right after a full `start()` app mounts
 * would otherwise race the mail store's own one-time startup
 * `/mail/store` poll and throw an uncaught, unrelated `ConnectionLostError`
 * before either test below gets anywhere.
 *
 * That settle does not cover `openActivityDropdown()`'s own click, though:
 * opening the dropdown always calls `ActivityMenu.onBeforeOpen`, which
 * issues a fresh `fetchStoreData("systray_get_activities")`
 * (@mail/core/web/activity_menu.js) *after* the connection is already down
 * -- a deterministic, expected failure, not the startup race, declared
 * below in both offline tests.
 */
const CONNECTION_LOST_MAIL_STORE =
    'Connection to "/mail/store" couldn\'t be established or was interrupted';

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();

    _records = [{ id: 1, name: "First lead" }];
}

// A second, unrelated model standing in for "any model other than
// crm.lead": the base `availableViews()` puts "kanban" first
// (`@mail/core/web/activity_menu.js`), so unlike `Lead` above (only ever
// opened through the crm.lead-specific action, which this file defines
// with a plain list view), this one needs a working kanban arch too.
class OtherThread extends models.Model {
    _name = "test.other.thread";

    name = fields.Char();

    _records = [{ id: 1, name: "Other record" }];

    _views = {
        kanban: /* xml */ `
            <kanban><templates><t t-name="card"><field name="name"/></t></templates></kanban>`,
        list: /* xml */ `<list><field name="name"/></list>`,
        form: /* xml */ `<form><field name="name"/></form>`,
    };
}

defineModels([Lead, OtherThread]);
defineMailModels();
defineActions([
    {
        id: "crm.crm_lead_action_my_activities",
        name: "My Pipeline Activities",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [[false, "list"]],
    },
]);

async function openActivityDropdown() {
    await contains(".o_menu_systray i[aria-label='Activities']").click();
}

// ---------------------------------------------------------------------------
// VAL-FIX-011 / VAL-DIS-011: offline, the crm.lead group is inert.
// ---------------------------------------------------------------------------

test("offline, clicking the crm.lead activity group issues no loadAction/doAction and no RPC", async () => {
    const pyEnv = await startServer();
    pyEnv["mail.activity"].create({ res_id: 1, res_model: "crm.lead" });
    onRpc("/web/action/load", () => expect.step("load_action"));
    onRpc("crm.lead", "web_search_read", () => expect.step("web_search_read"));
    const setOffline = mockCrmOffline();
    await start();
    await setOffline(true);
    expect.errors(1);
    await openActivityDropdown();

    expect(".o-mail-ActivityGroup[data-model_name='crm.lead']").toHaveCount(1);
    await contains(".o-mail-ActivityGroup[data-model_name='crm.lead']").click();

    expect.verifySteps([]); // neither loadAction's RPC nor the target view's RPC fired
    expect(".o_last_breadcrumb_item:contains('My Pipeline Activities')").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
    expect.verifyErrors([CONNECTION_LOST_MAIL_STORE]);
});

test("offline, pressing Enter while the crm.lead group is open issues no RPC (framework fact: the row is never keyboard-navigable)", async () => {
    const pyEnv = await startServer();
    pyEnv["mail.activity"].create({ res_id: 1, res_model: "crm.lead" });
    onRpc("/web/action/load", () => expect.step("load_action"));
    const setOffline = mockCrmOffline();
    await start();
    await setOffline(true);
    expect.errors(1);
    await openActivityDropdown();

    expect(".o-mail-ActivityGroup[data-model_name='crm.lead']").toHaveCount(1);
    await press("Enter");

    expect.verifySteps([]);
    expect(".o_last_breadcrumb_item:contains('My Pipeline Activities')").toHaveCount(0);
    expect.verifyErrors([CONNECTION_LOST_MAIL_STORE]);
});

// ---------------------------------------------------------------------------
// VAL-FIX-011 online guard: the crm.lead group still navigates as before.
// ---------------------------------------------------------------------------

test("online, clicking the crm.lead activity group still opens My Pipeline Activities", async () => {
    const pyEnv = await startServer();
    pyEnv["mail.activity"].create({ res_id: 1, res_model: "crm.lead" });
    // A route handler that returns `undefined` (not a model/method handler,
    // so there is no `parent()` to call) falls through to the mock server's
    // own default `/web/action/load` route handler
    // (`_framework/mock_server/mock_server.js`'s `_handleRequest`: it keeps
    // trying listeners until one returns a non-`null`/`undefined` result).
    onRpc("/web/action/load", () => expect.step("load_action"));
    await start();
    await openActivityDropdown();
    await contains(".o-mail-ActivityGroup[data-model_name='crm.lead']").click();

    // `openActivityGroup`'s `loadAction(...).then(...)` chain isn't awaited
    // by the click itself: wait for the resulting navigation instead of
    // asserting on it synchronously.
    await waitFor(".o_last_breadcrumb_item:contains('My Pipeline Activities')");
    expect.verifySteps(["load_action"]);
});

// ---------------------------------------------------------------------------
// VAL-FIX-011: entries for other models keep their existing (super) path,
// online, both before and after this fix (the else branch is untouched).
// ---------------------------------------------------------------------------

test("online, clicking a non-crm.lead activity group still uses the base behavior", async () => {
    const pyEnv = await startServer();
    pyEnv["mail.activity"].create({ res_id: 1, res_model: "test.other.thread" });
    await start();
    await openActivityDropdown();

    await contains(".o-mail-ActivityGroup[data-model_name='test.other.thread']").click();

    // The base `openActivityGroup` built and ran an `ir.actions.act_window`
    // on `test.other.thread` directly (no `crm.crm_lead_action_my_activities`
    // involved): its default (kanban-first) view renders that model's record.
    await waitFor(".o_kanban_record:contains('Other record')");
});
