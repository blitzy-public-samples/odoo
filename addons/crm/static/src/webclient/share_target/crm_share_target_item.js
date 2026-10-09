import { registry } from "@web/core/registry";
import { ShareTargetItem } from "@web/webclient/share_target/share_target_item";
import { onWillStart } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";

export class CrmShareTargetItem extends ShareTargetItem {
    static template = "crm.ShareTargetItem";
    static name = _t("Lead");
    static sequence = 4;

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        this.teamsDomain = [["company_id", "in", [this.currentCompany.id, false]]];
        onWillStart(() => this.updateTeams());
    }

    /**
     * Loads the sales teams of the selected company and selects the first one.
     *
     * The team list only feeds the share-target lead creation, which uploads the shared files to
     * the server and therefore has no offline path. So the read is not issued while offline, and a
     * connection lost during the read is swallowed: in both cases the teams and the selected team
     * keep their current values (none on an offline mount, so the team panel stays hidden), and
     * nothing is raised from `onWillStart` or from the unawaited call in `onCompanyChange`. Any
     * other error still propagates. Online, the request is unchanged.
     */
    async updateTeams() {
        if (this.crmOffline.isOffline()) {
            return;
        }
        try {
            this.state.teams = await this.orm
                .webSearchRead("crm.team", this.teamsDomain, {
                    specification: { id: {}, display_name: {} },
                    context: this.context,
                })
                .then(({ records }) => records);
            this.state.selected_team = this.state.teams.length ? this.state.teams[0] : false;
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return;
            }
            throw error;
        }
    }

    onCompanyChange(companyId) {
        super.onCompanyChange(companyId);
        this.teamsDomain = [["company_id", "in", [this.currentCompany.id, false]]];
        this.updateTeams();
    }

    get defaultState() {
        return { ...super.defaultState, teams: [], selected_team: false };
    }

    get hasMultiTeams() {
        return this.state.teams.length > 1;
    }

    get modelName() {
        return "crm.lead";
    }
    get context() {
        return {
            ...super.context,
            default_team_id: this.state.selected_team.id,
        };
    }

    get teamRecordProps() {
        return {
            mode: "readonly",
            values: { team: this.state.selected_team },
            fieldNames: ["team"],
            fields: {
                team: {
                    name: "team",
                    type: "many2one",
                    relation: "crm.team",
                    domain: this.teamsDomain,
                },
            },
            hooks: {
                onRecordChanged: (record) => {
                    this.state.selected_team = record.data.team;
                },
            },
        };
    }
}

registry.category("share_target_items").add("crm", CrmShareTargetItem);
