import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    mockOffline,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    switchView,
} from "@web/../tests/web_test_helpers";
import { user } from "@web/core/user";
import { WebClient } from "@web/webclient/webclient";
import { TeamSwitcher } from "@crm/components/team_switcher/team_switcher";

/**
 * Defect 3 (architecture.md §3.2 item 3 / offline_inventory.md rows
 * A4/A5/A6/A26/C20):
 * - A6/C20 (`crm.team.get_team_switcher_data`): `CrmSearchModel._initSwitcher()`
 *   must degrade to `{available: false, teams: []}` on a cache-miss
 *   rejection instead of rejecting `load()` and aborting the view's mount.
 * - A4 (`user.hasGroup("sales_team.group_sale_manager")`) must never be
 *   issued while offline, not just caught -- `Cache.read()`
 *   (addons/web/static/src/core/utils/cache.js) never evicts a rejected
 *   promise, so an uncached probe issued offline would stay rejected for
 *   the rest of the page's life, even after reconnecting.
 * - A5/A26 ("Manage Teams" / `onSelect`) are reached only through the
 *   switcher's toggler, a plain `<button>` with no `data-available-offline`
 *   (`team_switcher.xml`); the framework's `SELECTORS_TO_DISABLE` already
 *   disables it offline, so these are DOM/reachability-proof tests, not a
 *   crm code fix.
 */

class Users extends models.Model {
    name = fields.Char();
    // Matches the default built-in mock (addons/web/static/tests/
    // _framework/mock_server/mock_models/res_users.js), which this local
    // model replaces: TeamSwitcher.onWillStart calls `user.hasGroup(...)`
    // on every online mount, so "res.users" must answer it even in tests
    // that aren't about A4.
    has_group() {
        return false;
    }

    _records = [{ id: 1, name: "Mitchell Admin" }];
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    use_opportunities = fields.Boolean({ default: true });

    _records = [
        { id: 1, name: "Mushroom Kingdom" },
        { id: 2, name: "Hyrule" },
    ];

    get_team_switcher_data() {
        const teams = this._filter([["use_opportunities", "=", true]]);
        return {
            available: teams.length > 1,
            teams: teams.map((team) => ({
                id: team.id,
                name: team.name,
                switcher_domain: ["|", ["team_id", "=", team.id], ["team_id", "=", false]],
            })),
        };
    }
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();

    _records = [{ id: 1, name: "New" }];
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _records = [
        { id: 1, name: "Lead 1", stage_id: 1, team_id: 1 },
        { id: 2, name: "Lead 2", stage_id: 1, team_id: 2 },
        { id: 3, name: "Lead 3", stage_id: 1 },
    ];

    _views = {
        kanban: `
            <kanban js_class="crm_kanban">
                <templates>
                    <t t-name="card"><field name="name"/></t>
                </templates>
            </kanban>`,
        list: `<list js_class="crm_list"><field name="name"/></list>`,
        search: `<search><field name="team_id"/></search>`,
    };
}

defineModels([Users, Team, Stage, Lead]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: { show_team_switcher: true },
        views: [
            [false, "kanban"],
            [false, "list"],
        ],
    },
    {
        id: "sales_team.crm_team_action_config",
        name: "Team Config",
        res_model: "crm.team",
        type: "ir.actions.act_window",
        views: [[false, "list"]],
    },
]);

// ---------------------------------------------------------------------------
// VAL-FIX-006 / VAL-FIX-007 / VAL-SKIP-001: a `get_team_switcher_data`
// cache-miss degrades the search model instead of rejecting its load.
// Mirrors crm_offline_rainbowman.test.js's "connection lost" test: the RPC
// is forced to fail directly, decoupled from `mockOffline()`, because the
// fix catches `ConnectionLostError` regardless of why it was raised.
// ---------------------------------------------------------------------------

