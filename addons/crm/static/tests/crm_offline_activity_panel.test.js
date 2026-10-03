import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, runAllTimers, test } from "@odoo/hoot";
import { queryAllTexts, queryOne } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    MockServer,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { user } from "@web/core/user";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/crm_test_helpers";

/**
 * m3-activity-panel (architecture.md §3.3, offline_inventory.md rows
 * B17/B23/BR7's Notes #2 "superseded by future work", VAL-DATA-008..016):
 * the lead form's own offline activity panel (`crm_lead_activity_panel.js`
 * / `.xml`, registered as the `crm_lead_activity_panel` view widget,
 * wired into the form arch by `crm_lead_view_form_activity_panel`'s
 * `<xpath>` just before `<chatter>`), distinct from -- and not reachable
 * through -- mail's own `kanban_activity`/`list_activity`
 * `ActivityButton`, which stays DISABLE (B17/B23/BR7) regardless.
 *
 * Every test here uses the exact `activity_ids` subfields the real
 * inheriting view loads (`activity_type_id`, `summary`, `date_deadline`,
 * `user_id`, `state`) and the widget tag the real view embeds, inlined
 * directly into this file's own arch -- the same convention
 * `crm_offline_mark_won.test.js` already uses for the Won button, since a
 * hoot test mounts a view from its own `_views.form`, not through actual
 * XML-inheritance file loading.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    type = fields.Selection({
        selection: [["lead", "Lead"], ["opportunity", "Opportunity"]],
        default: "opportunity",
    });
    active = fields.Boolean({ default: true });
    won_status = fields.Selection({
        selection: [["won", "Won"], ["pending", "In Progress"], ["lost", "Lost"]],
        default: "pending",
    });
    activity_ids = fields.One2many({ relation: "mail.activity", string: "Activities" });

    _records = [
        { id: 1, name: "Open Opportunity", type: "opportunity", active: true, won_status: "pending" },
    ];

    _views = {
        form: `
            <form js_class="crm_form">
                <header>
                    <button name="action_set_won_rainbowman" string="Won"
                        type="object" class="oe_highlight" data-hotkey="w"
                        data-available-offline=""
                        invisible="won_status == 'won' or type == 'lead' or not active"/>
                    <field name="type" invisible="1"/>
                    <field name="active" invisible="1"/>
                    <field name="won_status" invisible="1"/>
                </header>
                <sheet>
                    <field name="name" required="1"/>
                    <div class="d-none">
                        <field name="activity_ids">
                            <list>
                                <field name="activity_type_id"/>
                                <field name="summary"/>
                                <field name="date_deadline"/>
                                <field name="user_id"/>
                                <field name="state"/>
                            </list>
                        </field>
                    </div>
                    <widget name="crm_lead_activity_panel"/>
                </sheet>
            </form>`,
        search: `<search/>`,
    };
}

defineModels([Lead]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Open Opportunity",
        res_model: "crm.lead",
        res_id: 1,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    },
    {
        id: 2,
        name: "New Opportunity",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    },
]);

/**
 * `defineMailModels()`'s own `mail.activity.type` fixture
 * (`mail_activity_type.js`) seeds three baseline types with no `res_model`
 * -- id 1 "Email", id 2 "Call" (category "phonecall"), id 28 "Upload
 * Document" (no category at all, unlike the real `upload_file`-categorized
 * "Document" type `mail_activity_type_data.xml` ships in production) --
 * that this panel's own domain (generic types, `res_model = False`) always
 * also matches. Removing them here, before seeding this test's own types,
 * is what makes every assertion below about exact types/ids/ordering
 * deterministic; the panel's production domain is intentionally this
 * broad (every generic type must show up, not just crm-scoped ones), so
 * narrowing it instead would misrepresent real behavior.
 */
function removeBaselineActivityTypes(pyEnv) {
    pyEnv["mail.activity.type"].unlink(pyEnv["mail.activity.type"].search([]));
}

/**
 * Seeds the activity-type disk cache with a non-excluded, a meeting and an
 * upload type. `startServer()` may only be called once per test
 * (a second call raises "MockServer has already been _started"), so every
 * test that needs its own `mail.activity`/`crm.lead` fixture data gets the
 * `pyEnv` back here instead of calling `startServer()` again itself.
 */
