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
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * m4-sync-refresh (architecture.md §3.4, VAL-MOBILE-018): the fix for the
 * known limit `crm_offline_mobile_quick_create.test.js`'s own VAL-MOBILE-010
 * test used to document -- once a stage's queued lead create(s) finish
 * replaying, `CrmKanbanRenderer`'s mobile-pipeline branch reloads *that
 * stage's own list only* (`group.list.load()`), so the real card replaces
 * the pending-sync one with no page reload, no navigation and no
 * duplicate, while every other stage issues no RPC at all.
 *
 * Both stages are unfolded (`fold: false`, the default) with one seeded
 * lead each: the comment in crm_offline_mobile_quick_create.test.js
 * explains why ("a mock crm.stage has no `_read_group_expand_full`, so
 * `web_read_group` only returns a group for a stage that has at least one
 * record"), and -- the reason it matters here -- an unfolded group's
 * records are inlined in that same initial `web_read_group` response
 * (crm_offline_mobile_pipeline.test.js's own "offline, an already-cached
 * stage still renders..." test proves this: stepping onto an unfolded
 * stage issues no further RPC). So the *only* `web_search_read` this file
 * expects, ever, is the one the fix issues after replay for the one stage
 * whose queue just emptied.
 *
 * m4-fix-header-after-sync (VAL-MOBILE-003/018): the kanban arch below now
 * also declares a `<progressbar sum_field="expected_revenue">`, the same
 * shape the real pipeline arch uses, so `CrmMobilePipeline`'s header
 * actually renders a revenue total (`<AnimatedNumber>`, `.o_animated_
 * number`) to assert on -- without it `progressBarState` is `undefined`
 * and the revenue half of the header's bug (stale count *and* stale sum)
 * can't be exercised at all. `colors="{}"`: this file never clicks a
 * progress-bar segment, so the bar-color mapping itself is irrelevant,
 * only the `sum_field` aggregate is.
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
        context: { default_type: "opportunity" },
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
]);

async function seedLeads() {
    const pyEnv = await startServer();
    pyEnv["crm.lead"].create([
        { name: "Lead New", stage_id: 1, expected_revenue: 100 },
        { name: "Lead Qualified", stage_id: 2, expected_revenue: 50 },
    ]);
}