test("a connection lost while fetching the team switcher data degrades to 'All Teams' instead of failing the view", async () => {
    onRpc("crm.team", "get_team_switcher_data", () => new Response("", { status: 502 }));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // CrmSearchModel.load() resolved instead of rejecting: the control
    // panel mounted with the pipeline's own breadcrumb and its records.
    expect(".o_control_panel").toHaveCount(1);
    expect(".o_last_breadcrumb_item:contains('Pipeline')").toHaveCount(1);
    // ":not(.o_kanban_ghost)" excludes the layout-filler placeholder cards
    // the (ungrouped) kanban renderer pads a short row with.
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(3);
    // Degraded to "unavailable": CrmBreadcrumbs falls back to the default
    // web.Breadcrumbs (no team switcher rendered at all) because
    // `isTeamSwitcherEnabled` depends on `switcherAvailable`, which the
    // catch left `false`.
    expect(".o_cp_team_switcher").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
});

// ---------------------------------------------------------------------------
// VAL-SKIP-001 / A4: a team-switcher mount never issues the sales-manager
// probe while offline. Mounts the component directly (as
// crm_offline_hooks.test.js does for useCrmOffline) with a minimal fake
// `searchModel`, decoupled from RPCCache/action-reuse semantics that would
// otherwise make "isOffline() stays true" and "this is a genuinely fresh
// mount" hard to guarantee together through the full action stack: any RPC
// that happens to succeed over a real connection flips `OfflinePlugin`'s
// `isOffline` back via its "RPC:RESPONSE" listener (offline_plugin.js), and
// revisiting an already-open action can reuse the live controller/component
// instead of remounting it.
// ---------------------------------------------------------------------------

test("offline, the sales-manager probe is skipped even though the server would have answered", async () => {
    // Model+method matches every `res.users.has_group` call; filter down to
    // the specific group team_switcher.js asks for (crm_column_progress.js
    // asks for a different one on its own mount).
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] === "sales_team.group_sale_manager") {
            expect.step("has_group");
        }
    });
    // `mockOffline()`'s `setOffline()` needs a running test app/service
    // registry (`getService(OfflinePlugin)`), so a throwaway WebClient is
    // mounted first purely to bring that up; it does nothing else here,
    // beyond its own background "/mail/store" poll failing once offline.
    expect.errors(1);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await setOffline(true);
    await mountWithCleanup(TeamSwitcher, {
        componentEnv: {
            searchModel: {
                state: { switcherTeamId: null, switcherTeams: [] },
                isTeamSwitcherEnabled: true,
                _updateSwitcherSelection: () => {},
            },
        },
    });

    // The framework disables the toggler on its own (A5/A26); the point
    // here is only that mounting it at all never issued the probe.
    expect(".o_cp_team_switcher").toHaveCount(1);
    expect(".o_cp_team_switcher").toHaveAttribute("disabled");
    expect.verifySteps([]); // has_group was never called
    expect.verifyErrors([
        `Connection to "/mail/store" couldn't be established or was interrupted`,
    ]);
});

// ---------------------------------------------------------------------------
// VAL-FIX-007 / "don't regress": a team already selected in the search state
// stays a facet across a view switch while offline, with no re-fetch.
// ---------------------------------------------------------------------------

