/**
 * CRM offline behaviour: lane 2 (Hoot) of the offline/mobile work.
 *
 * These tests prove, under the desktop and mobile presets, that:
 * - the post-save rainbowman lookup is skipped offline (PART 2.1) and still issued online;
 * - the email/phone partner-sync copy reaches the queued `web_save` (PART 2.2);
 * - every DISABLE entry point of `static/src/mobile/offline_inventory.md` is disabled offline,
 *   re-enabled online and inert by click, hotkey, keyboard selection and direct call (PART 2.3 to
 *   2.8 and the handler patches of `@crm/mobile/crm_offline_hooks`), while SKIP calls are not
 *   issued and raise nothing;
 * - existing lead controls usable offline carry the offline-availability attribute (K9);
 * - leads, stages and teams are created, edited and moved through the shared framework queue,
 *   replayed in timestamp order with last-write-wins and parked on rejection (PART 3, gate 8).
 *
 * Conventions:
 * - Every mock model is local to this file; no existing test helper is modified.
 * - Offline state is driven only through the offline plugin (`mockOffline()` and
 *   `getService(OfflinePlugin)`).
 * - "Inert" always means: no RPC (stepped by a route watcher registered after `mockOffline()`, so
 *   that it sees the requests the offline mock answers with a 502), no record save, no dialog and
 *   no action. Hoot fails a test on any undeclared error, which is how "no uncaught error" is
 *   asserted; only errors the framework itself produces are declared.
 */

import {
    advanceTime,
    animationFrame,
    beforeEach,
    describe,
    expect,
    queryAll,
    queryAllTexts,
    queryFirst,
    queryOne,
    runAllTimers,
    test,
} from "@odoo/hoot";
import { press } from "@odoo/hoot-dom";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";
import {
    click as mailClick,
    contains as mailContains,
    hover,
    insertText,
    listenStoreFetch,
    mailModels,
    openFormView,
    openView,
    start,
    startServer,
    waitStoreFetch,
} from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    findComponent,
    getService,
    isSmall,
    makeServerError,
    mockOffline,
    mockService,
    models,
    mountView,
    MockServer,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    serverState,
    swipeLeft,
    swipeRight,
    toggleActionMenu,
    toggleMenuItem,
} from "@web/../tests/web_test_helpers";
import { status } from "@odoo/owl";

import {
    CRM_FOREIGN_DISABLED_BUTTONS,
    CRM_OFFLINE_DISABLED_SELECTORS,
    CRM_OFFLINE_MODELS,
} from "@crm/mobile/crm_offline_hooks";
import { LeadGenerationDropdown } from "@crm/components/lead_generation_dropdown/lead_generation_dropdown";
import { TeamSwitcher } from "@crm/components/team_switcher/team_switcher";
import { CrmPlsTooltipButton } from "@crm/views/crm_form/crm_pls_tooltip_button";
import { CrmColumnProgress } from "@crm/views/crm_kanban/crm_column_progress";
import { CrmShareTargetItem } from "@crm/webclient/share_target/crm_share_target_item";
import { HtmlField } from "@html_editor/fields/html_field";
import { ScheduledMessage } from "@mail/chatter/web/scheduled_message";
import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { Composer } from "@mail/core/common/composer";
import { MessageAction } from "@mail/core/common/message_actions";
import { MessageReactionList } from "@mail/core/common/message_reaction_list";
import { MessageReactionMenu } from "@mail/core/common/message_reaction_menu";
import { QuickReactionMenu } from "@mail/core/common/quick_reaction_menu";
import { Activity } from "@mail/core/web/activity";
import { ActivityAssignPopover } from "@mail/core/web/activity_assign_popover";
import { ActivityMailTemplate } from "@mail/core/web/activity_mail_template";
import { ActivityMarkAsDone } from "@mail/core/web/activity_markasdone_popover";
import { Follower } from "@mail/core/web/follower";
import { FollowerList } from "@mail/core/web/follower_list";
import { FollowerSubtypeDialog } from "@mail/core/web/follower_subtype_dialog";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { Many2One } from "@web/views/fields/many2one/many2one";
import { FormController } from "@web/views/form/form_controller";
import { KanbanRecord } from "@web/views/kanban/kanban_record";
import { ListController } from "@web/views/list/list_controller";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { MultiRecordViewButton } from "@web/views/view_button/multi_record_view_button";
import { ViewButton } from "@web/views/view_button/view_button";
import { shareTargetService } from "@web/webclient/share_target/share_target_service";
import { WebClient } from "@web/webclient/webclient";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const R_CALL_KW = /\/web\/dataset\/call_(?:kw|button)\/(?<model>[\w.]+)\/(?<method>\w+)/;
const BASE_OFFLINE_SELECTOR = "button:not([data-available-offline]):not([disabled])";

/**
 * Steps every request whose `model/method` (ORM calls) or path (other routes) is watched, as
 * `"<model>/<method>"` or the path. The watcher returns nothing, so the request goes on to the
 * next handler. Registered after `mockOffline()`, it runs first and therefore also steps the
 * requests the offline mock answers with a 502: a guard that lets a call through is caught even
 * while offline.
 *
 * @param {Array<string | RegExp>} watched `"model/method"`, `"method"`, a path, or a regex
 */
function watchRpcs(watched) {
    const matches = (label, method) =>
        watched.some((w) =>
            w instanceof RegExp ? w.test(label) : w === label || (method && w === method)
        );
    onRpc("/*", (request) => {
        const path = new URL(request.url).pathname;
        const match = path.match(R_CALL_KW);
        if (match) {
            const label = `${match.groups.model}/${match.groups.method}`;
            if (matches(label, match.groups.method)) {
                expect.step(label);
            }
        } else if (matches(path)) {
            expect.step(path);
        }
    });
}

/**
 * Steps, as `"offline:<model>/<method>"` or `"offline:<path>"`, every request issued while the
 * offline plugin reports offline, except the plugin's own reconnection pings and the many2one
 * autocomplete's `web_name_search`. Offline on small screens a lead many2one renders its
 * autocomplete inline, which searches as soon as it is shown; the framework's
 * `Many2XAutocomplete.search` answers that 502 from the relational-field cache. That read is the
 * offline partner lookup, never a DISABLE path. Registered after `mockOffline()`, the watcher sees
 * the requests the offline mock answers with a 502: a DISABLE guard that lets anything reach the
 * network is caught.
 */
function watchOfflineRpcs() {
    onRpc("/*", (request) => {
        let isOffline = false;
        try {
            isOffline = getService(OfflinePlugin).isOffline();
        } catch {
            return; // no test app yet: nothing can be offline
        }
        const path = new URL(request.url).pathname;
        if (!isOffline || path === "/web/webclient/version_info") {
            return;
        }
        const match = path.match(R_CALL_KW);
        if (match?.groups.method === "web_name_search") {
            return;
        }
        expect.step(`offline:${match ? `${match.groups.model}/${match.groups.method}` : path}`);
    });
}

/**
 * Steps, as `"has_group:<group>"`, every group probe request the client sends for one of the
 * given groups, online or offline. `user.hasGroup` caches its answer per group, so this counts the
 * probes that actually reach the network.
 *
 * @param {string[]} groups
 */
function watchGroupProbes(groups) {
    onRpc("/web/dataset/call_kw/res.users/has_group", async (request) => {
        const { params } = await request.clone().json();
        const group = params.args[1];
        if (groups.includes(group)) {
            expect.step(`has_group:${group}`);
        }
    });
}

/**
 * Makes every request answer with a 502 (connection lost) while `state.offline` is true, as the
 * framework sees a connection that drops during a call. The returned state is mutable.
 */
function mockConnectionDrop() {
    const state = { offline: false };
    onRpc("/*", () => {
        if (state.offline) {
            return new Response("", { status: 502 });
        }
    });
    return state;
}

/** Keeps the reconnection pings failing, so the client stays offline across timers. */
function keepPingsFailing() {
    onRpc("/web/webclient/version_info", () => new Response("", { status: 502 }), { pure: true });
}

/**
 * Collects the instances of a component class (or of its subclasses) created during the test.
 *
 * @template T
 * @param {new (...args: any[]) => T} ComponentClass
 * @returns {T[]}
 */
function captureInstances(ComponentClass) {
    const instances = [];
    patchWithCleanup(ComponentClass.prototype, {
        setup() {
            const result = super.setup(...arguments);
            instances.push(this);
            return result;
        },
    });
    return instances;
}

/** @returns {Object[]} the framework offline queue entries, as stored */
function queuedEntries() {
    return Object.values(getService(OfflinePlugin)._ormToSync());
}

/**
 * @param {string} model
 * @param {string} method
 * @returns {Object[]} the queued values of `model.method`
 */
function queuedCalls(model, method) {
    return queuedEntries()
        .map(({ value }) => value)
        .filter((value) => value.model === model && value.method === method);
}

/** Resolves once the offline plugin has read which items are available offline. */
async function visitedReady() {
    await getService(OfflinePlugin).getVisitedStatus();
    await animationFrame();
}

/** @param {HTMLElement | string} target */
function isDisabledOffline(target) {
    const el = typeof target === "string" ? queryOne(target) : target;
    return el.hasAttribute("disabled") && el.classList.contains("o_disabled_offline");
}

// -----------------------------------------------------------------------------
// Mock models
// -----------------------------------------------------------------------------

class CrmStage extends models.Model {
    _name = "crm.stage";
    _order = "sequence, id";

    name = fields.Char({ string: "Stage Name" });
    sequence = fields.Integer({ default: 1 });
    is_won = fields.Boolean({ string: "Is Won Stage?" });
    fold = fields.Boolean({ string: "Folded in Pipeline" });
    team_ids = fields.Many2many({ string: "Sales Teams", relation: "crm.team" });

    _records = [
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Qualified", sequence: 2 },
        { id: 3, name: "Won", sequence: 3, is_won: true },
    ];

    _views = {
        form: /* xml */ `
            <form>
                <sheet>
                    <field name="name"/>
                    <field name="sequence"/>
                </sheet>
            </form>`,
        list: /* xml */ `<list><field name="name"/><field name="sequence"/></list>`,
        search: /* xml */ `<search><field name="name"/></search>`,
    };
}

class CrmTeam extends models.Model {
    _name = "crm.team";

    name = fields.Char({ string: "Sales Team" });
    sequence = fields.Integer({ default: 10 });
    use_opportunities = fields.Boolean({ default: true });
    member_ids = fields.Many2many({ string: "Members", relation: "res.users" });
    company_id = fields.Many2one({ string: "Company", relation: "res.company" });

    _records = [
        { id: 1, name: "Mushroom Kingdom", sequence: 1, company_id: false },
        { id: 2, name: "Hyrule", sequence: 2, company_id: false },
    ];

    _views = {
        form: /* xml */ `
            <form>
                <header>
                    <button name="action_assign_leads" type="object" string="Assign Leads"/>
                </header>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_open_opportunities" type="object"
                            class="oe_stat_button" icon="star" string="Pipeline"/>
                    </div>
                    <field name="name"/>
                </sheet>
            </form>`,
        list: /* xml */ `<list><field name="name"/></list>`,
        kanban: /* xml */ `
            <kanban class="o_crm_team_kanban" action="action_primary_channel_button" type="object">
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                        <a type="object" name="action_open_unassigned_opportunities">Unassigned</a>
                        <a type="action" name="crm.crm_case_form_view_salesteams_lead">Leads</a>
                        <a type="action" name="crm.crm_case_form_view_salesteams_opportunity">Opportunities</a>
                        <a type="action" name="crm.crm_lead_action_open_lead_form">New Lead</a>
                        <a type="action" name="crm.action_opportunity_form">New Opportunity</a>
                        <a type="action" name="crm.action_report_crm_lead_salesteam">Leads Report</a>
                        <a type="action" name="crm.action_report_crm_opportunity_salesteam">Opportunities Report</a>
                        <a type="action" name="crm.crm_activity_report_action_team">Activities</a>
                    </t>
                </templates>
            </kanban>`,
        search: /* xml */ `<search><field name="name"/></search>`,
    };

    /** Same behaviour as the switcher data of `crm_team_switcher.test.js`. */
    get_team_switcher_data() {
        const teams = this._filter([["use_opportunities", "=", true]]);
        const stages = this.env["crm.stage"];
        const sharedStageIds = stages
            .filter((stage) => !stage.team_ids.length)
            .map((stage) => stage.id);
        return {
            available: teams.length > 1,
            teams: teams.map((team) => {
                const teamStageIds = stages
                    .filter((stage) => stage.team_ids.includes(team.id))
                    .map((stage) => stage.id);
                return {
                    id: team.id,
                    name: team.name,
                    switcher_domain: [
                        "|",
                        ["team_id", "=", team.id],
                        "&",
                        ["team_id", "=", false],
                        ["stage_id", "in", [...teamStageIds, ...sharedStageIds]],
                    ],
                };
            }),
        };
    }
}

class CrmTag extends models.Model {
    _name = "crm.tag";

    name = fields.Char();
    color = fields.Integer();

    _records = [
        { id: 1, name: "Product" },
        { id: 2, name: "Services" },
    ];
}

class CrmLostReason extends models.Model {
    _name = "crm.lost.reason";

    name = fields.Char();

    _records = [{ id: 1, name: "Too expensive" }];

    _views = {
        form: /* xml */ `
            <form>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_lost_leads" type="object"
                            class="oe_stat_button" icon="star" string="Leads"/>
                    </div>
                    <field name="name"/>
                </sheet>
            </form>`,
    };
}

class CrmActivityReport extends models.Model {
    _name = "crm.activity.report";

    name = fields.Char({ string: "Summary" });

    _records = [{ id: 1, name: "Call the customer" }];

    _views = {
        list: /* xml */ `
            <list action="action_open_lead" type="object">
                <field name="name"/>
            </list>`,
        search: /* xml */ `<search/>`,
    };
}

class UtmCampaign extends models.Model {
    _name = "utm.campaign";

    name = fields.Char();

    _records = [{ id: 1, name: "Spring" }];

    _views = {
        form: /* xml */ `
            <form>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_redirect_to_leads_opportunities" type="object"
                            class="oe_stat_button" icon="star" string="Leads"/>
                    </div>
                    <field name="name"/>
                </sheet>
            </form>`,
    };
}

class ResConfigSettings extends models.Model {
    _name = "res.config.settings";

    name = fields.Char();

    _records = [{ id: 1, name: "Settings" }];

    _views = {
        form: /* xml */ `
            <form>
                <div name="crm_settings">
                    <button name="crm.crm_recurring_plan_action" type="action"
                        string="Manage Recurring Plans" class="btn-link"/>
                    <button name="crm.crm_lead_pls_update_action" type="action"
                        string="Update Probabilities" class="btn-link"/>
                    <button name="action_crm_assign_leads" type="object"
                        string="Update now" class="btn-link"/>
                </div>
                <field name="name"/>
            </form>`,
    };
}

class IrModuleModule extends models.Model {
    _name = "ir.module.module";

    name = fields.Char();
    shortdesc = fields.Char();
    state = fields.Char();

    _records = [
        { id: 11, name: "crm_iap_mine", shortdesc: "Lead Generation", state: "uninstalled" },
        { id: 12, name: "website", shortdesc: "Website", state: "uninstalled" },
        { id: 13, name: "mass_mailing", shortdesc: "Email Marketing", state: "uninstalled" },
        { id: 14, name: "survey", shortdesc: "Surveys", state: "uninstalled" },
    ];

    button_immediate_install() {
        return true;
    }
}

/** Transient wizards of the CRM addon, each with its confirm button (inventory B36 to B39). */
class CrmLeadLost extends models.Model {
    _name = "crm.lead.lost";

    name = fields.Char();

    _views = {
        form: /* xml */ `
            <form>
                <field name="name"/>
                <footer>
                    <button name="action_lost_reason_apply" type="object" string="Mark as Lost"
                        class="btn-primary" data-hotkey="q"/>
                    <button special="cancel" string="Cancel"/>
                </footer>
            </form>`,
    };
}

class CrmLeadPlsUpdate extends models.Model {
    _name = "crm.lead.pls.update";

    name = fields.Char();

    _views = {
        form: /* xml */ `
            <form>
                <field name="name"/>
                <footer>
                    <button name="action_update_crm_lead_probabilities" type="object"
                        string="Update" class="btn-primary" data-hotkey="q"/>
                    <button special="cancel" string="Cancel"/>
                </footer>
            </form>`,
    };
}

class CrmLead2OpportunityPartnerMass extends models.Model {
    _name = "crm.lead2opportunity.partner.mass";

    name = fields.Char();

    _views = {
        form: /* xml */ `
            <form>
                <field name="name"/>
                <footer>
                    <button name="action_apply" type="object" string="Convert"
                        class="btn-primary" data-hotkey="q"/>
                    <button special="cancel" string="Cancel"/>
                </footer>
            </form>`,
    };
}

class CrmMergeOpportunity extends models.Model {
    _name = "crm.merge.opportunity";

    name = fields.Char();

    _views = {
        form: /* xml */ `
            <form>
                <field name="name"/>
                <footer>
                    <button name="action_merge" type="object" string="Merge"
                        class="btn-primary" data-hotkey="q"/>
                    <button special="cancel" string="Cancel"/>
                </footer>
            </form>`,
    };
}

/** Followers wizard opened by the chatter "Add Followers" link (`mail.followers.edit`). */
class MailFollowersEdit extends models.Model {
    _name = "mail.followers.edit";

    res_model = fields.Char({ string: "Related Document Model" });
    res_ids = fields.Char({ string: "Related Document IDs" });
    partner_ids = fields.Many2many({ string: "Recipients", relation: "res.partner" });

