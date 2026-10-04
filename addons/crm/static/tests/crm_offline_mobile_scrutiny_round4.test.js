import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, runAllTimers, test } from "@odoo/hoot";
import { animationFrame, queryAllTexts } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    editSearch,
    fields,
    getService,
    models,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    validateSearch,
} from "@web/../tests/web_test_helpers";
import { WebClient } from "@web/webclient/webclient";
import { CrmKanbanModel } from "@crm/views/crm_kanban/crm_kanban_model";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * validation/mobile-ui/scrutiny/synthesis.json (M4 scrutiny round 4),
 * VAL-MOBILE-006: round 3's own fix (`crm_offline_mobile_scrutiny_round3
 * .test.js`) keyed the fetched-state tracker on the stage id
 * (`_stageIdsWithLoadedList`, a `Set<group.value>`). A stage id survives
 * every `RelationalModel.load()` reload unchanged, but a reload replaces
 * every group's own `list` object with a brand-new, empty one
 * (`relational_model.js`'s `_webReadGroup`, same mechanic round3's own
 * module doc comment explains) -- so a *folded* stage reloaded this way
 * read as cached forever after on the strength of a mark that pointed at
 * a now-discarded list: no cards (the new list is genuinely empty, never
 * loaded) and no helper (wrongly suppressed by the stale stage-id mark).
 * Offline navigation to it hit a dead end with neither.
 *
 * The fix (`crm_kanban_renderer.js`) replaces that `Set` with
 * `_loadedLists`, a `WeakSet<group.list>`: the mark now lives on the list
 * object itself, so a reload's fresh list for a still-folded stage was
 * never added to it and correctly reads as uncached, exactly like a stage
 * never visited at all -- the helper shows, in both the two bugs this
 * fix addresses:
 *   (f) a stage loaded online, then folded, then caught by an unrelated
 *       search/filter reload while folded: offline, must show the
 *       helper (its post-reload list was never loaded), not the stale
 *       "cached" read the old stage-id mark gave it.
 *   (g) the same reload, but the stage is still open (not yet folded
 *       back) when it happens: the renderer's own `useEffect`
 *       (`setup()`'s `!group.isFolded` sweep) re-marks its fresh,
 *       re-inlined list the moment the reload resolves, so folding it
 *       back afterwards and going offline must still show its cards, no
 *       helper -- proving the fix does not regress the "stays open
 *       through a reload" case round3's own (a)/(b) rows already cover
 *       for a *different* kind of reload (a record delete, not a
 *       search/filter change).
 *
 * Both stages are seeded with two leads each (over the kanban arch's own
 * `limit="2"`, matching round3's own (a) row) so the offline assertions
 * below can tell "no cards because never loaded" (f) apart from "cards
 * because loaded" (g) unambiguously. The search view's `name` field
 * lets `editSearch`/`validateSearch` add a real facet whose domain still
 * matches every seeded lead (`"Lead"` is a substring of every one of
 * their names) -- the reload this triggers is a genuine domain change
 * (`[]` -> `[["name", "ilike", "Lead"]]`), not a no-op, but it must not
 * itself remove any group so (f)'s and (g)'s stages are still there
 * afterwards to be folded/navigated to, same as a real user narrowing a
 * search without filtering out the stage they are about to revisit.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    expected_revenue = fields.Float();
    // `group_expand` mirrors crm.lead's real `stage_id` field so both
    // stages keep their own kanban column across the search/filter
    // reload below, same reasoning as round2's and round3's identical
    // field.
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage", group_expand: true });

    _views = {
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id" limit="2">
                <field name="stage_id"/>
                <field name="expected_revenue"/>
                <progressbar field="name" colors="{}" sum_field="expected_revenue"/>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>`,
        form: `<form><field name="name"/></form>`,
        // `name` is an explicit search field (not a bare `<search/>` like
        // round2/round3's own view) so `editSearch`/`validateSearch`
        // below have a real facet to add -- a free-text search with no
        // declared field has nothing to filter on.
        search: `<search><field name="name"/></search>`,
    };
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    sequence = fields.Integer({ default: 10 });
    fold = fields.Boolean({ default: false });

    _records = [
        { id: 1, name: "New", sequence: 1 }, // entry stage, not folded
        { id: 2, name: "StageF", sequence: 2, fold: true }, // (f)
        { id: 3, name: "StageG", sequence: 3, fold: true }, // (g)
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
        context: { default_type: "opportunity" },
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
]);

const HELPER_TEXT = "There is no data to display offline for the given filters";