test("offline, a previously selected team stays a search facet across a view switch, with no re-fetch", async () => {
    onRpc("crm.team", "get_team_switcher_data", () => expect.step("get_team_switcher_data"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(".o_cp_team_switcher:contains('All Teams')").toHaveCount(1);
    expect.verifySteps(["get_team_switcher_data"]); // the initial, online, load

    await contains(".o_cp_team_switcher").click();
    // No ".o_popover" ancestor: on the mobile preset the dropdown menu
    // isn't wrapped in one (see component_test_helpers.js's getDropdownMenu).
    await contains(".dropdown-item:contains('Hyrule')").click();
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1);
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2); // Lead 2 (Hyrule) + Lead 3 (unassigned)

    // Visit the list view once online too, so the offline switch below
    // exercises "no re-fetch for the switcher", not the unrelated "a view
    // never visited before shows the offline fallback" behavior.
    await switchView("list");
    expect("tr.o_data_row").toHaveCount(2);
    await switchView("kanban");

    const setOffline = mockOffline();
    await setOffline(true);
    // Reactivating the list view still attempts to refresh its records
    // (window_action.test.js's own "[Offline] navigate through window
    // actions" test declares the same kind of error for a previously
    // visited list); unrelated to the team switcher, which is what this
    // test is about.
    expect.errors(1);
    await switchView("list");

    // The team facet survived the view switch while offline, with no new
    // `get_team_switcher_data` call: `_initSwitcher()`'s early return on
    // `config.state?.teamSwitcherState` (restored by `_importState`) means
    // this path never touches the network at all.
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1);
    expect("tr.o_data_row").toHaveCount(2);
    expect.verifySteps([]);
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/crm.lead/web_search_read" couldn't be established or was interrupted`,
    ]);
});

// ---------------------------------------------------------------------------
// VAL-DIS-010 / VAL-FIX-013: "Manage Teams" is reachable online, unreachable
// offline (toggler disabled by the framework), reachable again online.
// ---------------------------------------------------------------------------

test("offline, Manage Teams is unreachable through the disabled toggler; online it works again", async () => {
    patchWithCleanup(user, { hasGroup: () => Promise.resolve(true) });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    expect(".o_cp_team_switcher").not.toHaveAttribute("disabled");
    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item:contains('Manage Teams')").toHaveCount(1);
    await contains(".o_cp_team_switcher").click(); // close it before going offline

    const setOffline = mockOffline();
    await setOffline(true);

    // The toggler is a plain `<button>` without `data-available-offline`:
    // the framework disables it on its own.
    expect(".o_cp_team_switcher").toHaveAttribute("disabled");
    expect(".o_cp_team_switcher").toHaveClass("o_disabled_offline");
    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item").toHaveCount(0); // unreachable: no dropdown opened, no "Manage Teams" item at all
    expect(".o_last_breadcrumb_item:contains('Team Config')").toHaveCount(0); // no navigation happened

    await setOffline(false);

    expect(".o_cp_team_switcher").not.toHaveAttribute("disabled");
    expect(".o_cp_team_switcher").not.toHaveClass("o_disabled_offline");
    await contains(".o_cp_team_switcher").click();
    await contains(".dropdown-item:contains('Manage Teams')").click();
    expect(".o_last_breadcrumb_item:contains('Team Config')").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// VAL-DIS-010 / VAL-FIX-013: selecting another team is unreachable offline
// (same disabled toggler); reachable again online.
// ---------------------------------------------------------------------------

test("offline, selecting another team is unreachable through the disabled toggler; online it works again", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await contains(".o_cp_team_switcher").click();
    await contains(".dropdown-item:contains('Hyrule')").click();
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1);
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item").toHaveCount(0); // unreachable: the dropdown never opens
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1); // selection unchanged
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2); // no reload happened

    await setOffline(false);

    await contains(".o_cp_team_switcher").click();
    await contains(".dropdown-item:contains('Mushroom Kingdom')").click();
    expect(".o_cp_team_switcher:contains('Mushroom Kingdom')").toHaveCount(1);
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2); // Lead 1 (Mushroom Kingdom) + Lead 3 (unassigned)
});

// ---------------------------------------------------------------------------
// VAL-FIX-006 online guard: the probe is still issued online, unaffected by
// the offline check added to `onWillStart`.
// ---------------------------------------------------------------------------

test("online, the sales-manager probe is still issued", async () => {
    onRpc("res.users", "has_group", ({ args, parent }) => {
        const result = parent();
        if (args[1] === "sales_team.group_sale_manager") {
            expect.step("has_group");
        }
        return result;
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    expect.verifySteps(["has_group"]);
});
