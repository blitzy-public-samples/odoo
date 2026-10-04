import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { queryAllTexts } from "@odoo/hoot-dom";
import {
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    switchView,
} from "@web/../tests/web_test_helpers";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { WebClient } from "@web/webclient/webclient";
import { CrmColumnProgress } from "@crm/views/crm_kanban/crm_column_progress";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * Defect 5 (architecture.md §3.2 item 5 / offline_inventory.md row A7):
 * `CrmColumnProgress.onWillStart` must not call `user.hasGroup(
 * "crm.group_use_recurring_revenues")` while offline -- an uncached probe
 * issued offline would stay rejected in the disk cache for the rest of the
 * page's life (architecture.md §2), the same reasoning already applied to
 * the team-switcher's sales-manager probe
 * (crm_offline_team_switcher.test.js). `showRecurringRevenue` keeps its
 * `false` default, so the MRR line is simply absent, not shown as "0"
 * (VAL-FIX-009): `crm.ColumnProgress`'s template only renders the MRR
 * `AnimatedNumber` inside `<t t-if="this.showRecurringRevenue">`.
 */

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    is_won = fields.Boolean({ string: "Is won" });

    _records = [{ id: 1, name: "New" }];
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();
}

class Users extends models.Model {
    name = fields.Char();

    // Matches the probed group only; this file never asks about any other
    // group, so a single unconditional answer is enough (unlike
    // crm_offline_team_switcher.test.js's `Users`, which must also answer
    // a *different* group probe truthfully).
    has_group() {
        return true;
    }

    _records = [{ id: 1, name: "Mitchell Admin" }];
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    activity_state = fields.Char({ string: "Activity State" });
    expected_revenue = fields.Integer({ string: "Revenue", sortable: true, aggregator: "sum" });
    recurring_revenue_monthly = fields.Integer({
        string: "Recurring Revenue",
        sortable: true,
        aggregator: "sum",
    });
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });

    _records = [
        {
            id: 1,
            name: "Lead 1",
            activity_state: "planned",
            expected_revenue: 10,
            recurring_revenue_monthly: 5,
            stage_id: 1,
        },
        {
            id: 2,
            name: "Lead 2",
            activity_state: "today",
            expected_revenue: 4,
            recurring_revenue_monthly: 20,
            stage_id: 1,
        },
    ];

    _views = {
        kanban: `
            <kanban js_class="crm_kanban">
                <field name="activity_state"/>
                <progressbar field="activity_state" colors='{"planned": "success", "today": "warning", "overdue": "danger"}' sum_field="expected_revenue" recurring_revenue_sum_field="recurring_revenue_monthly"/>
                <templates>
                    <t t-name="card"><field name="name" class="p-2"/></t>
                </templates>
            </kanban>`,
        list: `<list js_class="crm_list"><field name="name"/></list>`,
        search: `<search/>`,
    };
}

defineModels([Lead, Users, Stage, Team]);
defineMailModels();
patchWithCleanup(AnimatedNumber, { enableAnimations: false });
defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: { group_by: ["stage_id"] },
        views: [
            [false, "kanban"],
            [false, "list"],
        ],
    },
]);

// ---------------------------------------------------------------------------
// VAL-FIX-009 / VAL-SKIP-002: a `CrmColumnProgress` mount never issues the
// recurring-revenues probe while offline. Mounts the component directly
// (as crm_offline_team_switcher.test.js does for `TeamSwitcher`) with
// hand-built props, decoupled from the kanban/view-loading stack: opening a
// kanban view that was never visited online has its own offline story
// (`OfflineActionHelper`), unrelated to this probe.
// ---------------------------------------------------------------------------
test("offline, a CrmColumnProgress mount issues no has_group probe and renders no MRR aggregate", async () => {
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] === "crm.group_use_recurring_revenues") {
            expect.step("has_group");
        }
    });
    // `mockCrmOffline()`'s `setOffline()` needs a running test app/service
    // registry (`getService(OfflinePlugin)`), so a throwaway WebClient is
    // mounted first purely to bring that up; `mockCrmOffline()` settles its
    // background "/mail/store" poll before the connection drops, so it
    // never surfaces here.
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await setOffline(true);
    await mountWithCleanup(CrmColumnProgress, {
        props: {
            aggregate: { value: 14, title: "Revenue", currencies: [false] },
            group: { count: 2, _config: { fields: {} } },
            progressBar: { bars: [], isReady: true },
            progressBarState: {
                progressAttributes: { recurring_revenue_sum_field: "recurring_revenue_monthly" },
                getAggregateValue: () => {
                    throw new Error("getAggregateValue must not be called offline");
                },
            },
            onRotIconClicked: () => {},
        },
    });

    expect.verifySteps([]); // has_group was never called
    // The base revenue aggregate still renders (it's a plain prop, not a
    // probed value); only the MRR line, gated on `showRecurringRevenue`,
    // is absent -- not shown as "0".
    expect(".o_animated_number").toHaveCount(1);
    expect(".o_animated_number[data-tooltip='Revenue']").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Scrutiny finding 5 (VAL-FIX-009): `showRecurringRevenue` is computed only