    _views = {
        form: /* xml */ `
            <form>
                <field name="res_model" invisible="1"/>
                <field name="res_ids" invisible="1"/>
                <field name="partner_ids" widget="many2many_tags"/>
                <footer>
                    <button string="Update Followers" name="edit_followers" type="object"
                        class="btn-primary" data-hotkey="q"/>
                    <button special="cancel" string="Discard"/>
                </footer>
            </form>`,
    };
}

/** Lead form mirroring `crm_lead_view_form` (header, smart buttons, PLS controls, fields). */
const LEAD_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <header>
            <button name="action_set_won_rainbowman" string="Won" type="object"
                class="oe_highlight" data-hotkey="w"/>
            <button name="action_convert_to_opportunity" string="Convert to Opportunity"
                type="object" class="oe_highlight" data-hotkey="v"/>
            <button name="action_restore" string="Restore" type="object" data-hotkey="x"/>
            <button name="crm.crm_lead_lost_action" string="Lost" type="action" data-hotkey="l"/>
            <field name="stage_id" widget="statusbar" options="{'clickable': '1'}"/>
        </header>
        <sheet>
            <field name="active" invisible="1"/>
            <field name="won_status" invisible="1"/>
            <field name="company_currency" invisible="1"/>
            <field name="partner_email_update" invisible="1"/>
            <field name="partner_phone_update" invisible="1"/>
            <div class="oe_button_box" name="button_box">
                <button name="action_schedule_meeting" type="object" class="oe_stat_button"
                    icon="calendar_today" string="Meeting"/>
                <button name="action_show_potential_duplicates" type="object"
                    class="oe_stat_button" icon="star" string="Similar Leads"/>
            </div>
            <field name="name"/>
            <field name="expected_revenue" widget="monetary"
                options="{'currency_field': 'company_currency'}"/>
            <a class="btn btn-light o_crm_automated_probability_header"
                name="action_set_automated_probability" role="button" type="object">AI</a>
            <widget name="pls_tooltip_button"/>
            <field name="probability" widget="float"/>
            <a class="btn btn-link o_crm_automated_probability_info"
                name="action_set_automated_probability" role="button" type="object">AI</a>
            <field name="partner_id"/>
            <field name="contact_name"/>
            <field name="email_from" widget="email"/>
            <button name="mail_action_blacklist_remove" type="object" string="Unblacklist email"/>
            <field name="phone" widget="phone"/>
            <button name="phone_action_blacklist_remove" type="object" string="Unblacklist phone"/>
            <field name="website" widget="url"/>
            <field name="priority" widget="priority"/>
            <field name="tag_ids" widget="many2many_tags"/>
            <field name="description"/>
        </sheet>
    </form>`;

/** Lead form with its chatter (inventory B11): the chatter is read-only offline (PART 2.8). */
const LEAD_CHATTER_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="partner_id"/>
        </sheet>
        <chatter reload_on_post="True"/>
    </form>`;

/** Pipeline kanban mirroring `crm_case_kanban_view_leads` (card menu, color, priority). */
const LEAD_KANBAN_ARCH = /* xml */ `
    <kanban js_class="crm_kanban" highlight_color="color" default_group_by="stage_id"
        on_create="quick_create" archivable="false">
        <field name="stage_id"/>
        <field name="company_currency"/>
        <field name="recurring_revenue_monthly"/>
        <progressbar field="activity_state"
            colors='{"planned": "success", "today": "warning", "overdue": "danger"}'
            sum_field="expected_revenue" recurring_revenue_sum_field="recurring_revenue_monthly"/>
        <templates>
            <t t-name="menu">
                <t t-if="widget.editable"><a role="menuitem" type="open" class="dropdown-item"
                    data-available-offline="1">Edit</a></t>
                <t t-if="widget.deletable"><a role="menuitem" type="delete" class="dropdown-item"
                    data-available-offline="1">Delete</a></t>
                <div role="separator" class="dropdown-divider"/>
                <field name="color" widget="kanban_color_picker"/>
            </t>
            <t t-name="card">
                <field class="fw-bold fs-5" name="name"/>
                <field name="expected_revenue" widget="monetary"
                    options="{'currency_field': 'company_currency'}"/>
                <footer class="pt-1">
                    <field name="priority" widget="priority" class="me-2"/>
                </footer>
            </t>
        </templates>
    </kanban>`;

/** Leads list mirroring `crm_case_tree_view_leads` (header buttons B12, B13). */
const LEAD_LIST_ARCH = /* xml */ `
    <list js_class="crm_list" limit="2">
        <header>
            <button name="crm.action_crm_send_mass_convert" type="action"
                string="Convert to Opportunities"/>
            <button name="crm.crm_lead_lost_action" type="action" string="Mark Lost"/>
        </header>
        <field name="name"/>
        <field name="active" column_invisible="1"/>
    </list>`;

/** Opportunities list mirroring `crm_case_tree_view_oppor` (header B16, B17 and row B18). */
const OPPORTUNITY_LIST_ARCH = /* xml */ `
    <list js_class="crm_list">
        <header>
            <button name="crm.crm_lead_lost_action" type="action" string="Mark Lost"/>
            <button name="crm.action_lead_mass_mail" type="action" string="Email"/>
        </header>
        <field name="name"/>
        <button name="crm.action_lead_mail_compose" type="action" icon="mail" string="Email"/>
    </list>`;

/** Bound actions of `crm.lead` reached through the Actions menu (inventory D13 to D17). */
const BOUND_LEAD_ACTIONS = [
    {
        id: 101,
        xml_id: "crm.crm_lead_lost_action",
        name: "Mark Lost",
        res_model: "crm.lead.lost",
        type: "ir.actions.act_window",
        target: "new",
        views: [[false, "form"]],
        binding_view_types: "list,form,kanban",
    },
    {
        id: 102,
        xml_id: "crm.action_merge_opportunities",
        name: "Merge",
        res_model: "crm.merge.opportunity",
        type: "ir.actions.act_window",
        target: "new",
        views: [[false, "form"]],
        binding_view_types: "list,kanban",
    },
    {
        id: 103,
        xml_id: "crm.action_lead_mail_compose",
        name: "Send email",
        res_model: "mail.compose.message",
        type: "ir.actions.act_window",
        target: "new",
        views: [[false, "form"]],
        binding_view_types: "form",
    },
    {
        id: 104,
        xml_id: "crm.mail_followers_edit_action_from_lead",
        name: "Add/Remove Followers",
        res_model: "mail.followers.edit",
        type: "ir.actions.act_window",
        target: "new",
        views: [[false, "form"]],
        binding_view_types: "list,kanban",
    },
];
const BOUND_LEAD_ACTION_IDS = BOUND_LEAD_ACTIONS.map(({ id }) => id);

class CrmLead extends models.Model {
    _name = "crm.lead";

    name = fields.Char({ string: "Opportunity" });
    type = fields.Selection({
        selection: [
            ["lead", "Lead"],
            ["opportunity", "Opportunity"],
        ],
        default: "opportunity",
    });
    active = fields.Boolean({ default: true });
    won_status = fields.Selection({
        selection: [
            ["won", "Won"],
            ["lost", "Lost"],
            ["pending", "Pending"],
        ],
        default: "pending",
    });
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });
    user_id = fields.Many2one({ string: "Salesperson", relation: "res.users" });
    partner_id = fields.Many2one({ string: "Customer", relation: "res.partner" });
    contact_name = fields.Char({ string: "Contact Name" });
    email_from = fields.Char({ string: "Email" });
    phone = fields.Char({ string: "Phone" });
    website = fields.Char({ string: "Website" });
    company_currency = fields.Many2one({ string: "Currency", relation: "res.currency" });
    expected_revenue = fields.Monetary({
        string: "Expected Revenue",
        currency_field: "company_currency",
        aggregator: "sum",
    });
    recurring_revenue_monthly = fields.Float({
        string: "Expected MRR",
        aggregator: "sum",
    });
    probability = fields.Float({ string: "Probability" });
    automated_probability = fields.Float({ string: "Automated Probability" });
    priority = fields.Selection({
        selection: [
            ["0", "Low"],
            ["1", "Medium"],
            ["2", "High"],
            ["3", "Very High"],
        ],
        default: "0",
    });
    color = fields.Integer({ string: "Color Index" });
    tag_ids = fields.Many2many({ string: "Tags", relation: "crm.tag" });
    description = fields.Html({ string: "Notes" });
    partner_email_update = fields.Boolean();
    partner_phone_update = fields.Boolean();
    activity_state = fields.Selection({
        selection: [
            ["overdue", "Overdue"],
            ["today", "Today"],
            ["planned", "Planned"],
        ],
    });
    activity_ids = fields.One2many({ string: "Activities", relation: "mail.activity" });
    message_ids = fields.One2many({ relation: "mail.message" });
    message_follower_ids = fields.Many2many({ string: "Followers", relation: "mail.followers" });

    _records = [
        {
            id: 1,
            name: "Lead 1",
            stage_id: 1,
            team_id: 1,
            user_id: 7,
            company_currency: 1,
            expected_revenue: 100,
            recurring_revenue_monthly: 10,
            probability: 10,
            email_from: "lead1@example.com",
            phone: "+32 555 01",
        },
        {
            id: 2,
            name: "Lead 2",
            stage_id: 1,
            team_id: 2,
            company_currency: 1,
            expected_revenue: 50,
            recurring_revenue_monthly: 5,
            probability: 20,
        },
        {
            id: 3,
            name: "Lead 3",
            stage_id: 2,
            team_id: 1,
            company_currency: 1,
            expected_revenue: 30,
            probability: 30,
        },
        {
            id: 4,
            name: "Lead 4",
            stage_id: 3,
            team_id: 1,
            active: false,
            company_currency: 1,
            expected_revenue: 70,
            probability: 100,
        },
        {
            id: 5,
            name: "Lead 5",
            stage_id: 3,
            team_id: 2,
            company_currency: 1,
            expected_revenue: 40,
            probability: 100,
            won_status: "won",
        },
    ];

    _views = {
        form: LEAD_FORM_ARCH,
        kanban: LEAD_KANBAN_ARCH,
        list: LEAD_LIST_ARCH,
        "list,opportunities": OPPORTUNITY_LIST_ARCH,
        search: /* xml */ `
            <search>
                <field name="name"/>
                <field name="team_id"/>
            </search>`,
    };

    _toolbar = { action: BOUND_LEAD_ACTIONS, print: [] };

    /** Leads are activity-enabled threads (`mail.activity.mixin`), as on the server. */
    has_activities = true;

    get_views() {
        const result = super.get_views(...arguments);
        result.models[this._name].has_activities = true;
        return result;
    }

    prepare_pls_tooltip_data() {
        // No top/low criteria: the tooltip shows its default sections. The server answers lists,
        // but `CrmPlsTooltip` declares these props as objects and the test app validates props
        // (dev mode); the online tooltip itself is not part of the offline work, so its typing is
        // left as is and the mock answers empty objects, which render the same default sections.
        return { probability: 42, team_name: "Mushroom Kingdom", low_3_data: {}, top_3_data: {} };
    }
}

/**
 * Form of the activity editor, mirroring the footer of `mail.mail_activity_view_form_popup`
 * (Schedule, Save, Mark Done, Discard, Delete). Set on the mail mock model the way the mail
 * activity tests do.
 */
mailModels.MailActivity._views = {
    form: /* xml */ `
        <form>
            <field name="res_model" invisible="1"/>
            <field name="res_id" invisible="1"/>
            <field name="summary"/>
            <footer>
                <field name="id" invisible="1"/>
                <button string="Schedule" name="action_close_dialog" type="object"
                    class="btn-primary" invisible="id" data-hotkey="q"/>
                <button string="Save" name="action_close_dialog" type="object"
                    class="btn-primary" invisible="not id" data-hotkey="q"/>
                <button string="Mark Done" name="action_done" type="object"
                    class="btn-secondary" data-hotkey="w"/>
                <button special="cancel" string="Discard" data-hotkey="x"/>
                <button string="Delete" type="object" name="unlink"
                    class="btn-secondary ms-auto" invisible="not id"/>
            </footer>
        </form>`,
};

// Registers the mail models and the CRM lead server model beneath the local fixtures below, which
// is why `defineMailModels` is not called too.
defineCrmModels();
defineModels([
    CrmStage,
    CrmTeam,
    CrmTag,
    CrmLostReason,
    CrmActivityReport,
    UtmCampaign,
    ResConfigSettings,
    IrModuleModule,
    CrmLeadLost,
    CrmLeadPlsUpdate,
    CrmLead2OpportunityPartnerMass,
    CrmMergeOpportunity,
    MailFollowersEdit,
    CrmLead,
]);

const PIPELINE_ACTION_ID = 1;
const FORECAST_ACTION_ID = 2;
const ACTIVITY_REPORT_ACTION_ID = 3;
const TEAM_DASHBOARD_ACTION_ID = 4;
const STAGE_ACTION_ID = 5;
const TEAM_ACTION_ID = 6;
const LEAD_FORM_ACTION_ID = 7;
const OPPORTUNITY_LIST_ACTION_ID = 8;
const ARCHIVED_LEAD_FORM_ACTION_ID = 9;

defineActions([
    {
        id: PIPELINE_ACTION_ID,
        xml_id: "crm.crm_lead_action_pipeline",
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: {
            show_team_switcher: true,
            show_lead_gen_button: true,
            default_type: "opportunity",
        },
        views: [
            [false, "kanban"],
            [false, "list"],
            [false, "form"],
        ],
    },
    {
        id: FORECAST_ACTION_ID,
        xml_id: "crm.crm_lead_action_forecast",
        name: "Forecast",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: { forecast_field: "date_deadline", forecast_filter: 1 },
        views: [
            [false, "kanban"],
            [false, "list"],
        ],
    },
    {
        id: ACTIVITY_REPORT_ACTION_ID,
        xml_id: "crm.crm_activity_report_action",
        name: "Activities Analysis",
        res_model: "crm.activity.report",
        type: "ir.actions.act_window",
        views: [[false, "list"]],
    },
    {
        id: TEAM_DASHBOARD_ACTION_ID,
        xml_id: "sales_team.crm_team_action_pipeline",
        name: "Teams",
        res_model: "crm.team",
        type: "ir.actions.act_window",
        views: [[false, "kanban"]],
    },
    {
        id: STAGE_ACTION_ID,
        xml_id: "crm.crm_stage_action",
        name: "Stages",
        res_model: "crm.stage",
        type: "ir.actions.act_window",
        views: [
            [false, "list"],
            [false, "form"],
        ],
    },
    {
        id: TEAM_ACTION_ID,
        xml_id: "sales_team.crm_team_action_config",
        name: "Sales Teams",
        res_model: "crm.team",
        type: "ir.actions.act_window",
        views: [
            [false, "list"],
            [false, "form"],
        ],
    },
    {
        id: LEAD_FORM_ACTION_ID,
        name: "Lead",
        res_model: "crm.lead",
        res_id: 1,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    },
    {
        id: OPPORTUNITY_LIST_ACTION_ID,
        name: "Opportunities",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            ["opportunities", "list"],
            [false, "form"],
        ],
    },
    {
        id: ARCHIVED_LEAD_FORM_ACTION_ID,
        name: "Archived Lead",
        res_model: "crm.lead",
        res_id: 4,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    },
    ...BOUND_LEAD_ACTIONS,
]);

beforeEach(() => {
    patchWithCleanup(AnimatedNumber, { enableAnimations: false });
});

