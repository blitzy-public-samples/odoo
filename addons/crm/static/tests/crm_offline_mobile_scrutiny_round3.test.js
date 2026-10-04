import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, runAllTimers, test } from "@odoo/hoot";
import { animationFrame, queryAllTexts } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { WebClient } from "@web/webclient/webclient";
import { CrmKanbanModel } from "@crm/views/crm_kanban/crm_kanban_model";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * validation/mobile-ui/scrutiny/synthesis.json (M4 scrutiny round 3),
 * VAL-MOBILE-006: `mobilePipelineIsUncached()` used to compare
 * `group.list.records.length` against `group.count`
 * (`crm_kanban_renderer.js`, added by m4-fix-scrutiny-r2-counts-empty-stage).
 * That broke on two boundaries this file is named after and covers in one
 * test, with one stage per matrix row, all seeded up front so prev/next
 * navigation visits them in a fixed order:
 *   (a) a folded stage loaded online with every one of its leads already
 *       in memory (`records.length === count`): must show its cards, no
 *       helper.
 *   (b) a folded stage loaded online but only partially (fewer records
 *       loaded than its count, here 2 of 3 leads, capped by the kanban
 *       arch's own `limit`) -- exactly how a real stage with more leads
 *       than one page looks right after being unfolded once: the old
 *       `records.length < count` comparison wrongly flagged this as
 *       uncached and showed the helper beside 2 perfectly good cards.
 *       Must show those cards (plus the base template's own "Load
 *       more", disabled offline like any other framework button lacking
 *       `data-available-offline`), no helper.
 *   (c) a folded stage loaded online and genuinely empty
 *       (`records.length === count === 0`): must show the normal empty
 *       body, no helper (same case m4-fix-scrutiny-r2-counts-empty-stage
 *       already fixed and crm_offline_mobile_scrutiny_round2.test.js
 *       already covers; kept here so this file alone proves the whole
 *       matrix for one scrutiny round).
 *   (d) a folded stage never loaded, with leads (`count > 0`): must show
 *       the helper, no cards -- the ordinary case, kept here for the
 *       same completeness reason as (c).
 *   (e) a folded stage never loaded, with no leads (`count === 0`): the
 *       old comparison (`0 < 0` is false) wrongly treated this as
 *       cached and withheld the helper. Per VAL-MOBILE-006 ("uncached
 *       stage shows OfflineActionHelper", independent of count), this
 *       must show the helper too, exactly like (d).
 *
 * The fix replaces the count comparison with `_stageIdsWithLoadedList`,
 * a plain per-render-instance `Set` of stage ids whose list has loaded
 * at least once (`crm_kanban_renderer.js setup()`'s own comment explains
 * why no framework signal for this exists and why a `Set` rather than a
 * `signal`/`computed`). (a)/(b)/(c) below are unfolded online once, each
 * through the real `_mobilePipelineGoTo` navigation path (never a direct
 * model call) -- the only way, in this build, to load a stage's list,
 * since there is no fold toggle in the mobile pipeline's own header
 * (hidden by crm_kanban_renderer.scss for the active stage); folding
 * them back is a direct model call instead.
 *
 * (c) and (e) both need a stage whose count is 0 by the time the offline
 * assertions run. The mock server's `group_expand` only *keeps* a group
 * that the model has already seen once it then loses its last record
 * (`relational_model.js`'s own "re-splice a vanished-but-known group back
 * in with count 0" logic, lines ~685-712) -- unlike the real ORM's
 * `field.determine_group_expand`, it never conjures a group for a stage
 * that had zero records from the very first `web_read_group`. So both
 * stages are seeded with one lead each (so the initial `web_read_group`
 * creates their column), and that lead is deleted before the offline
 * assertions: (c)'s stage is unfolded online first (loading that one
 * record), then its record is deleted through the group's own
 * `deleteRecords` (same path crm_offline_mobile_scrutiny_round2.test.js's
 * own VAL-MOBILE-006 test already uses for exactly this reason), landing
 * on "loaded, now empty"; (e)'s stage is never unfolded at all -- its
 * one record is deleted directly through the model's `orm`, with a plain
 * `model.load()` standing in for whatever later full-model reload would
 * ordinarily notice the deletion in production (a sync-refresh, another
 * stage's own full reload, ...) -- landing on "never loaded, empty".
 *
 * Both of those deletes end in a full `model.load()`
 * (`DynamicList._deleteRecords` for (c)'s own, a bare call for (e)'s),
 * which rebuilds every `Group` object from scratch -- so group
 * references are always re-looked up by name afterwards rather than
 * reused, same as round2's own test -- and only *currently open*
 * groups get their records re-inlined by it (the same `opening_info`
 * mechanism that lets an unfolded group survive a reload at all); a
 * folded one comes back with an empty list regardless of what it had
 * loaded before, indistinguishable from never having loaded at all.
 * That is why (a)'s and (b)'s own stages are folded back only once,
 * at the very end of the online setup, after both of these reloads:
 * refolding them any earlier would have both reloads below wipe their
 * just-loaded records before this test ever gets to prove anything
 * about them offline. Folding is a pure local flag flip (`toggle()`
 * only reloads going *into* unfolded), so deferring it changes nothing
 * about what a real, single fold/unfold the user actually did would
 * look like.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    expected_revenue = fields.Float();
    // `group_expand` mirrors crm.lead's real `stage_id` field so every
    // stage keeps its own kanban column for the life of this test (same
    // reasoning as crm_offline_mobile_scrutiny_round2.test.js's identical
    // field) once that column has been seen at least once -- see the
    // module doc comment above for why every stage still needs at least
    // one lead at creation time.
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
        search: `<search/>`,
    };
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    sequence = fields.Integer({ default: 10 });
    fold = fields.Boolean({ default: false });

    _records = [
        { id: 1, name: "New", sequence: 1 }, // entry stage, not folded
        { id: 2, name: "AllLoaded", sequence: 2, fold: true }, // (a)
        { id: 3, name: "Partial", sequence: 3, fold: true }, // (b)
        { id: 4, name: "EmptyLoaded", sequence: 4, fold: true }, // (c)
        { id: 5, name: "NeverNonEmpty", sequence: 5, fold: true }, // (d)
        { id: 6, name: "NeverEmpty", sequence: 6, fold: true }, // (e)
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
test("VAL-MOBILE-006 matrix: offline, a folded stage shows the helper exactly when its list was never loaded, independent of its count", async () => {
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
        // (a): exactly 2 leads, matching the kanban arch's own limit, so
        // unfolding loads every one of them.
        { name: "AL 1", stage_id: 2, expected_revenue: 10 },
        { name: "AL 2", stage_id: 2, expected_revenue: 20 },
        // (b): 3 leads, limit 2 -- unfolding loads only 2 of 3.
        { name: "P 1", stage_id: 3, expected_revenue: 10 },
        { name: "P 2", stage_id: 3, expected_revenue: 20 },
        { name: "P 3", stage_id: 3, expected_revenue: 30 },
        // (c): one lead, unfolded online then deleted below so the
        // stage's column survives its own emptying (see module doc).
        { name: "EL 1", stage_id: 4, expected_revenue: 10 },
        // (d): never unfolded online, has leads.
        { name: "NN 1", stage_id: 5, expected_revenue: 10 },
        // (e): one lead, deleted below without ever unfolding the stage.
        { name: "NE 1", stage_id: 6, expected_revenue: 10 },
    ]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    const findGroup = (name) => model.root.groups.find((g) => g.displayName === name);

    // Online: unfold AllLoaded, Partial and EmptyLoaded through the real
    // navigation path -- and leave all three unfolded for now. A full
    // `model.load()` (triggered below by EmptyLoaded's own deletion and
    // by NeverEmpty's) rebuilds every `Group` from scratch
    // (`DynamicGroupList`'s constructor always re-creates its group
    // datapoints) and a *folded* group's records never survive that
    // (only `__records` inlined for a *currently open* group does, the
    // same `opening_info` mechanism that re-fetches an unfolded group's
    // own page on any reload) -- so refolding AllLoaded/Partial/
    // EmptyLoaded has to wait until after both reloads, or they would
    // come back from each one with their records wiped, same as a
    // never-loaded stage. Folding them is a pure local flag flip
    // (`toggle()` only reloads going *into* unfolded), so doing it last
    // changes nothing about what this test proves.
    await contains(".o_crm_mobile_pipeline_next").click(); // New -> AllLoaded
    expect(".o_crm_mobile_pipeline_title").toHaveText("AllLoaded");
    expect(findGroup("AllLoaded").isFolded).toBe(false);
    expect(findGroup("AllLoaded").list.records.length).toBe(2);
    expect(findGroup("AllLoaded").count).toBe(2);

    await contains(".o_crm_mobile_pipeline_next").click(); // AllLoaded -> Partial
    expect(".o_crm_mobile_pipeline_title").toHaveText("Partial");
    expect(findGroup("Partial").isFolded).toBe(false);
    expect(findGroup("Partial").list.records.length).toBe(2); // capped by limit="2"
    expect(findGroup("Partial").count).toBe(3);

    await contains(".o_crm_mobile_pipeline_next").click(); // Partial -> EmptyLoaded
    expect(".o_crm_mobile_pipeline_title").toHaveText("EmptyLoaded");
    expect(findGroup("EmptyLoaded").isFolded).toBe(false);
    expect(findGroup("EmptyLoaded").list.records.length).toBe(1);
    expect(findGroup("EmptyLoaded").count).toBe(1);

    // EmptyLoaded: delete its one lead through the group's own
    // `deleteRecords` -- same path round2's own VAL-MOBILE-006 test
    // uses -- which ends in a full `model.load()` (dynamic_list.js).
    // Every `Group` reference (including AllLoaded's and Partial's) is
    // stale the instant this resolves, so all three are re-looked-up by
    // name afterwards, same as round2's own test warns.
    await findGroup("EmptyLoaded").deleteRecords(findGroup("EmptyLoaded").list.records);
    expect(findGroup("EmptyLoaded").count).toBe(0);
    expect(findGroup("EmptyLoaded").list.records.length).toBe(0);
    expect(findGroup("EmptyLoaded").isFolded).toBe(false);
    // AllLoaded and Partial, both still unfolded throughout, keep their
    // own records across that reload (the `opening_info` mechanism
    // above).
    expect(findGroup("AllLoaded").list.records.length).toBe(2);
    expect(findGroup("Partial").list.records.length).toBe(2);

    // NeverEmpty: never unfolded. Delete its one lead directly through
    // the model's own `orm`, then force the same kind of full reload a
    // real sync-refresh or another stage's own change would eventually
    // cause -- `NeverEmpty`'s group must stay folded and untouched
    // throughout, so this cannot go through `deleteRecords`, which needs
    // the stage's own records loaded (i.e. unfolded) to call in the
    // first place.
    const neverEmptyLead = pyEnv["crm.lead"].search([["stage_id", "=", 6]]);
    await model.orm.unlink("crm.lead", neverEmptyLead);
    await model.load();
    expect(findGroup("NeverEmpty").isFolded).toBe(true);
    expect(findGroup("NeverEmpty").count).toBe(0);
    expect(findGroup("NeverEmpty").list.records.length).toBe(0);
    // AllLoaded, Partial and EmptyLoaded, all still unfolded, keep their
    // post-deletion state across this second reload too.
    expect(findGroup("AllLoaded").list.records.length).toBe(2);
    expect(findGroup("Partial").list.records.length).toBe(2);
    expect(findGroup("EmptyLoaded").list.records.length).toBe(0);

    // Round 4 (synthesis.json, VAL-MOBILE-006): AllLoaded and Partial
    // both have real records, so `_webReadGroup`'s `opening_info`
    // (relational_model.js, built from each group's own *current*
    // `isFolded` right before the request) reliably asks the server to
    // keep them open across the reload above, and `isFolded` comes back
    // `false`. EmptyLoaded has none -- it only survives this reload at
    // all through the mock server's `group_expand` re-splice (module
    // doc comment above), which does not reproduce that same
    // opening_info handling for a group with no records of its own, so
    // its `isFolded` here is not reliably `false` the way the other
    // two's is. Force a deterministic cycle through the exact same
    // `toggle()` a real re-open/re-fold would use -- fold first (a
    // no-op if this reload already left it folded), then unfold again
    // (which always calls `list.load()`, since it is now definitely
    // folded going in) -- so EmptyLoaded reaches the shared flush/
    // fold-back below in the same known-open, known-loaded state as
    // AllLoaded and Partial, regardless of what this reload left it in.
    if (!findGroup("EmptyLoaded").isFolded) {
        await findGroup("EmptyLoaded").toggle();
    }
    await findGroup("EmptyLoaded").toggle();
    expect(findGroup("EmptyLoaded").isFolded).toBe(false);
    expect(findGroup("EmptyLoaded").list.records.length).toBe(0);

    // Round 4 (synthesis.json, VAL-MOBILE-006): the reloads above handed
    // AllLoaded, Partial and EmptyLoaded a brand-new `group.list` object
    // each (every `Group` is rebuilt from scratch, per this file's own
    // module doc comment) -- the renderer's fetched-state tracker is
    // now keyed on that object's identity, not the stage id, so only
    // the setup() effect's own `!group.isFolded` sweep re-marks these
    // new lists as loaded (the explicit mark `_mobilePipelineGoTo` added
    // before any of the reloads above pointed at the now-discarded old
    // objects). Flush pending effects here, while all three are still
    // unfolded, so that sweep runs before the fold-back below --
    // otherwise the offline assertions for (a)/(b)/(c) would wrongly see
    // their post-reload lists as never loaded. The effect is a reactive
    // `effect()` (owl.js), batched via one `Promise.resolve().then()`
    // hop (`batchProcessEffects`), not a timer, hence `animationFrame()`
    // (every other flush in this suite) rather than `runAllTimers()`.
    await animationFrame();

    // Now fold AllLoaded, Partial and EmptyLoaded back -- a pure local
    // flag flip, no RPC, no further `model.load()` -- so each one's
    // just-loaded state is exactly what the offline assertions below
    // see (no fold toggle exists in the mobile pipeline's own header,
    // hence going through the model directly, same as round1/round2).
    await findGroup("AllLoaded").toggle();
    expect(findGroup("AllLoaded").isFolded).toBe(true);
    await findGroup("Partial").toggle();
    expect(findGroup("Partial").isFolded).toBe(true);
    await findGroup("EmptyLoaded").toggle();
    expect(findGroup("EmptyLoaded").isFolded).toBe(true);

    // Back to "New". NeverNonEmpty and NeverEmpty are never visited
    // online at all, so their lists stay unloaded.
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");

    let rpcCount = 0;
    onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
        rpcCount++;
        return parent();
    });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // (a) loaded, all cards: no helper, nothing left to load.
    rpcCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("AllLoaded");
    expect(
        `.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`
    ).toHaveCount(0);
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name")).toEqual([
        "AL 1",
        "AL 2",
    ]);
    // Scoped to the active stage: every column stays mounted in the DOM
    // (crm_kanban_renderer.scss hides inactive ones), so an unscoped
    // `.o_kanban_load_more` lookup would also match Partial's own
    // (inactive) one below.
    expect(".o_crm_mobile_pipeline_active .o_kanban_load_more").toHaveCount(0);
    expect(rpcCount).toBe(0);

    // (b) loaded partially (2 of 3): the 2 loaded cards show, no helper;
    // "Load more" is present (1 lead still unloaded) but disabled, like
    // any framework button without `data-available-offline`.
    rpcCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Partial");
    expect(
        `.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`
    ).toHaveCount(0);
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name").length).toBe(2);
    expect(".o_crm_mobile_pipeline_active .o_kanban_load_more button").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_kanban_load_more button").toHaveProperty(
        "disabled",
        true
    );
    expect(rpcCount).toBe(0);

    // (c) loaded and genuinely empty: no helper, no cards, no "Load more".
    rpcCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("EmptyLoaded");
    expect(
        `.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`
    ).toHaveCount(0);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_card").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_active .o_kanban_load_more").toHaveCount(0);
    expect(rpcCount).toBe(0);

    // (d) never loaded, count > 0: the helper, no cards.
    rpcCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("NeverNonEmpty");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(
        `.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`
    ).toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_card").toHaveCount(0);
    expect(rpcCount).toBe(0);

    // (e) never loaded, count 0: the helper too -- VAL-MOBILE-006's
    // "uncached stage shows OfflineActionHelper" rule does not carve out
    // an exception for a zero count.
    rpcCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("NeverEmpty");
    expect(".o_crm_mobile_pipeline_count").toHaveText("0");
    expect(
        `.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`
    ).toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_card").toHaveCount(0);
    expect(rpcCount).toBe(0);
});
