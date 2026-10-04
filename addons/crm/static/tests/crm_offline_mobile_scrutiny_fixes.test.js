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
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * validation/mobile-ui/scrutiny/orchestrator-triage.md (M4 scrutiny
 * round-1, blockers 1-6): regression coverage for the six fixes this
 * file is named after -- see each test's own doc comment for the one
 * blocker (and VAL-MOBILE-xxx assertion) it proves. Every scenario below
 * is gated on `CrmKanbanRenderer.isMobilePipeline`
 * (`this.ui.isSmall() && ...`), so none of this needs a desktop
 * counterpart: desktop never takes any of the branches these fixes
 * touch, and the milestone's existing desktop tests (crm_offline_mobile_
 * pipeline.test.js, crm_offline_mobile_quick_create.test.js, crm_
 * offline_mobile_sync_refresh.test.js) already prove that unchanged.
 *
 * `limit="2"` on the arch below (blocker 5's own test patches
 * `RelationalModel.DEFAULT_COUNT_LIMIT` down to match it, the same pair
 * `kanban_view.test.js`'s own "pager, ungrouped, with count limit
 * reached" test uses): harmless for every other test in this file, none
 * of which ever seeds more than two leads in one stage, so `hasLimitedCount`
 * only ever flips to `true` in the one test that deliberately seeds past it.
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

    // "Won" folded by default, like the real pipeline -- the one way to
    // reach a stage whose records are never part of the pipeline's one
    // initial `web_read_group` (research/design_options.md "per-stage
    // offline behaviour").
    _records = [
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Won", sequence: 2, fold: true },
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
test("blocker 1 (VAL-MOBILE-001/009): a queued mobile quick create's extras let the offline systray open, list it as Created and discard it", async () => {
    const pyEnv = await startServer();
    pyEnv["crm.lead"].create([{ name: "Lead 1", stage_id: 1, expected_revenue: 100 }]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless startup sync now, while the queue is
    // empty (established in crm_offline_mobile_card.test.js).
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("Offline Lead", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();

    const queue = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queue.length).toBe(1);
    // Before the fix, extras.changes was undefined on this entry: the
    // systray's own `groupEntries` computed does `Object.entries(value.
    // extras.changes)` unconditionally for every web_save
    // (offline_systray.js) and throws the moment it is read -- which
    // happens the instant the dropdown below is opened.
    expect(queue[0].value.extras.changes).not.toBe(undefined);

    // Opening it does not throw: `.o-dropdown--menu` actually renders
    // (a crash here would leave it absent, not throw synchronously past
    // this await, since groupEntries is only read while painting the
    // open dropdown's content).
    await contains(".o_menu_systray .o_nav_entry.o_offline_systray").click();
    expect(".o-dropdown--menu").toHaveCount(1);

    // Listed as "Created" (web_save with args[0] = [], STATUS.CREATED in
    // offline_systray.js), with the lead's own name as its display name.
    expect(".o-dropdown--menu span.o_tag.badge").toHaveText("Created");
    expect(".o-dropdown--menu .text-truncate").toHaveText("Offline Lead");

    // Discard: the per-entry delete button, then confirm the dialog.
    await contains(".o-dropdown--menu button[data-icon='delete']").click();
    expect(".modal-footer .btn-primary").toHaveCount(1);
    await contains(".modal-footer .btn-primary").click();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o-dropdown--menu span.o_tag.badge").toHaveCount(0);
});

test.tags("mobile");
test("blockers 2/4 (VAL-MOBILE-006/018): a folded stage keeps showing its cards once loaded -- via a sync refresh into the folded active stage, and across a later offline navigation -- while a never-loaded folded stage still shows the offline helper", async () => {
    const pyEnv = await startServer();
    pyEnv["crm.lead"].create([
        { name: "Lead New", stage_id: 1, expected_revenue: 100 },
        { name: "Lead Won", stage_id: 2, expected_revenue: 10 },
    ]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    let rpcCount = 0;
    onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
        rpcCount++;
        return parent();
    });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Step onto "Won" offline: `_mobilePipelineGoTo` never toggles it
    // while offline, so it is still folded and, so far, never loaded --
    // the helper shows, no RPC.
    rpcCount = 0;
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(`.o_crm_mobile_pipeline_active .o_view_nocontent:contains('${HELPER_TEXT}')`).toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_card").toHaveCount(0);
    expect(rpcCount).toBe(0);

    // Queue a create targeting "Won" (the current active stage) without
    // ever navigating away from it.
    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("Synced Won Lead", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(1);

    await setOffline(false);
    await runAllTimers();
    await animationFrame();
    await runAllTimers();
    await animationFrame();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    // Blocker 4: still on "Won" (no click happened), still folded (the
    // sync-refresh effect calls `group.list.load()` directly, it never
    // toggles the group) -- yet the real cards are visible now, with no
    // navigation at all, instead of the helper or a blank body.
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(".o_crm_mobile_pipeline_active .o_view_nocontent").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(0);
    expect(new Set(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name"))).toEqual(
        new Set(["Lead Won", "Synced Won Lead"])
    );

    // Blocker 2: offline again, step away and back onto "Won" -- still
    // folded, but its records are already loaded from the sync above, so
    // it keeps rendering its cards with no RPC at all, instead of the
    // helper a plain `group.isFolded` check would show.
    await setOffline(true);
    rpcCount = 0;
    await contains(".o_crm_mobile_pipeline_prev").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(".o_crm_mobile_pipeline_active .o_view_nocontent").toHaveCount(0);
    expect(new Set(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name"))).toEqual(
        new Set(["Lead Won", "Synced Won Lead"])
    );
    expect(rpcCount).toBe(0);
});

test.tags("mobile");
test("blocker 3 (VAL-MOBILE-003): the header falls back to the group's cached aggregates when the progress bar never becomes ready", async () => {
    const pyEnv = await startServer();
    pyEnv["crm.lead"].create([
        { name: "Lead New", stage_id: 1, expected_revenue: 100 },
        { name: "Lead Won", stage_id: 2, expected_revenue: 10 },
    ]);

    // Simulates an offline remount/reload: the progress bar's own
    // `read_progress_bar` call never succeeds (a genuine `ConnectionLostError`,
    // the same `new Response("", { status: 502 })` shape crm_offline_mrr.
    // test.js's own progress-bar-related tests use), so `_pbCounts` stays
    // null and `getGroupInfo(group).isReady` is false for every group,
    // for the life of this mount -- while the stage's own `web_read_group`
    // (unaffected) still populates `group.aggregates` normally.
    onRpc("read_progress_bar", () => new Response("", { status: 502 }));

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // "New" (the default active stage): the revenue total still shows,
    // read from `group.aggregates.expected_revenue` instead of coming
    // back null/blank.
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText("100");

    // Folded "Won" too: its own aggregate came from the same initial
    // `web_read_group`, independent of the progress bar or of ever being
    // unfolded.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText("10");
});

test.tags("mobile");
test("blocker 5 (VAL-MOBILE-003/018): the post-sync header count adds the synced creates to the exact group count instead of the capped list count", async () => {
    patchWithCleanup(RelationalModel, { DEFAULT_COUNT_LIMIT: 2 });

    const pyEnv = await startServer();
    // Three leads already in "New" -- past the patched count limit (2),
    // so this stage's own list count is capped once reloaded; "Won" gets
    // just one, far under the limit, to prove it is unaffected.
    pyEnv["crm.lead"].create([
        { name: "Lead 1", stage_id: 1, expected_revenue: 100 },
        { name: "Lead 2", stage_id: 1, expected_revenue: 100 },
        { name: "Lead 3", stage_id: 1, expected_revenue: 100 },
        { name: "Lead Won", stage_id: 2, expected_revenue: 10 },
    ]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    // The group's own exact `web_read_group` count, corrected onto the
    // list by `Group._useGroupCountForList()` at mount time (group.js)
    // even though the list's own `web_search_read` capped itself at 2.
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_count").toHaveText("3");

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("Lead 4", { confirm: false });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(1);

    await setOffline(false);
    await runAllTimers();
    await animationFrame();
    await runAllTimers();
    await animationFrame();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    // Four real leads now exist in "New". The sync-refresh effect's own
    // `group.list.load()` reloads a capped list (`hasLimitedCount` true,
    // `list.count` clamped back to 2) -- the fix adds the one synced
    // create to the exact pre-sync count (3) instead of copying that
    // capped number, landing on 4; the pre-fix code would show "2".
    expect(".o_crm_mobile_pipeline_count").toHaveText("4");

    // "Won" (never had anything queued) is untouched by the same effect
    // pass.
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
});

test.tags("mobile");
test("blocker 6 (VAL-MOBILE-002/014): CrmMobilePendingLeadCreate reads its own queued entry from the shared hooks module by key", async () => {
    const pyEnv = await startServer();
    pyEnv["crm.lead"].create([
        { name: "Lead New", stage_id: 1, expected_revenue: 100 },
        { name: "Lead Won", stage_id: 2, expected_revenue: 10 },
    ]);

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Two queued creates in two different stages, queued directly on the
    // plugin (same shape the quick-create sheet's own producer uses) --
    // each `CrmMobilePendingLeadCreate` must resolve to its own entry's
    // name through `entryKey`, not whichever one happens to be first in
    // the queue.
    getService(OfflinePlugin).scheduleORM(
        "crm.lead",
        "web_save",
        [[], { name: "Pending New", stage_id: 1 }],
        { context: {}, specification: {} },
        { extras: { timeStamp: 1 } }
    );
    getService(OfflinePlugin).scheduleORM(
        "crm.lead",
        "web_save",
        [[], { name: "Pending Won", stage_id: 2 }],
        { context: {}, specification: {} },
        { extras: { timeStamp: 2 } }
    );
    await animationFrame();

    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create_name").toHaveText(
        "Pending New"
    );

    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Won");
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create_name").toHaveText(
        "Pending Won"
    );
});
