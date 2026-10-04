import { animationFrame, expect, test } from "@odoo/hoot";
import { Component, useProps, xml } from "@odoo/owl";
import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    getService,
    mockOffline,
    mountWithCleanup,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

defineMailModels();

class IsOfflineComponent extends Component {
    static template = xml`<span class="o_is_offline" t-esc="this.crmOffline.isOffline()"/>`;
    setup() {
        this.crmOffline = useCrmOffline();
    }
}

class AvailabilityComponent extends Component {
    static template = xml`
        <div>
            <span class="o_available_cached" t-esc="this.crmOffline.isLeadAvailableOffline(1, 42)"/>
            <span class="o_available_uncached" t-esc="this.crmOffline.isLeadAvailableOffline(1, 99)"/>
        </div>`;
    setup() {
        this.crmOffline = useCrmOffline();
    }
}

class QueueComponent extends Component {
    static template = xml`<button class="o_queue_call" t-on-click="() => this.onQueueCall()">Queue</button>`;
    setup() {
        this.crmOffline = useCrmOffline();
    }
    onQueueCall() {
        this.crmOffline.queueCall("crm.lead", "action_set_won", [[1]], { context: { a: 1 } }, {
            actionName: "Won",
        });
    }
}

test("useCrmOffline.isOffline() mirrors OfflinePlugin.isOffline()", async () => {
    const setOffline = mockOffline();
    await mountWithCleanup(IsOfflineComponent);
    expect(".o_is_offline").toHaveText("false");

    await setOffline(true);
    expect(".o_is_offline").toHaveText("true");

    await setOffline(false);
    expect(".o_is_offline").toHaveText("false");
});

test("useCrmOffline.isLeadAvailableOffline is gated on isOffline() and mirrors the plugin's cache", async () => {
    // Only record 42 of action 1 is "visited" (cached); isAvailableOffline
    // is only meaningful while offline (architecture.md §2), so the guard
    // must short-circuit to true while online regardless of the cache.
    patchWithCleanup(OfflinePlugin.prototype, {
        isAvailableOffline(actionId, viewType, resId) {
            return actionId === 1 && viewType === "form" && resId === 42;
        },
    });
    const setOffline = mockOffline();
    await mountWithCleanup(AvailabilityComponent);
    expect(".o_available_cached").toHaveText("true");
    expect(".o_available_uncached").toHaveText("true");

    await setOffline(true);
    expect(".o_available_cached").toHaveText("true");
    expect(".o_available_uncached").toHaveText("false");
});

test("useCrmOffline.queueCall schedules a verbatim ORM call tagged with a timeStamp", async () => {
    await mountWithCleanup(QueueComponent);
    await contains(".o_queue_call").click();

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("action_set_won");
    expect(value.args).toEqual([[1]]);
    expect(value.kwargs).toEqual({ context: { a: 1 } });
    expect(value.extras.actionName).toBe("Won");
    expect(typeof value.extras.timeStamp).toBe("number");
});

/**
 * m3-activity-panel (architecture.md §3.1, VAL-DATA-009/013/015): the
 * offline activity panel needs to tell apart, among everything queued,
 * which entries belong to one particular lead -- a queued `mail.activity`
 * `create` or `crm.lead` `action_log_call` names the lead directly, but a
 * bare `action_done([[id]])` only names the activity, so the caller must
 * pass in the ids it already knows are this lead's own activities.
 */
class PendingActivitiesComponent extends Component {
    static template = xml`<span class="o_pending_activities" t-esc="this.kinds"/>`;
    props = useProps();

    setup() {
        this.crmOffline = useCrmOffline();
    }
    get kinds() {
        return JSON.stringify(
            this.crmOffline
                .pendingActivities(this.props.leadId, this.props.activityIds || [])
                .map((e) => e.kind)
        );
    }
}

test("useCrmOffline.pendingActivities finds queued mail.activity.create and crm.lead.action_log_call by lead id", async () => {
    await mountWithCleanup(PendingActivitiesComponent, { props: { leadId: 7 } });
    expect(".o_pending_activities").toHaveText("[]");

    const offlinePlugin = getService(OfflinePlugin);
    offlinePlugin.scheduleORM(
        "mail.activity",
        "create",
        [[{ res_model: "crm.lead", res_id: 7, activity_type_id: 1, summary: "Call back" }]],
        {},
        { extras: { timeStamp: Date.now() } }
    );
    // Targets a different lead: must not match.
    offlinePlugin.scheduleORM(
        "mail.activity",
        "create",
        [[{ res_model: "crm.lead", res_id: 99, activity_type_id: 1 }]],
        {},
        { extras: { timeStamp: Date.now() } }
    );
    offlinePlugin.scheduleORM(
        "crm.lead",
        "action_log_call",
        [[7], 2, "Called", "Interested", 1],
        {},
        { extras: { timeStamp: Date.now() } }
    );
    await animationFrame();
    expect(".o_pending_activities").toHaveText(JSON.stringify(["create", "log_call"]));
});

test("useCrmOffline.pendingActivities only matches action_done entries among the given activityIds", async () => {
    await mountWithCleanup(PendingActivitiesComponent, { props: { leadId: 7, activityIds: [42] } });
    expect(".o_pending_activities").toHaveText("[]");

    const offlinePlugin = getService(OfflinePlugin);
    offlinePlugin.scheduleORM("mail.activity", "action_done", [[42]], {}, {
        extras: { timeStamp: Date.now() },
    });
    offlinePlugin.scheduleORM("mail.activity", "action_done", [[55]], {}, {
        extras: { timeStamp: Date.now() },
    });
    await animationFrame();
    expect(".o_pending_activities").toHaveText(JSON.stringify(["done"])); // only 42, not 55
});

