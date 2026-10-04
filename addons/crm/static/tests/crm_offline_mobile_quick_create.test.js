import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, runAllTimers, test } from "@odoo/hoot";
import { animationFrame, queryAllTexts } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getKanbanRecordTexts,
    getService,
    models,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/crm_test_helpers";

/**
 * m4-quick-create (architecture.md §3.4, VAL-MOBILE-009..011/013): the
 * mobile pipeline's own quick create, `CrmMobileQuickCreate`, opened as a
 * bottom sheet from `CrmMobilePipeline`'s "+" control
 * (`.o_crm_mobile_pipeline_add`) -- mounted through the real "Pipeline"
 * action under the mobile preset, the same wiring proof
 * `crm_offline_mobile_pipeline.test.js`/`crm_offline_mobile_card.test.js`
 * already establish for the rest of the mobile pipeline (`CrmKanbanRenderer`'s
 * one `isMobilePipeline` branch wires the header, the cards and this sheet
 * together).
 *
 * `default_group_by="stage_id"` with two stages, "New" (unfolded) and
 * "Qualified" (also unfolded, to keep the exact-context assertion below
 * independent of the fold/offline-helper branch `crm_offline_mobile_pipeline
 * .test.js` already covers).
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    contact_name = fields.Char();
    phone = fields.Char();
    email_from = fields.Char();
    expected_revenue = fields.Float();
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });

    _views = {
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <field name="stage_id"/>
                <field name="expected_revenue"/>
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

    _records = [
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Qualified", sequence: 2 },
    ];
}

defineModels([Lead, Stage]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        // VAL-MOBILE-010: the context the real pipeline action carries
        // (team/type defaults in production) -- `group.context` is this,
        // plus `default_stage_id`, the exact shape desktop's own kanban
        // quick create uses (`kanban_renderer.xml`'s `context="group.
        // context"`); a non-empty value here is what makes the
        // equal-to-the-board's-own-context assertion below meaningful,
        // not vacuous.
        context: { default_type: "opportunity" },
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
]);

/**
 * One lead per stage: a mock `crm.stage` has no `_read_group_expand_full`
 * (unlike the real one), so `web_read_group` only returns a group for a
 * stage that has at least one record -- "Qualified" needs its own lead to
 * exist as a navigable stage at all, independent of this file's own
 * quick-create assertions.
 */
async function seedLeads() {
    const pyEnv = await startServer();
    const [lead1] = pyEnv["crm.lead"].create([
        { name: "Lead 1", stage_id: 1, expected_revenue: 100 },
        { name: "Lead 2", stage_id: 2, expected_revenue: 200 },
    ]);
    return lead1;
}

test.tags("mobile");
test("VAL-MOBILE-009: the quick-create sheet opens with exactly six fixed field controls plus Save, each available offline", async () => {
    await seedLeads();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    expect(".o_bottom_sheet").toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_add").click();

    expect(".o_bottom_sheet .o_crm_mobile_quick_create").toHaveCount(1);
    const fieldSelectors = [
        ".o_crm_mobile_quick_create_name",
        ".o_crm_mobile_quick_create_contact_name",
        ".o_crm_mobile_quick_create_phone",
        ".o_crm_mobile_quick_create_email",
        ".o_crm_mobile_quick_create_expected_revenue",
        ".o_crm_mobile_quick_create_stage",
    ];
    expect(fieldSelectors.length).toBe(6);
    for (const selector of fieldSelectors) {
        expect(selector).toHaveCount(1);
        expect(selector).toHaveAttribute("data-available-offline");
    }
    // No other input/select/textarea in the sheet besides these six.
    expect(".o_crm_mobile_quick_create input, .o_crm_mobile_quick_create select, .o_crm_mobile_quick_create textarea").toHaveCount(6);

    expect(".o_crm_mobile_quick_create_save").toHaveCount(1);
    expect(".o_crm_mobile_quick_create_save").toHaveAttribute("data-available-offline");
    // Empty name: disabled, not just inert -- the framework's own
    // SELECTORS_TO_DISABLE pass only ever *adds* `disabled`, it never
    // removes one a tagged control sets for its own reasons.
    expect(".o_crm_mobile_quick_create_save").toHaveProperty("disabled", true);

    expect(".o_crm_mobile_quick_create_cancel").toHaveAttribute("data-available-offline");
    await contains(".o_crm_mobile_quick_create_cancel").click();
    expect(".o_bottom_sheet").toHaveCount(0);
});

