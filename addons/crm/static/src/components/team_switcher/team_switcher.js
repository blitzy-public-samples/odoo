import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";

import { Component, onWillStart, signal, untrack, useEffect } from "@odoo/owl";

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
        // Sales-manager probe answer: `null` until a probe succeeds online, then the boolean. It is
        // retained across disconnections, so a known answer is never probed again.
        this.probedSaleManager = signal(null);

        // The probe is advisory (it only toggles "Manage Teams"), so it is skipped offline and a
        // cold offline mount does not fail.
        onWillStart(async () => {
            if (this.crmOffline.isOffline()) {
                return;
            }
            try {
                await this._probeSaleManager();
            } catch (error) {
                // A probe that lost the connection, just now or replayed by the user group cache
                // (which keeps rejected answers), leaves the answer unknown: the mount completes
                // with "Manage Teams" hidden until the page is reloaded. Any other error received
                // online propagates.
                if (!(error instanceof ConnectionLostError) && !this.crmOffline.isOffline()) {
                    throw error;
                }
            }
        });

        // Probes while online and the answer is unknown. The effect runs at setup, so `onWillStart`
        // awaits this same request (a single `has_group`); after a cold offline mount it re-runs on
        // reconnect. The probe runs untracked so only the two signals read above are dependencies;
        // the block body returns nothing because an effect's return value is its cleanup.
        useEffect(() => {
            if (this.crmOffline.isOffline() || this.probedSaleManager() !== null) {
                return;
            }
            untrack(() => this._probeSaleManager()).catch(() => {
                // A failed reconnect probe leaves the answer unknown, so "Manage Teams" stays
                // hidden; an online mount handles the same failure in `onWillStart`.
            });
        });
    }

    /**
     * Probes the sales-manager group. Callers share the in-flight request; a failed probe is
     * cleared so a later trigger can retry.
     *
     * @returns {Promise<void>}
     */
    _probeSaleManager() {
        if (!this._saleManagerProbe) {
            this._saleManagerProbe = user
                .hasGroup("sales_team.group_sale_manager")
                .then((isManager) => this.probedSaleManager.set(isManager))
                .catch((error) => {
                    this._saleManagerProbe = null;
                    throw error;
                });
        }
        return this._saleManagerProbe;
    }

    /**
     * Whether "Manage Teams" is offered: never offline, where the team configuration cannot open;
     * otherwise the retained probe answer.
     *
     * @returns {boolean}
     */
    get isSaleManager() {
        return !this.crmOffline.isOffline() && this.probedSaleManager() === true;
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
        // The team configuration action is not available offline. The guard also covers a
        // dropdown left open at disconnection and direct calls, which no disabled button stops.
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
        // Switching teams is locked offline: the reload would query another team's domain,
        // which may never have been cached. The switcher data itself still comes from the search
        // model's disk cache at load, and the current selection and its facet are kept as they are.
        if (this.crmOffline.isOffline()) {
            return;
        }
        if (this.selectedTeamId === teamId) {
            return;
        }
        this.env.searchModel._updateSwitcherSelection(teamId);
    }
};