/** Form used by the rainbowman and partner-sync tests: the CRM form record, its stage widget. */
const STAGE_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <header>
            <field name="stage_id" widget="statusbar" options="{'clickable': '1'}"/>
        </header>
        <sheet>
            <field name="name"/>
            <field name="expected_revenue"/>
            <field name="company_currency" invisible="1"/>
            <field name="email_from"/>
            <field name="phone"/>
            <field name="partner_email_update" invisible="1"/>
            <field name="partner_phone_update" invisible="1"/>
        </sheet>
    </form>`;

/**
 * Moves the form record to a stage through the statusbar: its buttons on desktop, its dropdown on
 * small screens.
 */
async function selectStageInForm(stageId, stageName) {
    if (isSmall()) {
        await contains(".o_statusbar_status button.dropdown-toggle").click();
        await contains(`.o-dropdown--menu .dropdown-item:contains('${stageName}')`).click();
    } else {
        await contains(`.o_statusbar_status button[data-value='${stageId}']`).click();
    }
}

// -----------------------------------------------------------------------------
// PART 2.1: rainbowman lookup (SKIP offline)
// -----------------------------------------------------------------------------

describe("Rainbowman", () => {
    test("offline form save on stage change: queued, no rainbowman lookup, no error", async () => {
        const connection = mockConnectionDrop();
        watchRpcs(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: STAGE_FORM_ARCH });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        await selectStageInForm(3, "Won");
        // The connection drops during the save: the framework queues it and goes offline.
        connection.offline = true;
        await contains(".o_form_button_save").click();
        await animationFrame();

        expect.verifySteps(["crm.lead/web_save"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queuedEntries()).toHaveLength(1);
        const [save] = queuedCalls("crm.lead", "web_save");
        expect(save.args[0]).toEqual([1]);
        expect(save.args[1].stage_id).toBe(3);
        expect(".o_reward").toHaveCount(0);
        // The record shows the queued stage, and nothing else was requested for the lookup.
        expect(".o_form_renderer").toHaveClass("o_form_editable");
        await runAllTimers();
        expect.verifySteps([]);
    });

    test("online form stage change issues the rainbowman lookup", async () => {
        watchRpcs(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: STAGE_FORM_ARCH });

        await selectStageInForm(3, "Won");
        await contains(".o_form_button_save").click();
        await animationFrame();

        expect.verifySteps(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect(queuedEntries()).toHaveLength(0);
    });
});

// -----------------------------------------------------------------------------
// PART 2.2: email/phone partner-sync copy (QUEUE)
// -----------------------------------------------------------------------------

describe("Email/phone copy", () => {
    test("offline form save queues the email and phone partner-sync copy", async () => {
        CrmLead._records[0].partner_email_update = true;
        CrmLead._records[0].partner_phone_update = true;
        CrmLead._records[1].email_from = "lead2@example.com";
        CrmLead._records[1].phone = "+32 555 02";
        CrmLead._records[1].partner_email_update = true;
        CrmLead._records[1].partner_phone_update = true;
        CrmLead._records[2].email_from = "lead3@example.com";
        CrmLead._records[2].phone = "+32 555 03";
        CrmLead._records[2].partner_email_update = true;
        CrmLead._records[2].partner_phone_update = true;
        CrmLead._records[3].email_from = "lead4@example.com";
        CrmLead._records[3].phone = "+32 555 04";
        CrmLead._records[3].partner_email_update = true;
        CrmLead._records[3].partner_phone_update = true;
        CrmLead._records[4].email_from = "lead5@example.com";
        CrmLead._records[4].phone = "+32 555 05";
        CrmLead._records[4].partner_email_update = false;
        CrmLead._records[4].partner_phone_update = false;
        const formControllers = captureInstances(FormController);
        const setOffline = mockOffline();
        const connection = mockConnectionDrop();
        watchRpcs(["crm.lead/web_save"]);
        keepPingsFailing();

        // Every form is loaded online. Leads 1 and 2 are each saved through one UI path to the
        // queue. Leads 3 to 5 enter `_offlineSave` directly; they are mounted between leads 1 and
        // 2, so that `:first` and `:last` keep targeting leads 1 and 2.
        await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: STAGE_FORM_ARCH });
        await mountView({ type: "form", resModel: "crm.lead", resId: 3, arch: STAGE_FORM_ARCH });
        await mountView({ type: "form", resModel: "crm.lead", resId: 4, arch: STAGE_FORM_ARCH });
        await mountView({ type: "form", resModel: "crm.lead", resId: 5, arch: STAGE_FORM_ARCH });
        await mountView({ type: "form", resModel: "crm.lead", resId: 2, arch: STAGE_FORM_ARCH });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // Path 1: the connection drops during the save request.
        await contains(".o_field_widget[name=name]:first input").edit("Lead 1 (edited)");
        connection.offline = true;
        await contains(".o_form_button_save:first").click();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        let saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args).toEqual([
            [1],
            {
                name: "Lead 1 (edited)",
                email_from: "lead1@example.com",
                phone: "+32 555 01",
            },
        ]);

        // Path 2: the client is already offline when the save starts.
        await setOffline(true);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        await contains(".o_field_widget[name=name]:last input").edit("Lead 2 (edited)");
        await contains(".o_form_button_save:last").click();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save"]);
        saves = queuedCalls("crm.lead", "web_save").filter(({ args }) => args[0][0] === 2);
        expect(saves).toHaveLength(1);
        expect(saves[0].args[1]).toEqual({
            name: "Lead 2 (edited)",
            email_from: "lead2@example.com",
            phone: "+32 555 02",
        });
        expect(queuedEntries()).toHaveLength(2);

        // Path 3: `_offlineSave` is entered directly, never through `_save`, as the framework does
        // for the records of a list or kanban save that loses the connection. The lead's CRM form
        // record queues one entry of its own, with its context and an empty specification.
        const CrmFormRecord = registry.category("views").get("crm_form").Model.Record;
        const offlineSaveDirectly = async (resId) => {
            const record = formControllers
                .map(({ model }) => model.root)
                .find((root) => root.resId === resId);
            expect(record).toBeInstanceOf(CrmFormRecord);
            expect(record.resModel).toBe("crm.lead");
            expect(record.resId).toBe(resId);
            expect(record._offlineSave()).toBe(true);
            await animationFrame();
            expect.verifySteps([]);
            const calls = queuedCalls("crm.lead", "web_save").filter(
                ({ args }) => args[0][0] === resId
            );
            expect(calls).toHaveLength(1);
            expect(calls[0].kwargs).toEqual({ context: record.context, specification: {} });
            return calls[0];
        };

        // Path 3, both flags set, email and phone untouched: both are copied next to the edit.
        expect(".o_field_widget[name=name]:eq(1) input").toHaveValue("Lead 3");
        expect(".o_field_widget[name=email_from]:eq(1) input").toHaveValue("lead3@example.com");
        expect(".o_field_widget[name=phone]:eq(1) input").toHaveValue("+32 555 03");
        await contains(".o_field_widget[name=name]:eq(1) input").edit("Lead 3 (edited)");
        let save = await offlineSaveDirectly(3);
        expect(save.args).toEqual([
            [3],
            {
                name: "Lead 3 (edited)",
                email_from: "lead3@example.com",
                phone: "+32 555 03",
            },
        ]);

        // Path 3, both flags set, email changed by the user: the user's email is queued, not the
        // stored one, and the untouched phone is copied.
        expect(".o_field_widget[name=name]:eq(2) input").toHaveValue("Lead 4");
        expect(".o_field_widget[name=phone]:eq(2) input").toHaveValue("+32 555 04");
        await contains(".o_field_widget[name=email_from]:eq(2) input").edit(
            "lead4.new@example.com"
        );
        save = await offlineSaveDirectly(4);
        expect(save.args).toEqual([
            [4],
            {
                email_from: "lead4.new@example.com",
                phone: "+32 555 04",
            },
        ]);

        // Path 3, both flags unset, email and phone untouched: neither is queued.
        expect(".o_field_widget[name=name]:eq(3) input").toHaveValue("Lead 5");
        expect(".o_field_widget[name=email_from]:eq(3) input").toHaveValue("lead5@example.com");
        expect(".o_field_widget[name=phone]:eq(3) input").toHaveValue("+32 555 05");
        await contains(".o_field_widget[name=name]:eq(3) input").edit("Lead 5 (edited)");
        save = await offlineSaveDirectly(5);
        expect(save.args).toEqual([[5], { name: "Lead 5 (edited)" }]);
        expect(queuedEntries()).toHaveLength(5);
    });
});

// -----------------------------------------------------------------------------
// PART 2.1 / 3a: kanban stage moves (QUEUE, rainbowman SKIP)
// -----------------------------------------------------------------------------

describe("Kanban moves", () => {
    test.tags("desktop");
    test("offline kanban stage move: queued, no rainbowman lookup", async () => {
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        keepPingsFailing();
        // The moved card was visited online: the framework keeps it usable offline.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        await mountView({
            type: "kanban",
            resModel: "crm.lead",
            groupBy: ["stage_id"],
            arch: LEAD_KANBAN_ARCH,
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect(".o_kanban_group:eq(0) .o_kanban_record").toHaveCount(2);
        expect(".o_kanban_group:eq(2) .o_kanban_record").toHaveCount(1);

        await setOffline(true);
        await contains(".o_kanban_group:eq(0) .o_kanban_record:first").dragAndDrop(
            ".o_kanban_group:eq(2) .o_kanban_record"
        );
        await animationFrame();

        expect.verifySteps(["crm.lead/web_save"]);
        expect(".o_kanban_group:eq(0) .o_kanban_record").toHaveCount(1);
        expect(".o_kanban_group:eq(2) .o_kanban_record").toHaveCount(2);
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args[0]).toEqual([1]);
        expect(saves[0].args[1]).toMatchObject({ stage_id: 3 });
        expect(saves[0].extras.viewType).toBe("kanban");
        expect(".o_reward").toHaveCount(0);
    });

    test.tags("desktop");
    test("online kanban stage move to won stage issues the rainbowman lookup", async () => {
        watchRpcs(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        await mountView({
            type: "kanban",
            resModel: "crm.lead",
            groupBy: ["stage_id"],
            arch: LEAD_KANBAN_ARCH,
        });

        await contains(".o_kanban_group:eq(0) .o_kanban_record:first").dragAndDrop(
            ".o_kanban_group:eq(2) .o_kanban_record"
        );
        await animationFrame();

        expect.verifySteps(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        expect(".o_kanban_group:eq(2) .o_kanban_record").toHaveCount(2);
        expect(queuedEntries()).toHaveLength(0);
    });

    // On small screens the pipeline is the stage-at-a-time `crm_mobile_pipeline` view: stages are
    // reached by swiping the stage body, and a lead is moved through its card's stage list instead
    // of being dragged. That move goes through the same CRM kanban model `moveRecords` whose
    // rainbowman lookup is skipped offline.
    test.tags("mobile");
    test("mobile: offline pipeline stage move to the won stage, reached by swipe: queued, no rainbowman lookup", async () => {
        // The background refresh of each read served from the RPC cache offline rejects with a
        // connection loss nobody awaits: the activities of every displayed lead visited online,
        // then the activity types, each time the displayed leads change. Lead 5 (Won) was never
        // displayed online, so its uncached read is answered by the caught connection loss.
        const ACTIVITIES = "mail.activity/web_search_read";
        const TYPES = "mail.activity.type/web_search_read";
        const errors = [
            // offline swipe to Qualified (Lead 3), then back to New (Lead 1, Lead 2)
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // the move: New loses Lead 1 (Lead 2), then Won is displayed (Lead 1)
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            TYPES,
            // swipes back to New through Qualified (Lead 3, then Lead 2), then to Won again through
            // Qualified (Lead 3, then Lead 1)
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            TYPES,
        ].map((route) => `Connection to "/web/dataset/call_kw/${route}"`);
        expect.errors(errors.length);
        const setOffline = mockOffline();
        watchRpcs([
            "crm.lead/web_save",
            "crm.lead/get_rainbowman_message",
            "crm.lead/web_search_read",
            "crm.lead/web_read_group",
        ]);
        keepPingsFailing();
        const header = ".o_crm_mobile_pipeline_header";
        const cardNames = () =>
            queryAllTexts(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card_name");
        const cardOf = (name) =>
            `.o_crm_mobile_pipeline_body .o_crm_mobile_lead_card:has(.o_crm_mobile_lead_card_name:text(${name}))`;
        const expectStage = (name, count, names) => {
            expect(`${header} .o_crm_mobile_pipeline_stage_name`).toHaveText(name);
            expect(`${header} .o_crm_mobile_pipeline_count`).toHaveText(String(count));
            expect(cardNames()).toEqual(names);
        };

        await mountView({
            type: "kanban",
            resModel: "crm.lead",
            arch: LEAD_KANBAN_ARCH.replace(
                'js_class="crm_kanban"',
                'js_class="crm_mobile_pipeline"'
            ),
            config: { actionId: PIPELINE_ACTION_ID, cache: true },
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["crm.lead/web_read_group"]);
        expect(".o_crm_mobile_pipeline .o_crm_mobile_pipeline_body").toHaveCount(1);
        expectStage("New", 2, ["Lead 1", "Lead 2"]);

        // Online, a swipe to the left displays the next stage and one to the right the previous.
        await swipeLeft(".o_crm_mobile_pipeline_body");
        expectStage("Qualified", 1, ["Lead 3"]);
        await swipeRight(".o_crm_mobile_pipeline_body");
        expectStage("New", 2, ["Lead 1", "Lead 2"]);
        expect.verifySteps([]);

        // Offline, the swipes still navigate between the loaded stages, with no lead read.
        await setOffline(true);
        await swipeLeft(".o_crm_mobile_pipeline_body");
        expectStage("Qualified", 1, ["Lead 3"]);
        await swipeRight(".o_crm_mobile_pipeline_body");
        expectStage("New", 2, ["Lead 1", "Lead 2"]);
        expect.verifySteps([]);

        // Offline, choosing the won stage in Lead 1's card stage list is mark-won: the framework
        // queues the stage write and the rainbowman lookup is skipped.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).click();
        await contains(
            `${cardOf("Lead 1")} .o_crm_mobile_stage_option[data-stage-value='3']`
        ).click();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save"]);
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args[0]).toEqual([1]);
        expect(saves[0].args[1]).toMatchObject({ stage_id: 3 });
        expect(saves[0].extras.viewType).toBe("kanban");
        expect(".o_reward").toHaveCount(0);
        expect(".modal").toHaveCount(0);

        // The won stage is displayed with the moved card and its pending-sync badge.
        expectStage("Won", 2, ["Lead 1", "Lead 5"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(`${cardOf("Lead 5")} .o_crm_mobile_pending_badge`).toHaveCount(0);

        // Swiped back to New, Lead 1 is no longer there; swiped on to Won, it still is.
        await swipeRight(".o_crm_mobile_pipeline_body");
        expectStage("Qualified", 1, ["Lead 3"]);
        await swipeRight(".o_crm_mobile_pipeline_body");
        expectStage("New", 1, ["Lead 2"]);
        await swipeLeft(".o_crm_mobile_pipeline_body");
        await swipeLeft(".o_crm_mobile_pipeline_body");
        expectStage("Won", 2, ["Lead 1", "Lead 5"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");

        await runAllTimers();
        expect.verifySteps([]);
        expect(queuedEntries()).toHaveLength(1);
        expect(".o_reward").toHaveCount(0);
        expect.verifyErrors(errors);
    });
});

// -----------------------------------------------------------------------------
// PART 1 DISABLE rows: disabled offline, re-enabled online, inert on every path
// -----------------------------------------------------------------------------

/** Names of the DISABLE buttons of the lead form header and button box (B1 to B6). */
const LEAD_HEADER_BUTTONS = [
    "action_set_won_rainbowman",
    "action_convert_to_opportunity",
    "action_restore",
    "crm.crm_lead_lost_action",
    "action_schedule_meeting",
    "action_show_potential_duplicates",
];

/** Steps every view button the action service is asked to run, instead of running it. */
function mockViewButtonActions() {
    mockService("action", {
        async doActionButton(params) {
            expect.step(`doActionButton:${params.name}`);
        },
    });
}

/**
 * Opens a menu through its keyboard hotkey and selects the item labelled `label` with the arrow
 * keys and Enter, as a keyboard user would.
 *
 * @param {string} hotkey
 * @param {string} label
 */
async function selectMenuItemWithKeyboard(hotkey, label) {
    await press(["alt", hotkey]);
    await animationFrame();
    const items = queryAll(".o-dropdown--menu .o-dropdown-item");
    for (let index = 0; index < items.length + 1; index++) {
        const focused = queryFirst(".o-dropdown--menu .o-dropdown-item.focus");
        if (focused?.textContent.includes(label)) {
            break;
        }
        await press("ArrowDown");
        await animationFrame();
    }
    expect(".o-dropdown--menu .o-dropdown-item.focus").toHaveText(new RegExp(label));
    await press("Enter");
    await animationFrame();
}

describe("DISABLE controls and handler enforcement", () => {
    test.tags("desktop");
    test("team switcher: online mount, disconnect, reconnect", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        watchGroupProbes(["sales_team.group_sale_manager"]);
        mockService("action", {
            doAction(action) {
                if (action === "sales_team.crm_team_action_config") {
                    expect.step(`doAction:${action}`);
                    return Promise.resolve();
                }
                return super.doAction(...arguments);
            },
        });
        const webClient = await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        expect.verifySteps(["has_group:sales_team.group_sale_manager"]);
        const switcher = findComponent(webClient, (component) => component instanceof TeamSwitcher);

        // Online: a team is selected, and "Manage Teams" opens the team configuration.
        await contains(".o_cp_team_switcher").click();
        await contains(".o_popover .dropdown-item:text('Mushroom Kingdom')").click();
        expect(".o_cp_team_switcher").toHaveText("Mushroom Kingdom");
        expect(switcher.selectedTeamId).toBe(1);
        await contains(".o_cp_team_switcher").click();
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(1);
        await contains(".o_popover .dropdown-item:contains('Manage Teams')").click();
        expect.verifySteps(["doAction:sales_team.crm_team_action_config"]);

        // The dropdown is left open when the connection drops.
        await contains(".o_cp_team_switcher").click();
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(1);
        await setOffline(true);
        expect(".o_popover .dropdown-item:contains('Hyrule')").toHaveCount(1);
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(0);
        expect(switcher.isSaleManager).toBe(false);
        expect(isDisabledOffline(".o_cp_team_switcher")).toBe(true);

        // Direct calls, without any DOM event, change nothing.
        switcher.onClickManageTeams();
        switcher.onSelect(2);
        await animationFrame();
        expect(switcher.selectedTeamId).toBe(1);
        expect(".o_cp_team_switcher").toHaveText("Mushroom Kingdom");
        // The selected team facet (switcher label) is kept offline.
        expect(".o_cp_team_switcher").toHaveAttribute("data-tooltip", "Mushroom Kingdom");

        // Back online: "Manage Teams" is offered again from the retained probe answer.
        await setOffline(false);
        expect(".o_cp_team_switcher").not.toHaveAttribute("disabled");
        if (!queryAll(".o_popover .dropdown-item").length) {
            await contains(".o_cp_team_switcher").click();
        }
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(1);
        expect(switcher.isSaleManager).toBe(true);
        // Exactly one probe in total, and nothing reached the network while offline.
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("lead generation dropdown: disabled offline, no module lookup, access probe or install", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs([
            "ir.module.module/search_read",
            "ir.module.module/button_immediate_install",
            "has_access",
            "check_access_rights",
        ]);
        mockService("action", {
            doAction(action) {
                if (
                    action?.tag === "import" ||
                    action?.res_model === "base.module.install.request"
                ) {
                    expect.step(`doAction:${action.tag || action.res_model}`);
                    return Promise.resolve();
                }
                return super.doAction(...arguments);
            },
        });
        const webClient = await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const dropdown = findComponent(
            webClient,
            (component) => component instanceof LeadGenerationDropdown
        );
        const generateButton = "button.o-dropdown-caret:contains('Generate')";
        expect(generateButton).toBeEnabled();

        // Offline before the first opening: neither the module lookup nor the opening happens.
        await setOffline(true);
        expect(isDisabledOffline(generateButton)).toBe(true);
        await dropdown.toggleDropdown();
        expect(".o_lead_mining_menu_choices").toHaveCount(0);
        expect(dropdown.dropdownWasAlreadyOpened).toBe(undefined);
        await setOffline(false);
        expect(generateButton).toBeEnabled();
        expect.verifySteps([]);

        // Online: the first opening looks the modules up, and an uninstalled choice asks to
        // install it.
        await contains(generateButton).click();
        expect.verifySteps(["ir.module.module/search_read"]);
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        await contains(
            ".o_lead_mining_element[data-module-xml-id='base.module_crm_iap_mine']"
        ).click();
        expect(".modal").toHaveCount(1);
        expect(".modal .modal-footer .btn-primary").toHaveText("Install");

        // The connection drops while the confirmation is open: confirming installs nothing.
        await setOffline(true);
        expect(".modal .modal-footer .btn-primary").toBeEnabled();
        await contains(".modal .modal-footer .btn-primary").click();
        expect(".modal").toHaveCount(0);
        expect(".o_lead_mining_element .oi-spin").toHaveCount(0);

        // Offline, "Generate" is disabled and every entry point is inert, without DOM event.
        expect(isDisabledOffline(generateButton)).toBe(true);
        const [leadSourcing] = dropdown.state.dropdownContentElements;
        const leadImport = dropdown.state.dropdownContentElements.find(
            (element) => element.moduleName === "Lead Import"
        );
        await dropdown.toggleDropdown();
        await dropdown.onClickAction(leadSourcing);
        await dropdown.onClickAction(leadImport);
        await dropdown.onClickAction({ ...leadSourcing, hasAccess: false });
        dropdown.redirectToImport();
        dropdown.requestAccess(leadSourcing.moduleName, leadSourcing.title, true);
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect(leadSourcing.status).toBe("NOT_INSTALLED");

        await setOffline(false);
        expect(generateButton).toBeEnabled();
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("form header DISABLE buttons and probability anchors: disabled offline, re-enabled online, hotkeys and direct onClick() inert", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/web_save"]);
        watchOfflineRpcs();
        mockViewButtonActions();
        const buttons = captureInstances(ViewButton);
        await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: LEAD_FORM_ARCH });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // Online, the buttons run their action.
        await contains("button[name='action_set_won_rainbowman']").click();
        await contains("a[name='action_set_automated_probability']:first").click();
        expect.verifySteps([
            "doActionButton:action_set_won_rainbowman",
            "doActionButton:action_set_automated_probability",
        ]);

        // A pending edit: a button that got through would save it first.
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (unsaved)");
        await setOffline(true);
        for (const name of LEAD_HEADER_BUTTONS) {
            expect(isDisabledOffline(`button[name='${name}']`)).toBe(true);
        }
        const anchors = queryAll("a[name='action_set_automated_probability']");
        expect(anchors).toHaveLength(2);
        for (const anchor of anchors) {
            expect(isDisabledOffline(anchor)).toBe(true);
        }

        // Hotkeys of the header buttons (Won, Convert, Restore, Lost).
        for (const key of ["w", "v", "x", "l"]) {
            await press(["alt", key]);
            await animationFrame();
        }

        // Direct calls of every server button handler, without any DOM event.
        const serverButtons = buttons.filter(({ clickParams }) =>
            ["object", "action"].includes(clickParams.type)
        );
        const names = new Set(serverButtons.map(({ clickParams }) => clickParams.name));
        for (const name of [...LEAD_HEADER_BUTTONS, "action_set_automated_probability"]) {
            expect(names.has(name)).toBe(true, { message: `${name} is rendered` });
        }
        for (const button of serverButtons) {
            await button.onClick();
        }
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 (unsaved)");
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // Back online, the controls are usable again.
        await setOffline(false);
        for (const name of LEAD_HEADER_BUTTONS) {
            expect(`button[name='${name}']`).toBeEnabled();
            expect(`button[name='${name}']`).not.toHaveClass("o_disabled_offline");
        }
        for (const anchor of queryAll("a[name='action_set_automated_probability']")) {
            expect(anchor).not.toHaveAttribute("disabled");
            expect(anchor).not.toHaveClass("o_disabled_offline");
        }
    });

    test.tags("desktop");
    test("list header DISABLE buttons: direct MultiRecordViewButton.onClick() inert offline", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        mockViewButtonActions();
        const buttons = captureInstances(MultiRecordViewButton);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        const lists = [
            {
                rows: "B12, B13",
                views: [[false, "list"]],
                names: ["crm.action_crm_send_mass_convert", "crm.crm_lead_lost_action"],
            },
            {
                rows: "B16, B17",
                views: [["opportunities", "list"]],
                names: ["crm.crm_lead_lost_action", "crm.action_lead_mass_mail"],
            },
        ];
        for (const { rows, views, names } of lists) {
            buttons.length = 0;
            await openView({ res_model: "crm.lead", views });
            await contains(".o_data_row:first .o_list_record_selector input").click();
            await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
            for (const name of names) {
                expect(`button[name='${name}']`).toBeEnabled({ message: `${rows}: ${name}` });
            }

            // Online, a header button runs its action on the selected records.
            await contains(`button[name='${names[0]}']`).click();
            expect.verifySteps([`doActionButton:${names[0]}`]);

            await setOffline(true);
            for (const name of names) {
                expect(isDisabledOffline(`button[name='${name}']`)).toBe(true, {
                    message: `${rows}: ${name}`,
                });
            }
            const rendered = buttons.filter(({ clickParams }) => names.includes(clickParams.name));
            expect(new Set(rendered.map(({ clickParams }) => clickParams.name)).size).toBe(
                names.length
            );
            // Direct calls, without any DOM event: no id search, no action, no dialog.
            for (const button of rendered) {
                await button.onClick();
            }
            await animationFrame();
            expect(".modal").toHaveCount(0);
            expect.verifySteps([]);

            await setOffline(false);
            for (const name of names) {
                expect(`button[name='${name}']`).toBeEnabled({ message: `${rows}: ${name}` });
            }
        }
    });

    test.tags("desktop");
    test("Actions menu: bound wizards, Duplicate and Export inert offline; Archive, Unarchive and Delete still queue", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs([
            "crm.lead/search",
            "crm.lead/copy",
            "crm.lead/web_save",
            "crm.lead/action_archive",
            "crm.lead/action_unarchive",
            "crm.lead/web_unlink",
            "/web/export/get_fields",
        ]);
        // A bound action that got through would be loaded: it is stepped instead.
        mockService("action", {
            doAction(action) {
                const id = typeof action === "object" ? action?.id : action;
                if (BOUND_LEAD_ACTION_IDS.includes(id)) {
                    expect.step(`doAction:${id}`);
                    return Promise.resolve();
                }
                return super.doAction(...arguments);
            },
        });
        const menus = captureInstances(ActionMenus);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        /**
         * The action menus of the current view, and its items: the raw bound actions and the
         * menu wrappers of the bound and static items.
         */
        const currentMenu = () => menus.at(-1);
        const boundWrappers = () => currentMenu().actionItems.filter((item) => item.action);
        const staticWrapper = (key) => currentMenu().actionItems.find((item) => item.key === key);

        /** Every server path of the current menu, called directly while offline. */
        async function callServerPathsDirectly() {
            const menu = currentMenu();
            expect(boundWrappers().length).toBeGreaterThan(0);
            for (const wrapper of boundWrappers()) {
                await menu.onItemSelected(wrapper);
                await menu.executeAction(wrapper.action);
                await menu.executeAction(
                    BOUND_LEAD_ACTIONS.find(({ id }) => id === wrapper.action.id)
                );
            }
            for (const key of ["duplicate", "export"]) {
                if (staticWrapper(key)) {
                    await menu.onItemSelected(staticWrapper(key));
                }
            }
            await animationFrame();
            expect(".modal").toHaveCount(0);
        }

        // 1. List, whole domain selected.
        await getService("action").doAction(PIPELINE_ACTION_ID, { viewType: "list" });
        await contains("thead .o_list_record_selector input").click();
        await contains(".o_select_domain").click();
        expect(currentMenu().props.isDomainSelected).toBe(true);
        expect(staticWrapper("duplicate")).not.toBe(undefined);
        await setOffline(true);
        await callServerPathsDirectly();
        // The menu is opened through its hotkey and a bound wizard is picked with the keyboard.
        await selectMenuItemWithKeyboard("u", "Mark Lost");
        await selectMenuItemWithKeyboard("u", "Merge");
        expect.verifySteps([]);
        await setOffline(false);

        // 2. Kanban, selection mode.
        await getService("action").doAction(PIPELINE_ACTION_ID, { viewType: "kanban" });
        await contains(".o_kanban_record:first").click({ altKey: true });
        expect(".o_kanban_record.o_record_selected").toHaveCount(1);
        await setOffline(true);
        await callServerPathsDirectly();
        await selectMenuItemWithKeyboard("u", "Add/Remove Followers");
        expect.verifySteps([]);
        await setOffline(false);

        // 3. Form of an archived lead: Unarchive still queues.
        await getService("action").doAction(ARCHIVED_LEAD_FORM_ACTION_ID);
        await setOffline(true);
        await toggleActionMenu();
        await toggleMenuItem("Unarchive");
        expect.verifySteps(["crm.lead/action_unarchive"]); // answered offline, then queued
        expect(queuedCalls("crm.lead", "action_unarchive")).toHaveLength(1);
        expect(queuedCalls("crm.lead", "action_unarchive")[0].args).toEqual([[4]]);
        await setOffline(false);
        await expect.waitForSteps(["crm.lead/action_unarchive"]); // replayed on reconnect

        // 4. Form: the bound wizards and Duplicate are inert, Archive and Delete still queue.
        await getService("action").doAction(LEAD_FORM_ACTION_ID);
        // Online, a bound action runs.
        await toggleActionMenu();
        await toggleMenuItem("Send email");
        expect.verifySteps(["doAction:103"]);
        // A pending edit: a path that got through `shouldExecuteAction` would save it.
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (unsaved)");
        // The menu is left open when the connection drops.
        await toggleActionMenu();
        await setOffline(true);
        expect(".o-dropdown--menu .o_menu_item:contains('Mark Lost')").toHaveClass("pe-none");
        queryOne(".o-dropdown--menu .o_menu_item:contains('Mark Lost')").click();
        queryOne(".o-dropdown--menu .o_menu_item:contains('Duplicate')").click();
        await animationFrame();
        await callServerPathsDirectly();
        await selectMenuItemWithKeyboard("u", "Send email");
        expect.verifySteps([]);
        expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 (unsaved)");
        await contains(".o_form_button_cancel").click();

        await toggleActionMenu();
        await toggleMenuItem("Archive");
        await contains(".modal-footer .btn-primary").click();
        await toggleActionMenu();
        await toggleMenuItem("Delete");
        await contains(".modal-footer button.btn-danger").click();
        expect.verifySteps(["crm.lead/action_archive", "crm.lead/web_unlink"]);
        expect(queuedCalls("crm.lead", "action_archive").map(({ args }) => args)).toEqual([[[1]]]);
        expect(queuedCalls("crm.lead", "web_unlink").map(({ args }) => args)).toEqual([[[1]]]);
        expect(queuedEntries()).toHaveLength(2);
    });

    test.tags("desktop");
    test("activity menu CRM entry: disabled offline", async () => {
        const pyEnv = await startServer();
        pyEnv["mail.activity"].create({
            res_id: 1,
            res_model: "crm.lead",
            summary: "Call the customer",
        });
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        listenStoreFetch("systray_get_activities");
        mockService("action", {
            async loadAction(action) {
                expect.step(`loadAction:${action}`);
                return {
                    type: "ir.actions.act_window",
                    res_model: "crm.lead",
                    views: [[false, "list"]],
                    domain: [],
                };
            },
            async doAction(action, options) {
                if (action?.res_model === "crm.lead" && options?.clearBreadcrumbs) {
                    expect.step("doAction:crm.crm_lead_action_my_activities");
                    return;
                }
                return super.doAction(...arguments);
            },
        });
        const webClients = captureInstances(WebClient);
        await start();
        await waitStoreFetch("systray_get_activities"); // fetched once when the store starts
        const crmEntry = '.o-mail-ActivityGroup[data-model_name="crm.lead"]';

        // Online, the CRM entry opens the CRM activities.
        await mailClick(".o_menu_systray i[aria-label='Activities']");
        await waitStoreFetch("systray_get_activities");
        await mailContains(crmEntry);
        await mailClick(crmEntry);
        await expect.waitForSteps([
            "loadAction:crm.crm_lead_action_my_activities",
            "doAction:crm.crm_lead_action_my_activities",
        ]);

        // The menu is left open when the connection drops.
        await mailClick(".o_menu_systray i[aria-label='Activities']");
        await waitStoreFetch("systray_get_activities");
        await mailContains(crmEntry);
        await setOffline(true);
        expect(isDisabledOffline(crmEntry)).toBe(true);
        // Clicks on the entry and on its Late/Today/Future links are inert.
        queryOne(crmEntry).click();
        for (const span of queryAll(`${crmEntry} span.text-truncate`)) {
            span.click();
        }
        // Direct calls, without any DOM event.
        const activityMenu = findComponent(
            webClients[0],
            (component) => typeof component?.openActivityGroup === "function"
        );
        const crmGroup = activityMenu.store.activityGroups.find(
            ({ model }) => model === "crm.lead"
        );
        expect(crmGroup).not.toBe(undefined);
        activityMenu.openActivityGroup(crmGroup);
        activityMenu.openActivityGroup(crmGroup, "overdue");
        await animationFrame();
        expect(crmEntry).toHaveCount(1); // the menu stays open: nothing was opened
        expect.verifySteps([]);

        await setOffline(false);
        expect(crmEntry).not.toHaveAttribute("disabled");
        expect(crmEntry).not.toHaveClass("o_disabled_offline");
    });

    test.tags("desktop");
    test("team dashboard anchors and card: disabled offline, direct onGlobalClick inert", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        mockViewButtonActions();
        // Every dashboard card was visited online: only the CRM selectors dim it offline.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        const records = captureInstances(KanbanRecord);
        const buttons = captureInstances(ViewButton);
        await mountView({ type: "kanban", resModel: "crm.team" });
        expect(".o_crm_team_kanban .o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2);
        const anchorSelector = ".o_crm_team_kanban .o_kanban_record a[type]";
        expect(anchorSelector).toHaveCount(16);

        // Online, the card opens its team through the server and the anchors run their action.
        await contains(".o_crm_team_kanban .o_kanban_record:first").click();
        await contains(`${anchorSelector}:contains('Leads'):first`).click();
        expect.verifySteps([
            "doActionButton:action_primary_channel_button",
            "doActionButton:crm.crm_case_form_view_salesteams_lead",
        ]);

        await setOffline(true);
        for (const anchor of queryAll(anchorSelector)) {
            expect(isDisabledOffline(anchor)).toBe(true);
        }
        for (const card of queryAll(".o_crm_team_kanban .o_kanban_record:not(.o_kanban_ghost)")) {
            expect(isDisabledOffline(card)).toBe(true);
        }
        // DOM clicks reach the handlers of the dimmed card and anchors, which are inert.
        queryOne(".o_crm_team_kanban .o_kanban_record:first").click();
        queryOne(`${anchorSelector}:first`).click();
        // Direct calls, with an event that is not a selection click and without any event.
        const teamRecords = records.filter(({ props }) => props.record.resModel === "crm.team");
        expect(teamRecords.length).toBeGreaterThan(0);
        for (const record of teamRecords) {
            record.onGlobalClick({ target: document.body, altKey: false });
            record.onGlobalClick();
        }
        for (const button of buttons) {
            button.onClick();
        }
        await animationFrame();
        expect.verifySteps([]);

        await setOffline(false);
        for (const anchor of queryAll(anchorSelector)) {
            expect(anchor).not.toHaveAttribute("disabled");
            expect(anchor).not.toHaveClass("o_disabled_offline");
        }
        expect(".o_crm_team_kanban .o_kanban_record.o_disabled_offline").toHaveCount(0);
    });

    test.tags("desktop");
    test("inventory DISABLE buttons in CRM views: disabled offline, re-enabled online", async () => {
        expect(OfflinePlugin.SELECTORS_TO_DISABLE).toEqual([
            BASE_OFFLINE_SELECTOR,
            ...CRM_OFFLINE_DISABLED_SELECTORS,
        ]);
        expect(CRM_OFFLINE_DISABLED_SELECTORS).toHaveLength(4);

        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        mockViewButtonActions();
        const buttons = captureInstances(ViewButton);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        const partnerId = serverState.partnerId; // the current user's partner
        /**
         * Every DISABLE `<button>` row of the offline inventory, by the CRM view that renders it.
         * `select` marks the lists whose header buttons need a selection.
         */
        const views = [
            {
                rows: "B1-B6, B9, B10",
                res_model: "crm.lead",
                res_id: 1,
                views: [[false, "form"]],
                names: [
                    ...LEAD_HEADER_BUTTONS,
                    "mail_action_blacklist_remove",
                    "phone_action_blacklist_remove",
                ],
            },
            {
                rows: "B12, B13",
                res_model: "crm.lead",
                views: [[false, "list"]],
                select: true,
                names: ["crm.action_crm_send_mass_convert", "crm.crm_lead_lost_action"],
            },
            {
                rows: "B16-B18",
                res_model: "crm.lead",
                views: [["opportunities", "list"]],
                select: true,
                names: [
                    "crm.crm_lead_lost_action",
                    "crm.action_lead_mass_mail",
                    "crm.action_lead_mail_compose",
                ],
            },
            {
                rows: "B19",
                res_model: "crm.lost.reason",
                res_id: 1,
                views: [[false, "form"]],
                names: ["action_lost_leads"],
            },
            {
                rows: "B20, B21",
                res_model: "crm.team",
                res_id: 1,
                views: [[false, "form"]],
                names: ["action_assign_leads", "action_open_opportunities"],
            },
            {
                rows: "B30-B32",
                res_model: "res.config.settings",
                res_id: 1,
                views: [[false, "form"]],
                names: [
                    "crm.crm_recurring_plan_action",
                    "crm.crm_lead_pls_update_action",
                    "action_crm_assign_leads",
                ],
            },
            {
                rows: "B33",
                res_model: "res.partner",
                res_id: partnerId,
                views: [[false, "form"]],
                arch: /* xml */ `
                    <form>
                        <sheet>
                            <div class="oe_button_box" name="button_box">
                                <button name="action_view_opportunity" type="object"
                                    class="oe_stat_button" icon="star" string="Opportunities"/>
                            </div>
                            <field name="name"/>
                        </sheet>
                    </form>`,
                names: ["action_view_opportunity"],
            },
            {
                rows: "B35",
                res_model: "utm.campaign",
                res_id: 1,
                views: [[false, "form"]],
                names: ["action_redirect_to_leads_opportunities"],
            },
            {
                rows: "B36",
                res_model: "crm.lead.lost",
                views: [[false, "form"]],
                target: "new",
                names: ["action_lost_reason_apply"],
            },
            {
                rows: "B37",
                res_model: "crm.lead.pls.update",
                views: [[false, "form"]],
                target: "new",
                names: ["action_update_crm_lead_probabilities"],
            },
            {
                rows: "B38",
                res_model: "crm.lead2opportunity.partner.mass",
                views: [[false, "form"]],
                target: "new",
                names: ["action_apply"],
            },
            {
                rows: "B39",
                res_model: "crm.merge.opportunity",
                views: [[false, "form"]],
                target: "new",
                names: ["action_merge"],
            },
        ];

        for (const { rows, select, names, target, ...view } of views) {
            buttons.length = 0;
            if (target === "new") {
                // Wizards are dialogs: their confirm buttons are in the dialog footer.
                await getService("action").doAction({
                    type: "ir.actions.act_window",
                    target,
                    ...view,
                });
            } else {
                await openView(view);
            }
            if (select) {
                await contains(".o_data_row:first .o_list_record_selector input").click();
            }
            for (const name of names) {
                expect(`button[name='${name}']`).toBeEnabled({ message: `${rows}: ${name}` });
            }
            await setOffline(true);
            for (const name of names) {
                for (const el of queryAll(`button[name='${name}']`)) {
                    expect(isDisabledOffline(el)).toBe(true, { message: `${rows}: ${name}` });
                }
            }
            const rendered = buttons.filter(({ clickParams }) => names.includes(clickParams.name));
            expect(new Set(rendered.map(({ clickParams }) => clickParams.name)).size).toBe(
                names.length,
                { message: `${rows}: every button has a handler` }
            );
            for (const button of rendered) {
                await button.onClick();
            }
            await animationFrame();
            // Nothing opened: only the wizard itself is a dialog.
            expect(".modal").toHaveCount(target === "new" ? 1 : 0);
            expect.verifySteps([]);
            await setOffline(false);
            for (const name of names) {
                for (const el of queryAll(`button[name='${name}']`)) {
                    expect(el).toBeEnabled({ message: `${rows}: ${name} online` });
                    expect(el).not.toHaveClass("o_disabled_offline");
                }
            }
            if (target === "new") {
                await getService("action").doAction({ type: "ir.actions.act_window_close" });
                await animationFrame();
                expect(".modal").toHaveCount(0);
            }
        }
    });

    test.tags("desktop");
    test("DISABLE guards are CRM-scoped", async () => {
        expect(
            CRM_FOREIGN_DISABLED_BUTTONS.some(
                ([model, name]) => model === "res.partner" && name === "action_partner_custom"
            )
        ).toBe(false);
        expect(CRM_OFFLINE_MODELS.includes("res.partner")).toBe(false);
        const setOffline = mockOffline();
        keepPingsFailing();
        mockViewButtonActions();
        const buttons = captureInstances(ViewButton);
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: serverState.partnerId,
            arch: /* xml */ `
                <form>
                    <header>
                        <button name="action_partner_custom" type="object" string="Custom"/>
                        <button name="action_view_opportunity" type="object" string="Opportunities"/>
                    </header>
                    <field name="name"/>
                </form>`,
        });

        await setOffline(true);
        const button = (name) => buttons.find(({ clickParams }) => clickParams.name === name);
        // A button CRM does not list keeps its framework handling (the framework only dims it).
        await button("action_partner_custom").onClick();
        // The CRM button rendered on the same model is inert.
        await button("action_view_opportunity").onClick();
        await animationFrame();
        expect.verifySteps(["doActionButton:action_partner_custom"]);
    });
});

// -----------------------------------------------------------------------------
// SKIP rows and the remaining DISABLE rows (both presets)
// -----------------------------------------------------------------------------

/** Form with the predictive lead scoring tooltip button (inventory A18 to A20). */
const PLS_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="probability"/>
            <widget name="pls_tooltip_button"/>
        </sheet>
    </form>`;

