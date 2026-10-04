import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    switchView,
} from "@web/../tests/web_test_helpers";
import { serializeDate, today } from "@web/core/l10n/dates";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * VAL-DIS-007 (B81): the `crm_activity` view's empty cell, "Schedule
 * activity" footer and record-row link are inert offline; entering the
 * view offline with nothing cached shows `OfflineActionHelper` instead of
 * crashing.
 *
 * `activity_state`'s selection (`overdue`/`today`/`planned`) is declared
 * manually below because `ActivityRenderer.getGroupInfo()` reads
 * `this.props.fields.activity_state.selection` directly -- a real
 * `mail.activity.mixin` model gets it from the mixin; nothing here reads
 * the field's actual value.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    activity_ids = fields.One2many({ relation: "mail.activity", string: "Activities" });
    activity_state = fields.Selection({
        selection: [
            ["overdue", "Overdue"],
            ["today", "Today"],
            ["planned", "Planned"],
        ],
    });

    _records = [
        { id: 1, name: "Visited Lead" },
        { id: 2, name: "Never Visited Lead" },
    ];

    _views = {
        activity: `
            <activity js_class="crm_activity" string="Activities">
                <templates>
                    <div t-name="activity-box">
                        <field name="name"/>
                    </div>
                </templates>
            </activity>`,
        kanban: `<kanban js_class="crm_kanban"><templates><t t-name="card"><field name="name"/></t></templates></kanban>`,
        form: `<form><field name="name"/></form>`,
        search: `<search/>`,
    };
}

defineModels([Lead]);
defineMailModels();

/**
 * Email (id 1) on lead 1, Call (id 2) on lead 2 -- distinct types so each
 * lead ends up with one genuinely *empty* cell (the other type's column)
 * to click, instead of both leads sharing a single, always-filled column.
 * Without at least one activity each, a lead is left out of
 * `get_activity_data`'s `activity_res_ids` entirely and gets no row at
 * all. `startServer()` (not `MockServer.env`, which is only populated once
 * a server is already running) is mail's own idiom for seeding before the
 * first mount (`crm_offline_activity_menu.test.js`).
 */
async function seedActivities() {
    const pyEnv = await startServer();
    const [activity1, activity2] = pyEnv["mail.activity"].create([
        {
            res_model: "crm.lead",
            res_id: 1,
            activity_type_id: 1,
            date_deadline: serializeDate(today()),
        },
        {
            res_model: "crm.lead",
            res_id: 2,
            activity_type_id: 2,
            date_deadline: serializeDate(today()),
        },
    ]);
    // `activity_ids` has no automatic inverse in the mock server (unlike
    // the real `mail.activity.mixin`): `ActivityModel.load()` filters its
    // own root search on `activity_ids.active`, so without this the lead
    // search comes back empty and no row renders at all, regardless of
    // what `get_activity_data` returns.
    pyEnv["crm.lead"].write([1], { activity_ids: [activity1] });
    pyEnv["crm.lead"].write([2], { activity_ids: [activity2] });
    return pyEnv;
}

// ---------------------------------------------------------------------------
// Empty cell and "Schedule activity" footer: both open a transient wizard
// (SelectCreateDialog / a new mail.activity form dialog), DISABLE offline
// regardless of any record's cache state.
// ---------------------------------------------------------------------------

test("offline, the activity view's empty cell and footer are inert; online they still open their dialog (desktop)", async () => {
    await seedActivities();
    await mountView({ resModel: "crm.lead", type: "activity", arch: Lead._views.activity });
    expect(".o_view_controller.o_activity_view").toHaveCount(1);
    expect("tbody .o_data_row").toHaveCount(2);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains("tbody .o_data_row:eq(0) .o_activity_empty_cell").click();
    expect(".modal").toHaveCount(0);

    await contains(".o_activity_view_table_footer .o_record_selector").click();
    expect(".modal").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);

    await contains("tbody .o_data_row:eq(0) .o_activity_empty_cell").click();
    expect(".modal").toHaveCount(1);
    await contains(".modal .o_form_button_cancel, .modal .btn-secondary").click();

    await contains(".o_activity_view_table_footer .o_record_selector").click();
    expect(".modal").toHaveCount(1);
});

