import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { animationFrame, expect, runAllTimers, test } from "@odoo/hoot";
import { queryRect } from "@odoo/hoot-dom";
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
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * VAL-MOBILE-007/008 (architecture.md §3.4): the mobile pipeline's own
 * card, `CrmMobileCard` (`static/src/mobile/crm_mobile_card/`) -- mounted
 * through the real "Pipeline" action under the mobile preset, the same
 * wiring proof `crm_offline_mobile_pipeline.test.js` already establishes
 * for the fixed header next to it (`CrmKanbanRenderer`'s small-screen
 * branch renders both from the one `isMobilePipeline` check).
 *
 * `activity_ids` is referenced (invisible, with a minimal `id`-only
 * subview) the same way the real `crm_case_kanban_view_leads` arch
 * references it for `kanban_activity`, so this card's `isPendingSync`
 * getter sees the same shape of data it does in production: a
 * `record.data.activity_ids` static list of already-synced activities,
 * used to combine `pendingForLead` with `pendingActivities(leadId,
 * activityIds)` (offline_hooks.js's own doc on why a queued
 * `mail.activity.action_done` needs that second call).
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    stage_id = fields.Many2one({ relation: "crm.stage" });
    partner_id = fields.Many2one({ relation: "res.partner" });
    expected_revenue = fields.Float();
    activity_ids = fields.One2many({ relation: "mail.activity" });

    _views = {
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <field name="stage_id"/>
                <field name="partner_id"/>
                <field name="expected_revenue"/>
                <field name="activity_ids" invisible="1">
                    <list>
                        <field name="id"/>
                    </list>
                </field>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>`,
        form: `<form><field name="name"/></form>`,
        search: `<search/>`,
    };
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    sequence = fields.Integer({ default: 10 });
    fold = fields.Boolean({ default: false });

    _records = [{ id: 1, name: "New", sequence: 1 }];
}

defineModels([Lead, Stage]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
]);

/**
 * Three leads in the one stage: #1 has a partner and a revenue, #2 has
 * neither (proves the card omits a blank partner row rather than
 * showing one empty), #3 carries one pre-existing server activity (the
 * `action_done` combination case, VAL-MOBILE-008).
 */
async function seedLeads() {
    const pyEnv = await startServer();
    const partnerId = pyEnv["res.partner"].create({ name: "Acme Corp" });
    const activityTypeId = pyEnv["mail.activity.type"].create({ name: "Call" });
    const [lead1, lead2, lead3] = pyEnv["crm.lead"].create([
        { name: "Lead 1", stage_id: 1, partner_id: partnerId, expected_revenue: 1000 },
        { name: "Lead 2", stage_id: 1, partner_id: false, expected_revenue: 250 },
        { name: "Lead 3", stage_id: 1, expected_revenue: 50 },
    ]);
    const activityId = pyEnv["mail.activity"].create({
        res_model: "crm.lead",
        res_id: lead3,
        activity_type_id: activityTypeId,
        summary: "Follow up",
    });
    pyEnv["crm.lead"].write([lead3], { activity_ids: [activityId] });
    return { lead1, lead2, lead3, activityId };
}

test.tags("mobile");
test("the mobile pipeline's cards are the crm mobile card: name, partner name and expected revenue, each >= 44x44 CSS px", async () => {
    await seedLeads();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // VAL-MOBILE-007: every card in the mobile pipeline is the crm
    // mobile card -- no base `KanbanRecord` left in it.
    expect(".o_crm_mobile_card").toHaveCount(3);
    expect(".o_kanban_record:not(.o_crm_mobile_card)").toHaveCount(0);

    expect(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_name").toHaveText("Lead 1");
    expect(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_partner").toHaveText("Acme Corp");
    expect(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_revenue").toHaveText(/1,000/);

    // Lead 2 has no partner: no blank row, not an empty one.
    expect(".o_crm_mobile_card:eq(1) .o_crm_mobile_card_name").toHaveText("Lead 2");
    expect(".o_crm_mobile_card:eq(1) .o_crm_mobile_card_partner").toHaveCount(0);
    expect(".o_crm_mobile_card:eq(1) .o_crm_mobile_card_revenue").toHaveText(/250/);

    // VAL-MOBILE-007: the whole card is the one touch target, >= 44x44 CSS px.
    for (let i = 0; i < 3; i++) {
        const rect = queryRect(`.o_crm_mobile_card:eq(${i})`);
        expect(rect.width).toBeWithin(44, 100000);
        expect(rect.height).toBeWithin(44, 100000);
    }

    // The card's one touch target must actually open the record (it
    // replaces `KanbanRecord`'s own `openRecord` click, not just its
    // looks) -- a plain `t-on-click="onClick"` without the `this.`
    // prefix this build's templates require evaluates to `undefined`
    // and throws instead of opening anything, so this is a real
    // regression check, not a formality.
    await contains(".o_crm_mobile_card:eq(0)").click();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead 1");
});

test.tags("mobile");
test("the pending-sync badge comes from the offline queue via the hooks module, including a queued activity action_done through the card's own activity_ids", async () => {
    const { lead1, lead3, activityId } = await seedLeads();
    onRpc("mail.activity", "action_done", function ({ args }) {
        this.env["mail.activity"].write(args[0], { active: false, state: "done" });
        return true;
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless startup sync (3s after mount,
    // offline_plugin.js's constructor) now, while the queue is empty, so
    // it can't race the replay triggered by setOffline(false) below.
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_crm_mobile_card_pending_sync").toHaveCount(0);

    // VAL-MOBILE-008: a plain queued write naming lead 1 (e.g. a revenue
    // edit) is enough on its own -- `pendingForLead` sees it directly.
    getService(OfflinePlugin).scheduleORM(
        "crm.lead",
        "web_save",
        [[lead1], { expected_revenue: 1234 }],
        { context: {}, specification: {} },
        { extras: { timeStamp: Date.now() } }
    );
    // Orchestrator note after m4-hooks: `pendingForLead` does not see a
    // queued `mail.activity.action_done` (it carries only the activity
    // id, never the lead id) -- only the card's own combination with
    // `pendingActivities(leadId, activityIds)` catches this one, for
    // lead 3's pre-existing activity.
    getService(OfflinePlugin).scheduleORM(
        "mail.activity",
        "action_done",
        [[activityId]],
        {},
        { extras: { timeStamp: Date.now() } }
    );
    await animationFrame();

    expect(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_pending_sync").toHaveCount(1); // lead 1
    expect(".o_crm_mobile_card:eq(1) .o_crm_mobile_card_pending_sync").toHaveCount(0); // lead 2: untouched
    expect(".o_crm_mobile_card:eq(2) .o_crm_mobile_card_pending_sync").toHaveCount(1); // lead 3, via action_done

    await setOffline(false);
    // The sync loop waits 1s between each replayed call (offline_plugin.js);
    // a single runAllTimers() only advances to the furthest timer that
    // already existed when it was called, so two queued entries need a
    // second flush for the pause before the 2nd one.
    await runAllTimers();
    await runAllTimers();
    await animationFrame();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_crm_mobile_card_pending_sync").toHaveCount(0);
});
