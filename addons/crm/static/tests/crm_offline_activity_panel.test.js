import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { after, expect, runAllTimers, test } from "@odoo/hoot";
import { animationFrame, queryAllTexts, queryOne } from "@odoo/hoot-dom";
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
import { rpcBus } from "@web/core/network/rpc";
import { today } from "@web/core/l10n/dates";
import { user } from "@web/core/user";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

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
    // The lead's own salesperson (VAL-DATA-010): cached form data this
    // panel's assignee choice reads directly from `record.data.user_id`,
    // distinct from the `user_id` subfield of `activity_ids` below (that
    // one is an activity's own assignee, on `mail.activity`).
    user_id = fields.Many2one({ relation: "res.users" });
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
                        <!-- Rendered, not invisible="1": a statically
                             invisible many2one is fetched id-only
                             (relational_model/utils.js's getFieldsSpec,
                             the isAlwaysInvisible branch skips
                             display_name), unlike the real lead form
                             where this field is actually shown. -->
                        <field name="user_id"/>
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

    // VAL-DATA-010: `data-available-offline` is required on every usable
    // Schedule control, not just the Schedule button -- `OfflinePlugin`
    // only ever disables untagged `<button>`s (`SELECTORS_TO_DISABLE`), so
    // tagging the type/summary/deadline inputs and selects has no runtime
    // effect; this is a markup requirement, checked here directly, not
    // proof of a disabled-state toggle. `rpcBus`'s "RPC:REQUEST" (not a
    // model/method `onRpc()` listener, which never fires once offline --
    // see crm_offline_team_switcher.test.js:272-281) confirms Schedule
    // issues no onchange, no name_create and no mail.activity.schedule
    // wizard call, only the one create queued below.
    const requests = [];
    const onRequest = ({ detail }) => requests.push(detail.data.params);
    rpcBus.addEventListener("RPC:REQUEST", onRequest);
    after(() => rpcBus.removeEventListener("RPC:REQUEST", onRequest));

    const setOffline = mockCrmOffline();
    await setOffline(true);

    for (const selector of [
        ".o_crm_activity_schedule_type",
        ".o_crm_activity_schedule_user",
        ".o_crm_activity_schedule_summary",
        ".o_crm_activity_schedule_deadline",
        ".o_crm_activity_schedule_button",
    ]) {
        expect(selector).toHaveAttribute("data-available-offline");
        expect(selector).not.toHaveAttribute("disabled");
    }

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
    expect(requests.some((params) => params.method === "onchange")).toBe(false);
    expect(requests.some((params) => params.method === "name_create")).toBe(false);
    expect(requests.some((params) => params.model === "mail.activity.schedule")).toBe(false);

    expect(".o_crm_activity_panel_row").toHaveCount(1);
    expect(".o_crm_activity_panel_row .o_crm_activity_pending_sync").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// VAL-DATA-010: Schedule offers an assignee choice resolved from data
// already available offline -- the current user (default), the lead's own
// cached salesperson, and whatever `res.users` rows the framework's many2x
// cache already holds -- and queues the chosen assignee's user_id, not
// always the current user.
// ---------------------------------------------------------------------------