test.tags("mobile");
test("offline, the activity view's empty cell and footer are inert; online they still open their dialog (mobile)", async () => {
    await seedActivities();
    await mountView({ resModel: "crm.lead", type: "activity", arch: Lead._views.activity });
    expect(".o_view_controller.o_activity_view").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains("tbody .o_data_row:eq(0) .o_activity_empty_cell").click();
    expect(".modal").toHaveCount(0);

    await contains(".o_activity_view_table_footer .o_record_selector").click();
    expect(".modal").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);

    await contains("tbody .o_data_row:eq(0) .o_activity_empty_cell").click();
    expect(".modal").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// B81 (scrutiny finding 22): the template dropdown's "Send Mail" item is a
// `<div t-on-click>` (`activity_renderer.xml`'s `.o_send_mail_template`),
// not a `<button>`, so the framework's `SELECTORS_TO_DISABLE` never
// reaches it; `sendMailTemplate` had no offline guard of its own before
// this fix.
// ---------------------------------------------------------------------------

test.tags("desktop");
test('offline, the activity view\'s "Send Mail" item is inert; online it still sends (desktop)', async () => {
    const pyEnv = await seedActivities();
    const [templateId] = pyEnv["mail.template"].create([{ name: "Welcome" }]);
    pyEnv["mail.activity.type"].write([1], { mail_template_ids: [templateId] });
    // `activity_send_mail` is a bespoke crm method the mock server has no
    // default implementation for, so the hook must substitute a result
    // itself (returning `undefined` would fall through to "Unimplemented
    // ORM method").
    onRpc("crm.lead", "activity_send_mail", () => {
        expect.step("activity_send_mail");
        return true;
    });

    await mountView({ resModel: "crm.lead", type: "activity", arch: Lead._views.activity });
    expect(".o_view_controller.o_activity_view").toHaveCount(1);

    await contains(".o_activity_type_cell [data-bs-toggle='dropdown']").click();
    expect(".o_send_mail_template:contains('Welcome')").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_send_mail_template:contains('Welcome')").click();
    expect.verifySteps([]); // no activity_send_mail

    await setOffline(false);
    await contains(".o_activity_type_cell [data-bs-toggle='dropdown']").click();
    await contains(".o_send_mail_template:contains('Welcome')").click();
    expect.verifySteps(["activity_send_mail"]);
});

test.tags("mobile");
test('offline, the activity view\'s "Send Mail" item is inert (mobile)', async () => {
    const pyEnv = await seedActivities();
    const [templateId] = pyEnv["mail.template"].create([{ name: "Welcome" }]);
    pyEnv["mail.activity.type"].write([1], { mail_template_ids: [templateId] });
    onRpc("crm.lead", "activity_send_mail", () => {
        expect.step("activity_send_mail");
        return true;
    });

    await mountView({ resModel: "crm.lead", type: "activity", arch: Lead._views.activity });

    await contains(".o_activity_type_cell [data-bs-toggle='dropdown']").click();
    expect(".o_send_mail_template:contains('Welcome')").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_send_mail_template:contains('Welcome')").click();
    expect.verifySteps([]);
});

// ---------------------------------------------------------------------------
// Record link and "nothing cached" entry: same uncached-record-navigation
// reasoning and proof idiom as `crm_offline_uncached_lead.test.js`'s
// kanban/list `openRecord` guard -- a genuine online visit for "Visited
// Lead" (via the kanban, so the resulting form view is marked available
// under this same action), none for "Never Visited Lead", and the
// activity view's own root is never visited online either in the second
// test below.
// ---------------------------------------------------------------------------

defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "kanban"],
            [false, "activity"],
            [false, "form"],
        ],
    },
]);

const WEB_READ_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/web_read" couldn't be established or was interrupted`;
const HELPER_TEXT = "There is no data to display offline for the given filters";