/**
 * m4-hooks (architecture.md §3.1, VAL-MOBILE-001/008): the mobile card's
 * pending-sync badge needs one answer per lead -- "is there any queued
 * write that touches this lead at all" -- without the caller having to
 * know which methods crm might queue for it.
 */
class PendingForLeadComponent extends Component {
    static template = xml`<span class="o_pending_for_lead" t-esc="this.methods"/>`;
    props = useProps();

    setup() {
        this.crmOffline = useCrmOffline();
    }
    get methods() {
        return JSON.stringify(
            this.crmOffline.pendingForLead(this.props.leadId).map((e) => e.value.method)
        );
    }
}

test("useCrmOffline.pendingForLead finds every queued crm.lead call naming the id, and matching mail.activity creates", async () => {
    await mountWithCleanup(PendingForLeadComponent, { props: { leadId: 7 } });
    expect(".o_pending_for_lead").toHaveText("[]");

    const offlinePlugin = getService(OfflinePlugin);
    // web_save on the lead itself: args[0] = [7].
    offlinePlugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[7], { priority: "2" }],
        { context: {}, specification: {} },
        { extras: { timeStamp: Date.now() } }
    );
    // action_log_call also names the lead in args[0] = [7].
    offlinePlugin.scheduleORM(
        "crm.lead",
        "action_log_call",
        [[7], 2, "Called", "Interested", 1],
        {},
        { extras: { timeStamp: Date.now() } }
    );
    // A queued create for a *different* lead must not match.
    offlinePlugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[99], { priority: "2" }],
        { context: {}, specification: {} },
        { extras: { timeStamp: Date.now() } }
    );
    // A queued mail.activity create naming this lead in its vals, not args[0].
    offlinePlugin.scheduleORM(
        "mail.activity",
        "create",
        [[{ res_model: "crm.lead", res_id: 7, activity_type_id: 1 }]],
        {},
        { extras: { timeStamp: Date.now() } }
    );
    await animationFrame();
    expect(".o_pending_for_lead").toHaveText(
        JSON.stringify(["web_save", "action_log_call", "create"])
    );
});

test("useCrmOffline.pendingForLead does not match a bare mail.activity.action_done (no lead id in args)", async () => {
    await mountWithCleanup(PendingForLeadComponent, { props: { leadId: 7 } });

    const offlinePlugin = getService(OfflinePlugin);
    offlinePlugin.scheduleORM("mail.activity", "action_done", [[42]], {}, {
        extras: { timeStamp: Date.now() },
    });
    await animationFrame();
    // action_done([[activityId]]) carries no lead id: pendingForLead can't
    // attribute it to lead 7 (callers needing that use pendingActivities
    // with their own known activity ids instead).
    expect(".o_pending_for_lead").toHaveText("[]");
});

/**
 * m4-hooks (architecture.md §3.1/§3.4, VAL-MOBILE-008): the mobile
 * pipeline shows a pending-sync card per stage for leads created offline,
 * which have no id yet -- `args[0] = []` is the producer's own signal for
 * a create (`record.js` `_offlineSave`), so this reads that shape instead
 * of guessing from the vals.
 */
class PendingLeadCreatesComponent extends Component {
    static template = xml`
        <div>
            <span class="o_pending_lead_creates_all" t-esc="this.namesFor(undefined)"/>
            <span class="o_pending_lead_creates_stage1" t-esc="this.namesFor(1)"/>
            <span class="o_pending_lead_creates_stage2" t-esc="this.namesFor(2)"/>
        </div>`;

    setup() {
        this.crmOffline = useCrmOffline();
    }
    namesFor(stageId) {
        return JSON.stringify(
            this.crmOffline.pendingLeadCreates(stageId).map((e) => e.value.args[1].name)
        );
    }
}

test("useCrmOffline.pendingLeadCreates finds queued crm.lead creates, optionally narrowed to one stage", async () => {
    await mountWithCleanup(PendingLeadCreatesComponent);
    expect(".o_pending_lead_creates_all").toHaveText("[]");
    expect(".o_pending_lead_creates_stage1").toHaveText("[]");
    expect(".o_pending_lead_creates_stage2").toHaveText("[]");

    const offlinePlugin = getService(OfflinePlugin);
    offlinePlugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[], { name: "New Lead A", stage_id: 1 }],
        { context: {}, specification: {} },
        { extras: { timeStamp: Date.now() } }
    );
    offlinePlugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[], { name: "New Lead B", stage_id: 2 }],
        { context: {}, specification: {} },
        { extras: { timeStamp: Date.now() } }
    );
    // An edit of an *existing* lead (args[0] = [id], not []) must not be
    // mistaken for a create.
    offlinePlugin.scheduleORM(
        "crm.lead",
        "web_save",
        [[7], { stage_id: 1 }],
        { context: {}, specification: {} },
        { extras: { timeStamp: Date.now() } }
    );
    await animationFrame();
    // No stageId: every queued create regardless of stage.
    expect(".o_pending_lead_creates_all").toHaveText(JSON.stringify(["New Lead A", "New Lead B"]));
    // Narrowed to stage 1 or stage 2: only that stage's create.
    expect(".o_pending_lead_creates_stage1").toHaveText(JSON.stringify(["New Lead A"]));
    expect(".o_pending_lead_creates_stage2").toHaveText(JSON.stringify(["New Lead B"]));
});
