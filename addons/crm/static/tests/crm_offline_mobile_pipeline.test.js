import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { queryAllTexts } from "@odoo/hoot-dom";
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
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/crm_test_helpers";

/**
 * VAL-MOBILE-003..006 (architecture.md §3.4): the small-screen pipeline
 * branch `CrmKanbanRenderer` delegates to `CrmMobilePipeline` for. Mounts
 * the real "Pipeline" action (not a bare `mountView`), both for the
 * wiring proof (the component is only reachable from a rendered action,
 * never only from its own unit test) and because `OfflineActionHelper`
 * needs a real `env.config.actionId` to resolve its reset-filters list
 * (`crm_offline_uncached_lead.test.js` establishes the same pattern for
 * the same reason) -- `mockCrmOffline()`, not the plain `mockOffline()`
 * crm_offline_kanban_group_guards.test.js uses, follows from mounting a
 * full `WebClient` the same way (see that helper's own doc).
 *
 * Same mock models/arch idiom as crm_offline_kanban_group_guards.test.js,
 * plus a `fold` field on `crm.stage` (none of those tests needed one) so
 * "Won" opens folded -- the one way, offline or on, to reach a stage
 * whose records were never part of the single `web_read_group` that
 * loaded the rest of the board (research/design_options.md "per-stage
 * offline behaviour").
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    kanban_state = fields.Selection({
        selection: [
            ["normal", "Normal"],
            ["done", "Ready"],
            ["blocked", "Blocked"],
        ],
    });
    expected_revenue = fields.Float();

    _records = [
        { id: 1, name: "Lead 1", stage_id: 1, kanban_state: "normal", expected_revenue: 100 },
        { id: 2, name: "Lead 2", stage_id: 1, kanban_state: "done", expected_revenue: 200 },
        { id: 3, name: "Lead 3", stage_id: 2, kanban_state: "blocked", expected_revenue: 50 },
        { id: 4, name: "Lead 4", stage_id: 3, kanban_state: "normal", expected_revenue: 10 },
    ];

    _views = {
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <field name="stage_id"/>
                <progressbar field="kanban_state" colors='{"done": "success", "blocked": "danger", "normal": "muted"}' sum_field="expected_revenue"/>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>`,
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
        // Folded by default (like "Won" in the real pipeline): its lead
        // (id 4) is never part of the initial `web_read_group`'s inlined
        // `__records`, only its count/aggregates are -- the "uncached
        // stage" VAL-MOBILE-006 is about.
        { id: 3, name: "Won", sequence: 3, fold: true },
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
        views: [[false, "kanban"]],
    },
]);

const HELPER_TEXT = "There is no data to display offline for the given filters";

test.tags("mobile");
test("the pipeline action, under the mobile preset, renders the mobile layout: one stage at a time with a fixed header (name, lead count, revenue sum) and prev/next", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // VAL-MOBILE-003: exactly one stage visible, at the renderer's full
    // width -- not web's default 90% peek-of-next-column (every other
    // stage is still in the DOM, just `d-none`, so this is a visibility
    // assertion, not a geometry one, but the active group's own width
    // comes from the exact same flex rule that gives every kanban column
    // its width, so there is no separate "mobile width" number to get
    // wrong).
    expect(".o_kanban_group:not(.d-none)").toHaveCount(1);
    expect(".o_kanban_group.d-none").toHaveCount(2);

    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_count").toHaveText("2"); // Lead 1 + Lead 2
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText(/300/); // 100 + 200
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_kanban_record")).toEqual([
        "Lead 1",
        "Lead 2",
    ]);

    // VAL-MOBILE-003: prev/next carry the offline-availability attribute
    // on the button itself, like every other control this addon leaves
    // usable offline.
    expect(".o_crm_mobile_pipeline_prev").toHaveAttribute("data-available-offline");
    expect(".o_crm_mobile_pipeline_next").toHaveAttribute("data-available-offline");
    expect(".o_crm_mobile_pipeline_prev").toHaveProperty("disabled", true); // already the first stage

    await contains(".o_crm_mobile_pipeline_next").click();

    expect(".o_crm_mobile_pipeline_title").toHaveText("Qualified");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText(/50/);
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_kanban_record")).toEqual(["Lead 3"]);
    expect(".o_crm_mobile_pipeline_prev").not.toHaveProperty("disabled", true);

    await contains(".o_crm_mobile_pipeline_prev").click();

    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_prev").toHaveProperty("disabled", true);
});

test.tags("desktop");
test("desktop rendering is unchanged: every stage shows at once, with no mobile pipeline header or prev/next", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // VAL-MOBILE-004/005: the three stages the base renderer already
    // produces, untouched -- no group hidden, no new header, no
    // js_class/view/action change to this same arch.
    expect(".o_kanban_group").toHaveCount(3);
    expect(".o_kanban_group.d-none").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_header").toHaveCount(0);
    expect(getKanbanRecordTexts(0)).toEqual(["Lead 1", "Lead 2"]);
});

test.tags("mobile");
test("offline, an already-cached stage still renders; the folded stage prev/next reaches instead shows the generic offline helper; online it unfolds normally", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    let loadCount = 0;
    onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
        loadCount++;
        return parent();
    });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // VAL-MOBILE-006: "Qualified" was part of the pipeline's one initial
    // `web_read_group` (it isn't folded), so it is "cached" -- stepping to
    // it offline shows its cards normally, with no RPC at all.
    loadCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Qualified");
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_kanban_record")).toEqual(["Lead 3"]);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(loadCount).toBe(0);

    // "Won" is folded: never part of that same call, so it is the
    // "uncached" stage -- `_mobilePipelineGoTo` (crm_kanban_renderer.js)
    // checks `isOffline()` before calling `group.toggle()`, so stepping
    // to it offline issues no RPC either, and the header still shows its
    // name/count/revenue (those came from the initial call regardless of
    // fold state) while the body shows OfflineActionHelper instead of a
    // dead "Load more" button.
    loadCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText(/10/);
    expect(`.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    expect(".o_kanban_load_more").toHaveCount(0);
    expect(loadCount).toBe(0);

    await setOffline(false);

    // Online, stepping back onto "Won" (still folded -- going offline
    // never attempted, and so never completed, the unfold) now loads it
    // like any other first visit.
    await contains(".o_crm_mobile_pipeline_prev").click();
    loadCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_kanban_record")).toEqual(["Lead 4"]);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(loadCount).toBeGreaterThan(0);
});