test("offline, Schedule's assignee choice lists the current user, the lead's cached salesperson and the many2x-cached res.users, and queues a non-default assignee", async () => {
    const { pyEnv, callId } = await seedActivityTypes();
    // `res.users.name` is a related field (-> `partner_id.name`): a
    // user's display name comes from its partner, not a direct `name`.
    const salespersonId = pyEnv["res.users"].create({
        partner_id: pyEnv["res.partner"].create({ name: "Team Lead" }),
    });
    pyEnv["crm.lead"].write([1], { user_id: salespersonId });
    const colleagueId = pyEnv["res.users"].create({
        partner_id: pyEnv["res.partner"].create({ name: "Office Colleague" }),
    });

    await mountWithCleanup(WebClient);

    // Seeded the same way an *earlier* online many2one search would
    // (`Many2XAutocomplete.search()` -> `OfflinePlugin.cacheMany2XSearch`,
    // the same framework API `crm_offline_contact_lookup.test.js` uses for
    // `res.partner`): this device never actually searched a `res.users`
    // many2one field in this test, but the fix reads the many2x cache
    // through that same existing API, not a direct IndexedDB write. Done
    // before `doAction` below, since the panel resolves its assignee list
    // once, in `onWillStart` -- exactly like a search that happened on an
    // earlier visit, before this lead's form was ever opened.
    const offlinePlugin = getService(OfflinePlugin);
    await offlinePlugin.cacheMany2XSearch("res.users", [
        { id: colleagueId, display_name: "Office Colleague" },
    ]);

    await getService("action").doAction(1); // online visit: loads the lead's own user_id

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Default: the current user, so Schedule stays usable with nothing
    // else cached (VAL-DATA-010's "current user as default").
    expect(".o_crm_activity_schedule_user").toHaveValue(String(user.userId));
    expect(".o_crm_activity_schedule_user").toHaveAttribute("data-available-offline");
    const assigneeOptions = queryAllTexts(".o_crm_activity_schedule_user option");
    expect([...assigneeOptions].sort()).toEqual(
        [user.name, "Team Lead", "Office Colleague"].sort()
    );

    await contains(".o_crm_activity_schedule_summary").edit("Follow up with the colleague");
    await contains(".o_crm_activity_schedule_user").select(String(colleagueId));
    await contains(".o_crm_activity_schedule_button").click();

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("mail.activity");
    expect(value.method).toBe("create");
    expect(value.args[0][0]).toEqual({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: callId,
        summary: "Follow up with the colleague",
        date_deadline: today().toISODate(),
        user_id: colleagueId, // not user.userId: the chosen, non-default assignee
    });

    expect(".o_crm_activity_panel_row .o_crm_activity_user").toHaveText("Office Colleague");
});

// ---------------------------------------------------------------------------
// VAL-DATA-010 regression (M3 scrutiny round 2, m3-fix-assignee-refresh):
// `_loadAssignableUsers` used to run only once, in `onWillStart`, so a
// colleague the many2x cache picked up *after* the form had already
// mounted online was missing from Schedule's assignee list once that same
// form later went offline (no remount in between). The fix recomputes the
// choice on every offline/online transition.
// ---------------------------------------------------------------------------

test("offline, a colleague cached by an online res.users search after the form mounted still appears in Schedule's assignee list, with no remount and no RPC", async () => {
    const { pyEnv, callId } = await seedActivityTypes();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1); // form mounts online: the panel resolves its first assignee list here

    // A colleague cached *after* the form already mounted -- e.g. by an
    // online `res.users` many2one autocomplete search elsewhere on this
    // same form (`Many2XAutocomplete.search()` ->
    // `OfflinePlugin.cacheMany2XSearch`, architecture.md §2
    // "Relational-field cache"). This is strictly later than the
    // `onWillStart` call above, which is exactly the defect this test
    // guards against.
    const colleagueId = pyEnv["res.users"].create({
        partner_id: pyEnv["res.partner"].create({ name: "Late Colleague" }),
    });
    await getService(OfflinePlugin).cacheMany2XSearch("res.users", [
        { id: colleagueId, display_name: "Late Colleague" },
    ]);

    // No model/method `onRpc()` listener below: once offline,
    // `mockCrmOffline()`'s network-wide route handler always wins route
    // dispatch over a model/method listener (see
    // crm_offline_cold_start.test.js / crm_offline_team_switcher.test.js),
    // so only `rpcBus`'s "RPC:REQUEST" event lets a "no RPC at all for
    // res.users" assertion hold for what follows.
    const resUsersCalls = [];
    const onRequest = ({ detail }) => {
        const { params } = detail.data;
        if (params.model === "res.users") {
            resUsersCalls.push(params.method);
        }
    };
    rpcBus.addEventListener("RPC:REQUEST", onRequest);
    after(() => rpcBus.removeEventListener("RPC:REQUEST", onRequest));

    const setOffline = mockCrmOffline();
    await setOffline(true); // same form instance, same panel: no remount

    const assigneeOptions = queryAllTexts(".o_crm_activity_schedule_user option");
    expect([...assigneeOptions].sort()).toEqual([user.name, "Late Colleague"].sort());
    expect(".o_crm_activity_schedule_user").toHaveValue(String(user.userId)); // default unchanged
    expect(".o_crm_activity_schedule_user").toHaveAttribute("data-available-offline");

    await contains(".o_crm_activity_schedule_summary").edit("Call the colleague back");
    await contains(".o_crm_activity_schedule_user").select(String(colleagueId));
    await contains(".o_crm_activity_schedule_button").click();

    expect(resUsersCalls).toEqual([]); // the recompute is a pure many2x-cache read, no RPC

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1); // exactly one call queued
    const [{ value }] = queued;
    expect(value.model).toBe("mail.activity");
    expect(value.method).toBe("create");
    expect(value.args[0][0]).toEqual({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: callId,
        summary: "Call the colleague back",
        date_deadline: today().toISODate(),
        user_id: colleagueId, // the colleague cached after mount, not the default current user
    });
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
    // VAL-DATA-020: Log a call only ever offers Call-category types, a
    // narrower exclusion than Schedule's (Email is a cached, non-excluded
    // type, but still not a Call).
    expect(logCallOptions).toEqual(["Call"]);
    expect(".o_crm_activity_panel:contains('Meeting')").toHaveCount(0);
    expect(".o_crm_activity_panel:contains('Upload Document')").toHaveCount(0);
    expect.verifySteps([]); // calendar path never reached, online or offline
});

