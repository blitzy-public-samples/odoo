import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { click, queryFirst, waitFor } from "@odoo/hoot-dom";
import { advanceTime, mockDate } from "@odoo/hoot-mock";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * VAL-DIS-008 (B82): every click path that opens a calendar event (single
 * click into the popover's own "Edit" link, double-click, the side panel,
 * the year view) funnels through `CalendarController.editRecord`, guarded
 * once there (`crm_calendar_controller.js`) instead of in each renderer.
 * Neither the real `crm.lead` calendar arch nor this test's arch sets
 * `event_open_popup`, so `hasEditDialog` is false and `editRecord` takes
 * its non-dialog branch, which this fix now routes through
 * `this.action.switchView("form", {...})` while offline instead of the
 * upstream `doAction` of a brand-new, id-less `ir.actions.act_window`
 * (`addons/web/static/src/views/calendar/calendar_controller.js`), which
 * needs a real action manager -- a bare `mountView` has none, so this
 * suite mounts the full `WebClient` and reaches the calendar through
 * `doAction`, the same idiom `crm_offline_uncached_lead.test.js` and
 * `window_action.test.js`'s "[Offline] navigate through window actions"
 * use for other id-less or never-before-loaded actions.
 *
 * The `editRecord` tests below reach it through a double-click
 * (`calendar_common_renderer.js`'s `onEventClick`: a second click fired
 * before the first click's 250ms debounce elapses is treated as a
 * double-click and calls `onDblClick` -> `editRecord` directly), not
 * through the single-click popover -- that isolates `editRecord`'s own
 * guard from whatever a single click does.
 *
 * A single click is a *different*, independently-guarded path (scrutiny
 * finding 23): `onEventClick`'s single-click branch calls `onClick` ->
 * `openPopover` directly, never `editRecord`. Unguarded, that mounts
 * `CalendarCommonPopover`, which wraps a `CardPopover`
 * (`addons/web/static/src/views/card/card_popover/card_popover.js`) whose
 * own standalone `Record` independently issues a bare `web_read` with no
 * offline cache of its own. `calendar_common_renderer_patch.js` (scoped to
 * `crm.lead`) blocks `openPopover` itself for an unavailable lead, before
 * `CardPopover` is ever mounted and before its `web_read` is ever
 * attempted -- unlike the double-click path, there is no cache-race to
 * declare here: the single-click tests below assert zero RPCs and no
 * popover at all for an unvisited lead.
 *
 * "Visited online" (the real QA scenario: open the lead from the
 * pipeline, then switch to Calendar) means the lead's form was opened
 * through *this same action* (`crm_lead_action_pipeline` has `calendar`
 * and `form` both on one action record, so the actionId is identical
 * whichever view you reach the form from). `OfflinePlugin.isAvailableOffline`
 * is keyed on `actionId`, so faking it without also genuinely switching
 * to the form view first would leave the "available" check lying to the
 * UI while nothing actually populated the disk cache -- the same trap
 * `crm_offline_uncached_lead.test.js`'s module comment warns against. This
 * suite instead performs a real `switchView("form", {resId})` on the
 * calendar's own action to visit the lead, then returns to the calendar,
 * before going offline -- the same genuine-visit idiom, applied through
 * the action rather than through a kanban/list click (this suite's arch
 * has no kanban/list of its own).
 *
 * Like `crm_offline_uncached_lead.test.js`'s "visited" kanban/list case, a
 * genuinely cached record's `web_read` is still attempted over the real
 * network when reopened, and that attempt still loses the race to the
 * local answer: the mock server's own `web_read` handler is never reached
 * while offline (so no "web_read" step is recorded for it, confirmed
 * below), yet the client-side call still rejects with a genuine
 * `ConnectionLostError`, which every "visited" test below declares with
 * `expect.errors(1)` and verifies. What the fix changes is only that the
 * form opens and renders the lead's data correctly despite that losing
 * attempt, with no error dialog, no notification, and no other uncaught
 * error -- exactly architecture.md §2's cache race, applied through the
 * calendar's own action instead of an orphaned one.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    date_deadline = fields.Date();

    _records = [
        { id: 1, name: "Available Lead", date_deadline: "2024-01-10" },
        { id: 2, name: "Never Visited Lead", date_deadline: "2024-01-12" },
    ];

    _views = {
        calendar: `
            <calendar js_class="crm_calendar" date_start="date_deadline" mode="month">
                <field name="name"/>
            </calendar>`,
        form: `<form><field name="name"/></form>`,
    };
}

