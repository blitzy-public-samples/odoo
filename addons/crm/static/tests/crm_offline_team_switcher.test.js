import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { after, animationFrame, expect, test } from "@odoo/hoot";
import {
    assignTestEnv,
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    mountView,
    mountWithCleanup,
    mountWithSearch,
    onRpc,
    patchWithCleanup,
    switchView,
} from "@web/../tests/web_test_helpers";
import { rpcBus } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { user } from "@web/core/user";
import { WebClient } from "@web/webclient/webclient";
import { getDefaultConfig } from "@web/views/view";
import { TeamSwitcher } from "@crm/components/team_switcher/team_switcher";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

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
// is forced to fail directly, decoupled from `mockCrmOffline()`, because the
// fix catches `ConnectionLostError` regardless of why it was raised.
// ---------------------------------------------------------------------------

test("a connection lost while fetching the team switcher data degrades to 'All Teams' instead of failing the view", async () => {
    onRpc("crm.team", "get_team_switcher_data", () => new Response("", { status: 502 }));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // CrmSearchModel.load() resolved instead of rejecting: the control
    // panel mounted with the pipeline's own records. The breadcrumb trail
    // itself ("Pipeline") does not render here: `crm_breadcrumbs.xml`
    // renders `<TeamSwitcher/>` *instead of* `web.Breadcrumbs` whenever a
    // switcher is shown (`hasTeamSwitcher`/`isTeamSwitcherVisible`), by
    // design -- exactly as in the VAL-COLD-001 cache-hit tests, which
    // assert the switcher's own label instead.
    expect(".o_control_panel").toHaveCount(1);
    // ":not(.o_kanban_ghost)" excludes the layout-filler placeholder cards
    // the (ungrouped) kanban renderer pads a short row with.
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(3);
    // VAL-COLD-004 (scrutiny round 1, revising this test's original
    // "degrades to no switcher at all" assertion): a cache-miss rejection
    // is `isTeamSwitcherVisible`'s offline fallback, not the "not enough
    // teams" `switcherAvailable: false` case -- the switcher still
    // renders, showing "All Teams" with no items to pick from.
    expect(".o_cp_team_switcher").toHaveCount(1);
    expect(".o_cp_team_switcher").toHaveText("All Teams");
    expect(".o_notification").toHaveCount(0);
});

// ---------------------------------------------------------------------------
// VAL-FIX-007 add-on: the same cache-miss degradation, through the list
// view instead of the kanban -- the contract names "the CRM kanban and
// list" together, and the test above only covers the kanban.
// ---------------------------------------------------------------------------

test("a connection lost while fetching the team switcher data still loads the crm list view, with its fallback and no error dialog", async () => {
    onRpc("crm.team", "get_team_switcher_data", () => new Response("", { status: 502 }));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Requesting "list" as the doAction viewType is ignored on the mobile
    // preset (it forces the kanban, its primary mobile view); switching to
    // it afterward instead works on both presets
    // (crm_offline_uncached_lead.test.js's own list-view tests do the same).
    await switchView("list");

    expect(".o_list_view").toHaveCount(1);
    expect("tr.o_data_row").toHaveCount(3);
    // VAL-COLD-004: same fallback as the kanban test above.
    expect(".o_cp_team_switcher").toHaveCount(1);
    expect(".o_cp_team_switcher").toHaveText("All Teams");
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);
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
    // `mockCrmOffline()`'s `setOffline()` needs a running test app/service
    // registry (`getService(OfflinePlugin)`), so a throwaway WebClient is
    // mounted first purely to bring that up; it does nothing else here.
    const setOffline = mockCrmOffline();
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
});

// ---------------------------------------------------------------------------
// User decision after M2 (VAL-SKIP-001/VAL-FIX-007 amended,
// research/offline-reload-oops.md): a cold mount (no `teamSwitcherState`
// carried in `config.state`) must still route `get_team_switcher_data`
// through the framework's existing RPC disk cache while offline -- never
// skip the call outright, since skipping it also left
// `team_switcher_enabled` (`_getContext`) and the selected team's
// `switcher_domain` (`_getDomain`) out of the search context on every cold
// offline start, which made the kanban root's own cached `web_read_group`
// miss too (its cache key is the whole request) and rendered
// `OfflineActionHelper` instead of the cached pipeline -- see
// crm_offline_cold_start.test.js for the cache-*hit* side of this (cached
// pipeline + matching online/offline `web_read_group`). This test covers
// the cache-*miss* side (VAL-COLD-004): a device that never loaded the
// switcher data online degrades straight to "All Teams", with exactly one
// attempted request and no error surfaced. `mountView()` (not
// `doAction()`) sidesteps `/web/action/load`'s own metadata fetch -- which
// a truly never-visited action id cannot survive offline either
// (`window_action.test.js`'s "[Offline] execute unavailable action") --
// while still going through the exact same `CrmSearchModel`/
// `CrmKanbanView` the pipeline action uses.
// ---------------------------------------------------------------------------

