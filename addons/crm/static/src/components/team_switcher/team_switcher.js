import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "@web/core/l10n/translation";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

import { Component, onWillStart } from "@odoo/owl";

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
        if (this.selectedTeamId === teamId) {
            return;
        }
        this.env.searchModel._updateSwitcherSelection(teamId);
    }
};