// once, in `onWillStart`, so a column mounted *online* (where it is set to
// `true`) and only taken offline afterwards must still lose the aggregate
// -- the test above only covers a mount that starts offline.
// ---------------------------------------------------------------------------
test("offline, after an online mount, the MRR aggregate disappears; it comes back online", async () => {
    onRpc("res.users", "has_group", ({ args, parent }) => {
        if (args[1] === "crm.group_use_recurring_revenues") {
            expect.step("has_group");
        }
        return parent();
    });
    await mountWithCleanup(WebClient); // bring up the service registry (OfflinePlugin)
    await mountWithCleanup(CrmColumnProgress, {
        props: {
            aggregate: { value: 14, title: "Revenue", currencies: [false] },
            group: { count: 2, _config: { fields: {} } },
            progressBar: { bars: [], isReady: true },
            progressBarState: {
                progressAttributes: { recurring_revenue_sum_field: "recurring_revenue_monthly" },
                getAggregateValue: () => ({ value: 25, title: "Recurring Revenue" }),
            },
            onRotIconClicked: () => {},
        },
    });
    expect.verifySteps(["has_group"]); // mounted online: the probe ran, true
    expect(".o_animated_number[data-tooltip='Recurring Revenue']").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);
    // `showRecurringRevenue` is still `true` (never recomputed), but the
    // aggregate must be absent now, not shown as "0" or stale "25".
    expect(".o_animated_number[data-tooltip='Recurring Revenue']").toHaveCount(0);
    expect(".o_animated_number[data-tooltip='Revenue']").toHaveCount(1); // base aggregate unaffected

    await setOffline(false);
    expect(".o_animated_number[data-tooltip='Recurring Revenue']").toHaveCount(1); // back, with no remount
});

// ---------------------------------------------------------------------------
// VAL-FIX-009 online guard: the probe is still issued online and the MRR
// aggregate still renders, unaffected by the offline check added to
// `onWillStart`. Goes through the full kanban view (unlike the offline test
// above) since there's no online-availability concern to decouple from here.
// ---------------------------------------------------------------------------
test("online, the pipeline kanban still issues the has_group probe and shows the MRR aggregate (guard)", async () => {
    onRpc("res.users", "has_group", ({ args, parent }) => {
        const result = parent();
        if (args[1] === "crm.group_use_recurring_revenues") {
            expect.step("has_group");
        }
        return result;
    });
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: `
            <kanban js_class="crm_kanban">
                <field name="activity_state"/>
                <progressbar field="activity_state" colors='{"planned": "success", "today": "warning", "overdue": "danger"}' sum_field="expected_revenue" recurring_revenue_sum_field="recurring_revenue_monthly"/>
                <templates>
                    <t t-name="card"><field name="name" class="p-2"/></t>
                </templates>
            </kanban>`,
    });

    expect.verifySteps(["has_group"]);
    expect(".o_animated_number[data-tooltip='Recurring Revenue']").toHaveCount(1);
    expect(queryAllTexts(".o_kanban_counter")).toEqual(["14\n+25"]);
});

// ---------------------------------------------------------------------------
// M2 user-testing round-1 (VAL-SKIP-002): the two offline tests above only
// cover a `CrmColumnProgress` mounted directly (hand-built props, no view)
// or a component that was already mounted *before* going offline. Neither
// proves the amended contract's "(re)mounting the pipeline kanban" wording
// through a real kanban controller that is destroyed and recreated while
// already offline (as crm_offline_team_switcher.test.js's own "remounting
// the pipeline kanban" test does for the team switcher's probe). Switching
// to list and back forces exactly that teardown/rebuild of the kanban
// controller and its `CrmColumnProgress` group header.
// ---------------------------------------------------------------------------

test("offline, remounting the pipeline kanban after a view switch still renders the progress bar, with no has_group reissued", async () => {
    onRpc("res.users", "has_group", ({ args, parent }) => {
        const result = parent();
        if (args[1] === "crm.group_use_recurring_revenues") {
            expect.step("has_group");
        }
        return result;
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    expect.verifySteps(["has_group"]); // the initial, online, mount (one stage_id group)
    expect(".o_column_progress").toHaveCount(1);
    expect(".o_animated_number[data-tooltip='Recurring Revenue']").toHaveCount(1);

    await switchView("list");
    // The action's own group_by context (needed for the kanban's progress
    // bar) carries over to the list view too, so it renders one group
    // header rather than ungrouped rows.
    expect(".o_group_header").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);
    // Remounting the kanban controller still attempts to refresh its
    // records (the same cost crm_offline_team_switcher.test.js's own
    // remount test declares); unrelated to the has_group probe, which is
    // what this test is about.
    expect.errors(1);
    await switchView("kanban"); // remount: a fresh kanban controller + progress-bar group header

    // Remounted while offline: the progress bar still renders, with no
    // has_group reissued -- `showRecurringRevenue` defaults to `false` on
    // this fresh mount (the test above this one), so the MRR aggregate
    // itself is correctly absent even though the base progress bar is
    // present.
    expect(".o_column_progress").toHaveCount(1);
    expect(".o_animated_number[data-tooltip='Recurring Revenue']").toHaveCount(0);
    expect.verifySteps([]);
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/crm.lead/web_read_group" couldn't be established or was interrupted`,
    ]);

    await setOffline(false);
});