describe("SKIP and remaining DISABLE", () => {
    test("recurring revenue aggregate: online mount, disconnect, reconnect", async () => {
        // A single pipeline column.
        for (const record of CrmLead._records) {
            record.stage_id = 1;
        }
        const setOffline = mockOffline();
        keepPingsFailing();
        watchGroupProbes(["crm.group_use_recurring_revenues"]);
        // Any group question asked while offline is stepped: none may be asked.
        patchWithCleanup(user, {
            hasGroup(group) {
                if (
                    group === "crm.group_use_recurring_revenues" &&
                    getService(OfflinePlugin).isOffline()
                ) {
                    expect.step(`hasGroup while offline:${group}`);
                }
                return super.hasGroup(...arguments);
            },
        });
        const progressBars = captureInstances(CrmColumnProgress);
        await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const mrr = ".o_kanban_counter .o_animated_number[data-tooltip='Expected MRR']";
        expect(".o_kanban_group").toHaveCount(1);
        // One probe reaches the server, and the aggregate is shown.
        expect.verifySteps(["has_group:crm.group_use_recurring_revenues"]);
        expect(mrr).toHaveText("+15");
        const onlineBar = progressBars.at(-1);
        expect(onlineBar.probedRecurringRevenue()).toBe(true);

        // The connection drops: the aggregate is hidden (not shown as 0, no "MRR" label).
        await setOffline(true);
        expect(mrr).toHaveCount(0);
        expect(".o_kanban_counter").not.toHaveText(/\+|MRR/);
        expect(onlineBar.showRecurringRevenue).toBe(false);
        expect(onlineBar.getRecurringRevenueGroupAggregate({})).toEqual({});

        // Back online: shown again from the retained answer, without probing again.
        await setOffline(false);
        expect(mrr).toHaveText("+15");
        expect(onlineBar.showRecurringRevenue).toBe(true);
        expect.verifySteps([]);

        // A progress bar mounted while offline (the kanban rendered again from the cache of its
        // visit) asks nothing, hides the aggregate, and probes when the connection returns.
        await getService("action").switchView("list");
        expect.errors(1);
        await setOffline(true);
        const barsBefore = progressBars.length;
        await getService("action").switchView("kanban");
        await animationFrame();
        expect(".o_kanban_group").toHaveCount(1);
        expect(progressBars.length).toBeGreaterThan(barsBefore);
        const offlineBar = progressBars.at(-1);
        expect(offlineBar.probedRecurringRevenue()).toBe(null);
        expect(offlineBar.showRecurringRevenue).toBe(false);
        expect(mrr).toHaveCount(0);
        await runAllTimers();
        expect(offlineBar.probedRecurringRevenue()).toBe(null);
        expect.verifySteps([]);
        expect.verifyErrors([`/web/dataset/call_kw/crm.lead/web_read_group`]);
        await setOffline(false);
        await animationFrame();
        expect(offlineBar.probedRecurringRevenue()).toBe(true);
        expect(offlineBar.showRecurringRevenue).toBe(true);
        // The answer of the first probe is reused: still a single probe in total.
        expect.verifySteps([]);
    });

    test("pls tooltip button: disabled offline, no lookup", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/web_save", "crm.lead/prepare_pls_tooltip_data", "crm.lead/web_read"]);
        const plsButtons = captureInstances(CrmPlsTooltipButton);
        await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: PLS_FORM_ARCH });
        expect.verifySteps(["crm.lead/web_read"]);
        const plsButton = plsButtons.at(-1);

        // Online, the button looks the tooltip data up, reloads the record and opens the tooltip.
        await contains(".o_crm_pls_tooltip_button").click();
        expect.verifySteps(["crm.lead/prepare_pls_tooltip_data", "crm.lead/web_read"]);
        expect(".o_crm_pls_tooltip").toHaveCount(1);
        plsButton.popover.close();
        await animationFrame();
        expect(".o_crm_pls_tooltip").toHaveCount(0);

        // A pending edit: a click that got through would save it first.
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (unsaved)");
        await setOffline(true);
        expect(isDisabledOffline(".o_crm_pls_tooltip_button")).toBe(true);
        await plsButton.onClickPlsTooltipButton({
            currentTarget: queryOne(".o_crm_pls_tooltip_button"),
        });
        await plsButton.onClickPlsTooltipButton();
        await animationFrame();
        expect(".o_crm_pls_tooltip").toHaveCount(0);
        expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 (unsaved)");
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        await setOffline(false);
        expect(".o_crm_pls_tooltip_button").toBeEnabled();
    });

    /** Every mail write the lead chatter could send, by route or ORM method. */
    const MAIL_WRITES = [
        "/mail/message/post",
        "/mail/message/update_content",
        "/mail/message/reaction",
        "/mail/attachment/upload",
        "/mail/attachment/delete",
        "/mail/thread/subscribe",
        "/mail/thread/unsubscribe",
        /\/message_subscribe$/,
        /\/message_unsubscribe$/,
        /\/message_update_siblings_subscription$/,
        /\/action_feedback$/,
        /\/action_feedback_schedule_next$/,
        /\/action_done$/,
        /\/activity_send_mail$/,
        /\/open_edit_form$/,
        /\/post_message$/,
        /\/unlink$/,
        /\/write$/,
        /\/web_save$/,
    ];

    /**
     * Seeds a lead thread with followers (the current user and another partner), an activity
     * without assignee whose type has a mail template, an attachment and a message carrying a
     * reaction of the current user.
     */
    async function seedLeadThread(resModel = "crm.lead", resId = 1) {
        const pyEnv = await startServer();
        const otherPartnerId = pyEnv["res.partner"].create({
            name: "Follower Partner",
            email: "follower@example.com",
        });
        for (const partnerId of [serverState.partnerId, otherPartnerId]) {
            pyEnv["mail.followers"].create({
                partner_id: partnerId,
                res_model: resModel,
                res_id: resId,
                is_active: true,
            });
        }
        const mailTemplateId = pyEnv["mail.template"].create({ name: "Dummy mail template" });
        const [emailType] = pyEnv["mail.activity.type"].search_read([["name", "=", "Email"]]);
        pyEnv["mail.activity.type"].write([emailType.id], { mail_template_ids: [mailTemplateId] });
        const activityId = pyEnv["mail.activity"].create({
            activity_type_id: emailType.id,
            can_write: true,
            res_id: resId,
            res_model: resModel,
            summary: "Follow the lead up",
            user_id: false,
        });
        // The local lead model has no server-side inverse for the activity link: set it.
        pyEnv[resModel].write([resId], { activity_ids: [[4, activityId]] });
        const attachmentId = pyEnv["ir.attachment"].create({
            mimetype: "text/plain",
            name: "notes.txt",
            res_id: resId,
            res_model: resModel,
        });
        const messageId = pyEnv["mail.message"].create({
            author_id: serverState.partnerId,
            body: "Hello lead",
            message_type: "comment",
            model: resModel,
            res_id: resId,
        });
        pyEnv["mail.message.reaction"].create({
            content: "👍",
            message_id: messageId,
            partner_id: serverState.partnerId,
        });
        return { pyEnv, activityId, attachmentId, messageId, mailTemplateId };
    }

    /**
     * Seeds a scheduled message of the current user, carrying one attachment, on a thread.
     *
     * @param {Object} pyEnv
     * @param {string} resModel
     * @param {number} resId
     * @returns {{ scheduledMessageId: number, attachmentId: number }}
     */
    function seedScheduledMessage(pyEnv, resModel, resId) {
        const attachmentId = pyEnv["ir.attachment"].create({
            mimetype: "text/plain",
            name: "agenda.txt",
            res_id: resId,
            res_model: resModel,
        });
        const scheduledMessageId = pyEnv["mail.scheduled.message"].create({
            attachment_ids: [attachmentId],
            body: "<p>Quote reminder</p>",
            model: resModel,
            res_id: resId,
            scheduled_date: "2030-01-01 10:00:00",
        });
        return { scheduledMessageId, attachmentId };
    }

    /**
     * @param {ScheduledMessage[]} instances captured scheduled message components
     * @param {string} model
     * @returns {ScheduledMessage | undefined} the mounted one showing a scheduled message of `model`
     */
    function mountedScheduledMessage(instances, model) {
        return instances.findLast(
            (instance) =>
                status(instance) === "mounted" &&
                instance.props.scheduledMessage.thread?.model === model
        );
    }

    /** Collects the instances of every patched mail component of the chatter. */
    function captureChatterComponents() {
        return {
            chatters: captureInstances(Chatter),
            followerLists: captureInstances(FollowerList),
            followers: captureInstances(Follower),
            subtypeDialogs: captureInstances(FollowerSubtypeDialog),
            activities: captureInstances(Activity),
            markDonePopovers: captureInstances(ActivityMarkAsDone),
            assignPopovers: captureInstances(ActivityAssignPopover),
            mailTemplates: captureInstances(ActivityMailTemplate),
            quickReactionMenus: captureInstances(QuickReactionMenu),
            reactionLists: captureInstances(MessageReactionList),
            reactionMenus: captureInstances(MessageReactionMenu),
            composers: captureInstances(Composer),
        };
    }

    /**
     * Messages re-render while their thread loads, a number of times that depends on timing: only
     * the actions of owners still mounted are the ones the user can reach.
     *
     * @param {Object[]} actions captured message actions
     * @param {string} model
     * @returns {Map<Object, Object[]>} the actions of the mounted owners showing a message of
     *  `model`
     */
    function messageActionsByOwner(actions, model) {
        const byOwner = new Map();
        for (const action of actions) {
            if (
                action.messageFn?.()?.thread?.model !== model ||
                !action.owner ||
                status(action.owner) !== "mounted"
            ) {
                continue;
            }
            if (!byOwner.has(action.owner)) {
                byOwner.set(action.owner, []);
            }
            byOwner.get(action.owner).push(action);
        }
        return byOwner;
    }

    const NO_EVENT = { stopPropagation() {}, preventDefault() {} };

    test("chatter on lead form is read-only offline on every mutation path", async () => {
        // The post started online whose request loses the connection raises one
        // `ConnectionLostError`: no mail component swallows it, the framework's lost-connection
        // error handler does (asserted below: nothing is retried, queued or shown).
        expect.errors(1);
        const { pyEnv, mailTemplateId } = await seedLeadThread();
        // As on the server, the lead model is a mail thread: its messages accept reactions, so
        // their actions render the quick reaction menu (the local fixture omits the mixin).
        const leadModel = pyEnv["crm.lead"];
        leadModel._inherit = [leadModel._inherit, "mail.thread"].filter(Boolean).join(",");
        const setOffline = mockOffline();
        keepPingsFailing();
        // Route listeners run last-registered first: the connection drop of the post is
        // registered before the watchers, so they still step the dropped request.
        const dropPosts = { offline: false };
        onRpc("/mail/message/post", () =>
            dropPosts.offline ? new Response("", { status: 502 }) : undefined
        );
        watchOfflineRpcs();
        // Every chatter write is stepped, online or offline: the only one is the final post.
        watchRpcs(MAIL_WRITES);
        const components = captureChatterComponents();
        const messageActions = captureInstances(MessageAction);
        await start();
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Message:contains('Hello lead')");
        await mailContains(".o-mail-Activity");
        const chatter = components.chatters.find((c) => c.threadModel() === "crm.lead");
        const thread = chatter.state.thread;

        // Online: the composer opens, the follower dropdown opens, messages have actions.
        await mailClick(".o-mail-Chatter-sendMessage");
        await mailContains(".o-mail-Composer");
        await mailClick(".o-mail-Followers-button");
        await mailContains(".o-mail-Followers-dropdown");
        // The current user follows the lead (shown in the dropdown header) with another partner.
        await mailContains(".o-mail-Follower:contains('Follower Partner')");
        await mailClick(".o-mail-Message");
        await hover(".o-mail-Message");
        const ownersOnline = messageActionsByOwner(messageActions, "crm.lead");
        const ownerNames = new Set([...ownersOnline.keys()].map((o) => o.constructor.name));
        expect(ownerNames.has("Message")).toBe(true);
        expect(ownerNames.has("MessageContextMenu")).toBe(true);
        for (const owner of ownersOnline.keys()) {
            if (["Message", "MessageContextMenu"].includes(owner.constructor.name)) {
                expect(owner.messageActions.actions.length).toBeGreaterThan(0);
            }
        }

        // The connection drops: the composer and the follower dropdown close.
        await setOffline(true);
        await animationFrame();
        expect(".o-mail-Chatter .o-mail-Composer").toHaveCount(0);
        expect(".o-mail-Followers-dropdown").toHaveCount(0);
        for (const selector of [
            ".o-mail-Chatter-sendMessage",
            ".o-mail-Chatter-logNote",
            ".o-mail-Chatter-activity",
        ]) {
            expect(isDisabledOffline(selector)).toBe(true, { message: selector });
        }
        expect(".o-mail-Followers-button").toHaveAttribute("disabled");
        expect(chatter.isDisabled).toBe(true);

        // Chatter handlers, called directly.
        chatter.toggleComposer("message");
        chatter.toggleComposer("note");
        await chatter.scheduleActivity();
        chatter.onAddFollowers();
        expect(await chatter.onClickAttachFile()).toBe(false);
        const file = new File(["hello"], "offline.txt", { type: "text/plain" });
        const uploadedData = { data: "aGVsbG8=", name: "offline.txt", type: "text/plain" };
        expect(chatter.onUploaded({ thread })(uploadedData)).toBe(undefined);
        // The drop zone uploads through the uploader of the chatter.
        await chatter.attachmentUploader.uploadFile(file, { thread });
        await chatter.attachmentUploader.uploadData(uploadedData, { thread });
        chatter.state.selectedAttachmentIds = thread.attachments.map(({ id }) => id);
        chatter.onClickDeleteSelectedAttachments();
        await chatter.unlinkAttachments(thread.attachments);
        await animationFrame();
        expect(".o-mail-Chatter .o-mail-Composer").toHaveCount(0);
        expect(".modal").toHaveCount(0);

        // Follower list and followers, called directly (the dropdown was opened online).
        const followerList = components.followerLists.at(-1);
        await followerList.onClickFollow();
        await followerList.onClickUnfollow();
        followerList.onClickAddFollowers();
        await followerList.onClickEdit();
        for (const follower of components.followers) {
            await follower.onClickRemove();
            await follower.onClickEdit();
        }
        await animationFrame();
        expect(".modal").toHaveCount(0);

        // Activity, its mail templates, called directly.
        const activity = components.activities.at(-1);
        activity.onClickMarkAsDone({ currentTarget: queryOne(".o-mail-Activity") });
        activity.onClickAssign({ currentTarget: queryOne(".o-mail-Activity") });
        await activity.onClickMail();
        await activity.onFileUploaded(uploadedData);
        await activity.edit();
        const mailTemplate = components.mailTemplates.at(-1);
        const template = pyEnv["mail.template"].search_read([["id", "=", mailTemplateId]])[0];
        mailTemplate.onClickPreview(NO_EVENT, template);
        await mailTemplate.onClickSend(NO_EVENT, template);
        await animationFrame();
        expect(".o-mail-ActivityMarkAsDone").toHaveCount(0);
        expect(".o-mail-ActivityAssignPopover").toHaveCount(0);
        expect(".modal").toHaveCount(0);

        // Reactions and message actions, each present for a lead message before it is called.
        const leadQuickReactionMenus = components.quickReactionMenus.filter(
            (quickReactionMenu) => quickReactionMenu.props.message.thread?.model === "crm.lead"
        );
        expect(leadQuickReactionMenus.length).toBeGreaterThan(0, {
            message: "a quick reaction menu of a lead message",
        });
        for (const quickReactionMenu of leadQuickReactionMenus) {
            quickReactionMenu.toggleReaction("👍");
            quickReactionMenu.toggleReaction("🤣");
            quickReactionMenu.onClick();
        }
        const leadReactionLists = components.reactionLists.filter(
            (reactionList) => reactionList.message().thread?.model === "crm.lead"
        );
        expect(leadReactionLists.length).toBeGreaterThan(0, {
            message: "a reaction list of a lead message",
        });
        for (const reactionList of leadReactionLists) {
            reactionList.onClickReaction(NO_EVENT, {
                messageAtRender: reactionList.message(),
                reactionAtRender: reactionList.reaction(),
            });
        }
        const ownersOffline = messageActionsByOwner(messageActions, "crm.lead");
        for (const ownerName of ["Message", "MessageContextMenu"]) {
            const ownerActions = [...ownersOffline]
                .filter(([owner]) => owner.constructor.name === ownerName)
                .flatMap(([, actions]) => actions);
            expect(ownerActions.length).toBeGreaterThan(0, {
                message: `${ownerName} of a lead message holds actions offline`,
            });
        }
        for (const [owner, actions] of ownersOffline) {
            if (["Message", "MessageContextMenu"].includes(owner.constructor.name)) {
                expect(owner.messageActions.actions).toHaveLength(0, {
                    message: `no action listed for ${owner.constructor.name}`,
                });
            }
            for (const action of actions) {
                expect(action.onSelected()).toBe(true, { message: action.id });
            }
        }
        await animationFrame();
        expect(".o-mail-MessageReaction:contains('🤣')").toHaveCount(0);
        expect(".modal").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // A mark-done popover opened online closes on disconnect, and its done handlers, called
        // directly afterwards, issue no `action_feedback` or `action_feedback_schedule_next`.
        await setOffline(false);
        await mailClick(".o-mail-Activity-markDone");
        await mailContains(".o-mail-ActivityMarkAsDone");
        const markDonePopover = components.markDonePopovers.at(-1);
        expect(markDonePopover.activity().res_model).toBe("crm.lead");
        expect(status(markDonePopover)).toBe("mounted");
        await setOffline(true);
        await animationFrame();
        expect(".o-mail-ActivityMarkAsDone").toHaveCount(0);
        await markDonePopover.onClickDone();
        await markDonePopover.onClickDoneAndScheduleNext();
        await animationFrame();
        expect(".o-mail-Activity:contains('Follow the lead up')").toHaveCount(1);
        expect(".modal").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // A post started online whose request loses the connection: silenced, nothing queued.
        await setOffline(false);
        await mailClick(".o-mail-Chatter-logNote");
        await mailContains(".o-mail-Composer-input");
        await insertText(".o-mail-Composer-input", "Lost in transit");
        dropPosts.offline = true;
        await mailClick(".o-mail-Composer-send:enabled");
        await animationFrame();
        expect.verifySteps(["/mail/message/post"]);
        await expect.waitForErrors([`Connection to "/mail/message/post"`]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queuedEntries()).toHaveLength(0);
        expect(".o-mail-Message:contains('Lost in transit')").toHaveCount(0);
        await mailContains(".o-mail-Message:contains('Hello lead')");
    });

    test("chatter scheduled message on a lead: cancel, attachment removal, edit and send now inert offline", async () => {
        const pyEnv = await startServer();
        const { scheduledMessageId, attachmentId } = seedScheduledMessage(pyEnv, "crm.lead", 1);
        // Online, "Send Now" and "Edit" are answered as the server does for a message still
        // scheduled: it stays in the list.
        onRpc("mail.scheduled.message", "post_message", ({ args }) => {
            expect(args).toEqual([scheduledMessageId]);
            return true;
        });
        onRpc("mail.scheduled.message", "open_edit_form", ({ args }) => {
            expect(args).toEqual([scheduledMessageId]);
            return { name: "Edit Scheduled Message" };
        });
        mockService("action", {
            doAction(action, options) {
                if (action?.name === "Edit Scheduled Message") {
                    expect.step(`doAction:${action.name}`);
                    return options.onClose();
                }
                return super.doAction(...arguments);
            },
        });
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        // Every chatter write is stepped, online or offline.
        watchRpcs(MAIL_WRITES);
        const scheduledMessages = captureInstances(ScheduledMessage);
        await start();
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        const shown =
            ".o-mail-ScheduledMessagesList .o-mail-Scheduled-Message:contains('Quote reminder')";
        const shownAttachment = `${shown} .o-mail-AttachmentCard:contains('agenda.txt')`;
        await mailContains(shown);
        await mailContains(shownAttachment);
        const scheduledMessage = mountedScheduledMessage(scheduledMessages, "crm.lead");
        expect(scheduledMessage.props.scheduledMessage.id).toBe(scheduledMessageId);
        expect(scheduledMessage.props.scheduledMessage.thread.id).toBe(1);
        const attachments = [...scheduledMessage.props.scheduledMessage.attachment_ids];
        expect(attachments.map(({ id }) => id)).toEqual([attachmentId]);

        // Online, the cancellation asks for confirmation.
        await mailClick(".o-mail-Scheduled-Message-buttons .btn:contains('Cancel')");
        await mailContains(".modal-footer button:contains('Cancel Message')");

        // The confirmation opened online, confirmed once offline, cancels nothing.
        await setOffline(true);
        await animationFrame();
        await contains(".modal-footer button:contains('Cancel Message')").click();
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        // Offline, every handler is inert, called directly or through its button.
        const offlineScheduledMessage = mountedScheduledMessage(scheduledMessages, "crm.lead");
        await offlineScheduledMessage.cancel();
        await offlineScheduledMessage.onClickAttachmentUnlink(attachments);
        offlineScheduledMessage.onClickCancel();
        await offlineScheduledMessage.onClickEdit();
        await offlineScheduledMessage.onClickSendNow();
        for (const label of ["Send Now", "Edit", "Cancel"]) {
            await contains(`.o-mail-Scheduled-Message-buttons .btn:contains('${label}')`).click();
        }
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect(shown).toHaveCount(1);
        expect(shownAttachment).toHaveCount(1);
        expect(pyEnv["mail.scheduled.message"].browse(scheduledMessageId)).toHaveLength(1);
        expect(pyEnv["ir.attachment"].browse(attachmentId)).toHaveLength(1);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // Back online, the same handlers reach the server again.
        await setOffline(false);
        await mailClick(".o-mail-Scheduled-Message-buttons .btn:contains('Send Now')");
        await expect.waitForSteps(["mail.scheduled.message/post_message"]);
        await mailClick(".o-mail-Scheduled-Message-buttons .btn:contains('Edit')");
        await expect.waitForSteps([
            "mail.scheduled.message/open_edit_form",
            "doAction:Edit Scheduled Message",
        ]);
        await mountedScheduledMessage(scheduledMessages, "crm.lead").onClickAttachmentUnlink(
            attachments
        );
        expect.verifySteps(["/mail/attachment/delete"]);
        await mailContains(shownAttachment, { count: 0 });
        await mailClick(".o-mail-Scheduled-Message-buttons .btn:contains('Cancel')");
        await mailClick(".modal-footer button:contains('Cancel Message')");
        await expect.waitForSteps(["mail.scheduled.message/unlink"]);
        await mailContains(shown, { count: 0 });
        expect(pyEnv["mail.scheduled.message"].browse(scheduledMessageId)).toEqual([]);
        expect(queuedEntries()).toHaveLength(0);
    });

    test("chatter overlays opened online are closed or inert after disconnection", async () => {
        const { activityId } = await seedLeadThread();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        const connection = { offline: false };
        const components = captureChatterComponents();
        const messageActions = captureInstances(MessageAction);
        const viewButtons = captureInstances(ViewButton);
        await start();
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Message:contains('Hello lead')");
        await mailContains(".o-mail-Activity");
        const ownActions = () =>
            [...messageActionsByOwner(messageActions, "crm.lead").values()].flat();

        // 1. Follower subtype dialog, and its mass-update confirmation, opened online.
        await mailClick(".o-mail-Followers-button");
        await mailClick(
            ".o-mail-Follower:contains('Follower Partner') [title='Edit Notification Preferences']"
        );
        await mailContains(".o-mail-FollowerSubtypeDialog");
        const subtypeDialog = components.subtypeDialogs.at(-1);
        // The lead belongs to a parent record (its team): the mass update is offered.
        subtypeDialog.parentRecord = { modelName: "Sales Team", display_name: "Mushroom Kingdom" };
        subtypeDialog.onClickUpdateAll();
        await mailContains(".modal-footer button:contains('Yes, Update All')");

        // 2. Activity assign popover, opened online.
        await mailClick(".o-mail-Activity-assign");
        await mailContains(".o-mail-ActivityAssignPopover");
        const assignPopover = components.assignPopovers.at(-1);

        await setOffline(true);
        await animationFrame();
        expect(".o-mail-FollowerSubtypeDialog").toHaveCount(0);
        expect(".o-mail-ActivityAssignPopover").toHaveCount(0);
        // The confirmation opened before the disconnection does nothing on confirm.
        await contains(".modal-footer button:contains('Yes, Update All')").click();
        await animationFrame();
        await subtypeDialog.updateSubscription({ updateAll: true });
        await subtypeDialog.updateSubscription();
        await subtypeDialog.onClickUpdateAll();
        await assignPopover.onClickAssign();
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);
        await setOffline(false);

        // 3. Emoji picker of the message "reaction" action, and the reaction menu, opened online.
        // The picker's `onSelect` reacts directly, bypassing the action: it must close itself.
        await hover(".o-mail-Message");
        const reactionAction = ownActions().find(
            (action) => action.id === "reaction" && action.owner.constructor.name === "Message"
        );
        reactionAction.owner.reactionPicker.open(() => queryOne(".o-mail-Message"));
        await mailContains(".o-EmojiPicker");
        await setOffline(true);
        await animationFrame();
        expect(".o-EmojiPicker").toHaveCount(0);
        // Selecting the action again does not reopen it.
        expect(reactionAction.onSelected()).toBe(true);
        await animationFrame();
        expect(".o-EmojiPicker").toHaveCount(0);
        await setOffline(false);

        const reactionsAction = ownActions().find(
            (action) => action.id === "reactions" && action.owner.constructor.name === "Message"
        );
        reactionsAction.onSelected();
        await mailContains(".o-mail-MessageReactionMenu");
        await setOffline(true);
        await animationFrame();
        expect(".o-mail-MessageReactionMenu").toHaveCount(0);
        expect(components.reactionMenus.length).toBeGreaterThan(0);
        expect.verifySteps([]);
        await setOffline(false);

        // 4. Edit composer of a message, left open.
        const editAction = ownActions().find(
            (action) => action.id === "edit" && action.owner.constructor.name === "Message"
        );
        editAction.onSelected();
        await mailContains(".o-mail-Message .o-mail-Composer-input");
        await setOffline(true);
        const editComposer = components.composers.find(
            (composer) => composer.props.composer?.message
        );
        await editComposer.sendMessage();
        await editComposer.editMessage();
        await animationFrame();
        expect.verifySteps([]);
        await setOffline(false);

        // 5. The `mail.activity` form opened through the activity "Edit".
        await mailClick(".o-mail-Activity .btn:contains('Edit')");
        await mailContains(".modal .o_form_view");
        const activityRecord = () =>
            viewButtons.find(({ props }) => props.record?.resModel === "mail.activity")?.props
                .record;
        expect(activityRecord().resId).toBe(activityId);
        await contains(".modal .o_field_widget[name=summary] input").edit("Edited offline");
        await setOffline(true);
        const activityButtons = viewButtons.filter(
            ({ props, clickParams }) =>
                props.record?.resModel === "mail.activity" &&
                ["action_close_dialog", "action_done"].includes(clickParams.name)
        );
        expect(activityButtons.length).toBeGreaterThan(0);
        for (const button of activityButtons) {
            await button.onClick();
        }
        await animationFrame();
        expect.verifySteps([]);
        // A save started offline is refused: its request fails and nothing is queued.
        expect(await activityRecord().save()).toBe(false);
        expect.verifySteps(["offline:mail.activity/web_save"]);
        expect(queuedEntries()).toHaveLength(0);
        expect(".modal .o_form_view").toHaveCount(1);
        await setOffline(false);

        // A save whose request loses the connection is refused too, and the dialog stays open.
        onRpc("/web/dataset/call_kw/mail.activity/web_save", () =>
            connection.offline ? new Response("", { status: 502 }) : undefined
        );
        connection.offline = true;
        expect(await activityRecord().save()).toBe(false);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queuedEntries()).toHaveLength(0);
        expect(".modal .o_form_view").toHaveCount(1);
        connection.offline = false;
        await setOffline(false);
        await getService("action").doAction({ type: "ir.actions.act_window_close" });
        await animationFrame();

        // 6. The followers wizard opened through "Add Followers".
        await mailClick(".o-mail-Followers-button");
        await mailClick(".o-mail-Followers-dropdown a:contains('Add Followers')");
        await mailContains(".modal button[name='edit_followers']");
        const followersRecord = viewButtons.find(
            ({ props }) => props.record?.resModel === "mail.followers.edit"
        ).props.record;
        expect(followersRecord.context.default_res_model).toBe("crm.lead");
        await setOffline(true);
        expect(isDisabledOffline(".modal button[name='edit_followers']")).toBe(true);
        for (const button of viewButtons.filter(
            ({ clickParams }) => clickParams.name === "edit_followers"
        )) {
            await button.onClick();
        }
        await animationFrame();
        expect.verifySteps([]);
        expect(await followersRecord.save()).toBe(false);
        expect.verifySteps(["offline:mail.followers.edit/web_save"]);
        expect(queuedEntries()).toHaveLength(0);
        expect(".modal button[name='edit_followers']").toHaveCount(1);
    });

    test("chatter patches are inert for non-CRM threads", async () => {
        const pyEnv = await startServer();
        const partnerId = pyEnv["res.partner"].create({ name: "Customer" });
        pyEnv["mail.followers"].create({
            partner_id: serverState.partnerId,
            res_model: "res.partner",
            res_id: partnerId,
            is_active: true,
        });
        pyEnv["mail.activity"].create({
            can_write: true,
            res_id: partnerId,
            res_model: "res.partner",
            summary: "Partner activity",
        });
        seedScheduledMessage(pyEnv, "res.partner", partnerId);
        const setOffline = mockOffline();
        keepPingsFailing();
        mockService("action", {
            doAction(action) {
                if (action?.res_model === "mail.followers.edit") {
                    expect.step(`doAction:${action.res_model}`);
                    return Promise.resolve();
                }
                return super.doAction(...arguments);
            },
        });
        const components = captureChatterComponents();
        const viewButtons = captureInstances(ViewButton);
        const scheduledMessages = captureInstances(ScheduledMessage);
        await start();
        await openFormView("res.partner", partnerId, {
            arch: /* xml */ `
                <form>
                    <sheet><field name="name"/></sheet>
                    <chatter/>
                </form>`,
        });
        await mailContains(".o-mail-Activity");
        await mailContains(".o-mail-Scheduled-Message:contains('Quote reminder')");
        // The follower list is rendered by its dropdown, opened online.
        await mailClick(".o-mail-Followers-button");
        await mailContains(".o-mail-Followers-dropdown");
        // The partner activity editor, opened online.
        await mailClick(".o-mail-Activity .btn:contains('Edit')");
        await mailContains(".modal .o_form_view");
        await contains(".modal .o_field_widget[name=summary] input").edit("Edited offline");

        await setOffline(true);
        await animationFrame();
        const chatter = components.chatters.find((c) => c.threadModel() === "res.partner");
        expect(chatter.isDisabled).toBe(false);
        // The composer still opens through `toggleComposer`.
        chatter.toggleComposer("note");
        await animationFrame();
        expect(chatter.state.composerType).toBe("note");
        // The follower handlers still run.
        components.followerLists.at(-1).onClickAddFollowers();
        await animationFrame();
        expect.verifySteps(["doAction:mail.followers.edit"]);
        // A partner activity saved offline is still queued, as the framework does.
        const activityRecord = viewButtons.find(
            ({ props }) => props.record?.resModel === "mail.activity"
        ).props.record;
        expect(await activityRecord.save()).toBe(true);
        const saves = queuedCalls("mail.activity", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args[1]).toMatchObject({ summary: "Edited offline" });
        // A partner scheduled message still asks to confirm its cancellation.
        const partnerScheduledMessage = mountedScheduledMessage(scheduledMessages, "res.partner");
        expect(partnerScheduledMessage.props.scheduledMessage.thread.id).toBe(partnerId);
        partnerScheduledMessage.onClickCancel();
        await mailContains(".modal-footer button:contains('Cancel Message')");
    });

    test("share target item issues no team read offline", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.team/web_search_read"]);
        const pngFile = new File([new Uint8Array(1)], "text.png", { type: "image/png" });
        const items = captureInstances(CrmShareTargetItem);
        // The shared files arrive once the client is offline.
        const sharedFiles = Promise.withResolvers();
        patchWithCleanup(shareTargetService, {
            _getShareTargetFiles: () => sharedFiles.promise,
        });
        const webClient = await mountWithCleanup(WebClient);
        await animationFrame();
        await setOffline(true);
        sharedFiles.resolve([pngFile]);
        await animationFrame();
        expect(".o_dialog").toHaveCount(1);
        const dialog = findComponent(
            webClient,
            (component) => typeof component?.onSelectedApp === "function"
        );
        if (!dialog.isSelectedShareTarget("Lead")) {
            dialog.onSelectedApp("Lead");
        }
        await animationFrame();
        expect(".o_dialog button.active").toHaveText("Lead");
        expect(items.length).toBeGreaterThan(0);
        const offlineItem = items.at(-1);
        expect(offlineItem.state.teams).toEqual([]);
        expect(offlineItem.state.selected_team).toBe(false);
        // A company change offline does not read the teams either.
        offlineItem.onCompanyChange(offlineItem.currentCompany);
        await offlineItem.updateTeams();
        await animationFrame();
        expect.verifySteps([]);

        // Online, the item reads the sales teams of the company.
        await setOffline(false);
        await offlineItem.updateTeams();
        expect.verifySteps(["crm.team/web_search_read"]);
        expect(offlineItem.state.teams.map(({ id }) => id)).toEqual([1, 2]);
        expect(offlineItem.state.selected_team.id).toBe(1);
    });
});

