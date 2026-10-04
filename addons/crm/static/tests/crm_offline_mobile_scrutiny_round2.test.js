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
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { RelationalModel } from "@web/model/relational_model/relational_model";
import { WebClient } from "@web/webclient/webclient";
import { CrmKanbanModel } from "@crm/views/crm_kanban/crm_kanban_model";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * validation/mobile-ui/scrutiny/synthesis.json (M4 scrutiny round 2),
 * orchestrator-triage.md: two boundary failures of round 1's own fixes.
 * `crm_offline_mobile_scrutiny_fixes.test.js`'s "blocker 5" test only
 * ever queued one create for one stage (a single 1->0 queue transition),
 * so it never exercised two creates for the same stage draining one at a
 * time; its "blockers 2/4" test only ever folded a *non-empty* stage, so
 * it never told a loaded-but-empty folded stage apart from one never
 * fetched at all. Both existing tests keep passing unmodified; the three
 * tests below add the missing boundaries. All three are gated on
 * `CrmKanbanRenderer.isMobilePipeline`, so none needs a desktop
 * counterpart (desktop never reaches either branch -- already proven
 * unaffected by crm_offline_mobile_sync_refresh.test.js's own desktop
 * test).
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    contact_name = fields.Char();
    phone = fields.Char();
    email_from = fields.Char();
    expected_revenue = fields.Float();
    // `group_expand` mirrors crm.lead's real `stage_id` field
    // (`models/crm_lead.py`'s `_read_group_stage_ids`): without it, the
    // mock server would drop a stage's own kanban column the moment its
    // last lead is deleted below, which is not what a real pipeline does.
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
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Won", sequence: 2, fold: true },
        { id: 3, name: "Lost", sequence: 3, fold: true },
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
test("VAL-MOBILE-003/018: two queued creates in one stage replaying separately at the count limit still give the exact header count, and other stages issue no list reload", async () => {
    patchWithCleanup(RelationalModel, { DEFAULT_COUNT_LIMIT: 2 });

    const pyEnv = await startServer();
    // Three leads already in "New" -- past the patched count limit (2),
    // so a reload of this stage's own list is capped once reconnected.
    // "Won" gets just one, far under the limit, to prove it is
    // untouched by the fix below.
    pyEnv["crm.lead"].create([
        { name: "Lead 1", stage_id: 1, expected_revenue: 100 },
        { name: "Lead 2", stage_id: 1, expected_revenue: 100 },
        { name: "Lead 3", stage_id: 1, expected_revenue: 100 },
        { name: "Lead Won", stage_id: 2, expected_revenue: 10 },
    ]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_count").toHaveText("3");

    const searchReadDomains = [];
    onRpc("web_search_read", ({ kwargs, parent }) => {
        searchReadDomains.push(kwargs.domain);
        return parent();
    });
    let searchCountCalls = 0;
    onRpc("search_count", ({ parent }) => {
        searchCountCalls++;
        return parent();
    });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Two queued creates in "New" -- the undercount this guards against
    // only shows up with at least two entries for the same stage, so the
    // queue drains one at a time (2->1->0) once `_syncORM` starts
    // replaying them, instead of the single-entry (1->0) transition
    // round 1's own "blocker 5" test exercised.
    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("Lead 4", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();

    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("Lead 5", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();

    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(2);
    const queueOffline = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queueOffline.filter(({ value }) => value.model === "crm.lead").length).toBe(2);

    await setOffline(false);
    // `_syncORM` replays queued entries one at a time with a 1s pause
    // between them (offline_plugin.js): several flush cycles so both
    // replays -- and the effect run each one triggers -- actually
    // complete, not just the first.
    for (let i = 0; i < 4; i++) {
        await runAllTimers();
        await animationFrame();
    }

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

    // Five real leads now exist in "New" (3 seeded + 2 synced). Round 1's
    // own hand-kept map only ever remembered the last-seen *non-zero*
    // pending count (1, by the time the queue reached 0, since the first
    // replay's own effect run already overwrote "2" with "1"), so it
    // would have landed on 3 + 1 = 4 instead of 5.
    expect(".o_crm_mobile_pipeline_count").toHaveText("5");

    // The fix asks the server for the stage's exact count exactly once:
    // the list reload's own `web_search_read` is itself capped at 2
    // (`hasLimitedCount`), so exactly one `search_count` (`fetchCount()`)
    // corrects it -- not once per replay, and not for "Won", which never
    // had anything queued and whose own list is never reloaded by this
    // effect pass.
    expect(searchCountCalls).toBe(1);
    const wonSearchReads = searchReadDomains.filter((domain) =>
        JSON.stringify(domain).includes(JSON.stringify(["stage_id", "=", 2]))
    );
    expect(wonSearchReads.length).toBe(0);

    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
});

test.tags("mobile");
test("VAL-MOBILE-003/018: a create discarded from the systray while offline leaves the header count unchanged on reconnect", async () => {
    const pyEnv = await startServer();
    pyEnv["crm.lead"].create([{ name: "Lead New", stage_id: 1, expected_revenue: 100 }]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    expect(".o_crm_mobile_pipeline_count").toHaveText("1");

    const searchReadDomains = [];
    onRpc("web_search_read", ({ kwargs, parent }) => {
        searchReadDomains.push(kwargs.domain);
        return parent();
    });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("Offline Lead", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(1);

    // Discard it from the offline systray while still offline -- the
    // queue drains to 0 with nothing replayed and no server change
    // (architecture.md's own "a discard removes the pending card without
    // changing the server").
    await contains(".o_menu_systray .o_nav_entry.o_offline_systray").click();
    expect(".o-dropdown--menu span.o_tag.badge").toHaveCount(1);
    await contains(".o-dropdown--menu button[data-icon='delete']").click();
    expect(".modal-footer .btn-primary").toHaveCount(1);
    await contains(".modal-footer .btn-primary").click();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(0);
    // Still offline: the discard alone must not have reloaded anything.
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(searchReadDomains.length).toBe(0);

    await setOffline(false);
    await runAllTimers();
    await animationFrame();
    await runAllTimers();
    await animationFrame();

    // Nothing was queued any more at reconnection, so `_syncORM` has
    // nothing to replay for "New". Round 1's own fix kept the discarded
    // create's count sitting in its map and wrongly credited it as a
    // sync the moment this stage was next observed online, bumping the
    // header to 2 with no RPC to show for it.
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(searchReadDomains.length).toBe(0);
});

test.tags("mobile");
test("VAL-MOBILE-006: a folded stage loaded online and genuinely empty shows the normal empty stage offline, while a never-loaded folded stage still shows the helper", async () => {
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
        { name: "Lead Won", stage_id: 2, expected_revenue: 10 },
        { name: "Lead Lost", stage_id: 3, expected_revenue: 20 },
    ]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    // Online: unfold "Won", confirm its one lead loaded, then delete it
    // through the same `web_unlink` path the kanban action menu uses.
    // `DynamicList._deleteRecords` finishes with a full `model.load()`,
    // which rebuilds `model.root` (and every `Group`) from scratch, so
    // `wonGroup` itself goes stale the moment the delete resolves -- the
    // group for "Won" has to be looked up again afterwards, same as a
    // real controller would re-render from the model's own new root
    // rather than keep using an old `Group` reference.
    let wonGroup = model.root.groups.find((g) => g.displayName === "Won");
    await wonGroup.toggle();
    expect(wonGroup.records.length).toBe(1);
    await wonGroup.deleteRecords(wonGroup.records);
    wonGroup = model.root.groups.find((g) => g.displayName === "Won");
    // "Won" keeps existing with `count` and `list.records` both back at
    // 0 -- the same shape a kanban column keeps after its last card is
    // deleted -- instead of disappearing, because the mock `stage_id`
    // field is declared `group_expand: true` above (mirrors crm.lead's
    // real one, `models/crm_lead.py`'s `_read_group_stage_ids`).
    expect(wonGroup.count).toBe(0);
    expect(wonGroup.records.length).toBe(0);
    expect(wonGroup.isFolded).toBe(false);
    // Fold it again: `toggle()` only reloads when going from folded to
    // unfolded, so this flips the flag with no RPC.
    await wonGroup.toggle();
    expect(wonGroup.isFolded).toBe(true);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    let rpcCount = 0;
    onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
        rpcCount++;
        return parent();
    });

    // "Won": folded, loaded, genuinely empty -- the normal empty stage,
    // not the helper, and no RPC (never toggled while offline).
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(".o_crm_mobile_pipeline_count").toHaveText("0");
    expect(".o_crm_mobile_pipeline_active .o_view_nocontent").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_card").toHaveCount(0);
    expect(rpcCount).toBe(0);

    // "Lost": folded, has one lead, never unfolded -- still uncached,
    // the helper shows, same as before this fix.
    rpcCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Lost");
    expect(
        `.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`
    ).toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_card").toHaveCount(0);
    expect(rpcCount).toBe(0);
});
