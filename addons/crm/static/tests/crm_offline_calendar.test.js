import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame, click, queryFirst, waitFor } from "@odoo/hoot-dom";
import { mockDate } from "@odoo/hoot-mock";
import {
    defineActions,
    defineModels,
    fields,
    getService,
    mockOffline,
    models,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";

/**
 * VAL-DIS-008 (B82): every click path that opens a calendar event (single
 * click into the popover's own "Edit" link, double-click, the side panel,
 * the year view) funnels through `CalendarController.editRecord`, guarded
 * once there (`crm_calendar_controller.js`) instead of in each renderer.
 * Neither the real `crm.lead` calendar arch nor this test's arch sets
 * `event_open_popup`, so `hasEditDialog` is false and `editRecord` takes
 * its non-dialog branch: a brand-new, id-less `ir.actions.act_window`
 * handed to `doAction`
 * (`addons/web/static/src/views/calendar/calendar_controller.js`), which
 * needs a real action manager -- a bare `mountView` has none, so this
 * suite mounts the full `WebClient` and reaches the calendar through
 * `doAction`, the same idiom `crm_offline_uncached_lead.test.js` and
 * `window_action.test.js`'s "[Offline] navigate through window actions"
 * use for other id-less or never-before-loaded actions.
 *
 * These tests reach `editRecord` through a double-click
 * (`calendar_common_renderer.js`'s `onEventClick`: a second click fired
 * before the first click's 250ms debounce elapses is treated as a
 * double-click and calls `onDblClick` -> `editRecord` directly), not
 * through the single-click popover. A single click opens
 * `CalendarCommonPopover`, which wraps a `CardPopover`
 * (`addons/web/static/src/views/card/card_popover/card_popover.js`) that
 * independently loads the record via its own `web_read` to render the
 * card -- a genuine, pre-existing (non-crm) network call that fails
 * offline for any resId with no real disk cache, regardless of this
 * guard, and prevents the popover itself from ever opening. Routing
 * through the popover would therefore test `CardPopover`'s own offline
 * behavior, not `editRecord`'s guard. The double-click path has no such
 * prerequisite read, so it isolates the guard precisely.
 *
 * Unlike the kanban/list `openRecord` guard
 * (`crm_offline_uncached_lead.test.js`), there is no reachable crm UI path
 * that genuinely visits a lead's form *through the calendar's own action*:
 * the ad hoc action `editRecord` builds has no `id`, so nothing durably
 * marks it "visited" and nothing pre-populates its own `web_read`'s disk
 * cache either way. `isAvailableOffline` is faked instead, to exercise the
 * gate itself (the same idiom the library notes sanction for a search
 * state no crm UI path can reach, e.g. crm_offline_team_switcher.test.js).
 * Because nothing genuinely populates the form's own disk cache either,
 * "available" offline still genuinely attempts (and loses) its `web_read`
 * -- there is no cache entry to win the race, unlike
 * crm_offline_uncached_lead.test.js's "visited" lead.
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
        views: [[false, "calendar"]],
    },
]);

const WEB_READ_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/web_read" couldn't be established or was interrupted`;
// The ad hoc action `editRecord` builds has no `id`, so its `get_views` is
// never pre-cached either (unlike a real, registered action's), and that
// is the very first call it makes -- it never gets as far as `web_read`.
const GET_VIEWS_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/get_views" couldn't be established or was interrupted`;
// Restoring the calendar after the ad hoc action fails also genuinely
// retries its own reload (the same pattern crm_offline_uncached_lead.
// test.js's "revisiting an already-visited kanban/list" comment notes).
const SEARCH_READ_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/search_read" couldn't be established or was interrupted`;

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
    patchWithCleanup(OfflinePlugin.prototype, {
        isAvailableOffline(actionId, viewType, resId) {
            return viewType === "form" && resId === 1;
        },
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
}

test.tags("desktop");
test("offline, double-clicking an unvisited lead's event does nothing; online it still opens the form (desktop)", async () => {
    onRpc("crm.lead", "web_read", () => expect.step("web_read"));
    await mountCalendar();
    expect(".fc-event").toHaveCount(2);

    const setOffline = mockOffline();
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

    const setOffline = mockOffline();
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
test("offline, double-clicking an available-offline lead's event still genuinely attempts its own action and loses the race (desktop)", async () => {
    onRpc("crm.lead", "get_views", () => expect.step("get_views"));
    await mountCalendar();

    const setOffline = mockOffline();
    await setOffline(true);

    // `isAvailableOffline` is faked to pass the gate, but this ad hoc
    // action was never actually cached, so its very first call --
    // `get_views`, since it has no `id` to load by -- genuinely fails and
    // architecture.md §2's silent-restore leaves the calendar mounted, not
    // a form. It never gets as far as `web_read`. Restoring the calendar
    // also genuinely retries its own `search_read`, which fails too.
    expect.errors(2);
    await doubleClickEvent(1);
    await waitFor(".fc-event"); // back on the calendar, not stuck
    await animationFrame(); // let the trailing error finish logging
    expect(".fc-event").toHaveCount(2);
    expect(".o_form_view").toHaveCount(0);
    expect.verifySteps(["get_views"]);
    expect.verifyErrors([GET_VIEWS_ERROR, SEARCH_READ_ERROR]);
});

test.tags("mobile");
test("offline, double-clicking an available-offline lead's event still genuinely attempts its own action and loses the race (mobile)", async () => {
    onRpc("crm.lead", "get_views", () => expect.step("get_views"));
    await mountCalendar();

    const setOffline = mockOffline();
    await setOffline(true);

    expect.errors(2);
    await doubleClickEvent(1);
    await waitFor(".fc-event");
    await animationFrame();
    expect(".fc-event").toHaveCount(2);
    expect(".o_form_view").toHaveCount(0);
    expect.verifySteps(["get_views"]);
    expect.verifyErrors([GET_VIEWS_ERROR, SEARCH_READ_ERROR]);
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