// -----------------------------------------------------------------------------
// K9: existing lead controls usable offline carry the offline-availability attribute
// -----------------------------------------------------------------------------

const OFFLINE_ATTRIBUTE = "data-available-offline";

/**
 * Seeds a customer and a tag on lead 1, so the form renders the partner, tag and contact
 * widgets with values (mailto link, phone link, tag remove link), and another customer on
 * lead 2, which a visit of lead 2 caches for the offline partner lookup.
 *
 * @returns {Promise<{ customerId: number, otherCustomerId: number }>}
 */
async function seedLeadCustomer() {
    const pyEnv = await startServer();
    const customerId = pyEnv["res.partner"].create({
        name: "Azure Interior",
        email: "azure@example.com",
    });
    pyEnv["crm.lead"].write([1], {
        partner_id: customerId,
        tag_ids: [1],
        website: "https://azure.example.com",
        description: "<p>Met at the fair</p>",
    });
    const otherCustomerId = pyEnv["res.partner"].create({
        name: "Deco Addict",
        email: "deco@example.com",
    });
    pyEnv["crm.lead"].write([2], { partner_id: otherCustomerId });
    return { customerId, otherCustomerId };
}

describe("K9 attributes", () => {
    test("existing CRM lead controls usable offline carry data-available-offline", async () => {
        const { otherCustomerId } = await seedLeadCustomer();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/web_save", "crm.lead/web_unlink"]);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // 1. Lead form, visited online (its record and partner are cached), then offline. The
        // form of lead 2, read online first, caches its customer for the offline lookup.
        await getService("action").doAction({
            type: "ir.actions.act_window",
            res_model: "crm.lead",
            res_id: 2,
            views: [[false, "form"]],
            cache: true, // as every action the server loads: its views are cached
        });
        expect(".o_field_widget[name=partner_id] input").toHaveValue("Deco Addict");
        await getService("action").doAction(LEAD_FORM_ACTION_ID);
        await mailContains(".o_field_widget[name=description] [contenteditable='true']");
        await setOffline(true);
        await visitedReady();
        const marked = [
            ".o_field_widget[name=name] input",
            ".o_field_widget[name=email_from] input",
            ".o_field_widget[name=email_from] a[href^='mailto:']",
            ".o_field_widget[name=phone] input",
            ".o_field_widget[name=website] input",
            ".o_field_widget[name=expected_revenue] input",
            ".o_field_widget[name=probability] input",
            ".o_field_widget[name=partner_id] input",
            ".o_field_widget[name=tag_ids] input",
            ".o_field_widget[name=tag_ids] .o_delete",
            ".o_field_widget[name=description] [contenteditable='true']",
        ];
        if (isSmall()) {
            // Only many2one fields switch to the cached autocomplete on small screens offline: the
            // tags field keeps the framework's search-dialog input, which is marked as well.
            expect(".o_field_widget[name=tag_ids] input").toHaveAttribute("readonly");
        }
        for (const selector of marked) {
            expect(selector).toHaveAttribute(OFFLINE_ATTRIBUTE, "1", { message: selector });
            expect(queryOne(selector)).not.toHaveAttribute("disabled");
        }
        expect(".o_field_widget[name=phone] a.o_phone_form_link").toHaveCount(1);
        expect(".o_field_widget[name=phone] a.o_phone_form_link").toHaveAttribute(
            OFFLINE_ATTRIBUTE,
            "1"
        );
        const phoneButtons = queryAll(".o_field_widget[name=phone] button.o_phone_form_link");
        for (const phoneButton of phoneButtons) {
            expect(phoneButton).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
        }
        // On small screens too, the partner field is an editable autocomplete offline.
        expect(".o_field_widget[name=partner_id] input").not.toHaveAttribute("readonly");

        // The cached customer is suggested; every suggestion entry is usable offline. Suggestions
        // are read within the partner field: offline on small screens every lead many2one shows
        // its autocomplete list inline.
        const partnerSuggestions =
            ".o_field_widget[name=partner_id] .o-autocomplete--dropdown-item";
        await contains(".o_field_widget[name=partner_id] input").edit("Deco", { confirm: false });
        await runAllTimers();
        const suggestions = queryAll(partnerSuggestions);
        expect(suggestions.length).toBeGreaterThan(0);
        for (const suggestion of suggestions) {
            expect(suggestion).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
            expect(suggestion.firstElementChild).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        }
        expect(queryAllTexts(partnerSuggestions)).toEqual(["Deco Addict"]);
        await contains(`${partnerSuggestions}:contains('Deco Addict') > *`).click();
        expect(".o_field_widget[name=partner_id] input").toHaveValue("Deco Addict");
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (offline)");
        await contains(".o_form_button_save").click();
        expect.verifySteps(["crm.lead/web_save"]);
        const [formSave] = queuedCalls("crm.lead", "web_save");
        expect(formSave.args[0]).toEqual([1]);
        expect(formSave.args[1]).toMatchObject({
            name: "Lead 1 (offline)",
            partner_id: otherCustomerId,
        });
        await setOffline(false);
        // The queued edit is replayed on reconnect.
        await expect.waitForSteps(["crm.lead/web_save"]);

        // 2. Pipeline kanban, visited online, then offline.
        await getService("action").doAction(PIPELINE_ACTION_ID);
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        await setOffline(true);
        const lead2Card = ".o_kanban_record:contains('Lead 2')";
        const toggler = `${lead2Card} .o_dropdown_kanban button`;
        expect(toggler).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        expect(toggler).toBeEnabled();
        await contains(toggler).click();
        // The card compiler turns `type` into a click handler: the anchors are found by label.
        expect(".o-dropdown--menu a:contains('Edit')").toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        expect(".o-dropdown--menu a:contains('Delete')").toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        const colors = queryAll(".o-dropdown--menu .o_kanban_colorpicker button");
        expect(colors.length).toBeGreaterThan(1);
        for (const color of colors) {
            expect(color).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
            expect(color).toBeEnabled();
        }
        // Picking a color queues a `web_save` of `color`.
        await contains(".o-dropdown--menu .o_kanban_colorpicker button:eq(2)").click();
        expect.verifySteps(["crm.lead/web_save"]);
        const colorSave = queuedCalls("crm.lead", "web_save").find(({ args }) => args[0][0] === 2);
        expect(colorSave.args[1]).toEqual({ color: 2 });
        // Deleting, once confirmed, queues a `web_unlink`.
        await contains(toggler).click();
        await contains(".o-dropdown--menu a:contains('Delete')").click();
        await contains(".modal-footer .btn-danger:contains('Delete')").click();
        expect.verifySteps(["crm.lead/web_unlink"]);
        expect(queuedCalls("crm.lead", "web_unlink").map(({ args }) => args)).toEqual([[[2]]]);
    });

    test("existing controls of other models carry no data-available-offline", async () => {
        await startServer();
        const setOffline = mockOffline();
        keepPingsFailing();
        await mountWithCleanup(WebClient);
        await openView({
            res_model: "res.partner",
            res_id: serverState.partnerId,
            views: [[false, "form"]],
            arch: /* xml */ `
                <form>
                    <field name="name"/>
                    <field name="email" widget="email"/>
                    <field name="phone" widget="phone"/>
                    <field name="parent_id"/>
                </form>`,
        });
        await contains(".o_field_widget[name=email] input").edit("admin@example.com");
        await contains(".o_field_widget[name=phone] input").edit("+32 555 99");
        if (!isSmall()) {
            await contains(".o_field_widget[name=parent_id] input").click();
            expect(".o-autocomplete--dropdown-item").not.toHaveCount(0);
            for (const suggestion of queryAll(".o-autocomplete--dropdown-item")) {
                expect(suggestion).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
                expect(suggestion.firstElementChild).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
            }
        }
        await setOffline(true);
        for (const selector of [
            ".o_field_widget[name=name] input",
            ".o_field_widget[name=email] input",
            ".o_field_widget[name=email] a[href^='mailto:']",
            ".o_field_widget[name=phone] input",
            ".o_field_widget[name=phone] .o_phone_form_link",
            ".o_field_widget[name=parent_id] input",
        ]) {
            expect(selector).not.toHaveCount(0, { message: selector });
            for (const el of queryAll(selector)) {
                expect(el).not.toHaveAttribute(OFFLINE_ATTRIBUTE, null, { message: selector });
            }
        }
        // On small screens the partner field of another model keeps the search-dialog input.
        if (isSmall()) {
            expect(".o_field_widget[name=parent_id] input").toHaveAttribute("readonly");
        }
    });

    test("html field editor: the lead notes editable is marked usable offline, other models' are not", async () => {
        const pyEnv = await startServer();
        pyEnv["crm.lead"].write([1], { description: "<p>Met at the fair</p>" });
        pyEnv["res.partner"].write([serverState.partnerId], { comment: "<p>Prefers email</p>" });
        const setOffline = mockOffline();
        keepPingsFailing();
        const htmlFields = captureInstances(HtmlField);
        await mountWithCleanup(WebClient);
        /**
         * @param {string} resModel
         * @param {string} fieldName
         * @returns {HTMLElement} the editable of the one mounted html field `resModel.fieldName`
         */
        const editableOf = (resModel, fieldName) => {
            const mounted = htmlFields.filter(
                (field) => field.props.record.resModel === resModel && status(field) === "mounted"
            );
            expect(mounted).toHaveLength(1, { message: `one mounted ${resModel} html field` });
            const rendered = queryOne(
                `.o_field_widget[name=${fieldName}] [contenteditable='true']`
            );
            expect(mounted[0].editor.editable).toBe(rendered, {
                message: `${resModel}: the editor's editable is the rendered one`,
            });
            return rendered;
        };

        // A lead's notes: marked once the editor is loaded, and still editable offline.
        await openView({
            res_model: "crm.lead",
            res_id: 1,
            views: [[false, "form"]],
            arch: /* xml */ `
                <form>
                    <sheet>
                        <field name="name"/>
                        <field name="description"/>
                    </sheet>
                </form>`,
        });
        await mailContains(".o_field_widget[name=description] [contenteditable='true']");
        const leadEditable = editableOf("crm.lead", "description");
        expect(leadEditable).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        await setOffline(true);
        expect(leadEditable).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        expect(leadEditable).toHaveAttribute("contenteditable", "true");
        expect(leadEditable).toHaveText("Met at the fair");
        await setOffline(false);

        // A partner's notes: the same html field, never marked.
        await openView({
            res_model: "res.partner",
            res_id: serverState.partnerId,
            views: [[false, "form"]],
            arch: /* xml */ `
                <form>
                    <sheet>
                        <field name="name"/>
                        <field name="comment"/>
                    </sheet>
                </form>`,
        });
        await mailContains(".o_field_widget[name=comment] [contenteditable='true']");
        const partnerEditable = editableOf("res.partner", "comment");
        expect(partnerEditable).toHaveText("Prefers email");
        expect(partnerEditable).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
        await setOffline(true);
        expect(partnerEditable).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
    });
});