test("offline, the activity view opens a visited lead's row and leaves an unvisited one alone; online both open (desktop)", async () => {
    await seedActivities();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Genuinely visit "Visited Lead"'s form online (via the kanban, same
    // idiom as crm_offline_uncached_lead.test.js), then come back and
    // switch to the activity view -- still online, so its own root loads
    // without error -- before going offline.
    await contains(".o_kanban_record:contains('Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    await switchView("activity");
    expect(".o_view_controller.o_activity_view").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // "Never Visited Lead" first: the guard short-circuits before
    // `super.openRecord`, so nothing navigates and the activity view stays
    // mounted -- unlike `ActivityModel` (`static withCache = false`),
    // re-entering it after a real navigation always reattempts (and,
    // offline, always fails) its own root load, which is a different
    // concern from this guard and covered by the "nothing cached" test
    // below instead of a revisit here.
    await contains(".o_data_row:contains('Never Visited Lead') .o_activity_record").click();
    expect(".o_form_view").toHaveCount(0); // unreachable: no navigation, no RPC at all
    expect(".o_view_controller.o_activity_view").toHaveCount(1);
    expect(".o_notification").toHaveCount(0);

    expect.errors(1); // web_read is genuinely attempted; it loses the race to the disk-cache hit
    await contains(".o_data_row:contains('Visited Lead') .o_activity_record").click();
    expect(".o_form_view").toHaveCount(1);
    expect.verifyErrors([WEB_READ_ERROR]);
});

test.tags("mobile");
test("offline, the activity view opens a visited lead's row and leaves an unvisited one alone; online both open (mobile)", async () => {
    await seedActivities();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await contains(".o_kanban_record:contains('Visited Lead')").click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    await switchView("activity");
    expect(".o_view_controller.o_activity_view").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_data_row:contains('Never Visited Lead') .o_activity_record").click();
    expect(".o_form_view").toHaveCount(0);
    expect(".o_view_controller.o_activity_view").toHaveCount(1);

    expect.errors(1);
    await contains(".o_data_row:contains('Visited Lead') .o_activity_record").click();
    expect(".o_form_view").toHaveCount(1);
    expect.verifyErrors([WEB_READ_ERROR]);
});

// A real "never visited this exact search state before" offline is not
// reachable through the UI once *anything* has been cached: the
// view-switcher's own buttons are plain `<button>`s with no
// `data-available-offline`, so `OfflinePlugin.SELECTORS_TO_DISABLE`
// disables them like any other untagged button while offline -- there is
// no way to switch *into* a never-visited view type once offline; and a
// `doAction` by id or by an inline definition both still need a genuine,
// uncached `get_views`/`/web/action/load` round-trip to resolve the
// action itself before `CrmActivityModel.load()` is ever reached, which
// fails first and for an unrelated reason. Forcing the root RPC directly
// via `onRpc`, decoupled from `mockCrmOffline()`, is the only way to reach
// `couldNotLoadRootOffline` at all -- the same idiom as
// crm_offline_kanban_group_guards.test.js's own "a connection lost while
// loading the forecast board..." test (KNOWN-LIMIT: the unreachability
// itself is a framework fact, out of this fix's scope).
test("a connection lost while loading the activity view's root shows the offline helper instead of crashing (desktop)", async () => {
    onRpc("crm.lead", "web_search_read", () => new Response("", { status: 502 }));
    // No `expect.errors()`/`verifyErrors()` here: unlike the generic
    // `RelationalModel.load()`, which sets `couldNotLoadRootOffline` but
    // still rethrows (leaving the `ConnectionLostError` unhandled, as
    // `crm_offline_kanban_group_guards.test.js`'s own forecast-board test
    // proves for a plain kanban), `CrmActivityModel.load()` (B81's own
    // fix, crm_activity_model.js) catches and fully swallows it instead,
    // precisely so this scenario never surfaces as an error.
    await mountView({ resModel: "crm.lead", type: "activity", arch: Lead._views.activity });
    expect(".o_view_controller.o_activity_view").toHaveCount(1);
    expect(".o_view_nocontent").toHaveCount(1); // the generic OfflineActionHelper, not a crash
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1); // the exact helper text, not just any empty state
    expect("tbody .o_data_row").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
});

test.tags("mobile");
test("a connection lost while loading the activity view's root shows the offline helper instead of crashing (mobile)", async () => {
    onRpc("crm.lead", "web_search_read", () => new Response("", { status: 502 }));
    await mountView({ resModel: "crm.lead", type: "activity", arch: Lead._views.activity });
    expect(".o_view_nocontent").toHaveCount(1);
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1); // the exact helper text, not just any empty state
    expect("tbody .o_data_row").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0); // VAL-DIS-007: no error dialog on mobile either
    expect(".o_notification").toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Online guard: `isLeadAvailableOffline` short-circuits to `true` while
// online, so a never-visited lead's row still opens -- the fix only
// changes offline behavior.
// ---------------------------------------------------------------------------

test("online, the activity view opens every lead's row regardless of offline cache state (desktop)", async () => {
    await seedActivities();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await switchView("activity");
    expect(".o_view_controller.o_activity_view").toHaveCount(1);

    await contains(".o_data_row:contains('Never Visited Lead') .o_activity_record").click();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Never Visited Lead");
});