async function seedActivityTypes() {
    const pyEnv = await startServer();
    removeBaselineActivityTypes(pyEnv);
    const callId = pyEnv["mail.activity.type"].create({ name: "Call", category: "phonecall" });
    const emailId = pyEnv["mail.activity.type"].create({ name: "Email" });
    const meetingId = pyEnv["mail.activity.type"].create({ name: "Meeting", category: "meeting" });
    const uploadId = pyEnv["mail.activity.type"].create({
        name: "Upload Document",
        category: "upload_file",
    });
    return { pyEnv, callId, emailId, meetingId, uploadId };
}

// ---------------------------------------------------------------------------
// VAL-DATA-009: the panel renders only offline; online, nothing changes.
// ---------------------------------------------------------------------------

test("online, the lead form shows no activity panel; offline, it shows one listing cached server activities", async () => {
    const { pyEnv, callId } = await seedActivityTypes();
    const activityId = pyEnv["mail.activity"].create({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: callId,
        summary: "Follow up",
    });
    pyEnv["crm.lead"].write([1], { activity_ids: [activityId] });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(".o_crm_activity_panel").toHaveCount(0); // VAL-DATA-009: online, nothing is rendered

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_crm_activity_panel").toHaveCount(1);
    expect(".o_crm_activity_panel_row").toHaveCount(1);
    expect(".o_crm_activity_panel_row .o_crm_activity_type").toHaveText("Call");
    expect(".o_crm_activity_panel_row .o_crm_activity_summary").toHaveText("Follow up");
    expect(".o_crm_activity_panel_row .o_crm_activity_pending_sync").toHaveCount(0); // server activity, not queued
});

// ---------------------------------------------------------------------------
// VAL-DATA-010: Schedule queues one client-resolved mail.activity.create.
// ---------------------------------------------------------------------------

test("offline, Schedule queues one client-resolved mail.activity.create and shows the queued row as pending sync", async () => {
    const { callId } = await seedActivityTypes();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1); // online visit: warms the activity-type disk cache

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_crm_activity_schedule_type").toHaveValue(String(callId));
    await contains(".o_crm_activity_schedule_summary").edit("Call back next week");
    // `hoot-dom`'s `edit()` types one character at a time
    // (`events.js`'s `_fill`), which a native `<input type="date">` can't
    // consume: it has no text caret/selection to type into, only
    // dedicated day/month/year segments, so typing "2024-01-15"
    // char-by-char is swallowed rather than parsed, unlike the few types
    // `_fill` special-cases (color/time/file/range). Setting `.value`
    // directly and dispatching the same "input" event a real edit would
    // fire is what the `t-model` binding (owl.js's compiled model
    // listener) actually listens for.
    const deadlineInput = queryOne(".o_crm_activity_schedule_deadline");
    deadlineInput.value = "2024-01-15";
    deadlineInput.dispatchEvent(new Event("input", { bubbles: true }));
    await contains(".o_crm_activity_schedule_button").click();

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1); // exactly one call queued, no onchange, no wizard
    const [{ value }] = queued;
    expect(value.model).toBe("mail.activity");
    expect(value.method).toBe("create");
    expect(value.args).toEqual([
        [
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: callId,
                summary: "Call back next week",
                date_deadline: "2024-01-15",
                user_id: user.userId,
            },
        ],
    ]);
    expect(typeof value.extras.timeStamp).toBe("number");

    expect(".o_crm_activity_panel_row").toHaveCount(1);
    expect(".o_crm_activity_panel_row .o_crm_activity_pending_sync").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// VAL-DATA-011: no cached activity type disables Schedule (and Log a call).
// ---------------------------------------------------------------------------

test("offline, with no activity type cached, Schedule and Log a call are disabled and queue nothing", async () => {
    // No activity type exists at all (baseline fixtures removed, no
    // `seedActivityTypes()`), so the online visit's `search_read`
    // legitimately caches an *empty* result; offline, the disabled state
    // below comes from that cached empty list, not from a cold cache miss
    // (a true miss, with the view/action themselves never visited online
    // either, can't open at all offline -- out of scope here, VAL-DATA-011
    // is about a type cache with nothing usable in it, not about an
    // uncached lead).
    const pyEnv = await startServer();
    removeBaselineActivityTypes(pyEnv);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1); // online visit warms the (empty) type cache

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_crm_activity_panel").toHaveCount(1);
    expect(".o_crm_activity_schedule_button").toHaveAttribute("disabled");
    expect(".o_crm_activity_log_call_button").toHaveAttribute("disabled");

    await contains(".o_crm_activity_schedule_button").click();
    await contains(".o_crm_activity_log_call_button").click();
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
});

