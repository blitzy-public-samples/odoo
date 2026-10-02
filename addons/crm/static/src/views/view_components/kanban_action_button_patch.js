import { KanbanController } from "@web/views/kanban/kanban_controller";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B32-B39, B43, C19 (VAL-DIS-026/027): the team dashboard's menu links
 * (unassigned opportunities, Leads/Opportunities, New Lead/New Opportunity,
 * the three reports -- all `<a type="object"|"action">` compiled by
 * `CardCompiler.compileButton` into `ViewButton`s) and the UTM campaign
 * card's `<a type="object" name="action_redirect_to_leads_opportunities">`
 * (B43) are not `<button>`s, so the framework's `SELECTORS_TO_DISABLE`
 * never reaches them. Every `ViewButton` click runs through
 * `useViewButtonHandler`'s `onClickViewButton`, which calls
 * `options.beforeExecuteAction` (`KanbanController.beforeExecuteActionButton`,
 * a no-op stub) before doing anything else; returning `false` there cancels
 * the click outright, before any `call_kw`/`doAction`.
 *
 * No dedicated `js_class` exists for either `crm.team`'s or
 * `utm.campaign`'s kanban (both use the plain "kanban" view), so this patches
 * the shared `KanbanController` instead of subclassing, scoped by
 * `resModel` so every other addon's kanban action button is untouched,
 * online or offline.
 */
const SCOPED_MODELS = ["crm.team", "utm.campaign"];

patch(KanbanController.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    async beforeExecuteActionButton(clickParams) {
        if (SCOPED_MODELS.includes(this.props.resModel) && this.crmOffline.isOffline()) {
            return false;
        }
        return super.beforeExecuteActionButton(clickParams);
    },
});