test("offline, mounting the crm kanban with a cold switcher cache attempts get_team_switcher_data once through the disk cache and falls back to 'All Teams' on a miss", async () => {
    // `mountWithSearch()`'s own `env.config` assignment only has an effect
    // on the test's very first mount (`app_test_helpers.js`'s `testEnv` is
    // merged into `env` once, when the shared test `App` is created by
    // whichever `mountWithCleanup()` call runs first) -- this test's first
    // mount is the throwaway `WebClient` below, so it is set here instead.
    assignTestEnv({ config: getDefaultConfig() });
    // Counting via `rpcBus`'s "RPC:REQUEST" event, not a model/method
    // `onRpc()` listener: `mockCrmOffline()`'s network-wide `onRpc("/*",
    // ...)` always wins route dispatch over the built-in
    // `/web/dataset/call_kw` route that model/method listeners ride on
    // (`mock_server.js`'s `_findRouteListeners`/`_handleRequest`: routes
    // are tried most-recently-registered first and stop at the first one
    // that returns a result, and that network-wide route is always
    // registered after, hence tried before, the server's own built-in
    // dispatcher), so a model/method listener would never fire while
    // offline and could not prove what the client actually sent -- see
    // crm_offline_cold_start.test.js's module docstring for the same
    // reasoning. Using `OfflinePlugin.setOffline()` directly instead of
    // `mockCrmOffline()` has its own trap: `OfflinePlugin` resets its
    // offline flag to `false` on *any* RPC response that doesn't carry a
    // `ConnectionLostError` (`offline_plugin.js`'s "RPC:RESPONSE"
    // listener), and nothing stops an unrelated RPC from succeeding and
    // flipping it back before `_initSwitcher()` even runs -- which is
    // exactly why `has_group` used to leak through here. `mockCrmOffline()`
    // avoids that: every response is a 502 while offline, so that listener
    // never sees a success and the flag never reverts mid-test.
    const switcherCalls = [];
    const onRequest = ({ detail }) => {
        const { params } = detail.data;
        if (params.model === "crm.team" && params.method === "get_team_switcher_data") {
            switcherCalls.push(params);
        }
    };
    rpcBus.addEventListener("RPC:REQUEST", onRequest);
    after(() => rpcBus.removeEventListener("RPC:REQUEST", onRequest));
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] === "sales_team.group_sale_manager") {
            expect.step("has_group");
        }
    });
    const setOffline = mockCrmOffline();
    // A throwaway WebClient brings up the test app/service registry
    // `mockCrmOffline()` needs (`mail.store`, among others); it does
    // nothing else here.
    await mountWithCleanup(WebClient);
    await setOffline(true);

    // `mountWithSearch` builds a real `CrmSearchModel` straight from the
    // given props (`with_search.js`'s `onWillStart` calls `searchModel.
    // load(config)` directly, with no `View`/`get_views` indirection and
    // no kanban root read): the exact `CrmSearchModel._initSwitcher()`
    // path under test, with none of the unrelated incidental RPCs a full
    // `mountView()`/`doAction()` of a never-visited kanban would also
    // attempt (both genuinely uncached offline, but not what this test is
    // about). `config.state` starts empty for every `mountWithSearch`
    // call, so `teamSwitcherState` is guaranteed cold here regardless, and
    // this test's `RPCCache` (installed once per test, `mock_server.js`)
    // never had anything written to its `crm.team`/`get_team_switcher_data`
    // entry before now, so this is also a genuine disk-cache miss.
    const switcher = await mountWithSearch(
        TeamSwitcher,
        {
            resModel: "crm.lead",
            context: { show_team_switcher: true },
            searchViewArch: "<search/>",
            searchViewFields: {},
            SearchModel: CrmSearchModel,
        },
        {}
    );
    await animationFrame(); // flush the WithSearch -> searchModel.load() -> _initSwitcher() chain

    // Unavailable (no teams cached): falls back to "All Teams" with an
    // empty team list, exactly like the forced-502 case in the first test
    // of this file -- the switcher's two fallback states (VAL-FIX-007) are
    // "no team list" (this one) or a selected-team facet restored from the
    // search state (the next test below). The rejection is caught inside
    // `_initSwitcher()`'s own `try`/`catch` (there is no ram/disk value to
    // resolve from first, so `RPCCache.read()`'s returned promise itself
    // rejects -- unlike the cache-*hit* case, this is not a dangling,
    // separately-unhandled background rejection), so no dialog or
    // notification appears and nothing needs declaring via
    // `expect.errors()`.
    expect(switcher.hasDropdown).toBe(false);
    expect(switcher.currentLabel).toBe("All Teams");
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);
    // Exactly one attempt at get_team_switcher_data (VAL-SKIP-001/
    // VAL-FIX-007/VAL-COLD-004's "one attempted request"); has_group (A4)
    // is still never issued at all while offline.
    expect(switcherCalls).toHaveLength(1);
    expect.verifySteps([]);
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

    const setOffline = mockCrmOffline();
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
// VAL-FIX-007: the test above keeps a warm get_team_switcher_data cache
// entry throughout, so it never actually hits the contract's own
// precondition, "when crm.team get_team_switcher_data has no cached
// value". This clears exactly that entry (not the whole RPC cache) before
// going offline, so the facet-survives-a-view-switch path is proven on a
// genuine disk-cache miss, matching VAL-SKIP-001/VAL-COLD-004's "a page
// started offline whose team list was never loaded online".
// ---------------------------------------------------------------------------