test.tags("mobile");
test("VAL-MOBILE-010: offline, saving queues one crm.lead web_save([], vals) with the pipeline's own context, closes the sheet and shows a pending card in the chosen stage", async () => {
    await seedLeads();
    let boardContext;
    onRpc("web_read_group", ({ kwargs }) => {
        boardContext = kwargs.context;
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless startup sync now, while the queue is
    // empty (crm_offline_mobile_card.test.js's own note on why).
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("New Lead", { confirm: false });
    await contains(".o_crm_mobile_quick_create_contact_name").edit("Jane Doe", { confirm: false });
    await contains(".o_crm_mobile_quick_create_phone").edit("123456", { confirm: false });
    await contains(".o_crm_mobile_quick_create_email").edit("jane@example.com", { confirm: false });
    await contains(".o_crm_mobile_quick_create_expected_revenue").edit("500", { confirm: false });
    // Still on "New" (stage 1, the default), left untouched.

    // `parent()` keeps the real mock `web_save` running -- this handler
    // only observes the call, it must not swallow it, since the queued
    // entry's own later replay (after `setOffline(false)` below) goes
    // through this exact same handler.
    let createCalled = false;
    onRpc("crm.lead", "web_save", ({ parent }) => {
        createCalled = true;
        return parent();
    });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();

    // The sheet closes right away: no RPC round trip is awaited offline.
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(createCalled).toBe(false); // never reaches the server while offline

    const queue = Object.values(getService(OfflinePlugin)._ormToSync());
    const leadCreates = queue.filter(
        ({ value }) => value.model === "crm.lead" && value.method === "web_save"
    );
    expect(leadCreates.length).toBe(1);
    const { args, kwargs, extras } = leadCreates[0].value;
    // VAL-MOBILE-010: args[0] = [] is the producer's own shape for a
    // brand-new record (record.js's _offlineSave, same as every other
    // offline-queued create in this addon) -- not a resId-bearing write.
    expect(args[0]).toEqual([]);
    expect(args[1]).toEqual({
        name: "New Lead",
        contact_name: "Jane Doe",
        phone: "123456",
        email_from: "jane@example.com",
        expected_revenue: 500,
        stage_id: 1,
    });
    // The exact context desktop's own kanban quick create would use for
    // this same stage: the board's own list context plus
    // `default_stage_id`. `bin_size`/`read_group_expand` are stripped
    // first -- relational_model.js's own `_updateRoot` only adds those
    // two to the one `web_read_group` RPC's kwargs (relational_model.js:
    // ~1003, "context: { bin_size: true, read_group_expand: true,
    // ...config.context }"), they are never part of `config.context`/
    // `group.context` itself.
    const { bin_size, read_group_expand, ...listContext } = boardContext;
    expect(kwargs.context).toEqual({ ...listContext, default_stage_id: 1 });
    expect(extras.timeStamp).toBeOfType("number");

    // VAL-MOBILE-010: the pending-sync card, in "New" (the chosen stage).
    // Every group keeps its own copy of this card in the DOM, `d-none`
    // for the ones not currently shown (same as the real
    // `CrmMobileCard`s, crm_offline_mobile_pipeline.test.js's own
    // `.o_kanban_group.d-none` check), hence the `.o_crm_mobile_pipeline_
    // active` scoping on every assertion below -- an unscoped selector
    // would also match "New"'s own hidden copy once the active stage
    // changes.
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create_name").toHaveText("New Lead");
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create_badge").toHaveText("Pending sync");
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card")).toEqual(["Lead 1\n100.00"]);

    // Stepping to "Qualified" (its own lead, Lead 2, but no pending
    // creates targeted there) hides it again -- it is a per-stage card,
    // not a global one.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Qualified");
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(0);
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(1);

    await setOffline(false);
    await runAllTimers();
    await animationFrame();
    // Belt-and-suspenders second flush, like crm_offline_mobile_card.
    // test.js's own replay assertion: a single runAllTimers() only
    // advances to the furthest timer that already existed when it was
    // called.
    await runAllTimers();
    await animationFrame();

    // m4-sync-refresh (VAL-MOBILE-018): the replay dequeues the entry and
    // the pending card disappears, and -- the former KNOWN-LIMIT this
    // comment used to describe -- `CrmKanbanRenderer`'s own sync-refresh
    // effect now reloads "New"'s list (and only "New"'s) once its last
    // queued create clears, so the real "New Lead" card is there too, no
    // page reload, no duplicate; `crm_offline_mobile_sync_refresh.test.js`
    // covers this in detail (including that "Qualified" issues no RPC of
    // its own), this file only confirms its own scenario ends the same way.
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(0);
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name")).toEqual([
        "Lead 1",
        "New Lead",
    ]);
});

test.tags("mobile");
test("VAL-MOBILE-011: online, saving creates the lead immediately with no queueing and shows the new card without a pending badge", async () => {
    await seedLeads();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    let webSaveArgs;
    onRpc("crm.lead", "web_save", ({ args }) => {
        webSaveArgs = args;
    });

    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("Online Lead", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();

    expect(".o_bottom_sheet").toHaveCount(0);
    expect(webSaveArgs?.[0]).toEqual([]);
    expect(webSaveArgs?.[1].name).toBe("Online Lead");
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

    expect(".o_crm_mobile_pending_lead_create").toHaveCount(0);
    // At the top, like desktop's own kanban quick create: both call
    // `group.addExistingRecord(id, true)` (kanban_renderer.js:491 and
    // onMobileLeadCreated, crm_kanban_renderer.js).
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name")).toEqual([
        "Online Lead",
        "Lead 1",
    ]);
    expect(".o_crm_mobile_card_pending_sync").toHaveCount(0);
});

test.tags("desktop");
test("VAL-MOBILE-013: desktop keeps its own kanban quick create and cards unchanged -- no bottom sheet, no mobile quick-create control", async () => {
    await seedLeads();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    expect(".o_crm_mobile_pipeline_add").toHaveCount(0);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(".o_crm_mobile_quick_create").toHaveCount(0);
    // Desktop's own cards: the base KanbanRecord, not CrmMobileCard.
    expect(".o_crm_mobile_card").toHaveCount(0);
    expect(getKanbanRecordTexts(0)).toEqual(["Lead 1"]);

    // Desktop's own per-column quick create still works exactly as before.
    expect(".o_kanban_header .o_kanban_quick_add").toHaveCount(2);
});
