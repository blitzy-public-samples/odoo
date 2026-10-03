import { Breadcrumbs } from "@web/search/breadcrumbs/breadcrumbs";
import { TeamSwitcher } from "@crm/components/team_switcher/team_switcher";

export class CrmBreadcrumbs extends Breadcrumbs {
    static template = "crm.Breadcrumbs";
    static components = {
        ...Breadcrumbs.components,
        TeamSwitcher,
    };

    get hasTeamSwitcher() {
        // `isTeamSwitcherVisible`, not `isTeamSwitcherEnabled`: the latter
        // also feeds the search context's `team_switcher_enabled`, which
        // must stay strictly tied to `switcherAvailable` for the kanban
        // root's own cached request key to keep matching online
        // (VAL-COLD-004, see crm_search_model.js).
        return this.env.searchModel.isTeamSwitcherVisible;
    }
}
