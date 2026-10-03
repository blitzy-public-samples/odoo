import { browser } from "@web/core/browser/browser";
import { Domain } from "@web/core/domain";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { SearchModel } from "@web/search/search_model";

import { computed, proxy } from "@odoo/owl";

export class CrmSearchModel extends SearchModel {

    switcherTeam = computed(() => this.state.switcherTeams.find((t) => t.id === this.state.switcherTeamId));

    /**
     * @override
     */
    setup() {
        super.setup(...arguments);
        this.state = proxy({
            switcherAvailable: false, // Whether or not there's enough teams in DB to display the switcher.
            switcherTeams: [], // Teams to display in the switcher.
            switcherTeamId: null, // Selected team id ("undefined" = "All Teams")
            // VAL-COLD-004 (architecture.md §3.2 item 3): true only for a
            // genuine offline `get_team_switcher_data` cache miss (no disk
            // entry ever written -- see `_initSwitcher`'s `catch` below).
            // Kept apart from `switcherAvailable` on purpose: `_getContext`
            // feeds `switcherAvailable` into `team_switcher_enabled`, which
            // is part of the kanban/list root's own disk-cached
            // `web_read_group` request key. If this flag also flipped that
            // getter, a true miss would locally recompute a context that
            // disagrees with whatever was cached online, turning a missing
            // "All Teams" label into a second, cascading cache miss on the
            // pipeline itself (the exact defect this flag fixes without
            // reintroducing).
            switcherOfflineFallback: false,
        });
    }

    /**
     * Whether or not the switcher is actually displayed.
     */
    get isTeamSwitcherEnabled() {
        return this.showTeamSwitcher && this.state.switcherAvailable;
    }

    /**
     * Whether or not the switcher component should render. Unlike
     * `isTeamSwitcherEnabled` (used for the `team_switcher_enabled` search
     * context, see above), this also covers the offline cache-miss
     * fallback: VAL-COLD-004 requires the switcher to still show "All
     * Teams" even though `switcherAvailable` is `false` in that state.
     */
    get isTeamSwitcherVisible() {
        return this.showTeamSwitcher && (this.state.switcherAvailable || this.state.switcherOfflineFallback);
    }

    /**
     * Whether or not the view would like to display the team switcher.
     */
    get showTeamSwitcher() {
        return !!this._actionContext.show_team_switcher;
    }

    /**
     * @override
     * Init the switcher teams and selection.
     */
    async load(config) {
        // Keep a reference to the original action context so "_updateActionContext" can
        // later patch it to affect the context of the "New" button form view.
        this._actionContext = config.context;
        await this._initSwitcher(config);
        await super.load(config);
    }

    /**
     * @override
     * Export team switcher state with the config state.
     */
    exportState() {
        const state = super.exportState();
        state.teamSwitcherState = {
            available: this.state.switcherAvailable,
            teams: this.state.switcherTeams,
            teamId: this.state.switcherTeamId,
            offlineFallback: this.state.switcherOfflineFallback,
        };
        return state;
    }

    /**
     * @override
     * Restore team switcher state when the config state is imported (i.e. on switch view).
     */
    _importState(state) {
        super._importState(...arguments);
        if (state.teamSwitcherState) {
            this.state.switcherAvailable = state.teamSwitcherState.available;
            this.state.switcherTeams = state.teamSwitcherState.teams;
            this.state.switcherTeamId = state.teamSwitcherState.teamId;
            this.state.switcherOfflineFallback = state.teamSwitcherState.offlineFallback;
        }
    }

    /**
     * @override
     * Update the search context so the selected team is used as the default when
     * creating crm.lead records via quick create, business card, ... and creating crm.stage records.
     * Also ensure that only stages related to the selected team are displayed (see _read_group_stage_ids).
     */
    _getContext() {
        const context = {
            ...super._getContext(),
            // for view rendering
            team_switcher_enabled: this.isTeamSwitcherEnabled,
        };
        if (!this.state.switcherTeamId) {
            return context;
        }
        return {
            ...context,
            default_team_id: this.state.switcherTeamId,
            default_team_ids: [this.state.switcherTeamId], // for stages
        };
    }

