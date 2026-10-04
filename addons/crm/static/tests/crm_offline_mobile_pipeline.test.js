import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, runAllTimers, test } from "@odoo/hoot";
import { animationFrame, queryAllTexts, queryOne, queryRect } from "@odoo/hoot-dom";
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
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

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
    // m4-fix-ut-evidence (VAL-MOBILE-015): `aggregator: "sum"` +
    // `currency_field` is what makes `CrmMobilePipeline.
    // _cachedAggregateValue`'s monetary branches (crm_mobile_pipeline.js)
    // reachable at all -- `getAggregateSpecifications` (relational_model/
    // utils.js) only ever requests the `currency_id:array_agg_distinct`
    // aggregate this needs for a field declared this way. `default: 1`
    // keeps every record already in `_records` below, and every one
    // seeded ad hoc by the other tests in this file (none of which pass
    // `currency_id`), on the one same currency -- the single-currency
    // branch, not a change to any of their own existing aggregate
    // assertions. `CrmMobileCard.expectedRevenueText` (crm_mobile_card.js)
    // formats this through its own hardcoded "company_currency" field
    // name, never this one, so the cards' own exact-text assertions
    // below ("Lead 1\n100.00", ...) are unaffected either way.
    expected_revenue = fields.Monetary({ aggregator: "sum", currency_field: "currency_id" });
    currency_id = fields.Many2one({ relation: "res.currency", default: 1 });

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
                <field name="currency_id"/>
                <progressbar field="kanban_state" colors='{"done": "success", "blocked": "danger", "normal": "muted"}' sum_field="expected_revenue"/>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>`,
        // m4-fix-ut-evidence (VAL-MOBILE-015): a second kanban view
        // (`"kanban,2"`, resolved via `views: [[2, "kanban"]]` on action
        // id 2 below -- the mock server's own view-key convention,
        // `getViewKey`/`findView` in mock_model.js), whose `<progressbar>`
        // has no `sum_field` at all -- the one arch shape that reaches
        // `CrmMobilePipeline.groupAggregate`'s `!sumField` early return
        // (crm_mobile_pipeline.js), since every other action in this
        // milestone's own test suite always declares one.
        "kanban,2": `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <field name="stage_id"/>
                <progressbar field="kanban_state" colors='{"done": "success", "blocked": "danger", "normal": "muted"}'/>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>`,
        // VAL-MOBILE-006 (m4-fix-ut-evidence): a form view, used only by
        // the "uncached lead" test below to genuinely visit one lead's
        // form online (the same real-navigation idiom
        // crm_offline_uncached_lead.test.js uses) before going offline --
        // none of the other tests in this file open a record, so adding
        // it changes nothing for them.
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
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
    {
        id: 2,
        name: "Pipeline (no progressbar sum_field)",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        // m4-fix-ut-evidence (VAL-MOBILE-015): the `"kanban,2"` arch
        // above, via the explicit view id -- action id 1 keeps its own
        // `sum_field`-bearing kanban for every other test in this file.
        views: [[2, "kanban"]],
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
    // m4-card (VAL-MOBILE-007) made these `CrmMobileCard`, which always
    // shows the revenue line regardless of the arch's own "card"
    // template -- hence the second line on each, unlike the desktop
    // assertion below which still goes through that bare arch template.
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_kanban_record")).toEqual([
        "Lead 1\n100.00",
        "Lead 2\n200.00",
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
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_kanban_record")).toEqual([
        "Lead 3\n50.00",
    ]);
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
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_kanban_record")).toEqual([
        "Lead 3\n50.00",
    ]);
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
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_kanban_record")).toEqual([
        "Lead 4\n10.00",
    ]);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(loadCount).toBeGreaterThan(0);
});

test.tags("mobile");
test("VAL-MOBILE-002/010: the header's own pending-create count comes from the offline queue via the hooks module, per stage", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless startup sync now, while the queue is
    // empty (crm_offline_mobile_card.test.js's own note on why).
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_pending_count").toHaveCount(0);

    // A queued create for stage 1 ("New"), the same `web_save([], vals)`
    // shape the mobile quick-create sheet's own producer uses
    // (crm_offline_mobile_quick_create.test.js's VAL-MOBILE-010 test).
    getService(OfflinePlugin).scheduleORM(
        "crm.lead",
        "web_save",
        [[], { name: "Pending Lead", stage_id: 1 }],
        { context: {}, specification: {} },
        { extras: { timeStamp: Date.now() } }
    );
    await animationFrame();

    expect(".o_crm_mobile_pipeline_pending_count").toHaveText("1 pending");

    // "Qualified" (stage 2) has no queued create of its own: no badge.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Qualified");
    expect(".o_crm_mobile_pipeline_pending_count").toHaveCount(0);

    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_pending_count").toHaveText("1 pending");

    await setOffline(false);
    await runAllTimers();
    await animationFrame();
    // Belt-and-suspenders second flush, like other files in this
    // milestone's own replay assertions.
    await runAllTimers();
    await animationFrame();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_crm_mobile_pipeline_pending_count").toHaveCount(0);
});

test.tags("mobile");
test("VAL-MOBILE-003 (m4-fix-ut-evidence): the single visible stage fills the view's own width, and its fixed header stays in place (position-sticky) while the stage's cards scroll", async () => {
    const pyEnv = await startServer();
    // Enough cards in "New" for the view's own scroll container
    // (`.o_content`) to actually overflow the mobile viewport: this is
    // what proves `position-sticky` (crm_mobile_pipeline.xml) really
    // keeps the header pinned while scrolling, not merely present and
    // untested in the markup.
    pyEnv["crm.lead"].create(
        Array.from({ length: 20 }, (_, i) => ({
            name: `Scroll Lead ${i}`,
            stage_id: 1,
            kanban_state: "normal",
            expected_revenue: 10,
        }))
    );

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // VAL-MOBILE-003: a real bounding-rect comparison, not only the
    // visibility check the module doc above calls out as insufficient on
    // its own -- the one visible stage column is exactly as wide as the
    // view's own content area, not web's default 90%-peek-of-next-column
    // width.
    const contentRect = queryRect(".o_content");
    const activeGroupRect = queryRect(".o_crm_mobile_pipeline_active");
    expect(activeGroupRect.width).toBeCloseTo(contentRect.width, { digits: 0 });

    const headerRectBeforeScroll = queryRect(".o_crm_mobile_pipeline_header");

    // kanban_controller.scss's own narrow-breakpoint rules: `.o_kanban_
    // renderer.o_kanban_grouped` hides vertical overflow at that level
    // (`overflow: scroll hidden`, horizontal column-snap only) and pushes
    // vertical scrolling down to each `.o_kanban_group` itself
    // (`overflow-y: scroll`) -- the active group, not `.o_content`, is
    // the real scrolling ancestor for this stage's cards. The header
    // above is a sibling of the groups loop (crm_kanban_renderer.xml),
    // outside that scrolling element entirely, which is what actually
    // keeps it in place -- `position-sticky` in crm_mobile_pipeline.xml
    // is a second, redundant guarantee for whichever ancestor the header
    // does end up scrolling with.
    const scroller = queryOne(".o_crm_mobile_pipeline_active");
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight); // there is something to scroll
    scroller.scrollTop = scroller.scrollHeight;
    await animationFrame();
    expect(scroller.scrollTop).toBeGreaterThan(0); // the scroll actually moved

    // VAL-MOBILE-003: the header stays fully visible and pinned at
    // exactly the same spot while the stage's cards scroll underneath
    // it -- position-sticky effective, not merely present in the markup.
    expect(".o_crm_mobile_pipeline_header").toBeVisible();
    const headerRectAfterScroll = queryRect(".o_crm_mobile_pipeline_header");
    expect(headerRectAfterScroll.top).toBeCloseTo(headerRectBeforeScroll.top, { digits: 0 });
    expect(headerRectAfterScroll.top).toBeWithin(0, headerRectBeforeScroll.bottom);
});

