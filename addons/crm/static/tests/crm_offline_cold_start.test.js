import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { after, animationFrame, expect, test } from "@odoo/hoot";
import {
    contains,
    defineActions,
    defineModels,
    destroyApp,
    fields,
    getService,
    models,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { rpcBus } from "@web/core/network/rpc";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline, waitForMailStoreReady } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * m3-offline-cold-start (VAL-COLD-001, amended VAL-SKIP-001/VAL-FIX-007,
 * research/offline-reload-oops.md): an offline reload or app reopen is a
 * cold start -- a brand new `WebClient`/`CrmSearchModel`, with no
 * `config.state` carried over from the previous session; only
 * `browser.localStorage`'s selected-team id and whatever the framework's
 * RPC disk cache (`addons/web/static/src/core/network/rpc_cache.js`,
 * `rpc.js:99-105`'s whole-request cache key) persisted from the earlier
 * online visit survive it. `CrmSearchModel._initSwitcher()`
 * (`static/src/views/crm_search_model.js`) now reads
 * `get_team_switcher_data` through that same disk cache on *every* mount,
 * offline included, so the cold start's `team_switcher_enabled` context
 * flag and the selected team's `switcher_domain` match the online visit
 * that cached the kanban's own `web_read_group` -- otherwise that cache
 * also misses (its key is the whole request) and `OfflineActionHelper`
 * renders instead of the cached pipeline (the defect this feature fixes).
 *
 * Each test mounts a `WebClient`, visits the pipeline online, flushes that
 * `WebClient`'s own background `mail.store` fetch with
 * `waitForMailStoreReady()` (`mock_server/crm_offline_test_helpers.js` --
 * started at mount time like any other `WebClient`, and not cancelled by
 * destroying the app; left unflushed it can still reject with an uncaught
 * `ConnectionLostError` once the *second* `WebClient` below goes offline,
 * surfacing in whatever test happens to be running when that late
 * rejection lands rather than in this one), destroys that `WebClient`
 * (`destroyApp()` -- a real unmount, so the next mount is a genuinely
 * fresh `CrmSearchModel`/kanban controller, not a revisit of a live one),
 * goes offline, mounts a *second*, fresh `WebClient` and opens the same
 * action: a cold start with no `config.state`, offline from before the
 * first RPC. The mock server's `RPCCache` (`mock_server.js:541`) is
 * installed once per test and survives both `WebClient`s, exactly like
 * the browser's real disk-backed `IndexedDB` surviving a reload.
 *
 * Capturing what was actually sent uses `rpcBus`'s "RPC:REQUEST" event
 * (`addons/web/static/src/core/network/rpc.js`), not a model/method
 * `onRpc()` listener: once offline, `mockCrmOffline()`'s network-wide
 * `onRpc("/*", ...)` always wins route dispatch over any model-method
 * listener (`mock_server.js`'s `_findRouteListeners` checks the
 * most-recently-registered *route* match first, and the built-in
 * `/web/dataset/call_kw` dispatcher that feeds model/method listeners is
 * registered once, early, at server construction -- so it is always the
 * least recently registered route and loses to any test-added "/*"), so a
 * model/method listener would never fire and could not prove what the
 * client actually sent. `rpc.js`'s `RPCCache.read()` call always also
 * invokes its network fallback for `update: "always"` (even on a disk-cache
 * hit), and that fallback is a real `rpc._rpc()` call that always triggers
 * "RPC:REQUEST" before dispatch, regardless of what intercepts it
 * afterwards -- the one client-side point unaffected by server-side
 * dispatch order.
 *
 * A cold `doAction()` of this view mounts its kanban model/controller more
 * than once (confirmed stable across runs, independent of this fix, by
 * instrumenting `RelationalModel.prototype.load` while writing this test --
 * a pre-existing artifact of this view's responsive control-panel markup,
 * out of scope for this feature); each extra mount reissues the exact same,
 * already-cached `web_read_group`, so `readGroupCalls` below has more than
 * one offline entry even though "the" request is really just one, and the
 * errors declared below count every `ConnectionLostError` the mock XHR
 * layer logs (one per `_initSwitcher()` attempt, plus one for the kanban's
 * own cached root even though it is requested more than once -- the
 * framework's `RPCCache.read()` pending-request bookkeeping, `rpc_cache.js`,
 * collapses the extra, identical in-flight reads into the first one's
 * single background rejection).
 */

class Users extends models.Model {
    name = fields.Char();
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

    _records = [
        { id: 1, name: "New" },
        { id: 2, name: "Qualified" },
    ];
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _records = [
        { id: 1, name: "Lead 1", stage_id: 1, team_id: 1 },
        { id: 2, name: "Lead 2", stage_id: 1, team_id: 2 },
        { id: 3, name: "Lead 3", stage_id: 2, team_id: 2 },
        { id: 4, name: "Lead 4", stage_id: 2, team_id: false },
    ];

    _views = {
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <templates>
                    <t t-name="card"><field name="name"/></t>
                </templates>
            </kanban>`,
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
        views: [[false, "kanban"]],
    },
]);

/**
 * Records every real `web_read_group` request actually sent for
 * "crm.lead" (see the module docstring for why this goes through
 * `rpcBus` instead of a model/method `onRpc()` listener), as
 * `{ context, domain }`.
 * @returns {Array<{ context: Record<string, any>; domain: any }>}
 */
function recordLeadReadGroupCalls() {
    const calls = [];
    const onRequest = ({ detail }) => {
        const { params } = detail.data;
        if (params.model === "crm.lead" && params.method === "web_read_group") {
            calls.push({
                context: { ...params.kwargs.context },
                domain: params.kwargs.domain,
            });
        }
    };
    rpcBus.addEventListener("RPC:REQUEST", onRequest);
    after(() => rpcBus.removeEventListener("RPC:REQUEST", onRequest));
    return calls;
}

test("offline cold start of the pipeline with no team selected renders the cached columns and cards with the same web_read_group context and domain as online (VAL-COLD-001)", async () => {
    const readGroupCalls = recordLeadReadGroupCalls();
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] === "sales_team.group_sale_manager") {
            expect.step("has_group");
        }
    });
    const setOffline = mockCrmOffline();

    // Online visit: populates the RPC disk cache for both
    // `get_team_switcher_data` and this exact `web_read_group` request.
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(".o_kanban_group").toHaveCount(2); // New + Qualified
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(4); // every lead
    expect(".o_cp_team_switcher:contains('All Teams')").toHaveCount(1);
    expect(readGroupCalls).toHaveLength(1);

    // Flush this `WebClient`'s own background `mail.store` fetch while
    // still online, before tearing it down -- see the module docstring.
    await waitForMailStoreReady();

    // Cold start: destroy this `WebClient` entirely (a real unmount, not a
    // revisit of a live controller), then mount a brand new one with no
    // `config.state`, and go offline before the action even starts
    // loading.
    destroyApp();
    await mountWithCleanup(WebClient);
    await setOffline(true);
    // Both `get_team_switcher_data` and this `web_read_group` resolve from
    // their disk-cache hit, but `type: "disk", update: "always"`
    // (`relational_model.js`, `crm_search_model.js`) always *also* fires a
    // real network request in the background to refresh that cache; offline,
    // that background leg rejects with `ConnectionLostError` after its
    // promise already resolved from the cache, so it surfaces as a
    // separately-unhandled rejection instead of failing anything on screen
    // (`error_service.js`'s `lostConnectionHandler` swallows it with no
    // dialog/notification -- the assertions below are what prove that).
    // Hoot still tracks each one and requires it declared, exactly like the
    // "revisiting a view while offline" cost declared elsewhere in
    // `crm_offline_team_switcher.test.js`.
    expect.errors(2);
    await getService("action").doAction(1);
    // Both background legs are real network round-trips (the mock XHR
    // layer, same as a real `XMLHttpRequest`), so their rejection does not
    // necessarily land before `doAction()`'s own promise resolves from the
    // disk-cache hit -- without this tick, `expect.verifyErrors` below runs
    // before either has actually logged, intermittently reading `[]` where
    // the two errors declared above are expected (the exact flake this
    // extra tick removes; see the VAL-COLD-004 test further down for the
    // same reasoning on a cache-miss background leg).
    await animationFrame();

    // The cached pipeline rendered, not `OfflineActionHelper`.
    expect(".o_action_helper").toHaveCount(0);
    expect(".o_kanban_group").toHaveCount(2);
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(4);
    expect(".o_cp_team_switcher:contains('All Teams')").toHaveCount(1);
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);

    // Same request as online (module docstring: this view's cold mount
    // reissues it more than once, always identically) -- the cache hit on
    // the whole-request key (`rpc.js:99-105`) only happens because
    // `team_switcher_enabled` (`_getContext`) matches too.
    expect(readGroupCalls).toHaveLength(3);
    for (const call of readGroupCalls.slice(1)) {
        expect(call.context).toEqual(readGroupCalls[0].context);
        expect(call.domain).toEqual(readGroupCalls[0].domain);
    }

    // `has_group` (the sales-manager probe, A4) is issued once, online
    // only; never while offline, cold start included.
    expect.verifySteps(["has_group"]);
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/crm.team/get_team_switcher_data" couldn't be established or was interrupted`,
        `Connection to "/web/dataset/call_kw/crm.lead/web_read_group" couldn't be established or was interrupted`,
    ]);
});