// -----------------------------------------------------------------------------
// Unreachable offline: forecast and activity report
// -----------------------------------------------------------------------------

describe("Unreachable views", () => {
    test.tags("desktop");
    test("forecast and activity report never registered as available offline", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        mockViewButtonActions();
        const listControllers = captureInstances(ListController);
        await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await getService("action").doAction(FORECAST_ACTION_ID);
        await getService("action").switchView("list");
        await getService("action").doAction(ACTIVITY_REPORT_ACTION_ID);
        await animationFrame();
        // Online, an activity report row opens its lead through the server.
        await contains(".o_data_row .o_data_cell").click();
        expect.verifySteps(["doActionButton:action_open_lead"]);

        await setOffline(true);
        await visitedReady();
        const offline = getService(OfflinePlugin);
        // The pipeline visited online is available offline; the forecast and report are not.
        expect(offline.isAvailableOffline(PIPELINE_ACTION_ID)).toBe(true);
        expect(offline.isAvailableOffline(PIPELINE_ACTION_ID, "kanban")).toBe(true);
        expect(offline.isAvailableOffline(FORECAST_ACTION_ID)).toBe(false);
        expect(offline.isAvailableOffline(FORECAST_ACTION_ID, "kanban")).toBe(false);
        expect(offline.isAvailableOffline(FORECAST_ACTION_ID, "list")).toBe(false);
        expect(offline.isAvailableOffline(ACTIVITY_REPORT_ACTION_ID)).toBe(false);
        expect(offline.isAvailableOffline(ACTIVITY_REPORT_ACTION_ID, "list")).toBe(false);
        // A report row left on screen does not reach the server either, clicked or opened
        // directly.
        await contains(".o_data_row .o_data_cell").click();
        const reportController = listControllers.findLast(
            ({ props }) => props.resModel === "crm.activity.report"
        );
        await reportController.openRecord(reportController.model.root.records[0]);
        await animationFrame();
        expect.verifySteps([]);
    });
});