test.tags("mobile");
test("VAL-MOBILE-006 (m4-fix-ut-evidence): offline, tapping an uncached lead's grouped CrmMobileCard shows the offline helper; prev/next stay usable", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // Genuinely visit "Lead 1"'s form online (same real-navigation idiom
    // as crm_offline_uncached_lead.test.js) so its data lands in the real
    // RPC disk cache, then come back to the pipeline before going
    // offline. "Lead 2" (same unfolded "New" stage, so its card already
    // renders through this grouped mobile pipeline's own `CrmMobileCard`,
    // not the legacy ungrouped `KanbanRecord`
    // crm_offline_uncached_lead.test.js exercises) is deliberately left
    // unvisited.
    await contains(".o_crm_mobile_card:contains('Lead 1')").click();
    expect(".o_form_view").toHaveCount(1);
    expect(".o_field_widget[name=name] input").toHaveValue("Lead 1");
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // VAL-MOBILE-006: prev/next stay usable offline, including right
    // before and after the uncached-lead tap below -- the same
    // navigation the folded-stage test above already covers, re-asserted
    // here in the one scenario that also opens a card.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Qualified");
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");

    // VAL-MOBILE-006/VAL-UNCACHED behavior kept: tapping "Lead 2"'s own
    // `CrmMobileCard` (not the legacy card) offline shows the helper
    // instead of an empty form or a silent no-op; `CrmKanbanController.
    // openRecord`'s uncached-lead guard (crm_kanban_view.js) short-
    // circuits before any RPC, exactly like the ungrouped case
    // crm_offline_uncached_lead.test.js already proves, so no RPC is
    // declared here either.
    await contains(".o_crm_mobile_card:contains('Lead 2')").click();
    expect(".o_form_view").toHaveCount(0);
    expect(`.o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    // The whole small-screen branch (header included) is replaced by the
    // helper while it is showing (crm_kanban_view.xml) -- there is no
    // in-view "back" control (architecture.md §3.8), only reconnecting.
    expect(".o_crm_mobile_pipeline_header").toHaveCount(0);

    // Reconnecting is the documented recovery (architecture.md §3.8): the
    // helper is replaced by the pipeline again, prev/next included, and
    // they still work.
    await setOffline(false);
    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Qualified");
});

test.tags("mobile");
test("VAL-MOBILE-015 (m4-fix-ut-evidence): the header shows no aggregate at all when the arch's progressbar has no sum_field", async () => {
    await mountWithCleanup(WebClient);
    // Action id 2: the "kanban,2" arch above, whose `<progressbar>` has
    // no `sum_field` attribute -- `CrmMobilePipeline.groupAggregate`'s
    // `const { sumField } = progressBarState.progressAttributes; if
    // (!sumField) { return null; }` (crm_mobile_pipeline.js) is otherwise
    // unreachable in this milestone's whole test suite, every other arch
    // always declares one.
    await getService("action").doAction(2);

    expect(".o_crm_mobile_pipeline_header").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_count").toHaveText("2");
    // No crash, and no stray `AnimatedNumber` -- `groupAggregate` really
    // returned `null`, same as the "no progressBarState at all" case this
    // suite already covers elsewhere, not a leftover from the sum_field
    // arch this action deliberately doesn't use.
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveCount(0);

    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Qualified");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveCount(0);
});