    /**
     * @override
     * Update search domain depending on the team switcher selection.
     * Showing all "crm.lead" records assigned to the team + the unassigned ones which
     * happens to be part of the team visible stages.
     */
    _getDomain(params = {}) {
        const domain = super._getDomain({ ...params, raw: true }); // Force raw to simplify
        const team = this.switcherTeam();
        if (!team) {
            return params.raw ? domain : domain.toList(this.domainEvalContext);
        }
        const switcherDomain = Domain.and([domain, new Domain(team.switcher_domain)]);
        return params.raw ? switcherDomain : switcherDomain.toList(this.domainEvalContext);
    }

    /**
     * Initialize the team switcher by:
     * - checking whether the view would like the switcher (showTeamSwitcher)
     * - checking whether there are enough teams to actually show it (switcherAvailable)
     * - retrieving the list of crm teams to display (switcherTeams)
     * - restoring the previously selected team (switcherTeamId)
     *
     * The initialization is skipped if the team switcher state is present
     * in the config state as it'll be restored with "_importState".
     */
    async _initSwitcher(config) {
        if (!this.showTeamSwitcher || config.state?.teamSwitcherState) {
            return;
        }
        // Retrieve team switcher data
        let available = false;
        let teams = [];
        let offlineFallback = false;
        // User decision after M2 (VAL-SKIP-001/VAL-FIX-007 amended,
        // research/offline-reload-oops.md): always route through
        // `this.orm.cache()`, offline included, instead of skipping the
        // call while `isOffline()`. `RPCCache.read()`
        // (addons/web/static/src/core/network/rpc_cache.js) resolves from
        // its disk entry (if any) synchronously, in parallel with -- not
        // blocked by -- the network leg it always also attempts for
        // `update: "always"`; a disk hit therefore still resolves this
        // call even though the parallel network attempt then rejects with
        // `ConnectionLostError` (silently: the rejection is only observed
        // by the pending-request bookkeeping once a value already settled
        // the promise, per `rpc_cache.js`'s `onRejected`, and bubbles as an
        // uncaught rejection the framework's `lostConnectionHandler`
        // swallows, same as a 502 mid-flight below). The previous
        // "skip entirely offline" fix (scrutiny finding 2) left
        // `team_switcher_enabled` (`_getContext` below) and the selected
        // team's `switcher_domain` (`_getDomain` below) out of the search
        // context on every cold offline start, which made the cached
        // `web_read_group` for the kanban/list root also miss (its cache
        // key is the whole request, `rpc.js`) and rendered
        // `OfflineActionHelper` instead of the cached pipeline -- the
        // defect this call restores the fix for. Only a true cache miss
        // (this device never loaded the switcher data online) rejects and
        // falls through to "All Teams" below; a team already selected
        // earlier in this session is unaffected either way, since it is
        // restored above through `config.state.teamSwitcherState`, never
        // through this call.
        try {
            ({ available, teams } = await this.orm
                .cache({
                    type: "disk",
                    update: "always",
                    callback: (result, hasChanged) => {
                        if (hasChanged) {
                            this.state.switcherAvailable = result.available;
                            this.state.switcherTeams = result.teams;
                            // A later background refresh actually got a
                            // value: no longer a miss (VAL-COLD-004).
                            this.state.switcherOfflineFallback = false;
                            this._initSwitcherSelection(true);
                        }
                    },
                })
                .call("crm.team", "get_team_switcher_data"));
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
            // No disk value cached for this call (never loaded online on
            // this device) and the network leg failed, offline or
            // mid-flight (e.g. a 502 from a reverse proxy): degrade to
            // "All Teams" instead of rejecting this whole `_initSwitcher()`
            // and, through it, `load()` — aborting the view's load
            // (architecture.md §3.2 item 3, offline_inventory.md rows
            // A6/C20). VAL-COLD-004: by construction this `catch` only
            // ever runs on a genuine disk-cache miss -- `RPCCache.read()`
            // (rpc_cache.js) always resolves from a disk hit first, even
            // though its parallel network leg can still reject afterwards
            // (handled above, not here) -- so flag it so the switcher
            // still renders "All Teams" (`isTeamSwitcherVisible` above)
            // instead of disappearing entirely like a legitimate
            // "not enough teams" `switcherAvailable: false` would.
            offlineFallback = true;
        }
        this.state.switcherAvailable = available;
        this.state.switcherTeams = teams;
        this.state.switcherOfflineFallback = offlineFallback;
        this._initSwitcherSelection();
    }

