import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "@web/core/l10n/translation";
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
        // Result of the sales-manager group probe: `null` until it has been probed online, then
        // the boolean answer. It is retained across disconnections, so reconnecting never probes
        // again once an answer is known (see `isSaleManager`).
        this.probedSaleManager = signal(null);

        // The group probe is advisory (it only toggles the "Manage Teams" item), so it is skipped
        // offline: a cold offline mount must not fail on an RPC that cannot be answered.
        onWillStart(async () => {
            if (this.crmOffline.isOffline()) {
                return;
            }
            try {
                await this._probeSaleManager();
            } catch (error) {
                // The connection dropped while the probe was in flight: the offline plugin is
                // already offline when the RPC rejects, so the mount goes on with the item hidden
                // instead of failing. The answer stays unknown (the user group cache may keep
                // that failed answer, which keeps the item hidden: the safe outcome). Any other
                // error propagates as it always did.
                if (!this.crmOffline.isOffline()) {
                    throw error;
                }
            }
        });

        // Probes whenever the client is online and no answer is known yet. The effect runs once
        // synchronously here, so an online mount starts the probe now and `onWillStart` awaits
        // that same promise: exactly one `has_group` call, as before. After a cold offline mount
        // it re-runs on reconnect (it reads `isOffline()`) and probes once. The probe runs
        // untracked so the effect only depends on the two signals read above it, and the block
        // body returns nothing because an effect's return value is its cleanup.
        useEffect(() => {
            if (this.crmOffline.isOffline() || this.probedSaleManager() !== null) {
                return;
            }
            untrack(() => this._probeSaleManager()).catch(() => {
                // A failed reconnect probe leaves the answer unknown, so "Manage Teams" stays
                // hidden; an online mount reports the same failure through `onWillStart`.
            });
        });
    }

    /**
     * Probes the sales-manager group, sharing one in-flight request between the mount and the
     * reconnect effect. A failed probe is forgotten so that a later trigger may probe again.
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
     * Whether the "Manage Teams" item is offered. Navigating to the team configuration is not
     * possible offline, so the item is hidden whenever the client is offline, whether the
     * component was mounted offline or the connection dropped later, and shown again on
     * reconnect from the retained probe answer.
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