test.tags("mobile");
test("VAL-MOBILE-015 (m4-fix-ut-evidence): the cached-aggregate fallback covers both the single- and the multi-currency monetary branches", async () => {
    // Same "progress bar never becomes ready" trigger as blocker 3
    // (crm_offline_mobile_scrutiny_fixes.test.js): a genuine
    // ConnectionLostError from `read_progress_bar` keeps `isReady` false
    // for every group for the life of this mount, forcing `groupAggregate`
    // into `_cachedAggregateValue` for all of them -- unlike that test's
    // own float `sum_field`, this file's `expected_revenue` is now a real
    // `monetary` field with a `currency_field`, so this is the one
    // scenario in the whole suite that reaches that method's own
    // `sumField.type === "monetary"` branch at all.
    onRpc("read_progress_bar", () => new Response("", { status: 502 }));

    const pyEnv = await startServer();
    // A stage of its own, deliberately not in `Stage._records` above, so
    // none of the other tests in this file are affected: two leads, two
    // different currencies -- `aggregates.currency_id` (`array_agg_
    // distinct`) ends up with more than one entry for this group, lines
    // 125-129 (`currencies?.length > 1`) in crm_mobile_pipeline.js.
    const [multiCurrencyStageId] = pyEnv["crm.stage"].create([
        { name: "Multi Currency", sequence: 4 },
    ]);
    pyEnv["crm.lead"].create([
        { name: "EUR Lead", stage_id: multiCurrencyStageId, expected_revenue: 40, currency_id: 2 },
        { name: "USD Lead", stage_id: multiCurrencyStageId, expected_revenue: 60, currency_id: 1 },
    ]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // "New": both its leads default to the same `currency_id` (the
    // field's own `default: 1`, untouched by this test) -- the
    // single-currency branch, lines 130-132
    // (`currencies?.[0]` truthy, exactly one entry).
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText(/300/); // 100 + 200
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveCount(1);

    // Step onto "Multi Currency" (New -> Qualified -> Won -> Multi
    // Currency): the multi-currency branch above -- still renders an
    // aggregate (not null, not a crash), from `group.aggregates` instead
    // of the never-ready progress bar.
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Multi Currency");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveCount(1);
});