// -----------------------------------------------------------------------------
// PART 3c: partner lookup from the relational-field cache
// -----------------------------------------------------------------------------

describe("Partner lookup", () => {
    test("partner many2one: offline search from cache, no create option", async () => {
        await seedLeadCustomer();
        const setOffline = mockOffline();
        keepPingsFailing();
        const many2ones = captureInstances(Many2One);
        await mountWithCleanup(WebClient);
        await getService("action").doAction(LEAD_FORM_ACTION_ID);
        // The lead form's only many2one on `res.partner` is its customer field.
        const partnerField = () =>
            many2ones.findLast(
                (m2o) => m2o.props.relation === "res.partner" && status(m2o) === "mounted"
            );
        const input = ".o_field_widget[name=partner_id] input";
        const options = ".o_field_widget[name=partner_id] .o-autocomplete--dropdown-item";
        // Online, the framework's autocomplete props are unchanged on every screen size.
        expect("dropdown" in partnerField().many2XAutocompleteProps).toBe(false);
        if (isSmall()) {
            // Online, small screens use the read-only input that opens the search dialog.
            expect(input).toHaveAttribute("readonly");
        } else {
            // Online, the search reaches the server and offers to create.
            await contains(input).click();
            expect(queryAllTexts(options)).toInclude("Search more...");
            await contains(".o_form_renderer").click();
        }

        await setOffline(true);
        // Offline, small screens render the autocomplete inline (`dropdown: false`); large screens
        // keep the framework's props, whose autocomplete already searches the cache.
        if (isSmall()) {
            expect(partnerField().many2XAutocompleteProps.dropdown).toBe(false);
        } else {
            expect("dropdown" in partnerField().many2XAutocompleteProps).toBe(false);
        }
        // Offline, on every screen size, the autocomplete searches the cached partners.
        expect(input).not.toHaveAttribute("readonly");
        await contains(input).edit("Azure", { confirm: false });
        await runAllTimers();
        const optionTexts = queryAllTexts(options);
        expect(optionTexts).toEqual(["Azure Interior"]);
        for (const forbidden of ["Create", "Create and edit...", "Search more..."]) {
            expect(optionTexts.some((option) => option.startsWith(forbidden))).toBe(false, {
                message: forbidden,
            });
        }
        await contains(`${options}:contains('Azure Interior') > *`).click();
        expect(input).toHaveValue("Azure Interior");
        if (isSmall()) {
            // Text typed but not selected makes the field float, which hides its open-record
            // button; switching back to the search-dialog input discards that text.
            await contains(input).edit("Deco", { confirm: false });
            await runAllTimers();
            expect(partnerField().state.isFloating).toBe(true);
        }

        await setOffline(false);
        expect("dropdown" in partnerField().many2XAutocompleteProps).toBe(false);
        if (isSmall()) {
            expect(input).toHaveAttribute("readonly");
            expect(input).toHaveValue("Azure Interior");
            expect(partnerField().state.isFloating).toBe(false);
            expect(".o_field_widget[name=partner_id] .o_external_button").toHaveCount(1);
        } else {
            expect(input).not.toHaveAttribute("readonly");
        }
    });
});