test("offline, a previously selected team stays a search facet across a view switch even with no cached get_team_switcher_data value", async () => {
    const switcherCalls = [];
    const onRequest = ({ detail }) => {
        const { params } = detail.data;
        if (params.model === "crm.team" && params.method === "get_team_switcher_data") {
            switcherCalls.push(params);
        }
    };
    rpcBus.addEventListener("RPC:REQUEST", onRequest);
    after(() => rpcBus.removeEventListener("RPC:REQUEST", onRequest));

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(".o_cp_team_switcher:contains('All Teams')").toHaveCount(1);

    await contains(".o_cp_team_switcher").click();
    // No ".o_popover" ancestor: on the mobile preset the dropdown menu
    // isn't wrapped in one (see component_test_helpers.js's getDropdownMenu).
    await contains(".dropdown-item:contains('Hyrule')").click();
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1);
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2); // Lead 2 (Hyrule) + Lead 3 (unassigned)

    // Clear ONLY the get_team_switcher_data disk/ram cache entry -- the
    // real table name `rpc.js` keys the cache by is the RPC method name
    // (`params?.method || url`) -- not the whole RPC cache: a genuine
    // miss for this one call, nothing else disturbed in the generic RPC
    // cache. `OfflinePlugin`'s own CLEAR-CACHES listener
    // (offline_plugin.js) ignores the event's argument and unconditionally
    // wipes its *own* `_visited` tracking (and the many2x tables) on
    // every CLEAR-CACHES event, regardless of which table was asked for
    // -- architecture.md §2's "On RPC:CLEAR-CACHES the visited-ui and
    // many2x tables are invalidated." That side effect is re-warmed below
    // by visiting the kanban and list once more online, the same thing a
    // real session would do: a tab that is still open after another part
    // of the app clears a cache entry keeps browsing online before ever
    // going offline.
    switcherCalls.length = 0;
    rpcBus.trigger("CLEAR-CACHES", "get_team_switcher_data");

    // Re-visit both views online: `config.state.teamSwitcherState`
    // (plain component state, not stored in `_idb` and therefore
    // untouched by the clear above) means `_initSwitcher()`'s early
    // return still applies, so neither visit re-fetches
    // get_team_switcher_data -- the resulting cache stays genuinely
    // empty for it, while the kanban/list visited-ui is warm again.
    await switchView("list");
    expect("tr.o_data_row").toHaveCount(2);
    await switchView("kanban");
    expect(switcherCalls).toHaveLength(0); // confirms no re-fetch happened, online either

    const setOffline = mockCrmOffline();
    await setOffline(true);
    // The list's own web_search_read refresh attempt, unrelated to the
    // team switcher (same as the test above).
    expect.errors(1);
    await switchView("list");

    // The team facet survived the view switch while offline, even though
    // get_team_switcher_data now has no cached value at all:
    // `_initSwitcher()`'s early return on `config.state?.teamSwitcherState`
    // (restored by `_importState`) means this path never touches the
    // network, cache or otherwise, regardless of what is or isn't cached.
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1);
    expect("tr.o_data_row").toHaveCount(2);
    expect(switcherCalls).toHaveLength(0); // no switcher request at all, not even one
    expect(".o_error_dialog").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
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

    const setOffline = mockCrmOffline();
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

    const setOffline = mockCrmOffline();
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
// Scrutiny finding 3 (VAL-DIS-010): the framework only disables `<button>`s
// going offline (`OfflinePlugin.SELECTORS_TO_DISABLE`); it does not close a
// dropdown already open before the connection drops, so the `DropdownItem`
// spans inside stay in the DOM and clickable. Unlike the two tests above
// (which close the menu before going offline), this one leaves it open.
// ---------------------------------------------------------------------------