test("offline cold start of the pipeline with a team selected renders the cached columns and cards, with the team kept as the switcher selection and search facet (VAL-COLD-001)", async () => {
    const readGroupCalls = recordLeadReadGroupCalls();
    const setOffline = mockCrmOffline();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await contains(".o_cp_team_switcher").click();
    await contains(".dropdown-item:contains('Hyrule')").click();
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1);
    // Lead 2 (Hyrule) + Lead 3 (Hyrule) + Lead 4 (unassigned): the
    // selected team's own `switcher_domain`.
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(3);
    expect(readGroupCalls).toHaveLength(2); // the initial load + the team-filtered reload

    // Flush this `WebClient`'s own background `mail.store` fetch while
    // still online, before tearing it down -- see the module docstring.
    await waitForMailStoreReady();

    // Cold start, with "Hyrule" persisted in `browser.localStorage`
    // (`crm.switcher_team_id`, untouched by destroying/remounting the
    // `WebClient` -- only `config.state` is lost).
    destroyApp();
    await mountWithCleanup(WebClient);
    await setOffline(true);
    // See the no-team-selected test above: both calls' background refresh
    // leg rejects after resolving from the cache; declared, not a failure.
    expect.errors(2);
    await getService("action").doAction(1);
    // See the no-team-selected test above for why this tick is needed
    // before `expect.verifyErrors` can rely on both background legs
    // having already logged.
    await animationFrame();

    expect(".o_action_helper").toHaveCount(0);
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1); // selection restored
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(3); // same team-filtered set
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);

    // See the no-team-selected test above for why there is more than one.
    expect(readGroupCalls).toHaveLength(4);
    for (const call of readGroupCalls.slice(2)) {
        expect(call.context).toEqual(readGroupCalls[1].context);
        expect(call.domain).toEqual(readGroupCalls[1].domain);
    }
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/crm.team/get_team_switcher_data" couldn't be established or was interrupted`,
        `Connection to "/web/dataset/call_kw/crm.lead/web_read_group" couldn't be established or was interrupted`,
    ]);
});