// ---------------------------------------------------------------------------
// VAL-DATA-020: Log a call always uses a Call-category type, defaulting to
// and only offering one even when a non-Call type sorts first in the cache
// (the shipped data orders To-Do, sequence 2, before Call, sequence 6 --
// m3-activity-python's finding).
// ---------------------------------------------------------------------------

test("offline, Log a call always defaults to and only offers a Call-category type, even when a non-Call type is cached first", async () => {
    const pyEnv = await startServer();
    removeBaselineActivityTypes(pyEnv);
    const todoId = pyEnv["mail.activity.type"].create({ name: "To-Do" });
    const callId = pyEnv["mail.activity.type"].create({ name: "Call", category: "phonecall" });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Schedule is unaffected by this fix: every non-excluded cached type,
    // in cache order, still defaulting to the first one.
    expect(queryAllTexts(".o_crm_activity_schedule_type option")).toEqual(["To-Do", "Call"]);
    expect(".o_crm_activity_schedule_type").toHaveValue(String(todoId));

    // Log a call: only the Call type is offered, and it is the default --
    // the ordinary, unmodified click below queues it.
    expect(queryAllTexts(".o_crm_activity_log_call_type option")).toEqual(["Call"]);
    expect(".o_crm_activity_log_call_type").toHaveValue(String(callId));

    await contains(".o_crm_activity_log_call_button").click();
    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("action_log_call");
    expect(value.args[1]).toBe(callId); // the Call type id, never todoId
});