// `DropdownItem`'s default `closingMode` is "all" (`dropdown_item.js`): any
// item click closes the whole menu regardless of what the item's own
// handler does, and the toggler is a disabled `<button>` offline, so it
// cannot be reopened once closed. Each scenario below therefore opens its
// own dropdown and exercises exactly one item, mirroring how a real user
// can only make one such click before needing to reopen the menu.
test("offline, a team-switcher dropdown left open before disconnecting: selecting another team is inert", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    await contains(".o_cp_team_switcher").click(); // open it, and leave it open
    expect(".dropdown-item:contains('Hyrule')").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".dropdown-item:contains('Hyrule')").click();
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(0); // selection unchanged ("All Teams")
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(3); // no reload: still every lead

    await setOffline(false);

    // Works again: close/reopen (the component was never remounted).
    await contains(".o_cp_team_switcher").click();
    await contains(".dropdown-item:contains('Hyrule')").click();
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1);
});

test("offline, a team-switcher dropdown left open before disconnecting: Manage Teams is inert", async () => {
    patchWithCleanup(user, { hasGroup: () => Promise.resolve(true) });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    await contains(".o_cp_team_switcher").click(); // open it, and leave it open
    expect(".dropdown-item:contains('Manage Teams')").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".dropdown-item:contains('Manage Teams')").click();
    expect(".o_last_breadcrumb_item:contains('Team Config')").toHaveCount(0); // no navigation happened

    await setOffline(false);

    // Works again: close/reopen (the component was never remounted).
    await contains(".o_cp_team_switcher").click();
    await contains(".dropdown-item:contains('Manage Teams')").click();
    expect(".o_last_breadcrumb_item:contains('Team Config')").toHaveCount(1);
});

