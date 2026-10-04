import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

import { Component, effect, onWillDestroy, onWillStart } from "@odoo/owl";

export class TeamSwitcher extends Component {
    static template = "crm.team_switcher";
    static components = { Dropdown, DropdownItem };

    /**
     * @override
     */
    setup() {
        super.setup();
        this.actionService = useService("action");
        this.crmOffline = useCrmOffline();
        this.isSaleManager = false;

        // Scrutiny finding 4 (VAL-FIX-006/VAL-FIX-013): `onWillStart` below
        // only runs once, at mount time, so a manager whose switcher first
        // mounts offline would be stuck with `isSaleManager = false` for
        // the rest of this component's life, even after reconnecting --
        // the framework re-enables the toggler, but "Manage Teams" would
        // stay missing from inside it. This effect re-probes reactively
        // whenever `isOffline()` flips back to `false` after the initial
        // mount; `initialProbeDone` keeps it from firing a second,
        // redundant probe for the very first (online) mount, which
        // `onWillStart` already handles synchronously before the first
        // render. `isOffline()` must be read unconditionally so the effect
        // keeps tracking it even while `initialProbeDone` is still false.
        let initialProbeDone = false;
        const disposeIsSaleManagerEffect = effect(() => {
            const offline = this.crmOffline.isOffline();
            if (!initialProbeDone) {
                return;
            }
            if (offline) {
                this.isSaleManager = false;
                return;
            }
            // m5-fix-team-switcher-catch (research/m5-reconnect-stale-ui.md):
            // `isOffline()` can briefly read `false` while the network is
            // actually still down (a stray successful "RPC:RESPONSE" landing
            // ahead of a parked request's own failure), so this probe can
            // still reject with `ConnectionLostError` even though it is only
            // ever issued once `offline` above is already `false`.
            // `user.hasGroup`'s cache (`Cache.read()`, addons/web/static/src/
            // core/utils/cache.js) never evicts a rejected promise, so an
            // unhandled rejection here would stay cached for the rest of the
            // page's life: every later re-run of this effect would re-raise
            // the same `ConnectionLostError` unhandled, and
            // `lostConnectionHandler` (addons/web/static/src/core/offline/
            // offline_error.js) would call `setOffline(true)` again each
            // time, looping the page back offline forever. A
            // `ConnectionLostError` here is therefore treated the same as
            // the architecture's offline SKIP decision -- the attempted
            // request fails silently -- but, unlike the `offline` branch
            // above, it must not overwrite an already-known value with
            // `false`: keep whatever `isSaleManager` already held (the
            // existing offline default if it was never known yet). Any
            // other error is a genuine bug and must still surface.
            user.hasGroup("sales_team.group_sale_manager").then(
                (result) => {
                    this.isSaleManager = result;
                },
                (error) => {
                    if (!(error instanceof ConnectionLostError)) {
                        throw error;
                    }
                }
            );
        });
        onWillDestroy(disposeIsSaleManagerEffect);

        onWillStart(async () => {
            // `user.hasGroup` is backed by a `Cache` (addons/web/static/src/
            // core/utils/cache.js) that never evicts a rejected promise, so
            // an uncached probe issued offline would stay rejected for the
            // rest of the page's life, even after reconnecting
            // (architecture.md §2). Check `isOffline()` first and treat the
            // probe as `false` instead of issuing it (architecture.md §3.2
            // item 3). "Manage Teams" is unreachable offline regardless:
            // the toggler below is a plain `<button>` without
            // `data-available-offline`, so the framework's
            // `SELECTORS_TO_DISABLE` already disables it.
            this.isSaleManager = this.crmOffline.isOffline()
                ? false
                : await user.hasGroup("sales_team.group_sale_manager");
            initialProbeDone = true;
        });
    }

    get allTeamsLabel() {
        return _t("All Teams");
    }

    get currentLabel() {
        return this.teams.find((t) => t.id === this.selectedTeamId)?.name || this.allTeamsLabel;
    }

    get hasDropdown() {
        return this.teams.length > 0;
    }

    get selectedTeamId() {
        return this.env.searchModel.state.switcherTeamId;
    }

    get teams() {
        return this.env.searchModel.state.switcherTeams;
    }

    onClickManageTeams() {
        // Scrutiny finding 3 (VAL-DIS-010): the toggler is a plain
        // `<button>` without `data-available-offline`, so the framework
        // disables it on its own going offline -- but a dropdown already
        // open *before* the connection drops keeps its `DropdownItem`
        // spans in the DOM and clickable (the framework only disables
        // `<button>`s, not the items of an already-rendered menu), and
        // this handler is also reachable directly. Guard it here too.
        if (this.crmOffline.isOffline()) {
            return;
        }
        this.actionService.doAction("sales_team.crm_team_action_config");
    }

    /**
     * Change the currently selected team:
     * - crm.lead records are filtered to that team + team-less records
     * - only that team's stages are shown + the stages of team-less records
     * - the team becomes the default when creating a new crm.lead or crm.stage
     * @param {Number} teamId Id of the new selected team, "undefined" fallbacks on "All Sales Team".
     */
    onSelect(teamId) {
        // Scrutiny finding 3 (VAL-DIS-010): same reasoning as
        // `onClickManageTeams` above -- a menu opened online stays
        // reachable through its own already-rendered items once offline,
        // and `_updateSwitcherSelection` would otherwise reload the view
        // for data this team's stages/records may never have been
        // visited for offline.
        if (this.crmOffline.isOffline()) {
            return;
        }
        if (this.selectedTeamId === teamId) {
            return;
        }
        this.env.searchModel._updateSwitcherSelection(teamId);
    }
};