test.tags("mobile");
test("VAL-MOBILE-018: after an offline quick-create replays, only its own stage reloads and the real card replaces the pending one, with no duplicate", async () => {
    await seedLeads();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless startup sync now, while the queue is
    // empty (crm_offline_mobile_card.test.js's own note on why).
    await runAllTimers();

    const searchReadDomains = [];
    onRpc("web_search_read", ({ kwargs, parent }) => {
        searchReadDomains.push(kwargs.domain);
        return parent();
    });
    // m4-fix-header-after-sync: the two RPCs `progressBarState.
    // updateCounts(group)` issues to refresh a stage's header after its
    // own per-group reload -- counted from here on so the initial
    // mount's own `read_progress_bar` (issued once for every stage by
    // the progress bar's own `loadProgressBar`, architecture.md §3.4)
    // isn't mistaken for one of them. Neither is a stage-list reload
    // (that is `web_search_read`, tracked separately above): documents
    // exactly which RPCs the fix adds, and that they fire exactly once.
    let readProgressBarCalls = 0;
    let formattedReadGroupCalls = 0;
    onRpc("read_progress_bar", ({ parent }) => {
        readProgressBarCalls++;
        return parent();
    });
    onRpc("formatted_read_group", ({ parent }) => {
        formattedReadGroupCalls++;
        return parent();
    });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Still on "New" (stage 1, the default active stage). Before anything
    // is queued, the header matches the one seeded lead.
    expect(".o_crm_mobile_pipeline_title").toHaveText("New");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText("100");

    await contains(".o_crm_mobile_pipeline_add").click();
    await contains(".o_crm_mobile_quick_create_name").edit("Offline Lead", { confirm: false });
    await contains(".o_crm_mobile_quick_create_expected_revenue").edit("200", {
        confirm: false,
    });
    await contains(".o_crm_mobile_quick_create_save").click();
    await animationFrame();

    expect(".o_bottom_sheet").toHaveCount(0);
    const queueAfterCreate = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queueAfterCreate.filter(({ value }) => value.model === "crm.lead").length).toBe(1);

    // The pending card, in "New" only.
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(1);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create_name").toHaveText(
        "Offline Lead"
    );

    // No `web_search_read` at all yet: the create is only queued, not
    // replayed, and the pending card above came from the queue, not a
    // reload.
    expect(searchReadDomains.length).toBe(0);
    // VAL-MOBILE-003/018 (m4-fix-header-after-sync): the header still
    // shows the pre-sync numbers -- a queued, unsynced create is not
    // reflected there (only the pending-sync card above is).
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText("100");

    await setOffline(false);
    await runAllTimers();
    await animationFrame();
    // Belt-and-suspenders second flush, like crm_offline_mobile_quick_
    // create.test.js's own replay assertion: a single runAllTimers()
    // only advances to the furthest timer that already existed when it
    // was called.
    await runAllTimers();
    await animationFrame();

    // The queue is empty: the create replayed successfully.
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

    // VAL-MOBILE-018: exactly one reload RPC, scoped to "New" (stage 1)
    // only -- never a page reload/navigation (the same mounted WebClient
    // and action are still showing), and never one for "Qualified"
    // (stage 2), which never had a queued create.
    expect(searchReadDomains.length).toBe(1);
    const domainJSON = JSON.stringify(searchReadDomains[0]);
    expect(domainJSON.includes(JSON.stringify(["stage_id", "=", 1]))).toBe(true);
    expect(domainJSON.includes(JSON.stringify(["stage_id", "=", 2]))).toBe(false);

    // m4-fix-header-after-sync (VAL-MOBILE-003/018): the header now
    // includes the synced lead -- count and revenue sum both current --
    // with no page reload, and the two aggregate RPCs that refreshed it
    // fired exactly once each.
    expect(".o_crm_mobile_pipeline_count").toHaveText("2");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText("300");
    expect(readProgressBarCalls).toBe(1);
    expect(formattedReadGroupCalls).toBe(1);

    // The pending card is gone, replaced by exactly one real card for the
    // synced lead -- no duplicate, and the pre-existing "Lead New" card is
    // still there untouched.
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(0);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_card_pending_sync").toHaveCount(0);
    const cardNames = queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name");
    expect(cardNames.length).toBe(2);
    expect(new Set(cardNames)).toEqual(new Set(["Lead New", "Offline Lead"]));

    // "Qualified" (stage 2) is untouched: still its one original lead,
    // no pending card, no second reload triggered by stepping onto it --
    // and its own header numbers are unaffected (never recomputed from a
    // list reload of its own, only from the one combined aggregate
    // response above).
    await contains(".o_crm_mobile_pipeline_next").click();
    expect(".o_crm_mobile_pipeline_title").toHaveText("Qualified");
    expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    expect(".o_crm_mobile_pipeline_header .o_animated_number").toHaveText("50");
    expect(queryAllTexts(".o_crm_mobile_pipeline_active .o_crm_mobile_card_name")).toEqual([
        "Lead Qualified",
    ]);
    expect(".o_crm_mobile_pipeline_active .o_crm_mobile_pending_lead_create").toHaveCount(0);
    // Still exactly one search_read overall: visiting the already-loaded
    // "Qualified" issues no RPC of its own.
    expect(searchReadDomains.length).toBe(1);
});

test.tags("desktop");
test("VAL-MOBILE-018: desktop is unaffected -- a stage's queued create emptying issues no reload RPC", async () => {
    await seedLeads();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    const searchReadDomains = [];
    onRpc("web_search_read", ({ kwargs, parent }) => {
        searchReadDomains.push(kwargs.domain);
        return parent();
    });
    onRpc("crm.lead", "web_save", ({ parent }) => parent());

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // No mobile pipeline on desktop: queue the create directly, the same
    // shape the mobile quick-create sheet's own producer uses
    // (`web_save([], vals)`, architecture.md §3.4), to exercise the
    // renderer's sync-refresh effect without the sheet that only exists
    // on small screens.
    getService(OfflinePlugin).scheduleORM(
        "crm.lead",
        "web_save",
        [[], { name: "Offline Lead", stage_id: 1 }],
        { context: {}, specification: {} },
        { extras: { timeStamp: Date.now() } }
    );
    await animationFrame();
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1);

    await setOffline(false);
    await runAllTimers();
    await animationFrame();
    await runAllTimers();
    await animationFrame();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    // `CrmKanbanRenderer.isMobilePipeline` is false on desktop (not
    // `ui.isSmall()`), so the sync-refresh effect's `useCrmOffline().
    // pendingLeadCreates()` transition is never read as a reload trigger:
    // no `web_search_read` results from the replay above, exactly the
    // known-limit behaviour `crm_offline_mobile_quick_create.test.js`'s
    // own online test (VAL-MOBILE-011) already keeps proving unchanged
    // for desktop.
    expect(searchReadDomains.length).toBe(0);
});