// ---------------------------------------------------------------------------
// VAL-DATA-012: meeting/upload types excluded; calendar path unreachable.
// ---------------------------------------------------------------------------

test("offline, meeting and upload activity types are excluded from both type selectors, and action_create_calendar_event is never reachable", async () => {
    await seedActivityTypes();
    onRpc("crm.lead", "action_create_calendar_event", () =>
        expect.step("action_create_calendar_event")
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    const scheduleOptions = queryAllTexts(".o_crm_activity_schedule_type option");
    const logCallOptions = queryAllTexts(".o_crm_activity_log_call_type option");
    expect(scheduleOptions).toEqual(["Call", "Email"]); // Meeting, Upload Document excluded
    expect(logCallOptions).toEqual(["Call", "Email"]);
    expect(".o_crm_activity_panel:contains('Meeting')").toHaveCount(0);
    expect(".o_crm_activity_panel:contains('Upload Document')").toHaveCount(0);
    expect.verifySteps([]); // calendar path never reached, online or offline
});

// ---------------------------------------------------------------------------
// VAL-DATA-013: Done queues action_done([[id]]) only.
// ---------------------------------------------------------------------------

test("offline, Done on a server activity queues exactly one mail.activity.action_done([[id]]), nothing else", async () => {
    const { pyEnv, callId } = await seedActivityTypes();
    const activityId = pyEnv["mail.activity"].create({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: callId,
        summary: "Follow up",
    });
    pyEnv["crm.lead"].write([1], { activity_ids: [activityId] });
    onRpc("mail.activity", "action_feedback", () => expect.step("action_feedback"));
    onRpc("mail.activity", "action_feedback_schedule_next", () =>
        expect.step("action_feedback_schedule_next")
    );

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_crm_activity_panel_row .o_crm_activity_done").toHaveCount(1);
    expect(".o_crm_activity_panel_row .o_crm_activity_done").not.toHaveAttribute("disabled");
    // "Done & Schedule Next" is not offered by this panel at all.
    expect(".o_crm_activity_schedule_next").toHaveCount(0);

    await contains(".o_crm_activity_panel_row .o_crm_activity_done").click();
    expect.verifySteps([]); // no action_feedback / action_feedback_schedule_next call

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("mail.activity");
    expect(value.method).toBe("action_done");
    expect(value.args).toEqual([[activityId]]);

    expect(".o_crm_activity_panel_row .o_crm_activity_pending_sync").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// VAL-DATA-014: Done is disabled for an activity scheduled offline.
// ---------------------------------------------------------------------------

test("offline, Done is disabled for an activity scheduled offline (still queued, no server id yet)", async () => {
    await seedActivityTypes();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_crm_activity_schedule_summary").edit("New follow-up");
    await contains(".o_crm_activity_schedule_button").click();

    expect(".o_crm_activity_panel_row").toHaveCount(1);
    expect(".o_crm_activity_panel_row .o_crm_activity_pending_sync").toHaveCount(1);
    // The queued, not-yet-synced row offers no Done control at all (it has
    // no server activity id to call action_done([[id]]) with).
    expect(".o_crm_activity_panel_row .o_crm_activity_done").toHaveCount(0);

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1); // the create only
});

// ---------------------------------------------------------------------------
// VAL-DATA-015: Log a call queues exactly one crm.lead.action_log_call.
// ---------------------------------------------------------------------------

test("offline, Log a call queues exactly one crm.lead.action_log_call, nothing else, and shows it marked pending sync", async () => {
    const { callId } = await seedActivityTypes();
    onRpc("mail.activity", "create", () => expect.step("mail.activity create"));
    onRpc("mail.activity", "action_done", () => expect.step("mail.activity action_done"));

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_crm_activity_log_call_summary").edit("Called the lead");
    await contains(".o_crm_activity_log_call_note").edit("Interested, call back later");
    await contains(".o_crm_activity_log_call_button").click();
    expect.verifySteps([]); // no separate mail.activity create/action_done queued

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("action_log_call");
    expect(value.args).toEqual([
        [1],
        callId,
        "Called the lead",
        "Interested, call back later",
        user.userId,
    ]);

    expect(".o_crm_activity_panel_row").toHaveCount(1);
    expect(".o_crm_activity_panel_row .o_crm_activity_pending_sync").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// VAL-DATA-016: queued activity calls replay on reconnect.
// ---------------------------------------------------------------------------

test("offline-queued create, action_done and action_log_call all replay verbatim on reconnect, and pending-sync marks disappear", async () => {
    const { pyEnv, callId } = await seedActivityTypes();
    const activityId = pyEnv["mail.activity"].create({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: callId,
        summary: "Existing activity",
    });
    pyEnv["crm.lead"].write([1], { activity_ids: [activityId] });

    onRpc("mail.activity", "create", function ({ args }) {
        expect.step("mail.activity create " + JSON.stringify(args));
        return this.env["mail.activity"].create(args[0][0]);
    });
    onRpc("mail.activity", "action_done", function ({ args }) {
        expect.step("mail.activity action_done " + JSON.stringify(args));
        this.env["mail.activity"].write(args[0], { active: false, state: "done" });
        return true;
    });
    onRpc("crm.lead", "action_log_call", function ({ args }) {
        expect.step("crm.lead action_log_call " + JSON.stringify(args));
        return true;
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // OfflinePlugin schedules a startup sync 3s after mount (offline_plugin.js's
    // constructor). Flush it now, while the queue is empty and it's a no-op: left
    // pending, it would fire during the runAllTimers() below and race the real
    // sync triggered by setOffline(false) (hoot's MockLockManager doesn't actually
    // serialize navigator.locks.request, so two concurrent _syncORM() runs can
    // interleave and replay an entry twice while skipping another).
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_crm_activity_schedule_summary").edit("New follow-up");
    await contains(".o_crm_activity_schedule_button").click();
    await contains(".o_crm_activity_panel_row .o_crm_activity_done").click(); // marks the existing activity done
    await contains(".o_crm_activity_log_call_summary").edit("Called");
    await contains(".o_crm_activity_log_call_button").click();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(3);
    expect(".o_crm_activity_panel_row .o_crm_activity_pending_sync").toHaveCount(3);

    await setOffline(false);
    // The sync loop waits 1s between each replayed call (offline_plugin.js). A single
    // runAllTimers() only advances to the furthest timer that already existed when it
    // was called; the wait before the 3rd call is scheduled only once the 2nd call's
    // RPC settles, i.e. after that first flush, so it needs its own runAllTimers() too.
    await runAllTimers();
    await runAllTimers();
    expect.verifySteps([
        "mail.activity create " +
            JSON.stringify([
                [
                    {
                        res_model: "crm.lead",
                        res_id: 1,
                        activity_type_id: callId,
                        summary: "New follow-up",
                        date_deadline: "2019-03-11",
                        user_id: user.userId,
                    },
                ],
            ]),
        "mail.activity action_done " + JSON.stringify([[activityId]]),
        "crm.lead action_log_call " + JSON.stringify([[1], callId, "Called", false, user.userId]),
    ]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_crm_activity_panel").toHaveCount(0); // back online: the panel itself disappears
});

// ---------------------------------------------------------------------------
// VAL-DATA-008: Won and the panel's producers are unavailable on a lead
// created offline (no server id yet).
// ---------------------------------------------------------------------------

test("offline, on a lead created offline, Won/Schedule/Log a call are disabled and queue nothing beyond the create itself", async () => {
    await seedActivityTypes();
    onRpc("crm.lead", "action_set_won", () => expect.step("action_set_won"));

    await mountWithCleanup(WebClient);
    await getService("action").doAction(2); // "New Opportunity": no res_id yet
    await contains(".o_field_widget[name='name'] input").edit("Brand new lead");

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Saving offline queues web_save (a create: resId stays falsy, the
    // framework assigns no local id -- see `record.js`'s `_offlineSave`).
    await contains(".o_form_button_save").click();
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1);
    expect(MockServer.env["crm.lead"].find((r) => r.name === "Brand new lead")).toBe(undefined);

    expect("button[name='action_set_won_rainbowman']").toHaveAttribute("disabled");
    expect(".o_crm_activity_schedule_button").toHaveAttribute("disabled");
    expect(".o_crm_activity_log_call_button").toHaveAttribute("disabled");

    await contains("button[name='action_set_won_rainbowman']").click();
    await contains(".o_crm_activity_schedule_button").click();
    await contains(".o_crm_activity_log_call_button").click();
    expect.verifySteps([]); // action_set_won never called

    // Still exactly the one queued create: nothing else got queued.
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1);
});