    /**
     * Init the switcher selected team by retrieving it from
     * the local storage or fallback on "All Teams".
     */
    _initSwitcherSelection(loaded=false) {
        let teamId = JSON.parse(browser.localStorage.getItem("crm.switcher_team_id"));
        const isValid = this.state.switcherTeams.find((t) => t.id === teamId);
        if (!isValid) {
            // Fallback on "All Teams"
            teamId = undefined;
        }
        if (teamId === this.state.switcherTeamId) {
            // Already the current one: nothing to update.
            // If already loaded, notify as switcherAvailable or switcherTeams have changed.
            if (loaded) {
                this._notify();
            }
            return;
        }
        // Update the selected team
        // If already loaded: notify to recompute the search context and domain.
        this._updateSwitcherSelection(teamId, loaded);
    }

    /**
     * Set the team as "default_team_id" in the action context.
     * Useful to get the team as default when creating "crm.lead" records via the "New" button
     * as the form is opened using the original action context, not the current search context.
     * Also updating the globalContext (= action context one-time copy when the search model is loaded)
     * to prevent stale data.
     */
    _updateActionContext(teamId) {
        for (const context of [this._actionContext, this.globalContext]) {
            if (!context) {
                continue;
            }
            if (teamId) {
                context.default_team_id = teamId;
            } else {
                delete context.default_team_id;
            }
        }
    }

    /**
     * Update the team switcher selected team.
     * @param {Number} teamId Id of the new selected team, "undefined" fallbacks on "All Sales Team".
     * @param {Boolean} notify Whether or not to notify to recompute the search context and domain.
     */
    _updateSwitcherSelection(teamId, notify=true) {
        this.state.switcherTeamId = teamId;
        this._updateActionContext(teamId);
        if (teamId) {
            browser.localStorage.setItem("crm.switcher_team_id", JSON.stringify(teamId));
        } else {
            browser.localStorage.removeItem("crm.switcher_team_id");
        }
        if (notify) {
            this._notify();
        }
    }

    // ===========================================
    // Offline Mode
    // ===========================================

    /**
     * @override
     * In offline mode, restore the current search selected team.
     */
    applySearch(search) {
        // Restore the search (without the team)
        this.blockNotification = true; // Prevent notify
        super.applySearch({ ...search, facets: search.facets.filter((f) => !f.isTeamFacet) });
        this.blockNotification = false;
        // Restore the team
        if (search.teamId !== this.state.switcherTeamId) {
            this._updateSwitcherSelection(search.teamId);
            return;
        }
        this._notify();
    }

    /**
     * @override
     * In offline mode, the team switcher dropdown is disabled to reduce complexity.
     * Instead, showing the current search selected team in the search facets.
     */
    getCurrentSearch() {
        const search = super.getCurrentSearch();
        const team = this.switcherTeam();
        if (!team) {
            return search;
        }
        return {
            ...search,
            facets: [
                ...search.facets,
                { type: "field", icon: "filter_alt", title: _t("Team"), values: [team.name], isTeamFacet: true },
            ],
            teamId: team.id,
        };
    }
};