test.tags("mobile");
test(
    "VAL-MOBILE-006 round 4: a stage folded before a search/filter reload shows the helper " +
        "offline (its new list was never loaded), while one still open when the reload hits " +
        "keeps its cards",
    async () => {
        let model;
        patchWithCleanup(CrmKanbanModel.prototype, {
            setup() {
                super.setup(...arguments);
                model = this;
            },
        });

        const pyEnv = await startServer();
        pyEnv["crm.lead"].create([
            { name: "Lead New", stage_id: 1, expected_revenue: 100 },
            // (f): folded again before the search/filter reload hits.
            { name: "Lead F1", stage_id: 2, expected_revenue: 10 },
            { name: "Lead F2", stage_id: 2, expected_revenue: 20 },
            // (g): still open when the search/filter reload hits.
            { name: "Lead G1", stage_id: 3, expected_revenue: 10 },
            { name: "Lead G2", stage_id: 3, expected_revenue: 20 },
        ]);

        await mountWithCleanup(WebClient);
        await getService("action").doAction(1);
        await runAllTimers();

        const findGroup = (name) => model.root.groups.find((g) => g.displayName === name);

        // Online: unfold StageF and StageG through the real navigation
        // path, same as round3's own (a)/(b)/(c) rows -- the only way,
        // in this build, to load a stage's list.
        await contains(".o_crm_mobile_pipeline_next").click(); // New -> StageF
        expect(".o_crm_mobile_pipeline_title").toHaveText("StageF");
        expect(findGroup("StageF").isFolded).toBe(false);
        expect(findGroup("StageF").list.records.length).toBe(2);

        await contains(".o_crm_mobile_pipeline_next").click(); // StageF -> StageG
        expect(".o_crm_mobile_pipeline_title").toHaveText("StageG");
        expect(findGroup("StageG").isFolded).toBe(false);
        expect(findGroup("StageG").list.records.length).toBe(2);

        // (f): fold StageF back *before* the reload below -- a pure
        // local flag flip, no RPC (`toggle()` only reloads going *into*
        // unfolded). StageG is deliberately left open: that is the only
        // difference between the two rows below.
        await findGroup("StageF").toggle();
        expect(findGroup("StageF").isFolded).toBe(true);

        // The search/filter reload: a real facet through the actual
        // search bar, not a direct model call, so this exercises the
        // same `RelationalModel.load()` path a real user's search bar
        // keystroke would. The new domain still matches every seeded
        // lead ("Lead" is a substring of all of them), so neither
        // stage's column disappears -- both come back with a brand-new
        // `group.list` object instead (every `Group` is rebuilt from
        // scratch, same as round3's own module doc comment explains for
        // its own, differently-triggered reloads).
        await editSearch("Lead");
        await validateSearch();
        await runAllTimers();

        // Round 4 (synthesis.json, VAL-MOBILE-006): StageG is still
        // unfolded at this point, so this reload's own `opening_info`
        // (`_webReadGroup`, relational_model.js, built from each group's
        // *current* `isFolded` right before the request) re-inlines its
        // records, same mechanism that lets a folded group's own
        // `isFolded` instead come back `true` for a group not currently
        // open. Flush the renderer's reactive `useEffect` (setup()'s own
        // `!group.isFolded` sweep) here, while StageG is still unfolded,
        // so it re-marks StageG's *new* list as loaded before folding it
        // back below -- otherwise the offline assertion for (g) would
        // wrongly see that new list as never loaded. The effect is a
        // reactive `effect()` (owl.js), batched via one
        // `Promise.resolve().then()` hop (`batchProcessEffects`), not a
        // timer, hence `animationFrame()` (every other flush in this
        // suite) rather than `runAllTimers()`.
        await animationFrame();
        expect(findGroup("StageF").isFolded).toBe(true);
        expect(findGroup("StageG").isFolded).toBe(false);
        expect(findGroup("StageG").list.records.length).toBe(2);

        // (g): now fold StageG back too -- same pure local flag flip,
        // after its new list has already been marked loaded above.
        // StageG (not StageF) is still the active stage at this point
        // (the reload does not change `mobilePipelineIndex`), so this
        // is a direct model call rather than a `prev`/`next` click, same
        // as round3's own fold-backs: `_mobilePipelineGoTo` auto-
        // unfolds *any* folded stage it lands on while online (loading
        // it is the whole point of visiting one), so clicking back to
        // "New" from here would step through -- and silently re-unfold
        // -- StageF, undoing (f)'s own fold above. Going offline before
        // ever navigating past StageF sidesteps that: `_mobilePipeline
        // GoTo`'s auto-unfold is itself gated on `!isOffline()`.
        await findGroup("StageG").toggle();
        expect(findGroup("StageG").isFolded).toBe(true);

        let rpcCount = 0;
        onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
            rpcCount++;
            return parent();
        });

        const setOffline = mockCrmOffline();
        await setOffline(true);

        // (f) folded before the reload: its post-reload list was never
        // loaded, so the helper shows, no cards, independent of its
        // count -- the stale stage-id mark round3's own fix left behind
        // would have wrongly read this as cached forever after. One
        // `prev` click from StageG (the active stage since the fold-
        // backs above) lands on StageF -- offline, so this does not
        // trigger the auto-unfold the module doc above warns about.
        rpcCount = 0;
        await contains(".o_crm_mobile_pipeline_prev").click();
        expect(".o_crm_mobile_pipeline_title").toHaveText("StageF");
        expect(
            `.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`
        ).toHaveCount(1);
        expect(".o_crm_mobile_pipeline_active .o_crm_mobile_card").toHaveCount(0);
        expect(rpcCount).toBe(0);

        // (g) still open when the reload hit, folded back only
        // afterwards: its post-reload list was re-inlined and marked by
        // the effect, so its cards render, no helper, no RPC. One
        // `next` click back from StageF to StageG, still offline.
        rpcCount = 0;
        await contains(".o_crm_mobile_pipeline_next").click();
        expect(".o_crm_mobile_pipeline_title").toHaveText("StageG");
        expect(
            `.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`
        ).toHaveCount(0);
        expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name")).toEqual([
            "Lead G1",
            "Lead G2",
        ]);
        expect(rpcCount).toBe(0);
    }
);