test("offline, calling the team-switcher handlers directly does nothing", async () => {
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await setOffline(true);

    let selectionChanged = false;
    const comp = await mountWithCleanup(TeamSwitcher, {
        componentEnv: {
            searchModel: {
                state: { switcherTeamId: null, switcherTeams: [{ id: 2, name: "Hyrule" }] },
                isTeamSwitcherEnabled: true,
                _updateSwitcherSelection: () => {
                    selectionChanged = true;
                },
            },
        },
    });
    let doActionCalled = false;
    patchWithCleanup(comp.actionService, {
        doAction: () => {
            doActionCalled = true;
        },
    });

    comp.onSelect(2);
    comp.onClickManageTeams();

    expect(selectionChanged).toBe(false);
    expect(doActionCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// Scrutiny finding 4 (VAL-FIX-006/VAL-FIX-013): `isSaleManager` must be
// re-probed when the connection returns, even for a switcher that first
// mounted offline (so `onWillStart`'s own probe never ran) -- without
// requiring a remount.
// ---------------------------------------------------------------------------

test("a sales manager whose switcher first mounts offline sees Manage Teams after reconnecting, without remounting", async () => {
    patchWithCleanup(user, { hasGroup: () => Promise.resolve(true) });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await setOffline(true);

    const comp = await mountWithCleanup(TeamSwitcher, {
        componentEnv: {
            searchModel: {
                state: { switcherTeamId: null, switcherTeams: [{ id: 2, name: "Hyrule" }] },
                isTeamSwitcherEnabled: true,
                _updateSwitcherSelection: () => {},
            },
        },
    });
    // Mounted offline: `onWillStart` never issued the probe, so there is
    // nothing to see yet.
    expect(comp.isSaleManager).toBe(false);
    expect(".dropdown-item:contains('Manage Teams')").toHaveCount(0);

    await setOffline(false);
    await animationFrame(); // flush the reactive re-probe effect's `user.hasGroup()` promise

    expect(comp.isSaleManager).toBe(true); // same component instance, never remounted
    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item:contains('Manage Teams')").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Latent defect found during M5 user-testing round 2 (research/
// m5-reconnect-stale-ui.md, m5-fix-team-switcher-catch): the re-probe
// effect's `user.hasGroup(...).then((result) => { this.isSaleManager =
// result; })` above had no rejection handler. If `isOffline()` ever briefly
// reads `false` while the network is actually still down (the framework
// can read a stray successful "RPC:RESPONSE" before a parked request's own
// failure lands, see the research note), the probe fires and rejects with
// `ConnectionLostError`, which must not reach the global
// `UncaughtPromiseError` handler (`lostConnectionHandler` -- addons/web/
// static/src/core/offline/offline_error.js -- would turn it right back
// into `setOffline(true)`, a reload loop with no network traffic).
//
// Round 3 (VAL-FIX-006/VAL-FIX-013 recovery, m5-fix-team-switcher-recovery):
// catching that rejection is not enough on its own. `user.hasGroup` is
// backed by `Cache.read()` (addons/web/static/src/core/utils/cache.js),
// which never evicts a rejected promise -- once this group's FIRST ever
// `user.hasGroup(...)` call in the page's life rejects, every later call to
// `user.hasGroup("sales_team.group_sale_manager")` returns that exact same
// rejected promise forever, with no new RPC, even once the connection is
// genuinely back. Unlike the round-2 fix's own test (which fully replaced
// `user.hasGroup` with a counter-driven stub, so each call was a fresh,
// independent decision with no real cache involved), this test uses the
// REAL cache via `onRpc` on the server method it calls
// (`res.users.has_group`), so the permanent-rejection behavior is the
// genuine one, not a stand-in. The fix must still swallow the
// `ConnectionLostError` without altering `isSaleManager` (keep whatever was
// already known), and it must still recover on a later, genuine reconnect
// -- which, because the cache is now poisoned, requires bypassing
// `user.hasGroup` with a fresh, uncached read of the same server method.
// ---------------------------------------------------------------------------

test("a sales-manager probe poisoned by a brief false-online flip at cold start still recovers on a genuine reconnect, using the real hasGroup cache", async () => {
    let hasGroupCalls = 0;
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] !== "sales_team.group_sale_manager") {
            return false;
        }
        hasGroupCalls++;
        if (hasGroupCalls === 1) {
            // The brief flip: `isOffline()` reads `false` for a moment
            // while the network is actually still down, so this first
            // probe attempt still fails -- and poisons the real
            // `user.hasGroup` cache entry for this group for the rest of
            // this test's page life.
            return new Response("", { status: 502 });
        }
        return true; // the real reconnect, later
    });

    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await setOffline(true); // mounted while already offline: never known

    const comp = await mountWithCleanup(TeamSwitcher, {
        componentEnv: {
            searchModel: {
                state: { switcherTeamId: null, switcherTeams: [{ id: 2, name: "Hyrule" }] },
                isTeamSwitcherEnabled: true,
                _updateSwitcherSelection: () => {},
            },
        },
    });
    // `onWillStart` skipped the probe outright (offline mount); nothing
    // learned yet.
    expect(comp.isSaleManager).toBe(false);
    expect(hasGroupCalls).toBe(0);

    // The brief flip: the effect's non-offline branch fires and issues the
    // probe, which rejects and poisons the real cache entry.
    await setOffline(false);
    await animationFrame();

    expect(hasGroupCalls).toBe(1);
    // No unhandled rejection reached `lostConnectionHandler` on top of the
    // framework's own, correct "RPC:RESPONSE" detection (the failed probe's
    // own response genuinely re-flips the plugin offline on its own, since
    // the network really is still down) -- no error dialog opened either
    // way.
    expect(".o_error_dialog").toHaveCount(0);
    // The failed probe did not corrupt the already-known (default) value.
    expect(comp.isSaleManager).toBe(false);

    // Settle explicitly offline (idempotent: the "RPC:RESPONSE" handler
    // above already re-flipped the plugin) before the genuine reconnect.
    await setOffline(true);
    expect(comp.isSaleManager).toBe(false); // unaffected: same SKIP as always

    // The real reconnect: `user.hasGroup`'s cache entry for this group is
    // now permanently rejected, so recovering here requires the fix's
    // uncached bypass read, not a second call through `user.hasGroup`.
    await setOffline(false);
    await animationFrame(); // flush the effect's probe promise

    expect(hasGroupCalls).toBe(2);
    expect(comp.isSaleManager).toBe(true); // recovers; not stuck on the earlier rejection
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    expect(".o_error_dialog").toHaveCount(0);
    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item:contains('Manage Teams')").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Round 3 add-on (m5-fix-team-switcher-recovery): the same permanent-
// rejection hazard, but for `onWillStart`'s own, first-mount probe instead
// of the reactive effect's re-probe -- a false-online moment can land
// exactly at mount time too (the switcher's very first, online mount, with
// the network only looking up for that one request). `onWillStart` must not
// let that rejection break the mount (the component must still render,
// `isSaleManager` falling back to `false`), and the effect above must still
// recover it on the next online flip -- the same uncached bypass, triggered
// from the other call site.
// ---------------------------------------------------------------------------

test("a first-mount online probe that rejects with a false-online ConnectionLostError does not break the mount, and recovers on the next online flip", async () => {
    let hasGroupCalls = 0;
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] !== "sales_team.group_sale_manager") {
            return false;
        }
        hasGroupCalls++;
        if (hasGroupCalls === 1) {
            // False-online at mount: `onWillStart` runs while `isOffline()`
            // already reads `false`, but this one request still fails.
            return new Response("", { status: 502 });
        }
        return true; // the genuine reconnect, later
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1); // onWillStart's own probe runs here, online, and rejects

    expect(hasGroupCalls).toBe(1);
    // The rejection did not break the mount: the view and the switcher are
    // both there, with no error dialog.
    expect(".o_error_dialog").toHaveCount(0);
    expect(".o_cp_team_switcher").toHaveCount(1);
    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item:contains('Manage Teams')").toHaveCount(0); // fell back to false
    await contains(".o_cp_team_switcher").click(); // close before going offline

    const setOffline = mockCrmOffline();
    await setOffline(true);
    await setOffline(false); // the genuine reconnect
    await animationFrame();

    expect(hasGroupCalls).toBe(2);
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    expect(".o_error_dialog").toHaveCount(0);
    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item:contains('Manage Teams')").toHaveCount(1); // recovered
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

// ---------------------------------------------------------------------------
// M2 user-testing round-1 (VAL-FIX-007, VAL-SKIP-001): every team-switcher
// test above either mounts the component directly or exercises only the
// view's *first*, online, mount. None of them prove the amended contract's
// "(re)mounting" wording -- that a kanban controller destroyed and
// recreated while already offline (not a cold, never-visited mount, which
// hits `OfflineActionHelper` instead -- out of scope here, see
// crm_offline_uncached_lead.test.js) still renders its records and the
// switcher fallback, and still issues neither probe. Switching to list and
// back forces exactly that teardown/rebuild of the kanban controller,
// while `CrmSearchModel` (and so the team switcher's own mount) survives
// the switch unchanged -- already shown by the "stays a search facet
// across a view switch" test above, so the point here is specifically the
// *kanban controller's own* mount, not the switcher component's.
// ---------------------------------------------------------------------------

test("offline, remounting the pipeline kanban after a view switch still renders its records and the switcher fallback, with neither probe reissued", async () => {
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] === "sales_team.group_sale_manager") {
            expect.step("has_group");
        }
    });
    onRpc("crm.team", "get_team_switcher_data", () => expect.step("get_team_switcher_data"));

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(3);
    expect(".o_cp_team_switcher:contains('All Teams')").toHaveCount(1);

    await switchView("list");
    expect("tr.o_data_row").toHaveCount(3);
    expect.verifySteps(["get_team_switcher_data", "has_group"]); // the initial, online, mount

    const setOffline = mockCrmOffline();
    await setOffline(true);
    // Remounting the kanban controller still attempts to refresh its
    // records (the same "revisiting a view while offline" cost the
    // facet-preservation test above declares for the list view); unrelated
    // to the two probes, which is what this test is about.
    expect.errors(1);
    await switchView("kanban"); // remount: a fresh kanban controller

    // Remounted while offline: the switcher fallback still renders, and
    // neither probe fired again on this fresh mount.
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(3);
    expect(".o_cp_team_switcher:contains('All Teams')").toHaveCount(1);
    expect.verifySteps([]);
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/crm.lead/web_search_read" couldn't be established or was interrupted`,
    ]);

    await setOffline(false);
});
