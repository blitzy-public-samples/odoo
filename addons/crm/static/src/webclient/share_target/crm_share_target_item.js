import { registry } from "@web/core/registry";
import { ShareTargetItem } from "@web/webclient/share_target/share_target_item";
import { onWillStart, useOnChange } from "@odoo/owl";
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
        /**
         * The domain whose teams the last successful read loaded, `null` until one succeeds. A
         * company change assigns a new `teamsDomain`, so the loaded teams no longer match it; a
         * read that loses the connection leaves it unchanged.
         */
        this.loadedTeamsDomain = null;
        onWillStart(() => this.updateTeams());
        // A dialog opened offline, or whose read was lost, has no teams of the selected company.
        // They are read when the connection returns, so the team picker and the lead's default
        // team are offered as online. Only the connection state is tracked, and the first run is
        // skipped: an online mount issues only the read of `onWillStart`, and a reconnection after
        // a successful read issues none.
        useOnChange(
            () => [this.crmOffline.isOffline()],
            (isOffline) => {
                if (!isOffline && this.loadedTeamsDomain !== this.teamsDomain) {
                    this.updateTeams();
                }
            },
            { initialRun: false }
        );
    }

    /**
     * Loads the sales teams of the selected company and selects the first one.
     *
     * The team list only feeds the share-target lead creation, which uploads the shared files to
     * the server and therefore has no offline path. So the read is not issued while offline, and a
     * connection lost during the read is swallowed: in both cases the teams and the selected team
     * keep their current values (none on an offline mount, so the team panel stays hidden), and
     * nothing is raised from `onWillStart` or from the unawaited calls in `onCompanyChange` and
     * on reconnection. Any other error still propagates. Online, the request is unchanged. A
     * successful read records its domain in `loadedTeamsDomain`.
     */
    async updateTeams() {
        if (this.crmOffline.isOffline()) {
            return;
        }
        const domain = this.teamsDomain;
        try {
            this.state.teams = await this.orm
                .webSearchRead("crm.team", domain, {
                    specification: { id: {}, display_name: {} },
                    context: this.context,
                })
                .then(({ records }) => records);
            this.state.selected_team = this.state.teams.length ? this.state.teams[0] : false;
            this.loadedTeamsDomain = domain;
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

    /**
     * Activates the selected company on the client before the lead is created.
     *
     * The activation only prepares the share-target lead creation, which has no offline path (see
     * `process`), so it is skipped while offline and the active companies stay as they are.
     * Online, it is unchanged.
     */
    async checkAndActiveIfNeededUserCompany() {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.checkAndActiveIfNeededUserCompany();
    }

    /**
     * Uploads the shared files, creates the lead with them and opens it.
     *
     * The creation uploads the files to the server, so it has no offline path and is inert while
     * offline. The framework disables the dialog's Create button, but the share-target "save"
     * hook can still be called without it (a direct `callHook("save")` or a synthetic click), so
     * the guard sits here: nothing is uploaded, created, linked or queued, and nothing is raised.
     * Online, it is unchanged.
     */
    async process() {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.process();
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