defineModels([Lead]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Leads Calendar",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        // Both views on one action, like the real `crm_lead_action_pipeline`
        // (`kanban,list,graph,pivot,form,calendar,activity`): visiting the
        // form through this action, from any of its views, shares the one
        // `actionId` offline availability is keyed on.
        views: [
            [false, "calendar"],
            [false, "form"],
        ],
    },
]);

const WEB_READ_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/web_read" couldn't be established or was interrupted`;

// `.o_event`'s own harness sits off the viewport's visible top in month
// view; fullcalendar's hit-testing needs the element actually scrolled
// into view first, the same idiom calendar_test_helpers.js's `clickEvent`
// uses (`instantScrollTo` before `click`), or the click lands with no
// effect at all. Clicking twice back-to-back (no wait in between) is a
// double-click: the renderer's own 250ms single-click debounce
// (`onEventClick`) never gets a chance to fire, so the single-click
// popover (and its `CardPopover` prerequisite read) is never involved.
async function doubleClickEvent(resId) {
    const eventEl = queryFirst(`.o_event[data-event-id='${resId}']`);
    eventEl.scrollIntoView({ behavior: "instant", block: "center" });
    await click(eventEl);
    await click(eventEl);
}

// A genuine single click: unlike `doubleClickEvent` above, this waits out
// `onEventClick`'s 250ms single-click debounce so it fires `onClick` ->
// `openPopover`, never `onDblClick`/`editRecord`.
async function singleClickEvent(resId) {
    const eventEl = queryFirst(`.o_event[data-event-id='${resId}']`);
    eventEl.scrollIntoView({ behavior: "instant", block: "center" });
    await click(eventEl);
    await advanceTime(260);
}

// `CalendarController.editRecord`'s non-dialog branch
// (`addons/web/.../calendar_controller.js`) calls `this.action.doAction(action)`
// without returning or awaiting it, so awaiting a double-click resolves
// before `doAction`'s own RPCs (`get_views`, `web_read`) have even been
// issued. Asserting against a count-based matcher first (it polls instead
// of checking once) lets that fire-and-forget settle before the
// `verifySteps`/`verifyErrors` checks run, which don't poll.

async function mountCalendar() {
    // The month view's default range follows "today"; without pinning it,
    // the leads' January 2024 `date_deadline`s would fall outside
    // whatever month the real clock happens to be in and no `.fc-event`
    // would render at all (same idiom as calendar_view.test.js's own
    // `beforeEach`).
    mockDate("2024-01-15 10:00:00");
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
}

// Genuinely visits lead `resId`'s form *through the calendar's own action*
// (the same `switchView` call the fix now also makes), then returns to the
// calendar -- the one real way `isAvailableOffline(actionId, "form", resId)`
// becomes true for this actionId, matching how visiting the same lead from
// the pipeline kanban/list (another view of the very same action) would.
async function visitLeadFormThenReturnToCalendar(resId) {
    await getService("action").switchView("form", { resId, resIds: [1, 2] });
    await waitFor(".o_form_view");
    expect(".o_form_view").toHaveCount(1);
    // Consumes this online visit's own "web_read" step so the caller's
    // later checks only see what the offline reopen itself produces.
    expect.verifySteps(["web_read"]);
    await contains(".o_breadcrumb .o_back_button").click();
    await waitFor(".o_calendar_view");
    expect(".o_calendar_view").toHaveCount(1);
}

test.tags("desktop");
test("offline, double-clicking an unvisited lead's event does nothing; online it still opens the form (desktop)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();
    expect(".fc-event").toHaveCount(2);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // The guard short-circuits before `super.editRecord`, so nothing
    // navigates and the calendar stays mounted. Nothing async is pending
    // here (the guard returns synchronously), so no polling wait needed.
    await doubleClickEvent(2);
    expect.verifySteps([]); // unreachable: no navigation, no RPC at all
    expect(".o_form_view").toHaveCount(0);
    expect(".fc-event").toHaveCount(2);

    await setOffline(false);
    await doubleClickEvent(2);
    await waitFor(".o_form_view");
    expect(".o_form_view").toHaveCount(1);
    expect.verifySteps(["web_read"]);
});