test("offline, with a cached activity type but no Call-category one, Log a call is disabled while Schedule stays usable", async () => {
    const pyEnv = await startServer();
    removeBaselineActivityTypes(pyEnv);
    pyEnv["mail.activity.type"].create({ name: "To-Do" });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_crm_activity_schedule_button").not.toHaveAttribute("disabled");
    expect(".o_crm_activity_log_call_button").toHaveAttribute("disabled");
    expect(".o_crm_activity_log_call_type").toHaveAttribute("disabled");
    expect(queryAllTexts(".o_crm_activity_log_call_type option")).toEqual([]);

    await contains(".o_crm_activity_log_call_button").click();
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
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

    // VAL-DATA-010: Log a call's fields are also "usable Schedule/Log-a-call
    // controls" under the panel's "each usable control" wording.
    for (const selector of [
        ".o_crm_activity_log_call_type",
        ".o_crm_activity_log_call_summary",
        ".o_crm_activity_log_call_note",
        ".o_crm_activity_log_call_button",
    ]) {
        expect(selector).toHaveAttribute("data-available-offline");
        expect(selector).not.toHaveAttribute("disabled");
    }

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
    // sync triggered by setOffline(false) (hoot's mocked cross-tab lock manager
    // doesn't actually serialize the two tabs' sync requests the way a real
    // browser's does, so two concurrent _syncORM() runs can interleave and
    // replay an entry twice while skipping another).
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
// VAL-DATA-017 (m3-closeout): the systray's label patch
// (offline_systray_patch.js) was proved against entries seeded directly
// with `scheduleORM` (crm_offline_systray_restore.test.js's "the systray
// labels every CRM-queued method without crashing" tests, VAL-QUEUE-004).
// This test queues the same four methods through their real milestone-3
// producers instead -- the Won button, and this panel's own Schedule,
// Done and Log a call controls -- to prove the extras shape those
// producers actually build (`getScheduleORMExtras` via `queueCall`/
// `_queueLeadCallOffline`) is what the patch expects, not just the shape
// a hand-built scheduleORM() call happens to have.
// ---------------------------------------------------------------------------

test("the systray shows real milestone-3 producers (Won, Schedule, Done, Log a call) with their labels, with no crash", async () => {
    const { pyEnv, callId } = await seedActivityTypes();
    const activityId = pyEnv["mail.activity"].create({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: callId,
        summary: "Existing activity",
    });
    pyEnv["crm.lead"].write([1], { activity_ids: [activityId] });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless startup sync (3s after mount, offline_plugin.js's
    // constructor) now, while the queue is empty, so it can't race the four
    // producers queued below once mockCrmOffline's fake timers are in play.
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Schedule -> mail.activity create (CrmLeadActivityPanel.onClickSchedule)
    await contains(".o_crm_activity_schedule_summary").edit("New follow-up");
    await contains(".o_crm_activity_schedule_button").click();
    // Done, on the pre-existing server activity -> mail.activity action_done
    // (the newly scheduled row above offers no Done control, VAL-DATA-014,
    // so this still targets exactly one element).
    await contains(".o_crm_activity_panel_row .o_crm_activity_done").click();
    // Log a call -> crm.lead action_log_call (CrmLeadActivityPanel.onClickLogCall)
    await contains(".o_crm_activity_log_call_summary").edit("Called the lead");
    await contains(".o_crm_activity_log_call_button").click();
    // Won -> crm.lead action_set_won (CrmFormController._queueWonOffline)
    await contains("button[name='action_set_won_rainbowman']").click();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(4);

    await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
    await animationFrame(); // mobile's toggler is a bare div, not the Dropdown's own button
    expect(".o-dropdown--menu").toHaveCount(1); // opens without the addons/web crash (architecture.md §3.2 item 11)

    const labels = queryAllTexts(".o-dropdown--menu .o-dropdown-item div.ms-auto");
    expect(labels.length).toBe(4);
    expect([...labels].sort()).toEqual(
        ["Activity done", "Activity scheduled", "Call logged", "Won"].sort()
    );
});

// ---------------------------------------------------------------------------
// VAL-CROSS-001 (m3-closeout): mixed producers on one lead replay in order.
// A form edit (the framework's own `web_save` producer), an activity
// schedule (`mail.activity.create`, this panel's own producer) and
// mark-won (`action_set_won`, `CrmFormController`'s own producer) are
// queued in that order within one offline session on one lead; on
// reconnect the three RPCs must run in the same order, and both the queue
// and the systray must end up empty.
// ---------------------------------------------------------------------------

test("mixed producers on one lead (form edit, activity schedule, mark-won) replay in order", async () => {
    await seedActivityTypes();
    const steps = [];
    onRpc("crm.lead", "web_save", ({ parent }) => {
        steps.push("web_save");
        return parent();
    });
    onRpc("mail.activity", "create", function ({ args }) {
        steps.push("mail.activity create");
        return this.env["mail.activity"].create(args[0][0]);
    });
    onRpc("crm.lead", "action_set_won", function ({ args }) {
        steps.push("action_set_won");
        this.env["crm.lead"].write(args[0], { won_status: "won" });
        return true;
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers(); // flush the startup sync, same reasoning as the test above

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // 1. a form edit, saved explicitly -> queues web_save (the framework's
    // own producer, record.js's `_offlineSave`; crm adds nothing here).
    await contains(".o_field_widget[name='name'] input").edit("Edited offline");
    await contains(".o_form_button_save").click();

    // 2. an activity schedule -> queues mail.activity.create.
    // `onClickSchedule` never saves the record itself, so this cannot
    // reorder the edit queued just above.
    await contains(".o_crm_activity_schedule_summary").edit("Follow up");
    await contains(".o_crm_activity_schedule_button").click();

    // 3. mark-won. The form is clean again after step 1's save, so
    // `beforeExecuteActionButton`'s own `record.save()` call resolves
    // true without queuing a second web_save; only action_set_won is added.
    await contains("button[name='action_set_won_rainbowman']").click();

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(3);

    await setOffline(false);
    // Two 1s pauses between the three replayed calls (offline_plugin.js's
    // `_syncORM`); the same two-runAllTimers() idiom the activity-replay
    // test above uses for its own three queued entries.
    await runAllTimers();
    await runAllTimers();

    expect(steps).toEqual(["web_save", "mail.activity create", "action_set_won"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    // The systray's own Dropdown only renders while offline or while
    // something is still queued (offline_systray.xml); online with an
    // empty queue, it is gone entirely, not just empty-looking.
    expect(".o_menu_systray .o_offline_systray").toHaveCount(0);
    // Back online: the panel itself disappears (VAL-DATA-009), taking
    // every "pending sync" mark with it.
    expect(".o_crm_activity_panel").toHaveCount(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).won_status).toBe("won");
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