test("offline cold start when the team list was never loaded online falls back to 'All Teams' with no error, even though the rest of the pipeline is cached (VAL-COLD-004)", async () => {
    // A genuine miss, not a CLEAR-CACHES simulation after the fact:
    // `get_team_switcher_data` fails outright on its only online attempt
    // (same forced 502 as `crm_offline_team_switcher.test.js`'s "connection
    // lost" tests) and is therefore never written to the RPC disk cache at
    // all -- `rpc_cache.js`'s `onRejected` only ever deletes a
    // pending/ram entry, it never calls `IndexedDB.write` (only
    // `onFullfilled` does that). The pipeline's own `web_read_group` is
    // unaffected by that one call's failure and succeeds normally online,
    // so *it* does get a disk entry, caching `team_switcher_enabled: false`
    // (`_getContext`) -- the same value `_initSwitcher()`'s `catch` leaves
    // behind on *any* `ConnectionLostError`, online or offline, so the
    // kanban root's own cache key still matches on the cold offline start
    // below even though its switcher companion was never cached anywhere.
    onRpc("crm.team", "get_team_switcher_data", () => new Response("", { status: 502 }));
    const readGroupCalls = recordLeadReadGroupCalls();
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] === "sales_team.group_sale_manager") {
            expect.step("has_group");
        }
    });
    const setOffline = mockCrmOffline();

    // Online visit: the switcher probe fails and is never cached; the
    // kanban's own request succeeds and *is* cached. A true miss's
    // rejection has no ram/disk value to resolve from first, so it is the
    // one promise `_initSwitcher()` itself awaits inside its own
    // `try`/`catch` -- caught synchronously, not a dangling background
    // rejection, so (like the forced-502 test in
    // `crm_offline_team_switcher.test.js`) nothing needs declaring via
    // `expect.errors()` for it, online or offline.
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(4);
    expect(".o_cp_team_switcher").toHaveCount(1);
    expect(".o_cp_team_switcher").toHaveText("All Teams");
    expect(readGroupCalls).toHaveLength(1);
    // Online visit issues the sales-manager probe once, same as any other
    // online mount (A4); consumed here so the final `verifySteps` below is
    // only about the offline portion of this test.
    expect.verifySteps(["has_group"]);

    // Flush this `WebClient`'s own background `mail.store` fetch while
    // still online, before tearing it down -- see the module docstring.
    await waitForMailStoreReady();

    // Cold start: destroy this `WebClient` (a real unmount, not a revisit
    // of a live controller), mount a brand new one with no `config.state`,
    // go offline before the action even starts loading. No `CLEAR-CACHES`
    // event anywhere in this test -- the switcher's disk entry simply
    // never existed, online or offline.
    destroyApp();
    await mountWithCleanup(WebClient);
    await setOffline(true);
    // Only the kanban's own `web_read_group` is a disk-cache *hit* here,
    // so only its background refresh leg is a dangling, separately
    // rejected promise that needs declaring (see the VAL-COLD-001 tests
    // above). `get_team_switcher_data` is still a true miss, exactly like
    // online: its rejection is still the main, awaited promise inside
    // `_initSwitcher()`'s own `try`/`catch`, so it needs no declaration.
    expect.errors(1);
    await getService("action").doAction(1);
    // See the VAL-COLD-001 tests above for why this tick is needed before
    // `expect.verifyErrors` can rely on the background leg having already
    // logged.
    await animationFrame();

    expect(".o_action_helper").toHaveCount(0); // the pipeline itself is cached
    expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(4);
    // VAL-COLD-004: the switcher still renders, showing "All Teams" --
    // not hidden entirely, even though its own data was never cached.
    expect(".o_cp_team_switcher").toHaveCount(1);
    expect(".o_cp_team_switcher").toHaveText("All Teams");
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);

    // Same request as online (module docstring: this view's cold mount
    // reissues it more than once, always identically) -- the cache hit on
    // the whole-request key only happens because `team_switcher_enabled`
    // matches too, even though the switcher's own data never did.
    expect(readGroupCalls).toHaveLength(3);
    for (const call of readGroupCalls.slice(1)) {
        expect(call.context).toEqual(readGroupCalls[0].context);
        expect(call.domain).toEqual(readGroupCalls[0].domain);
    }
    expect.verifySteps([]); // has_group was never issued offline
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/crm.lead/web_read_group" couldn't be established or was interrupted`,
    ]);
});