test.tags("mobile");
test("offline, double-clicking an unvisited lead's event does nothing (mobile)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await doubleClickEvent(2);
    expect.verifySteps([]);
    expect(".o_form_view").toHaveCount(0);
});

test.tags("desktop");
test("online, double-clicking an unvisited lead's event opens it (desktop)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();

    await doubleClickEvent(2);
    await waitFor(".o_form_view");
    expect(".o_form_view").toHaveCount(1);
    expect.verifySteps(["web_read"]);
});

test.tags("desktop");
test("offline, double-clicking a lead's event visited online through the same action opens its form (desktop)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();
    await visitLeadFormThenReturnToCalendar(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Fixed: `editRecord` now routes through `this.action.switchView`
    // instead of an id-less ad hoc action, so this reopens the very same
    // action/viewType/resId already visited above and the form renders
    // the cached value. `web_read` is still genuinely attempted over the
    // real network and still loses that race (it never reaches the mock
    // server's handler while offline, so no further "web_read" step is
    // recorded for it), so one `ConnectionLostError` is declared and
    // verified; no other error, and no error dialog or notification is
    // shown to the user.
    expect.errors(1);
    await doubleClickEvent(1);
    await waitFor(".o_form_view");
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Available Lead");
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);
    expect.verifyErrors([WEB_READ_ERROR]);
});

test.tags("mobile");
test("offline, double-clicking a lead's event visited online through the same action opens its form (mobile)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();
    await visitLeadFormThenReturnToCalendar(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect.errors(1);
    await doubleClickEvent(1);
    await waitFor(".o_form_view");
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Available Lead");
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);
    expect.verifyErrors([WEB_READ_ERROR]);
});

test.tags("desktop");
test("online, double-clicking an available lead's event opens it (desktop)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();

    await doubleClickEvent(1);
    await waitFor(".o_form_view");
    expect(".o_form_view").toHaveCount(1);
    expect.verifySteps(["web_read"]);
});

// ---------------------------------------------------------------------------
// Scrutiny finding 23 (VAL-DIS-008): single-clicking an event takes the
// `openPopover` path, never `editRecord` -- the tests above never
// exercise it. `calendar_common_renderer_patch.js` routes it through
// `editRecord` instead while offline, so an unvisited lead does nothing
// (no popover, no read) and a visited one opens its form instead of the
// popover's always-failing read.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, single-clicking an unvisited lead's event mounts no popover and issues no read; online it still opens the popover (desktop)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();
    expect(".fc-event").toHaveCount(2);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await singleClickEvent(2);
    expect.verifySteps([]); // unreachable: no popover, no RPC at all
    expect(".o_popover").toHaveCount(0);
    expect(".o_form_view").toHaveCount(0);

    await setOffline(false);
    await singleClickEvent(2);
    expect(".o_popover").toHaveCount(1);
    expect.verifySteps(["web_read"]);
});

test.tags("mobile");
test("offline, single-clicking an unvisited lead's event mounts no popover and issues no read (mobile)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await singleClickEvent(2);
    expect.verifySteps([]);
    expect(".o_popover").toHaveCount(0);
    expect(".o_form_view").toHaveCount(0);
});

test.tags("desktop");
test("online, single-clicking an unvisited lead's event opens the popover (desktop)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();

    await singleClickEvent(2);
    expect(".o_popover").toHaveCount(1);
    expect.verifySteps(["web_read"]);
});

test.tags("desktop");
test("offline, single-clicking a lead's event visited online through the same action opens its form instead of the popover (desktop)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();
    await visitLeadFormThenReturnToCalendar(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Same cache-race as the double-click "visited" tests above: `editRecord`
    // still genuinely attempts `web_read` over the real network and still
    // loses that race, so one `ConnectionLostError` is declared.
    expect.errors(1);
    await singleClickEvent(1);
    await waitFor(".o_form_view");
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Available Lead");
    expect(".o_popover").toHaveCount(0); // opened through the form, not the popover
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);
    expect.verifyErrors([WEB_READ_ERROR]);
});

test.tags("mobile");
test("offline, single-clicking a lead's event visited online through the same action opens its form instead of the popover (mobile)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();
    await visitLeadFormThenReturnToCalendar(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect.errors(1);
    await singleClickEvent(1);
    await waitFor(".o_form_view");
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Available Lead");
    expect(".o_popover").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
    expect.verifySteps([]);
    expect.verifyErrors([WEB_READ_ERROR]);
});