// -----------------------------------------------------------------------------
// PART 3a: stages and teams through the framework queue
// -----------------------------------------------------------------------------

/**
 * Lets the framework replay the queue: it waits one second between two replayed calls.
 *
 * @param {number} count number of queued calls
 */
async function letQueueReplay(count) {
    for (let index = 0; index < count; index++) {
        await animationFrame();
        await advanceTime(1000);
    }
    await animationFrame();
}

/**
 * Deep copy of an ORM call: a queued value, or the params of a call the mock server received.
 * The queue is persisted and reloaded as JSON before its replay, so a JSON copy is exactly what
 * `OfflinePlugin._syncORM` sends, and it no longer changes with the live queue.
 *
 * @param {{ model: string, method: string, args: any[], kwargs: Object }} call
 * @returns {{ model: string, method: string, args: any[], kwargs: Object }}
 */
function copyOrmCall({ model, method, args, kwargs }) {
    return JSON.parse(JSON.stringify({ model, method, args, kwargs }));
}

describe("Stage and team coverage", () => {
    test.tags("desktop");
    test("crm.stage and crm.team: offline create and edit queue client-resolved web_save and replay", async () => {
        // Offline, the framework serves the visited views from its disk cache and its
        // background refresh of each one fails with a `ConnectionLostError`: the new-record
        // onchange, the list and the existing record, per model.
        expect.errors(6);
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.stage/web_save", "crm.team/web_save"]);
        // Online calls only: the replayed ones.
        const serverCalls = [];
        onRpc("web_save", ({ model, method, args, kwargs }) => {
            serverCalls.push(copyOrmCall({ model, method, args, kwargs }));
            expect.step(`replayed ${model}: ${JSON.stringify(args)}`);
        });
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // `createValues` is every value the new-record form sends: the name typed, and the
        // defaults of the other fields of its view.
        const cases = [
            {
                actionId: STAGE_ACTION_ID,
                model: "crm.stage",
                existing: { id: 1, name: "New" },
                created: "Offline Stage",
                createValues: { name: "Offline Stage", sequence: 1 },
                renamed: "Offline Stage Renamed",
            },
            {
                actionId: TEAM_ACTION_ID,
                model: "crm.team",
                existing: { id: 1, name: "Mushroom Kingdom" },
                created: "Offline Team",
                createValues: { name: "Offline Team" },
                renamed: "Offline Team Renamed",
            },
        ];
        for (const { actionId, model, existing, created, createValues, renamed } of cases) {
            // Online: the list, an existing record and a new record are visited (cached).
            await getService("action").doAction(actionId);
            await contains(`.o_data_row .o_data_cell:contains('${existing.name}')`).click();
            await contains(".o_breadcrumb .o_back_button").click();
            await contains(".o_list_button_add").click();
            await contains(".o_form_button_cancel").click();
            expect(".o_list_view").toHaveCount(1);

            await setOffline(true);
            await visitedReady();
            // Create.
            await contains(".o_list_button_add").click();
            await contains(".o_field_widget[name=name] input").edit(created);
            await contains(".o_form_button_save").click();
            expect(".o_field_widget[name=name] input").toHaveValue(created);
            await contains(".o_breadcrumb .o_back_button").click();
            // Edit.
            await contains(`.o_data_row .o_data_cell:contains('${existing.name}')`).click();
            await contains(".o_field_widget[name=name] input").edit(renamed);
            await contains(".o_form_button_save").click();
            expect(".o_field_widget[name=name] input").toHaveValue(renamed);
            expect.verifySteps([`${model}/web_save`, `${model}/web_save`]);
            await expect.waitForErrors([
                `${model}/onchange`,
                `${model}/web_search_read`,
                `${model}/web_read`,
            ]);

            // Both writes are queued with client-resolved arguments only. `Record._offlineSave`
            // stores the record's context, here the user context alone since the action has
            // none, and an empty specification.
            const saves = queuedCalls(model, "web_save").sort(
                (a, b) => a.extras.timeStamp - b.extras.timeStamp
            );
            expect(saves).toHaveLength(2);
            const queued = saves.map(copyOrmCall);
            const kwargs = { context: user.context, specification: {} };
            expect(queued).toEqual([
                { model, method: "web_save", args: [[], createValues], kwargs },
                { model, method: "web_save", args: [[existing.id], { name: renamed }], kwargs },
            ]);
            const replayedArgs = saves.map(({ args }) => JSON.stringify(args));
            // The optimistic names: the breadcrumb shows the server-computed `display_name`,
            // which only the replay recomputes, so offline the queued writes are listed under
            // the names the user entered in the offline systray.
            expect(saves.map(({ extras }) => extras.displayName)).toEqual([created, renamed]);
            await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
            const systrayTexts = queryAllTexts(".o-dropdown--menu .o_offline_systray_content div");
            for (const text of [created, "Created", renamed, "Edited"]) {
                expect(systrayTexts).toInclude(text);
            }
            await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();

            // Back online, the server receives the same calls, in order.
            await setOffline(false);
            await letQueueReplay(2);
            expect.verifySteps(
                replayedArgs.flatMap((args) => [`${model}/web_save`, `replayed ${model}: ${args}`])
            );
            // Each replayed call is the stored one, kwargs included: the ORM merges the user
            // context under the stored context, which already holds it.
            expect(serverCalls.splice(0)).toEqual(queued);
            expect(queuedEntries()).toHaveLength(0);
            const serverRecords = MockServer.env[model].search_read([], ["name"]);
            expect(serverRecords.map(({ name }) => name)).toInclude(created);
            expect(serverRecords.find(({ id }) => id === existing.id).name).toBe(renamed);
            // Once replayed, both records carry their new names, breadcrumb included. The
            // created name is a prefix of the renamed one, so rows are matched on their exact text.
            await contains(".o_breadcrumb .o_back_button").click();
            for (const name of [created, renamed]) {
                await contains(`.o_data_row .o_data_cell:text('${name}')`).click();
                expect(".o_breadcrumb .active").toHaveText(name);
                await contains(".o_breadcrumb .o_back_button").click();
            }
        }
    });
});

// -----------------------------------------------------------------------------
// Gate 8: queue semantics are the framework's (order, last write wins, parking)
// -----------------------------------------------------------------------------

/** Opens the pipeline and one lead form online, so both are available offline. */
async function visitPipelineAndLead(leadName) {
    await getService("action").doAction(PIPELINE_ACTION_ID);
    await contains(`.o_kanban_record:contains('${leadName}')`).click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_kanban_view").toHaveCount(1);
}

/** The context of the Pipeline action, as `defineActions` gives it above. */
const PIPELINE_ACTION_CONTEXT = {
    show_team_switcher: true,
    show_lead_gen_button: true,
    default_type: "opportunity",
};

describe("Queue semantics", () => {
    test.tags("desktop");
    test("two separate offline writes to the same lead field replay in timestamp order; the later value wins; no dialog", async () => {
        // Offline, the background refresh of the cached lead form, team switcher data and
        // pipeline groups fails with a `ConnectionLostError`, as the framework does.
        expect.errors(3);
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/web_save"]);
        const serverCalls = [];
        onRpc("crm.lead", "web_save", ({ model, method, args, kwargs }) => {
            serverCalls.push(copyOrmCall({ model, method, args, kwargs }));
            expect.step(`replayed priority ${args[1].priority}`);
        });
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await visitPipelineAndLead("Lead 1");

        await setOffline(true);
        await visitedReady();
        // K1: the lead form sets priority 1.
        await contains(".o_kanban_record:contains('Lead 1')").click();
        await contains(".o_field_widget[name=priority] .o_priority_star:eq(0)").click();
        await contains(".o_form_button_save").click();
        await advanceTime(5000);
        // K2: back on the kanban, rebuilt from its cache, the card sets priority 3.
        await contains(".o_breadcrumb .o_back_button").click();
        await contains(".o_kanban_record:contains('Lead 1') .o_priority_star:eq(2)").click();
        expect.verifySteps(["crm.lead/web_save", "crm.lead/web_save"]);
        await expect.waitForErrors([
            "crm.lead/web_read",
            "crm.team/get_team_switcher_data",
            "crm.lead/web_read_group",
        ]);

        const [k1, k2] = queuedEntries().sort(
            (a, b) => a.value.extras.timeStamp - b.value.extras.timeStamp
        );
        expect(queuedEntries()).toHaveLength(2);
        expect(k1.key).not.toBe(k2.key);
        expect(k1.value.extras.timeStamp).toBeLessThan(k2.value.extras.timeStamp);
        expect(k1.value.extras.viewType).toBe("form");
        expect(k2.value.extras.viewType).toBe("kanban");
        // Each record stores its own context: the form's is the user context with the
        // action's; the card's adds the CRM search context (`team_switcher_enabled`) and the
        // `default_stage_id` of its stage group.
        const formContext = { ...user.context, ...PIPELINE_ACTION_CONTEXT };
        const queued = [k1, k2].map(({ value }) => copyOrmCall(value));
        expect(queued).toEqual([
            {
                model: "crm.lead",
                method: "web_save",
                args: [[1], { priority: "1" }],
                kwargs: { context: formContext, specification: {} },
            },
            {
                model: "crm.lead",
                method: "web_save",
                args: [[1], { priority: "3" }],
                kwargs: {
                    context: { ...formContext, team_switcher_enabled: true, default_stage_id: 1 },
                    specification: {},
                },
            },
        ]);

        // Reconnect: K1 then K2 reach the server, the later value wins, nothing asks the user.
        await setOffline(false);
        await letQueueReplay(2);
        expect.verifySteps([
            "crm.lead/web_save",
            "replayed priority 1",
            "crm.lead/web_save",
            "replayed priority 3",
        ]);
        // The server receives the stored calls, kwargs included, in that order.
        expect(serverCalls).toEqual(queued);
        expect(MockServer.env["crm.lead"].browse(1)[0].priority).toBe("3");
        expect(queuedEntries()).toHaveLength(0);
        expect(".modal").toHaveCount(0);
    });

    test.tags("desktop");
    test("offline saves of one lead form coalesce into one entry", async () => {
        // Offline, the background refresh of the cached lead form (opened twice), team
        // switcher data and pipeline groups fails with a `ConnectionLostError`.
        expect.errors(4);
        const setOffline = mockOffline();
        keepPingsFailing();
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await visitPipelineAndLead("Lead 1");

        await setOffline(true);
        await visitedReady();
        await contains(".o_kanban_record:contains('Lead 1')").click();
        await contains(".o_field_widget[name=priority] .o_priority_star:eq(0)").click();
        await contains(".o_form_button_save").click();
        expect(queuedEntries()).toHaveLength(1);
        const [{ key, value: first }] = queuedEntries();
        // Every save stores the whole call again: the form record's context (the user context
        // with the action's) and an empty specification, next to the last values.
        const leadFormSave = (priority) => ({
            model: "crm.lead",
            method: "web_save",
            args: [[1], { priority }],
            kwargs: {
                context: { ...user.context, ...PIPELINE_ACTION_CONTEXT },
                specification: {},
            },
        });
        expect(copyOrmCall(first)).toEqual(leadFormSave("1"));

        await advanceTime(5000);
        await contains(".o_field_widget[name=priority] .o_priority_star:eq(1)").click();
        await contains(".o_form_button_save").click();
        expect(queuedEntries()).toHaveLength(1);
        expect(queuedEntries()[0].key).toBe(key);
        expect(queuedEntries()[0].value.extras.timeStamp).toBe(first.extras.timeStamp);
        expect(copyOrmCall(queuedEntries()[0].value)).toEqual(leadFormSave("2"));

        // Back to the pipeline, the lead form is reopened: it adopts the queued entry.
        await advanceTime(5000);
        await contains(".o_breadcrumb .o_back_button").click();
        await contains(".o_kanban_record:contains('Lead 1')").click();
        expect(".o_field_widget[name=priority] .o_priority_star.oi-filled").toHaveCount(2);
        await contains(".o_field_widget[name=priority] .o_priority_star:eq(2)").click();
        await contains(".o_form_button_save").click();
        expect(queuedEntries()).toHaveLength(1);
        const [entry] = queuedEntries();
        expect(entry.key).toBe(key);
        expect(entry.value.extras.timeStamp).toBe(first.extras.timeStamp);
        expect(entry.value.extras.viewType).toBe("form");
        expect(copyOrmCall(entry.value)).toEqual(leadFormSave("3"));
        await expect.waitForErrors([
            "crm.lead/web_read",
            "crm.team/get_team_switcher_data",
            "crm.lead/web_read_group",
            "crm.lead/web_read",
        ]);
    });

    test.tags("desktop");
    test("rejected replay parked in systray, no CRM error UI", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const serverCalls = [];
        onRpc("crm.lead", "web_save", ({ model, method, args, kwargs }) => {
            serverCalls.push(copyOrmCall({ model, method, args, kwargs }));
            expect.step("replay rejected");
            throw makeServerError({ message: "This lead is locked" });
        });
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(LEAD_FORM_ACTION_ID);

        await setOffline(true);
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (offline)");
        await contains(".o_form_button_save").click();
        expect(queuedEntries()).toHaveLength(1);
        // The stored call: the form record's context, the user context alone since the action
        // has none, and an empty specification.
        const [queued] = queuedEntries().map(({ value }) => copyOrmCall(value));
        expect(queued).toEqual({
            model: "crm.lead",
            method: "web_save",
            args: [[1], { name: "Lead 1 (offline)" }],
            kwargs: { context: user.context, specification: {} },
        });

        await setOffline(false);
        await letQueueReplay(1);
        expect.verifySteps(["replay rejected"]);
        // The server received the stored call, kwargs included, and rejected it.
        expect(serverCalls).toEqual([queued]);
        // The call stays in the queue, parked with the server error, and is not retried.
        const [parked] = queuedEntries();
        expect(queuedEntries()).toHaveLength(1);
        expect(copyOrmCall(parked.value)).toEqual(queued);
        expect(parked.value.extras.error).toMatch(/This lead is locked/);
        expect(".o_menu_systray .o_offline_systray").toHaveText("Sync issues");
        expect(".o_menu_systray .o_offline_systray [data-icon='error']").toHaveCount(1);
        await letQueueReplay(2);
        expect.verifySteps([]);
        // The framework systray is the only error UI: no CRM notification, no dialog.
        expect(".o_notification").toHaveCount(0);
        expect(".modal").toHaveCount(0);
    });
});
