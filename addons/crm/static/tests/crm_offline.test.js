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
 * - The mock models these tests add (the CRM models and the others their views need) are local
 *   to this file. The shared fixture of `defineCrmModels()` (the shared mail mocks plus the CRM
 *   helper's `crm.lead`, which the local lead model completes) is reused, and the shared
 *   `MailActivity` mock only gets a local form view, set the way the mail tests configure it. No
 *   existing test helper is modified.
 * - Offline state is driven only through the offline plugin (`mockOffline()` and
 *   `getService(OfflinePlugin)`).
 * - "Inert" always means: no RPC (stepped by a route watcher registered after `mockOffline()`, so
 *   that it sees the requests the offline mock answers with a 502), no record save, no dialog and
 *   no action. Hoot fails a test on any undeclared error, which is how "no uncaught error" is
 *   asserted. Two kinds of error are declared: those the framework itself produces offline (a read
 *   served from the framework RPC cache while offline still tries the server in the background,
 *   and that refresh rejects with a `ConnectionLostError` nobody awaits; a request in flight when
 *   the connection drops rejects the same way, and the framework's lost-connection handler
 *   silences it in production), and server rejections a test simulates on purpose to check that
 *   they reach the framework unchanged (a group probe and a module lookup the server refuses).
 */

import {
    advanceTime,
    animationFrame,
    beforeEach,
    describe,
    expect,
    mockTouch,
    mockUserAgent,
    queryAll,
    queryAllTexts,
    queryFirst,
    queryOne,
    runAllTimers,
    test,
} from "@odoo/hoot";
import { pointerDown, press, rightClick } from "@odoo/hoot-dom";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";
import {
    click as mailClick,
    contains as mailContains,
    dragenterFiles,
    dropFiles,
    hover,
    insertText,
    listenStoreFetch,
    mailModels,
    openFormView,
    openView,
    pasteFiles,
    start,
    startServer,
    waitStoreFetch,
} from "@mail/../tests/mail_test_helpers";
import { getPickerCell } from "@web/../tests/core/datetime/datetime_test_helpers";
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
    mountWebClient,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    serverState,
    swipeLeft,
    swipeRight,
    toggleActionMenu,
    toggleKanbanRecordDropdown,
    toggleMenuItem,
} from "@web/../tests/web_test_helpers";
import { Component, status, useProps, xml } from "@odoo/owl";

import {
    CRM_FOREIGN_DISABLED_BUTTONS,
    CRM_MAIL_FORM_TARGETS,
    CRM_OFFLINE_DISABLED_SELECTORS,
    CRM_OFFLINE_MODELS,
    isOfflineModel,
    loadActivityTypes,
    loadLeadActivities,
    targetsCrmLead,
    useCrmOffline,
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
import { Message } from "@mail/core/common/message";
import { MessageAction } from "@mail/core/common/message_actions";
import { MessageDeleteDialog } from "@mail/core/common/message_delete_dialog";
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
import { RottingStatusBarDurationField } from "@mail/js/rotting_mixin/rotting_statusbar";
import { LONG_PRESS_DELAY } from "@mail/utils/common/hooks";
import { AutoComplete } from "@web/core/autocomplete/autocomplete";
import { browser } from "@web/core/browser/browser";
import { NonSecureContextError } from "@web/core/errors/non_secure_context_error";
import { serializeDate, today } from "@web/core/l10n/dates";
import { ConnectionLostError, RPCError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { redirect } from "@web/core/utils/urls";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { computeM2OProps, Many2One } from "@web/views/fields/many2one/many2one";
import {
    buildM2OFieldDescription,
    many2OneFieldProps,
} from "@web/views/fields/many2one/many2one_field";
import { StatusBarField } from "@web/views/fields/statusbar/statusbar_field";
import { FormController } from "@web/views/form/form_controller";
import { KanbanController } from "@web/views/kanban/kanban_controller";
import { KanbanRecord } from "@web/views/kanban/kanban_record";
import { KanbanRenderer } from "@web/views/kanban/kanban_renderer";
import { ListController } from "@web/views/list/list_controller";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { MultiRecordViewButton } from "@web/views/view_button/multi_record_view_button";
import { ViewButton } from "@web/views/view_button/view_button";
import { ShareTargetItem } from "@web/webclient/share_target/share_target_item";
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
 * offline plugin reports offline, except the plugin's own reconnection pings. Registered after
 * `mockOffline()`, the watcher sees the requests the offline mock answers with a 502: a DISABLE
 * guard that lets anything reach the network is caught. A lead many2one that switches to its
 * cached autocomplete offline on small screens searches only once the user opens it, so a lead
 * form left untouched issues no request either.
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
    is_auto_campaign = fields.Boolean();

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

/**
 * CRM settings block (inventory B30 to B32). Its buttons are named as in the production settings
 * view, the action buttons by xmlid, which the lane-1 `test_offline_availability_view_wiring`
 * asserts against `crm.res_config_settings_view_form`.
 */
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

/**
 * Lead form mirroring `crm_lead_view_form` (header, smart buttons, PLS controls, fields). Its name
 * is a `widget="text"` field as in production, so the `web.TextField` extension renders it; the
 * production arch's widget is asserted by the lane-1 `test_offline_availability_view_wiring`.
 */
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
            <field class="text-break" options="{'line_breaks': False}" widget="text" name="name"/>
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

/**
 * Lead form with the customer and salesperson many2one fields, each with an onchange as in
 * `crm_lead_view_form`, for the offline partner lookup (PART 3c).
 */
const LEAD_LOOKUP_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="partner_id" on_change="1"/>
            <field name="user_id" on_change="1"/>
        </sheet>
    </form>`;

/**
 * Lead form whose customer field has an extra suggestion source, as `crm_lead_view_form` renders
 * it with the partner autocomplete's `res_partner_many2one` widget (see
 * `ExtraSourceMany2OneField`).
 */
const LEAD_EXTRA_SOURCE_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="partner_id" widget="crm_offline_test_extra_source_many2one"/>
        </sheet>
    </form>`;

/**
 * Pipeline kanban mirroring `crm_case_kanban_view_leads` (card menu, color, priority). The
 * card-menu Edit and Delete anchors repeat the production arch's offline attribute, so the tests
 * prove only that the card compiler copies it onto the rendered anchors; the production arch's
 * values are asserted by the lane-1 `test_offline_availability_view_wiring`.
 */
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

/**
 * The same pipeline kanban with the production arch's `js_class` and classes: the CRM offline
 * styles of unavailable cards are scoped to `o_opportunity_kanban`.
 */
const PIPELINE_KANBAN_ARCH = LEAD_KANBAN_ARCH.replace(
    '<kanban js_class="crm_kanban"',
    '<kanban js_class="crm_mobile_pipeline" class="o_kanban_small_column o_opportunity_kanban"'
);

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

/**
 * Bound actions of `crm.lead` reached through the Actions menu (inventory D13 to D17), in
 * inventory order, each bound to the view types the server binds it to.
 */
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
        id: 105,
        xml_id: "crm.action_lead_mass_mail",
        name: "Send email",
        res_model: "mail.compose.message",
        type: "ir.actions.act_window",
        target: "new",
        views: [[false, "form"]],
        context: { default_composition_mode: "mass_mail" },
        binding_view_types: "list,kanban",
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
        "form,lead_lookup": LEAD_LOOKUP_FORM_ARCH,
        "form,lead_extra_source": LEAD_EXTRA_SOURCE_FORM_ARCH,
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
        // As on the server, a bound action is listed only in the views of its
        // `binding_view_types`; the mock server lists every one in every view.
        for (const [viewType, view] of Object.entries(result.views)) {
            if (view.toolbar?.action) {
                view.toolbar = {
                    ...view.toolbar,
                    action: view.toolbar.action.filter(
                        ({ binding_view_types }) =>
                            !binding_view_types || binding_view_types.split(",").includes(viewType)
                    ),
                };
            }
        }
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
const LEAD_LOOKUP_ACTION_ID = 10;
const LEAD_EXTRA_SOURCE_ACTION_ID = 11;

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
    {
        id: LEAD_LOOKUP_ACTION_ID,
        name: "Lead lookup",
        res_model: "crm.lead",
        res_id: 1,
        type: "ir.actions.act_window",
        views: [["lead_lookup", "form"]],
    },
    {
        id: LEAD_EXTRA_SOURCE_ACTION_ID,
        name: "Lead extra source",
        res_model: "crm.lead",
        res_id: 1,
        type: "ir.actions.act_window",
        views: [["lead_extra_source", "form"]],
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

describe("Email and phone copy", () => {
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
    test("offline kanban stage move of a card not visited online: the drop goes through and is queued", async () => {
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        keepPingsFailing();
        // No lead form was visited online: offline, the framework marks every card unavailable.
        // The card button stands for the production card's activity and avatar buttons, which the
        // framework disables offline as well.
        await mountView({
            type: "kanban",
            resModel: "crm.lead",
            groupBy: ["stage_id"],
            arch: PIPELINE_KANBAN_ARCH.replace(
                "</footer>",
                /* xml */ `
                    <button name="action_schedule_meeting" type="object"
                        class="btn btn-link o_crm_card_control">Meeting</button>
                </footer>`
            ),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect(".o_opportunity_kanban").toHaveCount(1);
        expect(".o_kanban_group:eq(0) .o_kanban_record").toHaveCount(2);
        expect(".o_kanban_group:eq(2) .o_kanban_record").toHaveCount(1);

        await setOffline(true);
        const card = queryFirst(".o_kanban_group:eq(0) .o_kanban_record");
        expect(card).toHaveText(/Lead 1/);
        expect(card).toHaveClass("o_disabled_offline");
        const cardControl = queryOne(".o_crm_card_control", { root: card });
        expect(isDisabledOffline(cardControl)).toBe(true);
        expect(getComputedStyle(cardControl).pointerEvents).toBe("auto");
        const { drop, moveTo } = await contains(card).drag();
        await moveTo(".o_kanban_group:eq(2) .o_kanban_record");
        // While dragged, the card and the controls disabled in it let the pointer through to the
        // column under it: a real pointer would otherwise keep hitting the card, and the column
        // would never be entered.
        expect(card).toHaveClass(["o_dragged", "o_disabled_offline"]);
        expect(getComputedStyle(card).pointerEvents).toBe("none");
        expect(getComputedStyle(cardControl).pointerEvents).toBe("none");
        expect(".o_kanban_group:eq(2)").toHaveClass("o_kanban_hover");
        // The drag placeholder, a copy of the card's element and classes, keeps its ghost opacity.
        const placeholder = queryOne(".o_kanban_group:eq(2) .o_kanban_record.opacity-50");
        expect(placeholder).toHaveClass("o_disabled_offline");
        expect(getComputedStyle(placeholder).opacity).toBe("0.5");
        await drop();
        await animationFrame();

        expect.verifySteps(["crm.lead/web_save"]);
        expect(".o_kanban_group:eq(0) .o_kanban_record").toHaveCount(1);
        expect(".o_kanban_group:eq(2) .o_kanban_record").toHaveCount(2);
        expect(".o_kanban_group:eq(2) .o_kanban_record:contains('Lead 1')").toHaveCount(1);
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

/**
 * Hotkeys (`alt+<key>`) of the lead form header buttons, as in the production arch: Won, Convert,
 * Restore and Lost. The meeting and duplicates smart buttons, the blacklist buttons and the
 * probability anchors have none.
 */
const LEAD_HEADER_HOTKEYS = {
    w: "action_set_won_rainbowman",
    v: "action_convert_to_opportunity",
    x: "action_restore",
    l: "crm.crm_lead_lost_action",
};

/**
 * Presses Enter and Space on the element that has the keyboard focus, as a keyboard user
 * activating a control would.
 */
async function pressEnterAndSpace() {
    for (const key of ["Enter", " "]) {
        await press(key);
        await animationFrame();
    }
}

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

/**
 * Makes the visits of a test that happen before the returned function is called belong to an
 * earlier session, as when the page is reloaded afterwards: `user.hasGroup(group)` answers them
 * `true` itself, so neither the session's group cache nor the RPC cache holds an answer for
 * `group` once the current session starts. Every call made while the client is offline is stepped
 * as `"hasGroup while offline:<group>"`.
 *
 * @param {string} group
 * @returns {() => void} starts the current session
 */
function visitInEarlierSession(group) {
    let earlierSession = true;
    patchWithCleanup(user, {
        hasGroup(probedGroup) {
            if (probedGroup === group) {
                if (getService(OfflinePlugin).isOffline()) {
                    expect.step(`hasGroup while offline:${group}`);
                }
                if (earlierSession) {
                    return Promise.resolve(true);
                }
            }
            return super.hasGroup(...arguments);
        },
    });
    return () => {
        earlierSession = false;
    };
}

/**
 * Holds the next group probe request for `group`, as a request still in flight, until the
 * returned function answers it with the given response (a 502 is the connection lost during the
 * call). Registered before `watchGroupProbes()`, so the watcher still steps the held request.
 *
 * @param {string} group
 * @returns {(response: Response) => void}
 */
function holdGroupProbe(group) {
    const held = Promise.withResolvers();
    let holding = true;
    onRpc("/web/dataset/call_kw/res.users/has_group", async (request) => {
        const { params } = await request.clone().json();
        if (holding && params.args[1] === group) {
            holding = false;
            return held.promise;
        }
    });
    return held.resolve;
}

/**
 * The seven `type="action"` anchors of the team dashboard card menu (inventory B23 to B29), named
 * by xmlid as in the dashboard card fixture.
 */
const TEAM_MENU_ACTION_NAMES = [
    "crm.crm_case_form_view_salesteams_lead",
    "crm.crm_case_form_view_salesteams_opportunity",
    "crm.crm_lead_action_open_lead_form",
    "crm.action_opportunity_form",
    "crm.action_report_crm_lead_salesteam",
    "crm.action_report_crm_opportunity_salesteam",
    "crm.crm_activity_report_action_team",
];

/**
 * Team dashboard kanban with the production card menu: its View, New and Reporting sections of
 * action anchors, and the Configuration entry (`type="open"`), which opens the cached team form
 * and stays usable offline.
 */
const TEAM_DASHBOARD_MENU_ARCH = /* xml */ `
    <kanban class="o_crm_team_kanban" action="action_primary_channel_button" type="object">
        <templates>
            <t t-name="menu">
                <div class="container">
                    <div class="row">
                        <div name="manage_view" class="col-5">
                            <h5 role="menuitem" class="o_kanban_card_manage_title">
                                <span>View</span>
                            </h5>
                            <div>
                                <a name="crm.crm_case_form_view_salesteams_lead" type="action">Leads</a>
                            </div>
                            <div>
                                <a name="crm.crm_case_form_view_salesteams_opportunity" type="action">Opportunities</a>
                            </div>
                        </div>
                        <div name="manage_new" class="col-5">
                            <h5 role="menuitem" class="o_kanban_card_manage_title">
                                <span>New</span>
                            </h5>
                            <div>
                                <a name="crm.crm_lead_action_open_lead_form" type="action">Leads</a>
                            </div>
                            <div>
                                <a name="crm.action_opportunity_form" type="action">Opportunity</a>
                            </div>
                        </div>
                        <div name="manage_reports" class="col-5">
                            <h5 role="menuitem" class="o_kanban_card_manage_title">
                                <span>Reporting</span>
                            </h5>
                            <div>
                                <a name="crm.action_report_crm_lead_salesteam" type="action">Leads</a>
                            </div>
                            <div>
                                <a name="crm.action_report_crm_opportunity_salesteam" type="action">Opportunities</a>
                            </div>
                            <div name="o_team_kanban_report_separator"></div>
                            <div>
                                <a name="crm.crm_activity_report_action_team" type="action">Activities</a>
                            </div>
                        </div>
                    </div>
                    <div class="o_kanban_card_manage_settings row">
                        <div role="menuitem" class="col-4">
                            <a class="dropdown-item" type="open">Configuration</a>
                        </div>
                    </div>
                </div>
            </t>
            <t t-name="card">
                <field name="name"/>
            </t>
        </templates>
    </kanban>`;

/**
 * Lead form header with the production stage widget, its options and its readonly expression,
 * which covers lost and archived leads only.
 */
const LEAD_STAGE_WIDGET_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <header>
            <field name="stage_id" widget="rotting_statusbar_duration"
                options="{'clickable': '1', 'fold_field': 'fold'}"
                readonly="won_status == 'lost' or not active"/>
        </header>
        <sheet>
            <field name="won_status" invisible="1"/>
            <field name="active" invisible="1"/>
            <field name="is_rotting" invisible="1"/>
            <field name="rotting_days" invisible="1"/>
            <field name="name"/>
        </sheet>
    </form>`;

/**
 * Gives the lead mock, for the current test only, the fields the production stage widget reads,
 * and folds the won stage, so that its option is in the widget's "More..." dropdown on desktop.
 */
function setUpLeadStageWidget() {
    CrmLead._fields.duration_tracking = fields.Json();
    CrmLead._fields.is_rotting = fields.Boolean();
    CrmLead._fields.rotting_days = fields.Integer();
    CrmStage._records[2].fold = true;
}

/**
 * @param {StatusBarField} statusbar
 * @param {string} label
 * @returns {Object | undefined} the statusbar item of the stage labelled `label`
 */
function stageItem(statusbar, label) {
    return statusbar.getAllItems().find((item) => item.label === label);
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
        // Keyboard selection in the open dropdown, as a keyboard user does it: the arrow keys move
        // the focus to the team, and Enter selects it.
        const selectTeamWithKeyboard = async (name) => {
            const items = queryAll(".o_popover .o-dropdown-item");
            for (let index = 0; index <= items.length; index++) {
                if (queryFirst(".o_popover .o-dropdown-item.focus")?.textContent.includes(name)) {
                    break;
                }
                await press("ArrowDown");
                await animationFrame();
            }
            expect(".o_popover .o-dropdown-item.focus").toHaveText(name);
            await press("Enter");
            await animationFrame();
        };

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

        // Keyboard selection in the dropdown left open changes nothing either: Enter on "Hyrule"
        // only closes the dropdown, as any selection does.
        await selectTeamWithKeyboard("Hyrule");
        expect(".o_popover .dropdown-item").toHaveCount(0);
        expect(switcher.selectedTeamId).toBe(1);
        expect(".o_cp_team_switcher").toHaveText("Mushroom Kingdom");
        // The disabled toggle cannot take the keyboard focus, so neither Enter, Space nor the
        // arrow keys open the dropdown again. The toggle has no hotkey (no accesskey and no
        // registered hotkey), so there is no hotkey route to exercise.
        queryOne(".o_cp_team_switcher").focus();
        expect(".o_cp_team_switcher").not.toBeFocused();
        for (const key of ["Enter", " ", "ArrowDown"]) {
            await press(key);
            await animationFrame();
        }
        expect(".o_popover .dropdown-item").toHaveCount(0);
        expect(switcher.selectedTeamId).toBe(1);

        // Back online: "Manage Teams" is offered again from the retained probe answer.
        await setOffline(false);
        expect(".o_cp_team_switcher").not.toHaveAttribute("disabled");
        if (!queryAll(".o_popover .dropdown-item").length) {
            await contains(".o_cp_team_switcher").click();
        }
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(1);
        expect(switcher.isSaleManager).toBe(true);
        // Online, the same keyboard selection switches the team.
        await selectTeamWithKeyboard("Hyrule");
        expect(switcher.selectedTeamId).toBe(2);
        expect(".o_cp_team_switcher").toHaveText("Hyrule");
        // Exactly one probe in total, and nothing reached the network while offline.
        expect.verifySteps([]);
    });

    const SALE_MANAGER_GROUP = "sales_team.group_sale_manager";

    test.tags("desktop");
    test("team switcher: cold offline mount without a known group answer probes once on reconnect", async () => {
        // Offline, the kanban rendered again from its cache refreshes its groups in the
        // background, which fails with a `ConnectionLostError`, as the framework does.
        expect.errors(1);
        const setOffline = mockOffline();
        keepPingsFailing();
        watchGroupProbes([SALE_MANAGER_GROUP]);
        const startSession = visitInEarlierSession(SALE_MANAGER_GROUP);
        const switchers = captureInstances(TeamSwitcher);
        await mountWithCleanup(WebClient);
        // The pipeline and its list are cached by visits of an earlier session.
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await getService("action").switchView("list");
        expect.verifySteps([]);

        // The session starts offline: the switcher mounted from the cache asks nothing.
        startSession();
        await setOffline(true);
        await getService("action").switchView("kanban");
        await animationFrame();
        const switcher = switchers.at(-1);
        expect(status(switcher)).toBe("mounted");
        expect(".o_cp_team_switcher").toHaveCount(1);
        expect(isDisabledOffline(".o_cp_team_switcher")).toBe(true);
        expect(switcher.probedSaleManager()).toBe(null);
        expect(switcher.isSaleManager).toBe(false);
        await runAllTimers();
        expect(switcher.probedSaleManager()).toBe(null);
        expect.verifySteps([]);
        expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
        expect(queuedEntries()).toHaveLength(0);

        // Back online: one probe reaches the server, and "Manage Teams" is offered.
        await setOffline(false);
        await expect.waitForSteps([`has_group:${SALE_MANAGER_GROUP}`]);
        await animationFrame();
        expect(switcher.probedSaleManager()).toBe(true);
        expect(switcher.isSaleManager).toBe(true);
        expect(".o_cp_team_switcher").not.toHaveAttribute("disabled");
        await contains(".o_cp_team_switcher").click();
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(1);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("team switcher: a mount probe that loses the connection mounts with Manage Teams hidden, also after reconnect", async () => {
        const connection = mockConnectionDrop();
        const answerProbe = holdGroupProbe(SALE_MANAGER_GROUP);
        watchGroupProbes([SALE_MANAGER_GROUP]);
        const switchers = captureInstances(TeamSwitcher);
        await mountWithCleanup(WebClient);
        const pipelineDisplayed = getService("action").doAction(PIPELINE_ACTION_ID);
        await expect.waitForSteps([`has_group:${SALE_MANAGER_GROUP}`]);
        await animationFrame();

        // The connection drops while the mount probe is in flight (every request fails from now
        // on, the reconnection pings included): the pipeline still mounts, with the answer
        // unknown and "Manage Teams" hidden, and nothing is raised.
        connection.offline = true;
        answerProbe(new Response("", { status: 502 }));
        await pipelineDisplayed;
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        const switcher = switchers.at(-1);
        expect(status(switcher)).toBe("mounted");
        expect(".o_kanban_view").toHaveCount(1);
        expect(".o_cp_team_switcher").toHaveText("All Teams");
        expect(isDisabledOffline(".o_cp_team_switcher")).toBe(true);
        expect(switcher.probedSaleManager()).toBe(null);
        expect(switcher.isSaleManager).toBe(false);
        expect(queuedEntries()).toHaveLength(0);

        // The connection returns and a reconnection ping succeeds. The switcher asks again, but
        // the session's group cache keeps the failed answer: no request is sent, nothing is
        // raised and "Manage Teams" stays hidden until the page is reloaded, the safe outcome.
        connection.offline = false;
        await runAllTimers();
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect(switcher.probedSaleManager()).toBe(null);
        expect(switcher.isSaleManager).toBe(false);
        await contains(".o_cp_team_switcher").click();
        expect(".o_popover .dropdown-item:contains('Hyrule')").toHaveCount(1);
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // Online, the user leaves the pipeline and comes back: each new switcher is answered that
        // same failed answer by the session's group cache, without a request. The list and the
        // pipeline still mount, with "Manage Teams" hidden, and nothing is raised.
        await getService("action").switchView("list");
        await getService("action").switchView("kanban");
        await animationFrame();
        const remounted = switchers.at(-1);
        expect(remounted).not.toBe(switcher);
        expect(status(remounted)).toBe("mounted");
        expect(".o_kanban_view").toHaveCount(1);
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect(remounted.probedSaleManager()).toBe(null);
        expect(remounted.isSaleManager).toBe(false);
        await contains(".o_cp_team_switcher").click();
        expect(".o_popover .dropdown-item:contains('Hyrule')").toHaveCount(1);
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("team switcher: a mount probe that alone loses the connection while other requests succeed mounts with Manage Teams hidden", async () => {
        const RECURRING_REVENUE_GROUP = "crm.group_use_recurring_revenues";
        const answerProbe = holdGroupProbe(SALE_MANAGER_GROUP);
        const answerColumnProbe = holdGroupProbe(RECURRING_REVENUE_GROUP);
        watchGroupProbes([SALE_MANAGER_GROUP, RECURRING_REVENUE_GROUP]);
        const switchers = captureInstances(TeamSwitcher);
        await mountWithCleanup(WebClient);
        const pipelineDisplayed = getService("action").doAction(PIPELINE_ACTION_ID);
        // The switcher and the pipeline columns probe their groups at the same time.
        await expect.waitForSteps([
            `has_group:${SALE_MANAGER_GROUP}`,
            `has_group:${RECURRING_REVENUE_GROUP}`,
        ]);
        await animationFrame();

        // Only the switcher's probe loses the connection. The columns' probe is answered right
        // after it, which puts the client back online before that failure reaches the switcher:
        // the pipeline still mounts, with the answer unknown and "Manage Teams" hidden, and
        // nothing is raised.
        answerProbe(new Response("", { status: 502 }));
        answerColumnProbe(true); // the server's answer, sent back as the JSON-RPC result
        await pipelineDisplayed;
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        const switcher = switchers.at(-1);
        expect(status(switcher)).toBe("mounted");
        expect(".o_kanban_view").toHaveCount(1);
        expect(switcher.probedSaleManager()).toBe(null);
        expect(switcher.isSaleManager).toBe(false);
        expect(".o_cp_team_switcher").not.toHaveAttribute("disabled");
        await contains(".o_cp_team_switcher").click();
        expect(".o_popover .dropdown-item:contains('Hyrule')").toHaveCount(1);
        expect(".o_popover .dropdown-item:contains('Manage Teams')").toHaveCount(0);
        // Nothing asks again later: the group cache keeps the failed answer until reload.
        await runAllTimers();
        expect(switcher.isSaleManager).toBe(false);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("team switcher: a mount probe the server rejects still fails the mount", async () => {
        // The server error reaches the framework unchanged: the switcher does not swallow it.
        expect.errors(1);
        onRpc("/web/dataset/call_kw/res.users/has_group", async (request) => {
            const { params } = await request.clone().json();
            if (params.args[1] === SALE_MANAGER_GROUP) {
                throw makeServerError({ message: "Group probe refused" });
            }
        });
        watchGroupProbes([SALE_MANAGER_GROUP]);
        await mountWithCleanup(WebClient);
        // Not awaited: the pipeline never finishes mounting.
        getService("action").doAction(PIPELINE_ACTION_ID);
        await expect.waitForSteps([`has_group:${SALE_MANAGER_GROUP}`]);
        await expect.waitForErrors(["Group probe refused"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect(".o_cp_team_switcher").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
    });

    /** The browser key under which the CRM search model keeps the selected team. */
    const SWITCHER_TEAM_KEY = "crm.switcher_team_id";

    /** Asserts that the pipeline shows the cards of the Mushroom Kingdom team: Lead 1 and 3. */
    function expectMushroomKingdomCards() {
        expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2);
        expect(".o_kanban_record:contains('Lead 1')").toHaveCount(1);
        expect(".o_kanban_record:contains('Lead 3')").toHaveCount(1);
    }

    test("team switcher: a pipeline whose switcher data were never cached shows the offline action helper offline, and reads them again once online", async () => {
        // Offline, the pipeline groups were never cached either: their load fails with a
        // `ConnectionLostError`, as the framework does, and the kanban shows its offline helper.
        expect.errors(1);
        // The team selected in an earlier session.
        browser.localStorage.setItem(SWITCHER_TEAM_KEY, JSON.stringify(1));
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        onRpc("crm.team", "get_team_switcher_data", () => {
            expect.step("server:get_team_switcher_data");
        });
        // Only a lead form of the pipeline action is opened online, from its URL: the pipeline
        // itself never loads, so neither its groups nor the team switcher data are cached.
        redirect(`/odoo/action-${PIPELINE_ACTION_ID}/1`);
        await mountWebClient();
        expect(".o_form_view").toHaveCount(1);
        // The framework's list and kanban controllers probe the export group when they mount. A
        // server session knows that answer from its session info; the test session asks it here,
        // online.
        await user.hasGroup("base.group_allow_export");
        expect.verifySteps([]);

        await setOffline(true);
        await visitedReady();
        await contains(".o_breadcrumb .o_back_button").click();
        await animationFrame();
        // The switcher data are asked of the disk cache, which has nothing: the load completes
        // without the switcher, and the kanban renders the framework's offline action helper for
        // its uncached groups instead of a blank action.
        expect.verifySteps([
            "offline:crm.team/get_team_switcher_data",
            "offline:crm.lead/read_progress_bar",
            "offline:crm.lead/web_read_group",
        ]);
        await expect.waitForErrors(["crm.lead/web_read_group"]);
        expect(".o_kanban_view").toHaveCount(1);
        expect(".o_view_nocontent").toHaveText(/There is no data to display offline/);
        expect(".o_kanban_record").toHaveCount(0);
        expect(".o_cp_team_switcher").toHaveCount(0);
        // The saved team is kept, and nothing is queued.
        expect(browser.localStorage.getItem(SWITCHER_TEAM_KEY)).toBe("1");
        expect(queuedEntries()).toHaveLength(0);

        // Back online, a view switch does not restore the empty switcher: the list reads the
        // switcher data again and selects the saved team.
        await setOffline(false);
        await getService("action").switchView("list");
        expect.verifySteps(["server:get_team_switcher_data"]);
        expect(".o_list_view").toHaveCount(1);
        expect(".o_cp_team_switcher").toHaveText("Mushroom Kingdom");
        // The pipeline restores that switcher from the list's state and loads the team's leads.
        await getService("action").switchView("kanban");
        expect(".o_kanban_view").toHaveCount(1);
        expect(".o_view_nocontent").toHaveCount(0);
        expect(".o_cp_team_switcher").toHaveText("Mushroom Kingdom");
        expectMushroomKingdomCards();
        expect(browser.localStorage.getItem(SWITCHER_TEAM_KEY)).toBe("1");
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test("team switcher: a pipeline whose switcher data were cached online shows the switcher offline, answered by the disk cache", async () => {
        // Offline, the background refresh of the cached lead form, team switcher data and
        // pipeline groups fails with a `ConnectionLostError`, as the framework does.
        expect.errors(3);
        browser.localStorage.setItem(SWITCHER_TEAM_KEY, JSON.stringify(1));
        const setOffline = mockOffline();
        keepPingsFailing();
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await visitPipelineAndLead("Lead 1");
        expect(".o_cp_team_switcher").toHaveText("Mushroom Kingdom");

        await setOffline(true);
        await visitedReady();
        await contains(".o_kanban_record:contains('Lead 1')").click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_breadcrumb .o_back_button").click();
        await expect.waitForErrors([
            "crm.lead/web_read",
            "crm.team/get_team_switcher_data",
            "crm.lead/web_read_group",
        ]);
        // The pipeline is loaded again from the caches, with the saved team selected and the
        // switcher disabled.
        expect(".o_kanban_view").toHaveCount(1);
        expect(".o_view_nocontent").toHaveCount(0);
        expect(".o_cp_team_switcher").toHaveText("Mushroom Kingdom");
        expect(isDisabledOffline(".o_cp_team_switcher")).toBe(true);
        expectMushroomKingdomCards();
        expect(browser.localStorage.getItem(SWITCHER_TEAM_KEY)).toBe("1");
        expect(queuedEntries()).toHaveLength(0);
    });

    test("team switcher: a switcher data read the server rejects still fails the pipeline load", async () => {
        // The server error reaches the framework unchanged: only a lost connection falls back.
        expect.errors(1);
        onRpc("crm.team", "get_team_switcher_data", () => {
            throw makeServerError({ message: "Switcher data refused" });
        });
        await mountWithCleanup(WebClient);
        // Not awaited: the pipeline never finishes loading.
        getService("action").doAction(PIPELINE_ACTION_ID);
        await expect.waitForErrors(["Switcher data refused"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect(".o_kanban_view").toHaveCount(0);
        expect(".o_cp_team_switcher").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
    });

    const LEAD_GEN_BUTTON = "button.o-dropdown-caret:contains('Generate')";
    const LEAD_GEN_SURVEY_ITEM = ".o_lead_mining_element[data-module-xml-id='base.module_survey']";
    const LEAD_GEN_RPCS = [
        "ir.module.module/search_read",
        "ir.module.module/button_immediate_install",
        "has_access",
        "check_access_rights",
    ];

    /**
     * Makes the Survey entry of the lead generation dropdown access-gated, as an installed
     * lead-generation addon does: it gets a model, so the first opening probes `crm.lead` creation
     * access, and its own action steps `"onClick:survey"` instead of running. The probe is
     * answered `false`, the opposite of the entry's default for admin.
     */
    function mockAccessGatedLeadGenEntry() {
        patchWithCleanup(LeadGenerationDropdown.prototype, {
            setup() {
                super.setup(...arguments);
                const survey = this.state.dropdownContentElements.find(
                    (element) => element.moduleXmlId === "base.module_survey"
                );
                Object.assign(survey, {
                    model: "crm.lead",
                    onClick: () => expect.step("onClick:survey"),
                    status: "INSTALLED",
                });
            },
        });
        onRpc("crm.lead", "has_access", () => false);
    }

    /** Steps the import and access-request actions of the dropdown instead of running them. */
    function mockLeadGenActions() {
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
    }

    /**
     * Holds the next request to `route`, then answers it with a 502 when the returned function is
     * called, as a connection that drops during the call. Registered before `watchRpcs()`, so the
     * watcher still steps the request.
     *
     * @param {string} route
     * @returns {() => Promise<void>} drops the held request
     */
    function dropNextRequest(route) {
        const held = Promise.withResolvers();
        let holding = true;
        onRpc(route, async () => {
            if (holding) {
                holding = false;
                await held.promise;
                return new Response("", { status: 502 });
            }
        });
        return async () => {
            held.resolve();
            await animationFrame();
        };
    }

    /** @returns {LeadGenerationDropdown} the dropdown of the current pipeline */
    function findLeadGenDropdown(webClient) {
        return findComponent(webClient, (component) => component instanceof LeadGenerationDropdown);
    }

    /** @returns {Object} the access-gated Survey entry of `dropdown` */
    function surveyEntry(dropdown) {
        return dropdown.state.dropdownContentElements.find(
            (element) => element.moduleXmlId === "base.module_survey"
        );
    }

    test.tags("desktop");
    test("lead generation dropdown: disabled offline, no module lookup, access probe or install", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        mockAccessGatedLeadGenEntry();
        watchRpcs(LEAD_GEN_RPCS);
        mockLeadGenActions();
        // "Generate" has the accesskey "c" (hotkey `alt+c`), which the New button of the
        // pipeline also has: the hotkey runs the first of them in the DOM, New. The pipeline is
        // shown without lead creation, so that `alt+c` is the hotkey of "Generate".
        patchWithCleanup(KanbanController.prototype, {
            get canCreate() {
                return false;
            },
        });
        const webClient = await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        expect(".o-kanban-button-new").toHaveCount(0);
        const dropdown = findLeadGenDropdown(webClient);
        const survey = surveyEntry(dropdown);
        const surveyItem = LEAD_GEN_SURVEY_ITEM;
        const generateButton = LEAD_GEN_BUTTON;
        expect(generateButton).toBeEnabled();
        expect(survey.hasAccess).toBe(true);
        // Keyboard selection of a choice in the open dropdown, as a keyboard user does it: the
        // arrow keys move the focus to the choice, and Enter selects it.
        const selectChoiceWithKeyboard = async (moduleXmlId) => {
            const choice = `.o_lead_mining_element.focus[data-module-xml-id='${moduleXmlId}']`;
            for (let index = 0; index <= queryAll(".o_lead_mining_element").length; index++) {
                if (queryAll(choice).length) {
                    break;
                }
                await press("ArrowDown");
                await animationFrame();
            }
            expect(choice).toHaveCount(1);
            await press("Enter");
            await animationFrame();
        };

        // Offline before the first opening: neither the module lookup nor the opening happens.
        await setOffline(true);
        expect(isDisabledOffline(generateButton)).toBe(true);
        await dropdown.toggleDropdown();
        expect(".o_lead_mining_menu_choices").toHaveCount(0);
        expect(dropdown.dropdownWasAlreadyOpened).toBe(undefined);
        // Nor through the keyboard: its hotkey `alt+c` does nothing, and the disabled button
        // cannot take the keyboard focus, so Enter does nothing either.
        await press(["alt", "c"]);
        await animationFrame();
        queryOne(generateButton).focus();
        expect(generateButton).not.toBeFocused();
        await press("Enter");
        await animationFrame();
        expect(".o_lead_mining_menu_choices").toHaveCount(0);
        expect(dropdown.dropdownWasAlreadyOpened).toBe(undefined);
        await setOffline(false);
        expect(generateButton).toBeEnabled();
        expect.verifySteps([]);

        // Online: the first opening looks the modules up and probes the access of the gated
        // entry, whose answer replaces its default: selecting it asks for access instead of
        // running its action. An uninstalled choice asks to install it.
        await contains(generateButton).click();
        expect.verifySteps(["ir.module.module/search_read", "crm.lead/has_access"]);
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        expect(survey.hasAccess).toBe(false);
        await contains(surveyItem).click();
        expect.verifySteps(["doAction:base.module.install.request"]);
        // The hotkey is a real route to the same toggle: `alt+c` closes the dropdown and opens it
        // again (the modules are known by now, so nothing is looked up again).
        await press(["alt", "c"]);
        await animationFrame();
        expect(".o_lead_mining_menu_choices").toHaveCount(0);
        await press(["alt", "c"]);
        await animationFrame();
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        // Keyboard selection runs a choice: Enter on "Import leads from CSV" opens the import.
        await selectChoiceWithKeyboard("base.module_crm");
        expect.verifySteps(["doAction:import"]);
        await contains(
            ".o_lead_mining_element[data-module-xml-id='base.module_crm_iap_mine']"
        ).click();
        expect(".modal").toHaveCount(1);
        expect(".modal .modal-footer .btn-primary").toHaveText("Install");

        // The connection drops while the confirmation and the menu are open: confirming
        // installs nothing.
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        await setOffline(true);
        expect(".modal .modal-footer .btn-primary").toBeEnabled();
        await contains(".modal .modal-footer .btn-primary").click();
        expect(".modal").toHaveCount(0);
        expect(".o_lead_mining_element .oi-spin").toHaveCount(0);

        // The dropdown was left open behind the confirmation. Keyboard selection of its choices
        // (the uninstalled module and the import) opens no confirmation and runs no action, and
        // `alt+c` no longer toggles it.
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        await selectChoiceWithKeyboard("base.module_crm_iap_mine");
        await selectChoiceWithKeyboard("base.module_crm");
        await press(["alt", "c"]);
        await animationFrame();
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        expect(".modal").toHaveCount(0);

        // Offline, "Generate" and the entries of the menu left open are disabled, and neither
        // the keyboard nor a click reaches an entry.
        expect(isDisabledOffline(generateButton)).toBe(true);
        expect(isDisabledOffline(surveyItem)).toBe(true);
        await press(["alt", "c"]);
        await animationFrame();
        await press("ArrowDown");
        await press("Enter");
        await animationFrame();
        await contains(surveyItem).click();
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        // Every entry point is inert without DOM event too: toggling neither closes the menu
        // nor probes, and the gated entry neither runs its action nor asks for access.
        const [leadSourcing] = dropdown.state.dropdownContentElements;
        const leadImport = dropdown.state.dropdownContentElements.find(
            (element) => element.moduleName === "Lead Import"
        );
        await dropdown.toggleDropdown();
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        await dropdown.onClickAction(survey);
        await dropdown.onClickAction({ ...survey, hasAccess: true });
        await dropdown.onClickAction(leadSourcing);
        await dropdown.onClickAction(leadImport);
        await dropdown.onClickAction({ ...leadSourcing, hasAccess: false });
        dropdown.redirectToImport();
        dropdown.requestAccess(leadSourcing.moduleName, leadSourcing.title, true);
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect(leadSourcing.status).toBe("NOT_INSTALLED");
        expect(survey.hasAccess).toBe(false);

        await setOffline(false);
        expect(generateButton).toBeEnabled();
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("lead generation dropdown: an opening whose module lookup loses the connection initializes again once online", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        mockAccessGatedLeadGenEntry();
        const dropLookup = dropNextRequest("/web/dataset/call_kw/ir.module.module/search_read");
        watchRpcs(LEAD_GEN_RPCS);
        mockLeadGenActions();
        const webClient = await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const dropdown = findLeadGenDropdown(webClient);

        // The first opening starts both lookups. A click while they are pending toggles the
        // menu open without looking anything up again, as before.
        await contains(LEAD_GEN_BUTTON).click();
        expect.verifySteps(["ir.module.module/search_read", "crm.lead/has_access"]);
        await contains(LEAD_GEN_BUTTON).click();
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        expect.verifySteps([]);

        // The module lookup loses the connection: the client goes offline, no error escapes
        // (Hoot fails on any undeclared error), the menu is closed and the dropdown is no longer
        // initialized.
        await dropLookup();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(".o_lead_mining_menu_choices").toHaveCount(0);
        expect(dropdown.dropdownWasAlreadyOpened).toBe(false);

        // Back online, in the same dropdown: the next opening looks the modules up again (the
        // access answer is reused), opens the menu, and an uninstalled choice asks to install
        // it with its module name.
        await setOffline(false);
        expect(LEAD_GEN_BUTTON).toBeEnabled();
        await contains(LEAD_GEN_BUTTON).click();
        expect.verifySteps(["ir.module.module/search_read"]);
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        expect(dropdown.dropdownWasAlreadyOpened).toBe(true);
        expect(surveyEntry(dropdown).hasAccess).toBe(false);
        await contains(
            ".o_lead_mining_element[data-module-xml-id='base.module_crm_iap_mine']"
        ).click();
        expect(".modal").toHaveCount(1);
        expect(".modal .modal-body").toHaveText(
            'Do you want to install the "Lead Generation" App?'
        );
        expect(".modal .modal-footer .btn-primary").toHaveText("Install");
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("lead generation dropdown: an access probe lost to a dropped connection keeps the default access", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        mockAccessGatedLeadGenEntry();
        const dropProbe = dropNextRequest("/web/dataset/call_kw/crm.lead/has_access");
        watchRpcs(LEAD_GEN_RPCS);
        mockLeadGenActions();
        const webClient = await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const dropdown = findLeadGenDropdown(webClient);

        // The module lookup succeeds, then the access probe loses the connection: the
        // initialization completes with the entry's default access, but the menu does not open
        // offline and no error escapes.
        await contains(LEAD_GEN_BUTTON).click();
        expect.verifySteps(["ir.module.module/search_read", "crm.lead/has_access"]);
        await dropProbe();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(".o_lead_mining_menu_choices").toHaveCount(0);
        expect(dropdown.dropdownWasAlreadyOpened).toBe(true);
        expect(surveyEntry(dropdown).hasAccess).toBe(true);

        // Back online: the menu opens without any lookup, and the gated entry runs its action.
        await setOffline(false);
        await contains(LEAD_GEN_BUTTON).click();
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        await contains(LEAD_GEN_SURVEY_ITEM).click();
        expect.verifySteps(["onClick:survey"]);

        // A new pipeline initializes a new dropdown. The user access cache still holds the lost
        // answer and the module lookup is cached, so nothing reaches the network, yet the menu
        // opens with the default access.
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const newDropdown = findLeadGenDropdown(webClient);
        expect(newDropdown).not.toBe(dropdown);
        expect(newDropdown.dropdownWasAlreadyOpened).toBe(undefined);
        await contains(LEAD_GEN_BUTTON).click();
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        expect(newDropdown.dropdownWasAlreadyOpened).toBe(true);
        expect(surveyEntry(newDropdown).hasAccess).toBe(true);
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("lead generation dropdown: a module lookup server error propagates and the next opening initializes again", async () => {
        expect.errors(1);
        mockAccessGatedLeadGenEntry();
        let refuseLookup = true;
        onRpc("ir.module.module", "search_read", () => {
            if (refuseLookup) {
                refuseLookup = false;
                throw makeServerError({ message: "Module lookup refused" });
            }
        });
        watchRpcs(LEAD_GEN_RPCS);
        mockLeadGenActions();
        const webClient = await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const dropdown = findLeadGenDropdown(webClient);

        // The server refuses the module lookup: its error reaches the framework unchanged, the
        // client stays online, the menu stays closed and the dropdown is no longer initialized.
        await contains(LEAD_GEN_BUTTON).click();
        await animationFrame();
        expect.verifySteps(["ir.module.module/search_read", "crm.lead/has_access"]);
        expect.verifyErrors(["Module lookup refused"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect(".o_lead_mining_menu_choices").toHaveCount(0);
        expect(dropdown.dropdownWasAlreadyOpened).toBe(false);

        // The next opening looks the modules up again and opens the menu.
        await contains(".o_error_dialog .modal-footer .btn-primary").click();
        await contains(LEAD_GEN_BUTTON).click();
        expect.verifySteps(["ir.module.module/search_read"]);
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
        expect(dropdown.dropdownWasAlreadyOpened).toBe(true);
    });

    test.tags("desktop");
    test("form header DISABLE buttons and probability anchors: disabled offline, re-enabled online, hotkeys and direct onClick() inert", async () => {
        // The statusbar's "Move to next stage" command also has the hotkey `alt+x`, and hotkeys
        // registered by components win over the DOM `data-hotkey` of Restore. In production,
        // Restore is shown only on lost leads, whose statusbar is read-only, which makes that
        // command unavailable; here the lead is in the last stage, which does the same.
        CrmLead._records[0].stage_id = 3;
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/web_save"]);
        watchOfflineRpcs();
        mockViewButtonActions();
        const buttons = captureInstances(ViewButton);
        await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: LEAD_FORM_ARCH });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        await contains("button[name='action_set_won_rainbowman']").click();
        await contains("a[name='action_set_automated_probability']:first").click();
        expect.verifySteps([
            "doActionButton:action_set_won_rainbowman",
            "doActionButton:action_set_automated_probability",
        ]);
        // The keyboard reaches the same handlers online: each header hotkey runs its button, and
        // Enter on a focused button or probability anchor clicks it.
        for (const key of Object.keys(LEAD_HEADER_HOTKEYS)) {
            await press(["alt", key]);
            await animationFrame();
        }
        expect.verifySteps(
            Object.values(LEAD_HEADER_HOTKEYS).map((name) => `doActionButton:${name}`)
        );
        for (const name of LEAD_HEADER_BUTTONS) {
            queryOne(`button[name='${name}']`).focus();
            expect(`button[name='${name}']`).toBeFocused();
            await press("Enter");
            await animationFrame();
        }
        for (const anchor of queryAll("a[name='action_set_automated_probability']")) {
            anchor.focus();
            expect(anchor).toBeFocused();
            await press("Enter");
            await animationFrame();
        }
        expect.verifySteps([
            ...LEAD_HEADER_BUTTONS.map((name) => `doActionButton:${name}`),
            "doActionButton:action_set_automated_probability",
            "doActionButton:action_set_automated_probability",
        ]);

        // A pending edit: a button that got through would save it first.
        await contains(".o_field_widget[name=name] textarea").edit("Lead 1 (unsaved)");
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

        // Keyboard: the disabled buttons cannot take the keyboard focus, so neither Enter nor
        // Space reaches them. The probability anchors are only dimmed: they still take the focus,
        // and Enter (which clicks a link) and Space on them are inert. The anchors have no hotkey
        // in the production arch, so there is no hotkey route to exercise for them.
        for (const name of LEAD_HEADER_BUTTONS) {
            queryOne(`button[name='${name}']`).focus();
            expect(`button[name='${name}']`).not.toBeFocused();
            await pressEnterAndSpace();
        }
        for (const anchor of anchors) {
            anchor.focus();
            expect(anchor).toBeFocused();
            await pressEnterAndSpace();
        }

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
        expect(".o_field_widget[name=name] textarea").toHaveValue("Lead 1 (unsaved)");
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
        // The hotkey runs Won again, after saving the edit kept through the disconnection.
        await press(["alt", "w"]);
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save", "doActionButton:action_set_won_rainbowman"]);
    });

    test.tags("desktop");
    test("lead form stage widget of an active lead in a non-final stage: disabled offline, inert by command, overlay left open, direct call and re-render, re-enabled online", async () => {
        setUpLeadStageWidget();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/web_save"]);
        watchOfflineRpcs();
        const statusbars = captureInstances(StatusBarField);
        await mountView({
            type: "form",
            resModel: "crm.lead",
            resId: 1,
            arch: LEAD_STAGE_WIDGET_FORM_ARCH,
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        const statusbar = () => statusbars.at(-1);
        const stageId = () => statusbar().props.record.data.stage_id.id;
        const stageControls = () => queryAll(".o_statusbar_status button");
        const moreToggle = ".o_statusbar_status button.dropdown-toggle:visible";
        const moreOption = (label) => `.o-dropdown--menu .dropdown-item:contains('${label}')`;
        const moveCommands = ".o_command:contains('Move to')";
        // The production widget is a statusbar subclass; the lead is active, pending and in the
        // first of three stages, so its readonly expression leaves the widget editable.
        expect(statusbar()).toBeInstanceOf(RottingStatusBarDurationField);
        expect(statusbar().props.record.data.active).toBe(true);
        expect(statusbar().props.record.data.won_status).toBe("pending");
        expect(stageId()).toBe(1);

        // Online, the commands, the buttons and the "More..." dropdown move the stage.
        await press(["control", "k"]);
        await animationFrame();
        expect(queryAllTexts(moveCommands)).toEqual([
            "Move to Stage...\nALT + SHIFT + X",
            "Move to next Stage\nALT + X",
        ]);
        await press("Escape");
        await animationFrame();
        await press(["alt", "x"]);
        await animationFrame();
        expect(stageId()).toBe(2);
        await press(["alt", "shift", "x"]);
        await animationFrame();
        expect(queryAllTexts(".o_command")).toEqual(["New", "Qualified", "Won"]);
        await contains(".o_command:contains('New')").click();
        expect(stageId()).toBe(1);
        await contains(moreToggle).click();
        await contains(moreOption("Won")).click();
        expect(stageId()).toBe(3);
        await contains(".o_statusbar_status button[data-value='2']").click();
        expect(stageId()).toBe(2);
        await contains(".o_form_button_cancel").click();
        expect(stageId()).toBe(1);
        expect.verifySteps([]);

        // The command palette and the "More..." dropdown, opened online and left open at
        // disconnection, still list the stages: choosing one, by keyboard or click, changes nothing.
        await press(["alt", "shift", "x"]);
        await animationFrame();
        expect(queryAllTexts(".o_command")).toEqual(["New", "Qualified", "Won"]);
        await setOffline(true);
        await press("ArrowDown");
        await animationFrame();
        expect(".o_command.focused").toHaveText("Qualified");
        await press("Enter");
        await animationFrame();
        expect(".o_command_palette").toHaveCount(0);
        expect(stageId()).toBe(1);
        await setOffline(false);
        await press(["alt", "shift", "x"]);
        await animationFrame();
        await setOffline(true);
        await contains(".o_command:contains('Won')").click();
        expect(".o_command_palette").toHaveCount(0);
        expect(stageId()).toBe(1);
        await setOffline(false);
        await contains(moreToggle).click();
        await setOffline(true);
        expect(moreOption("Won")).toHaveClass("disabled");
        queryOne(moreOption("Won")).click();
        await animationFrame();
        expect(stageId()).toBe(1);
        expect(statusbar().props.record.dirty).toBe(false);

        // Offline, the widget is disabled through its own props: every stage button and dropdown
        // toggle renders `disabled`, and neither command is available, by hotkey or palette.
        expect(statusbar().props.isDisabled).toBe(true);
        expect(stageControls()).toHaveLength(5);
        for (const control of stageControls()) {
            expect(control).toHaveAttribute("disabled");
        }
        // Keyboard: a disabled stage button cannot take the keyboard focus.
        queryOne(".o_statusbar_status button[data-value='2']").focus();
        expect(".o_statusbar_status button[data-value='2']").not.toBeFocused();
        await pressEnterAndSpace();
        await press(["alt", "x"]);
        await animationFrame();
        await press(["alt", "shift", "x"]);
        await animationFrame();
        expect(".o_command_palette").toHaveCount(0);
        await press(["control", "k"]);
        await animationFrame();
        expect(".o_command_palette").toHaveCount(1);
        expect(moveCommands).toHaveCount(0);
        await press("Escape");
        await animationFrame();
        // Direct calls, without any DOM event.
        await statusbar().selectItem(stageItem(statusbar(), "Qualified"));
        await statusbar().selectItem(stageItem(statusbar(), "Won"));
        statusbar().onDropdownItemSelected({ detail: { payload: stageItem(statusbar(), "Won") } });
        await animationFrame();
        expect(stageId()).toBe(1);
        expect(statusbar().props.record.dirty).toBe(false);
        expect(".modal").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // Re-renders after disconnection (an edit of another field, a resize) keep every control
        // disabled and the commands unavailable.
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (edited)");
        window.dispatchEvent(new Event("resize"));
        await animationFrame();
        expect(statusbar().props.isDisabled).toBe(true);
        expect(stageControls()).toHaveLength(5);
        for (const control of stageControls()) {
            expect(control).toHaveAttribute("disabled");
        }
        await press(["alt", "x"]);
        await animationFrame();
        expect(stageId()).toBe(1);

        // Saved, the edit is queued without any stage.
        await contains(".o_form_button_save").click();
        await animationFrame();
        expect.verifySteps(["offline:crm.lead/web_save", "crm.lead/web_save"]);
        expect(queuedEntries()).toHaveLength(1);
        const [save] = queuedCalls("crm.lead", "web_save");
        expect(save.args).toEqual([[1], { name: "Lead 1 (edited)" }]);
        expect(stageId()).toBe(1);
        expect(".modal").toHaveCount(0);

        // Back online, the edit replays, and the widget is enabled and moves the stage again.
        await setOffline(false);
        await letQueueReplay(1);
        expect.verifySteps(["crm.lead/web_save"]);
        expect(queuedEntries()).toHaveLength(0);
        expect(statusbar().props.isDisabled).toBe(false);
        expect(".o_statusbar_status button[data-value='2']").toBeEnabled();
        expect(".o_statusbar_status button[data-value='2']").not.toHaveClass("o_disabled_offline");
        expect(moreToggle).toBeEnabled();
        await press(["alt", "x"]);
        await animationFrame();
        expect(stageId()).toBe(2);
    });

    test.tags("mobile");
    test("mobile: lead form stage dropdown: disabled offline, an option of a dropdown opened online is inert, re-enabled online", async () => {
        setUpLeadStageWidget();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        const statusbars = captureInstances(StatusBarField);
        await mountView({
            type: "form",
            resModel: "crm.lead",
            resId: 1,
            arch: LEAD_STAGE_WIDGET_FORM_ARCH,
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        const statusbar = () => statusbars.at(-1);
        const stageId = () => statusbar().props.record.data.stage_id.id;
        const stageControls = () => queryAll(".o_statusbar_status button");
        const toggle = ".o_statusbar_status button.dropdown-toggle:visible";
        const option = (label) => `.o-dropdown--menu .dropdown-item:contains('${label}')`;
        expect(statusbar()).toBeInstanceOf(RottingStatusBarDurationField);

        // Online, the small-screen dropdown, the widget's only visible control, moves the stage.
        expect(queryAll(toggle)).toHaveLength(1);
        await contains(toggle).click();
        await contains(option("Qualified")).click();
        expect(stageId()).toBe(2);
        await contains(".o_form_button_cancel").click();
        expect(stageId()).toBe(1);

        // Opened online and left open at disconnection, the dropdown's options are dimmed, and a
        // click that still reaches one changes nothing.
        await contains(toggle).click();
        await setOffline(true);
        expect(statusbar().props.isDisabled).toBe(true);
        expect(option("Qualified")).toHaveClass("disabled");
        expect(option("Won")).toHaveClass("disabled");
        queryOne(option("Won")).click();
        await animationFrame();
        expect(stageId()).toBe(1);

        // Every control renders disabled, also after a re-render, and a direct call is inert.
        for (const control of stageControls()) {
            expect(control).toHaveAttribute("disabled");
        }
        await statusbar().selectItem(stageItem(statusbar(), "Qualified"));
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (edited)");
        expect(statusbar().props.isDisabled).toBe(true);
        for (const control of stageControls()) {
            expect(control).toHaveAttribute("disabled");
        }
        expect(stageId()).toBe(1);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // Back online, the dropdown moves the stage again.
        await setOffline(false);
        expect(statusbar().props.isDisabled).toBe(false);
        expect(toggle).toBeEnabled();
        await contains(toggle).click();
        await contains(option("Qualified")).click();
        expect(stageId()).toBe(2);
    });

    test.tags("desktop");
    test("lead form stage widget guard is CRM-scoped: a statusbar of another model still changes offline", async () => {
        class UtmStage extends models.Model {
            _name = "utm.stage";
            _order = "sequence, id";

            name = fields.Char();
            sequence = fields.Integer();

            _records = [
                { id: 1, name: "New", sequence: 1 },
                { id: 2, name: "Schedule", sequence: 2 },
                { id: 3, name: "Sent", sequence: 3 },
            ];
        }
        defineModels([UtmStage]);
        UtmCampaign._fields.stage_id = fields.Many2one({ string: "Stage", relation: "utm.stage" });
        UtmCampaign._records[0].stage_id = 1;
        const setOffline = mockOffline();
        keepPingsFailing();
        const statusbars = captureInstances(StatusBarField);
        await mountView({
            type: "form",
            resModel: "utm.campaign",
            resId: 1,
            arch: /* xml */ `
                <form>
                    <header>
                        <field name="stage_id" widget="statusbar" options="{'clickable': '1'}"/>
                    </header>
                    <sheet>
                        <field name="name"/>
                    </sheet>
                </form>`,
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [statusbar] = statusbars;
        const stageId = () => statusbar.props.record.data.stage_id.id;

        await setOffline(true);
        // The widget keeps its own props, and its command and handler still move the stage.
        expect(statusbar.props.isDisabled).toBe(false);
        await press(["alt", "x"]);
        await animationFrame();
        expect(stageId()).toBe(2);
        await statusbar.selectItem(stageItem(statusbar, "Sent"));
        await animationFrame();
        expect(stageId()).toBe(3);
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
            // So does Enter on each focused header button.
            for (const name of names) {
                queryOne(`button[name='${name}']`).focus();
                expect(`button[name='${name}']`).toBeFocused({ message: `${rows}: ${name}` });
                await press("Enter");
                await animationFrame();
            }
            expect.verifySteps(names.map((name) => `doActionButton:${name}`));

            await setOffline(true);
            for (const name of names) {
                expect(isDisabledOffline(`button[name='${name}']`)).toBe(true, {
                    message: `${rows}: ${name}`,
                });
            }
            // Keyboard: Enter and Space where the focus was left online, then on each header
            // button, which cannot take the keyboard focus while disabled. The header buttons have
            // no hotkey in the production arch, so there is no hotkey route to exercise.
            await pressEnterAndSpace();
            document.activeElement.blur();
            for (const name of names) {
                queryOne(`button[name='${name}']`).focus();
                expect(`button[name='${name}']`).not.toBeFocused({ message: `${rows}: ${name}` });
                await pressEnterAndSpace();
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
        // Mark Lost, Merge, the mass mail "Send email" (105) and Add/Remove Followers.
        expect(boundWrappers().map(({ action }) => action.id)).toEqual([101, 102, 105, 104]);
        // Online, the mass mail picked with the keyboard runs on the searched domain.
        await selectMenuItemWithKeyboard("u", "Send email");
        await expect.waitForSteps(["crm.lead/search", "doAction:105"]);
        await setOffline(true);
        await callServerPathsDirectly();
        // The menu is opened through its hotkey and a bound wizard is picked with the keyboard.
        await selectMenuItemWithKeyboard("u", "Mark Lost");
        await selectMenuItemWithKeyboard("u", "Merge");
        await selectMenuItemWithKeyboard("u", "Send email");
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);
        await setOffline(false);

        // 2. Kanban, selection mode.
        await getService("action").doAction(PIPELINE_ACTION_ID, { viewType: "kanban" });
        await contains(".o_kanban_record:first").click({ altKey: true });
        expect(".o_kanban_record.o_record_selected").toHaveCount(1);
        expect(boundWrappers().map(({ action }) => action.id)).toEqual([101, 102, 105, 104]);
        await selectMenuItemWithKeyboard("u", "Send email");
        await expect.waitForSteps(["doAction:105"]);
        await setOffline(true);
        await callServerPathsDirectly();
        await selectMenuItemWithKeyboard("u", "Add/Remove Followers");
        await selectMenuItemWithKeyboard("u", "Send email");
        expect(".modal").toHaveCount(0);
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
        await contains(".o_field_widget[name=name] textarea").edit("Lead 1 (unsaved)");
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
        expect(".o_field_widget[name=name] textarea").toHaveValue("Lead 1 (unsaved)");
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
        const myActivitiesAction = () => ({
            type: "ir.actions.act_window",
            res_model: "crm.lead",
            views: [[false, "list"]],
            domain: [],
        });
        // When set, the next loadAction answers only once the test resolves this deferred.
        let deferredLoadAction = null;
        mockService("action", {
            async loadAction(action) {
                expect.step(`loadAction:${action}`);
                const deferred = deferredLoadAction;
                deferredLoadAction = null;
                return deferred ? deferred.promise : myActivitiesAction();
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
        // Keyboard: the entry is not an item of the menu's keyboard navigation (no `o-navigable`
        // class) and cannot take the keyboard focus, so the arrow keys and Enter in the open menu
        // do not reach it. Neither the entry nor the systray toggle has a hotkey, so there is no
        // hotkey route to exercise.
        expect(`${crmEntry}.o-navigable, ${crmEntry} .o-navigable`).toHaveCount(0);
        queryOne(crmEntry).focus();
        expect(crmEntry).not.toBeFocused();
        for (const key of ["ArrowDown", "Enter", "ArrowDown", "Enter"]) {
            await press(key);
            await animationFrame();
        }
        expect(crmEntry).toHaveCount(1);
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        await setOffline(false);
        expect(crmEntry).not.toHaveAttribute("disabled");
        expect(crmEntry).not.toHaveClass("o_disabled_offline");

        // Clicked online, but the connection drops while the action is loading: once the action
        // arrives, nothing is opened.
        deferredLoadAction = Promise.withResolvers();
        const pendingLoadAction = deferredLoadAction;
        await mailClick(crmEntry);
        await setOffline(true);
        pendingLoadAction.resolve(myActivitiesAction());
        await animationFrame();
        expect.verifySteps(["loadAction:crm.crm_lead_action_my_activities"]);

        await setOffline(false);
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
        // The keyboard reaches the same handlers: Enter on a focused card opens it (the kanban
        // renderer clicks the focused card), and Enter on a focused anchor clicks it.
        queryOne(".o_crm_team_kanban .o_kanban_record:first").focus();
        await press("Enter");
        await animationFrame();
        // Action buttons of cards are debounced (300 ms, leading call only): the window opened by
        // the pointer click must pass, or the keyboard click would be dropped before the handler.
        await advanceTime(300);
        queryOne(`${anchorSelector}:contains('Leads'):first`).focus();
        await press("Enter");
        await animationFrame();
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
        // Direct calls, with an event that is not a selection click and without any event. The
        // debounce windows of the anchors clicked above pass first, so that every call reaches the
        // handler.
        await advanceTime(300);
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
        // Keyboard: the dimmed cards and anchors still take the keyboard focus, and Enter on them
        // is inert, on the focused card, on the next card reached with the arrow keys and on
        // every anchor (once the debounce windows of the direct calls have passed). Neither the
        // cards nor the anchors have a hotkey, so there is no hotkey route to exercise.
        await advanceTime(300);
        const cards = queryAll(".o_crm_team_kanban .o_kanban_record:not(.o_kanban_ghost)");
        cards[0].focus();
        expect(cards[0]).toBeFocused();
        await press("Enter");
        await animationFrame();
        await press("ArrowDown");
        await animationFrame();
        expect(cards[1]).toBeFocused();
        await press("Enter");
        await animationFrame();
        for (const anchor of queryAll(anchorSelector)) {
            anchor.focus();
            expect(anchor).toBeFocused();
            await press("Enter");
            await animationFrame();
        }
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        await setOffline(false);
        for (const anchor of queryAll(anchorSelector)) {
            expect(anchor).not.toHaveAttribute("disabled");
            expect(anchor).not.toHaveClass("o_disabled_offline");
        }
        expect(".o_crm_team_kanban .o_kanban_record.o_disabled_offline").toHaveCount(0);
    });

    test.tags("desktop");
    test("team dashboard card menu anchors: disabled in a menu left open at disconnection, re-enabled online", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        mockViewButtonActions();
        // Every dashboard card was visited online: the framework does not dim it as uncached.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        const buttons = captureInstances(ViewButton);
        await mountView({ type: "kanban", resModel: "crm.team", arch: TEAM_DASHBOARD_MENU_ARCH });
        expect(".o_crm_team_kanban .o_kanban_record:not(.o_kanban_ghost)").toHaveCount(2);
        const menu = ".o-dropdown--kanban-record-menu";
        const menuAnchor = (name) => `${menu} a[name='${name}']`;
        const configuration = `${menu} a:contains('Configuration')`;

        // Online, the card menu opens in an overlay outside the dashboard, so no dashboard
        // selector reaches its anchors, which are usable.
        await toggleKanbanRecordDropdown(0);
        expect(menu).toHaveCount(1);
        expect(queryOne(menu).closest(".o_crm_team_kanban")).toBe(null);
        expect(configuration).toHaveCount(1);
        for (const name of TEAM_MENU_ACTION_NAMES) {
            expect(menuAnchor(name)).toHaveCount(1);
            expect(menuAnchor(name)).not.toHaveAttribute("disabled");
            expect(menuAnchor(name)).not.toHaveClass("o_disabled_offline");
        }
        const onlineMarkup = Object.fromEntries(
            TEAM_MENU_ACTION_NAMES.map((name) => [name, queryOne(menuAnchor(name)).outerHTML])
        );
        // Each anchor is drawn by a view button of the team record, the record its click guard
        // reads.
        const menuButtons = buttons.filter(
            (button) =>
                status(button) === "mounted" &&
                TEAM_MENU_ACTION_NAMES.includes(button.clickParams.name)
        );
        expect(menuButtons.map(({ clickParams }) => clickParams.name).sort()).toEqual(
            [...TEAM_MENU_ACTION_NAMES].sort()
        );
        for (const button of menuButtons) {
            expect(button.props.tag).toBe("a");
            expect(button.props.record.resModel).toBe("crm.team");
        }

        // The connection drops with the menu left open: every action anchor is disabled, while
        // Configuration, which opens the cached team form, stays usable.
        await setOffline(true);
        expect(menu).toHaveCount(1);
        for (const name of TEAM_MENU_ACTION_NAMES) {
            expect(isDisabledOffline(menuAnchor(name))).toBe(true, { message: name });
        }
        expect(configuration).not.toHaveAttribute("disabled");
        expect(configuration).not.toHaveClass("o_disabled_offline");

        // Direct calls of every anchor handler, without any DOM event, are inert, and the menu
        // stays open.
        for (const button of menuButtons) {
            button.onClick();
        }
        await animationFrame();
        expect(menu).toHaveCount(1);
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        // Back online, with the menu still open: the anchors are usable and rendered as before.
        await setOffline(false);
        expect(menu).toHaveCount(1);
        for (const name of TEAM_MENU_ACTION_NAMES) {
            expect(menuAnchor(name)).not.toHaveAttribute("disabled");
            expect(menuAnchor(name)).not.toHaveClass("o_disabled_offline");
            expect(queryOne(menuAnchor(name)).outerHTML).toBe(onlineMarkup[name]);
        }

        // The connection drops again, the menu still open: the anchors are disabled again. The
        // dimmed anchors still take the keyboard focus, and Enter on one is inert once the
        // debounce window of the direct calls has passed (the anchors have no hotkey, so there
        // is no hotkey route to exercise). The guard returns before `preventDefault`, so the
        // anchor's `#` link is followed, and that navigation closes the menu like any popover.
        await setOffline(true);
        expect(menu).toHaveCount(1);
        for (const name of TEAM_MENU_ACTION_NAMES) {
            expect(isDisabledOffline(menuAnchor(name))).toBe(true, { message: name });
        }
        await advanceTime(300);
        const focusedAnchor = queryOne(menuAnchor("crm.crm_lead_action_open_lead_form"));
        focusedAnchor.focus();
        expect(focusedAnchor).toBeFocused();
        await press("Enter");
        await animationFrame();
        expect(menu).toHaveCount(0);
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        // A DOM click on an anchor of a menu opened online and left open at disconnection is
        // inert too, and closes the menu in the same way.
        await setOffline(false);
        await toggleKanbanRecordDropdown(0);
        await setOffline(true);
        expect(isDisabledOffline(menuAnchor("crm.crm_case_form_view_salesteams_lead"))).toBe(true);
        queryOne(menuAnchor("crm.crm_case_form_view_salesteams_lead")).click();
        await animationFrame();
        expect(menu).toHaveCount(0);
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        // Online, a menu opened again has usable anchors, which run their action.
        await setOffline(false);
        await toggleKanbanRecordDropdown(0);
        for (const name of TEAM_MENU_ACTION_NAMES) {
            expect(menuAnchor(name)).not.toHaveAttribute("disabled");
            expect(menuAnchor(name)).not.toHaveClass("o_disabled_offline");
        }
        await contains(menuAnchor("crm.crm_activity_report_action_team")).click();
        expect.verifySteps(["doActionButton:crm.crm_activity_report_action_team"]);
    });

    test.tags("desktop");
    test("UTM campaign card leads anchor: disabled offline, re-enabled online; other campaign anchors untouched", async () => {
        expect(CRM_OFFLINE_MODELS.includes("utm.campaign")).toBe(false);
        expect(
            CRM_FOREIGN_DISABLED_BUTTONS.some(
                ([model, name]) => model === "utm.campaign" && name === "some_other_method"
            )
        ).toBe(false);
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        mockViewButtonActions();
        // The campaign card was visited online: the framework does not dim it as uncached.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        const buttons = captureInstances(ViewButton);
        // The leads/opportunities anchor of the production campaign card (inventory B34), next
        // to a campaign anchor that CRM does not list.
        await mountView({
            type: "kanban",
            resModel: "utm.campaign",
            arch: /* xml */ `
                <kanban>
                    <templates>
                        <t t-name="card">
                            <field name="name"/>
                            <a href="#" title="Leads" role="button" type="object"
                                name="action_redirect_to_leads_opportunities"
                                class="btn-outline-primary rounded-pill me-1 order-3">
                                <span class="badge">Leads</span>
                            </a>
                            <a type="object" name="some_other_method">Other</a>
                        </t>
                    </templates>
                </kanban>`,
        });
        const crmAnchor = ".o_kanban_record a[name='action_redirect_to_leads_opportunities']";
        const otherAnchor = ".o_kanban_record a[name='some_other_method']";
        expect(crmAnchor).toHaveCount(1);
        expect(otherAnchor).toHaveCount(1);
        const crmButton = buttons.find(
            ({ clickParams }) => clickParams.name === "action_redirect_to_leads_opportunities"
        );
        expect(crmButton.props.tag).toBe("a");

        // Online, both anchors are usable and run their method.
        for (const anchor of [crmAnchor, otherAnchor]) {
            expect(anchor).not.toHaveAttribute("disabled");
            expect(anchor).not.toHaveClass("o_disabled_offline");
        }
        await contains(crmAnchor).click();
        await contains(otherAnchor).click();
        expect.verifySteps([
            "doActionButton:action_redirect_to_leads_opportunities",
            "doActionButton:some_other_method",
        ]);
        // Taken once the pointer has shown the anchor's tooltip, which blanks its native title.
        const onlineMarkup = queryOne(crmAnchor).outerHTML;

        // Offline, only the CRM anchor is disabled, and it keeps its own classes.
        await setOffline(true);
        expect(isDisabledOffline(crmAnchor)).toBe(true);
        expect(crmAnchor).toHaveClass(["btn-outline-primary", "rounded-pill"]);
        expect(otherAnchor).not.toHaveAttribute("disabled");
        expect(otherAnchor).not.toHaveClass("o_disabled_offline");
        // The CRM anchor is inert by DOM click, by Enter on the focused anchor (it has no hotkey)
        // and by a direct call without any DOM event, each once the previous debounce window has
        // passed.
        await advanceTime(300);
        queryOne(crmAnchor).click();
        await animationFrame();
        await advanceTime(300);
        queryOne(crmAnchor).focus();
        expect(crmAnchor).toBeFocused();
        await press("Enter");
        await animationFrame();
        await advanceTime(300);
        await crmButton.onClick();
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);
        // The other campaign anchor keeps its framework handling.
        await contains(otherAnchor).click();
        expect.verifySteps(["doActionButton:some_other_method"]);

        // Back online, the CRM anchor is usable and rendered as before.
        await setOffline(false);
        expect(crmAnchor).not.toHaveAttribute("disabled");
        expect(crmAnchor).not.toHaveClass("o_disabled_offline");
        expect(queryOne(crmAnchor).outerHTML).toBe(onlineMarkup);
        await advanceTime(300);
        await contains(crmAnchor).click();
        expect.verifySteps(["doActionButton:action_redirect_to_leads_opportunities"]);
    });

    test.tags("desktop");
    test("DISABLE anchor presentation is CRM-scoped", async () => {
        expect(CRM_OFFLINE_MODELS.includes("res.partner")).toBe(false);
        expect(
            CRM_FOREIGN_DISABLED_BUTTONS.some(
                ([model, name]) => model === "res.partner" && name === "action_partner_custom"
            )
        ).toBe(false);
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        mockViewButtonActions();
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        // A partner card with an object anchor CRM does not list, and the CRM-listed
        // opportunities method drawn as an anchor.
        await mountView({
            type: "kanban",
            resModel: "res.partner",
            domain: [["id", "=", serverState.partnerId]],
            arch: /* xml */ `
                <kanban>
                    <templates>
                        <t t-name="card">
                            <field name="name"/>
                            <a type="object" name="action_partner_custom">Custom</a>
                            <a type="object" name="action_view_opportunity">Opportunities</a>
                        </t>
                    </templates>
                </kanban>`,
        });
        const customAnchor = ".o_kanban_record a[name='action_partner_custom']";
        const crmAnchor = ".o_kanban_record a[name='action_view_opportunity']";
        expect(customAnchor).toHaveCount(1);
        expect(crmAnchor).toHaveCount(1);

        await setOffline(true);
        // Only the listed CRM method is disabled: the partner's own anchor is untouched.
        expect(isDisabledOffline(crmAnchor)).toBe(true);
        expect(customAnchor).not.toHaveAttribute("disabled");
        expect(customAnchor).not.toHaveClass("o_disabled_offline");
        // A click on the partner's anchor still reaches the framework handling; one on the CRM
        // anchor is inert.
        await contains(customAnchor).click();
        queryOne(crmAnchor).click();
        await animationFrame();
        expect.verifySteps(["doActionButton:action_partner_custom"]);

        await setOffline(false);
        for (const anchor of [crmAnchor, customAnchor]) {
            expect(anchor).not.toHaveAttribute("disabled");
            expect(anchor).not.toHaveClass("o_disabled_offline");
        }
    });

    test.tags("desktop");
    test("DISABLE anchors already disabled online keep their own disabled state offline and after reconnect", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        // The campaign card was visited online: the framework does not dim it as uncached.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        const buttons = captureInstances(ViewButton);
        // Three leads/opportunities anchors (inventory B34) on one campaign card: one disabled by a
        // static arch attribute, one by a bound expression, and one enabled.
        await mountView({
            type: "kanban",
            resModel: "utm.campaign",
            arch: /* xml */ `
                <kanban>
                    <templates>
                        <t t-name="card">
                            <field name="name"/>
                            <a type="object" name="action_redirect_to_leads_opportunities"
                                class="o_test_static" disabled="1">Static</a>
                            <a type="object" name="action_redirect_to_leads_opportunities"
                                class="o_test_bound" t-att-disabled="true">Bound</a>
                            <a type="object" name="action_redirect_to_leads_opportunities"
                                class="o_test_enabled">Enabled</a>
                        </t>
                    </templates>
                </kanban>`,
        });
        const selectorOf = (name) => `.o_kanban_record a.o_test_${name}`;
        const buttonOf = (name) =>
            buttons.findLast(({ props }) => props.className.includes(`o_test_${name}`));
        const disabledNames = ["static", "bound"];
        const allNames = [...disabledNames, "enabled"];
        // The static attribute reaches the view button as a string, the bound expression as a
        // boolean; both render the `disabled` attribute.
        expect(buttonOf("static").props.disabled).toBe("1");
        expect(buttonOf("bound").props.disabled).toBe(true);
        expect(buttonOf("enabled").props.disabled).toBe(undefined);
        for (const name of allNames) {
            expect(selectorOf(name)).toHaveCount(1);
            expect(buttonOf(name).props.tag).toBe("a");
        }

        // Online: the two anchors render their own disabled state, none is marked offline.
        for (const name of disabledNames) {
            expect(selectorOf(name)).toHaveAttribute("disabled");
            expect(selectorOf(name)).not.toHaveClass("o_disabled_offline");
        }
        expect(selectorOf("enabled")).not.toHaveAttribute("disabled");
        expect(selectorOf("enabled")).not.toHaveClass("o_disabled_offline");
        const onlineMarkup = Object.fromEntries(
            allNames.map((name) => [name, queryOne(selectorOf(name)).outerHTML])
        );

        // Offline: only the enabled anchor is marked; the disabled ones are left as they were.
        await setOffline(true);
        for (const name of disabledNames) {
            expect(selectorOf(name)).toHaveAttribute("disabled");
            expect(selectorOf(name)).not.toHaveClass("o_disabled_offline");
            expect(queryOne(selectorOf(name)).outerHTML).toBe(onlineMarkup[name]);
            expect(Boolean(buttonOf(name).disabled)).toBe(true);
        }
        expect(isDisabledOffline(selectorOf("enabled"))).toBe(true);
        expect(buttonOf("enabled").disabled).toBe(true);

        // Back online: the disabled anchors are still disabled and rendered as before, the enabled
        // anchor is cleared; the DOM agrees with every component.
        await setOffline(false);
        for (const name of disabledNames) {
            expect(selectorOf(name)).toHaveAttribute("disabled");
            expect(selectorOf(name)).not.toHaveClass("o_disabled_offline");
            expect(Boolean(buttonOf(name).disabled)).toBe(true);
        }
        expect(selectorOf("enabled")).not.toHaveAttribute("disabled");
        expect(selectorOf("enabled")).not.toHaveClass("o_disabled_offline");
        expect(Boolean(buttonOf("enabled").disabled)).toBe(false);
        for (const name of allNames) {
            expect(queryOne(selectorOf(name)).outerHTML).toBe(onlineMarkup[name]);
        }
        expect.verifySteps([]);
    });

    test.tags("desktop");
    test("DISABLE anchor whose own disabled state changes while offline renders that state after reconnect", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["utm.campaign/web_save"]);
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        const buttons = captureInstances(ViewButton);
        // Two leads/opportunities anchors whose own disabled state follows the campaign's flag:
        // "locking" becomes disabled and "unlocking" becomes enabled when the flag is set.
        await mountView({
            type: "kanban",
            resModel: "utm.campaign",
            arch: /* xml */ `
                <kanban>
                    <field name="is_auto_campaign"/>
                    <templates>
                        <t t-name="card">
                            <field name="name"/>
                            <a type="object" name="action_redirect_to_leads_opportunities"
                                class="o_test_locking"
                                t-att-disabled="record.is_auto_campaign.raw_value">Locking</a>
                            <a type="object" name="action_redirect_to_leads_opportunities"
                                class="o_test_unlocking"
                                t-att-disabled="!record.is_auto_campaign.raw_value">Unlocking</a>
                        </t>
                    </templates>
                </kanban>`,
        });
        const locking = ".o_kanban_record a.o_test_locking";
        const unlocking = ".o_kanban_record a.o_test_unlocking";
        const lockingButton = () =>
            buttons.findLast(({ props }) => props.className.includes("o_test_locking"));
        const unlockingButton = () =>
            buttons.findLast(({ props }) => props.className.includes("o_test_unlocking"));
        expect(locking).toHaveCount(1);
        expect(unlocking).toHaveCount(1);
        expect(lockingButton().props.disabled).toBe(false);
        expect(unlockingButton().props.disabled).toBe(true);

        expect(locking).not.toHaveAttribute("disabled");
        expect(unlocking).toHaveAttribute("disabled");
        for (const anchor of [locking, unlocking]) {
            expect(anchor).not.toHaveClass("o_disabled_offline");
        }

        // Offline: the enabled anchor is marked, the disabled one keeps its own state.
        await setOffline(true);
        expect(isDisabledOffline(locking)).toBe(true);
        expect(unlocking).toHaveAttribute("disabled");
        expect(unlocking).not.toHaveClass("o_disabled_offline");

        // The flag is set while offline: the framework queues the campaign's save, and each anchor
        // swaps between its own disabled state and the offline mark.
        await lockingButton().props.record.update({ is_auto_campaign: true });
        await animationFrame();
        expect.verifySteps(["utm.campaign/web_save"]); // answered offline, then queued
        expect(queuedCalls("utm.campaign", "web_save").map(({ args }) => args)).toEqual([
            [[1], { is_auto_campaign: true }],
        ]);
        expect(locking).toHaveAttribute("disabled");
        expect(locking).not.toHaveClass("o_disabled_offline");
        expect(isDisabledOffline(unlocking)).toBe(true);

        // Back online: the anchor now disabled by its own state stays disabled, the other one is
        // enabled, and the DOM agrees with both components.
        await setOffline(false);
        await expect.waitForSteps(["utm.campaign/web_save"]); // replayed on reconnect
        expect(locking).toHaveAttribute("disabled");
        expect(locking).not.toHaveClass("o_disabled_offline");
        expect(lockingButton().disabled).toBe(true);
        expect(unlocking).not.toHaveAttribute("disabled");
        expect(unlocking).not.toHaveClass("o_disabled_offline");
        expect(unlockingButton().disabled).toBe(false);
    });

    test.tags("desktop");
    test("inventory DISABLE buttons in CRM views: disabled offline, re-enabled online", async () => {
        expect(OfflinePlugin.SELECTORS_TO_DISABLE).toEqual([
            BASE_OFFLINE_SELECTOR,
            ...CRM_OFFLINE_DISABLED_SELECTORS,
        ]);
        expect(CRM_OFFLINE_DISABLED_SELECTORS).toHaveLength(4);

        // As in the form header test, the lead is in the last stage, so that `alt+x` is the
        // hotkey of Restore and not the statusbar's "Move to next stage" command.
        CrmLead._records[0].stage_id = 3;
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        mockViewButtonActions();
        const buttons = captureInstances(ViewButton);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        const partnerId = serverState.partnerId; // the current user's partner
        /**
         * The hotkeys of a wizard confirm button: its `data-hotkey="q"` (`alt+q`), as in the
         * production wizard arch, and the dialog's `control+Enter`, which clicks the first button
         * of the dialog footer.
         *
         * @param {string} name
         */
        const wizardHotkeys = (name) => [
            [["alt", "q"], name],
            [["control", "Enter"], name],
        ];
        /**
         * Every DISABLE `<button>` row of the offline inventory, by the CRM view that renders it.
         * `select` marks the lists whose header buttons need a selection, and `hotkeys` lists the
         * `[keys, button name]` hotkeys of the row. Only the lead form header buttons
         * (`alt+w/v/x/l`) and the wizard confirm buttons have one in production; the other
         * buttons (meeting, duplicates and blacklist buttons, list header and row buttons, lost
         * reason, team, settings, partner and UTM campaign buttons) have none, so there is no
         * hotkey route to exercise for them.
         */
        const views = [
            {
                rows: "B1-B6, B9, B10",
                res_model: "crm.lead",
                res_id: 1,
                views: [[false, "form"]],
                hotkeys: Object.entries(LEAD_HEADER_HOTKEYS).map(([key, name]) => [
                    ["alt", key],
                    name,
                ]),
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
                hotkeys: wizardHotkeys("action_lost_reason_apply"),
                names: ["action_lost_reason_apply"],
            },
            {
                rows: "B37",
                res_model: "crm.lead.pls.update",
                views: [[false, "form"]],
                target: "new",
                hotkeys: wizardHotkeys("action_update_crm_lead_probabilities"),
                names: ["action_update_crm_lead_probabilities"],
            },
            {
                rows: "B38",
                res_model: "crm.lead2opportunity.partner.mass",
                views: [[false, "form"]],
                target: "new",
                hotkeys: wizardHotkeys("action_apply"),
                names: ["action_apply"],
            },
            {
                rows: "B39",
                res_model: "crm.merge.opportunity",
                views: [[false, "form"]],
                target: "new",
                hotkeys: wizardHotkeys("action_merge"),
                names: ["action_merge"],
            },
        ];
        // `res.config.settings` is not a CRM model: its buttons are guarded only through
        // `CRM_FOREIGN_DISABLED_BUTTONS`, which lists exactly the buttons the settings fixture
        // renders, under the names of the production settings view (asserted by the lane-1
        // `test_offline_availability_view_wiring`).
        const settingsRow = views.find(({ res_model }) => res_model === "res.config.settings");
        expect(CRM_OFFLINE_MODELS.includes(settingsRow.res_model)).toBe(false);
        const guardedSettings = CRM_FOREIGN_DISABLED_BUTTONS.filter(
            ([model]) => model === settingsRow.res_model
        ).map(([, name]) => name);
        expect(guardedSettings.sort()).toEqual([...settingsRow.names].sort());

        for (const { rows, select, names, target, hotkeys = [], ...view } of views) {
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
            // Online, each hotkey runs its button, and Enter on a focused button clicks it. Enter
            // on a button of a list row opens the row's record instead (the list's keyboard
            // navigation), so the row buttons are only checked offline, by the focus.
            for (const [keys, name] of hotkeys) {
                await press(keys);
                await animationFrame();
                expect.verifySteps([`doActionButton:${name}`]);
            }
            for (const name of names) {
                const el = queryAll(`button[name='${name}']`).find(
                    (button) => !button.closest(".o_data_row")
                );
                if (el) {
                    el.focus();
                    expect(el).toBeFocused({ message: `${rows}: ${name}` });
                    await press("Enter");
                    await animationFrame();
                    expect.verifySteps([`doActionButton:${name}`]);
                }
            }
            await setOffline(true);
            for (const name of names) {
                for (const el of queryAll(`button[name='${name}']`)) {
                    expect(isDisabledOffline(el)).toBe(true, { message: `${rows}: ${name}` });
                }
            }
            // Keyboard: Enter and Space where the focus was left online, then the hotkeys, which
            // only reach the disabled buttons through `click()`, a no-op on a disabled button.
            // Last, every button: none can take the keyboard focus while disabled, so neither
            // Enter nor Space reaches it.
            await pressEnterAndSpace();
            for (const [keys] of hotkeys) {
                await press(keys);
                await animationFrame();
            }
            document.activeElement.blur();
            for (const name of names) {
                for (const el of queryAll(`button[name='${name}']`)) {
                    el.focus();
                    expect(el).not.toBeFocused({ message: `${rows}: ${name}` });
                    await pressEnterAndSpace();
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
        watchOfflineRpcs();
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
        const crmButton = "button[name='action_view_opportunity']";
        const customButton = "button[name='action_partner_custom']";
        queryOne(crmButton).focus();
        expect(crmButton).toBeFocused();
        await press("Enter");
        await animationFrame();
        expect.verifySteps(["doActionButton:action_view_opportunity"]);

        await setOffline(true);
        // The framework disables both buttons offline: neither carries the offline attribute.
        expect(isDisabledOffline(crmButton)).toBe(true);
        expect(isDisabledOffline(customButton)).toBe(true);
        // Keyboard: Enter and Space where the focus was left online, then on the CRM button,
        // which cannot take the keyboard focus while disabled. It has no hotkey in the production
        // partner view, so there is no hotkey route to exercise.
        await pressEnterAndSpace();
        document.activeElement.blur();
        queryOne(crmButton).focus();
        expect(crmButton).not.toBeFocused();
        await pressEnterAndSpace();
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        // The foreign button is out of the keyboard's reach in the same way, because the
        // framework disables it: what shows the scoping is a direct call, which still reaches
        // `handleViewButton`.
        const button = (name) => buttons.find(({ clickParams }) => clickParams.name === name);
        // A button CRM does not list keeps its framework handling (the framework only dims it).
        await button("action_partner_custom").onClick();
        // The CRM button rendered on the same model is inert.
        await button("action_view_opportunity").onClick();
        await animationFrame();
        expect.verifySteps(["doActionButton:action_partner_custom"]);

        await setOffline(false);
        expect(crmButton).toBeEnabled();
        expect(customButton).toBeEnabled();
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

    const RECURRING_REVENUE_GROUP = "crm.group_use_recurring_revenues";
    const MRR_AGGREGATE = ".o_kanban_counter .o_animated_number[data-tooltip='Expected MRR']";

    test("recurring revenue aggregate: cold offline mount without a known group answer probes once on reconnect", async () => {
        // Offline, the kanban rendered again from its cache refreshes its groups in the
        // background, which fails with a `ConnectionLostError`, as the framework does.
        expect.errors(1);
        // A single pipeline column.
        for (const record of CrmLead._records) {
            record.stage_id = 1;
        }
        const setOffline = mockOffline();
        keepPingsFailing();
        watchGroupProbes([RECURRING_REVENUE_GROUP]);
        const startSession = visitInEarlierSession(RECURRING_REVENUE_GROUP);
        const progressBars = captureInstances(CrmColumnProgress);
        await mountWithCleanup(WebClient);
        // The pipeline and its list are cached by visits of an earlier session.
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await getService("action").switchView("list");
        expect.verifySteps([]);

        // The session starts offline: the progress bar mounted from the cache asks nothing and
        // hides the aggregate (not shown as 0, no "MRR" label).
        startSession();
        await setOffline(true);
        await getService("action").switchView("kanban");
        await animationFrame();
        expect(".o_kanban_group").toHaveCount(1);
        const bar = progressBars.at(-1);
        expect(status(bar)).toBe("mounted");
        expect(bar.probedRecurringRevenue()).toBe(null);
        expect(bar.showRecurringRevenue).toBe(false);
        expect(MRR_AGGREGATE).toHaveCount(0);
        expect(".o_kanban_counter").not.toHaveText(/\+|MRR/);
        await runAllTimers();
        expect(bar.probedRecurringRevenue()).toBe(null);
        expect.verifySteps([]);
        expect.verifyErrors(["/web/dataset/call_kw/crm.lead/web_read_group"]);
        expect(queuedEntries()).toHaveLength(0);

        // Back online: one probe reaches the server, and the bar renders the aggregate the
        // progress bar computes. Its counter waits for the progress bar counts, which the
        // framework could not read offline (`read_progress_bar` is not cached): the next load of
        // the pipeline shows the value, answered from the probe, without asking again.
        await setOffline(false);
        await expect.waitForSteps([`has_group:${RECURRING_REVENUE_GROUP}`]);
        await animationFrame();
        expect(bar.probedRecurringRevenue()).toBe(true);
        expect(bar.showRecurringRevenue).toBe(true);
        const { group, progressBarState } = bar.props;
        const rrField = progressBarState.progressAttributes.recurring_revenue_sum_field;
        expect(bar.getRecurringRevenueGroupAggregate(group)).toEqual(
            progressBarState.getAggregateValue(group, rrField)
        );
        expect(bar.getRecurringRevenueGroupAggregate(group).title).toBe("Expected MRR");
        await getService("action").switchView("list");
        await getService("action").switchView("kanban");
        expect(MRR_AGGREGATE).toHaveText("+15");
        expect(progressBars.at(-1).probedRecurringRevenue()).toBe(true);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test("recurring revenue aggregate: a mount probe that loses the connection hides the aggregate, also after reconnect", async () => {
        // A single pipeline column.
        for (const record of CrmLead._records) {
            record.stage_id = 1;
        }
        const connection = mockConnectionDrop();
        const answerProbe = holdGroupProbe(RECURRING_REVENUE_GROUP);
        watchGroupProbes([RECURRING_REVENUE_GROUP]);
        // Once the column is mounted, each group question is stepped, whether or not it reaches
        // the network. Each failure the progress bar reports is stepped too.
        let stepGroupQuestions = false;
        patchWithCleanup(user, {
            hasGroup(group) {
                if (stepGroupQuestions && group === RECURRING_REVENUE_GROUP) {
                    expect.step(`hasGroup:${group}`);
                }
                return super.hasGroup(...arguments);
            },
        });
        patchWithCleanup(console, {
            warn(message, error) {
                if (String(message).startsWith("CRM:")) {
                    expect.step(`warn:${message}: ${error?.message}`);
                    return;
                }
                return super.warn(...arguments);
            },
        });
        const progressBars = captureInstances(CrmColumnProgress);
        await mountWithCleanup(WebClient);
        const pipelineDisplayed = getService("action").doAction(PIPELINE_ACTION_ID);
        await expect.waitForSteps([`has_group:${RECURRING_REVENUE_GROUP}`]);
        await animationFrame();

        // The connection drops while the mount probe is in flight (every request fails from now
        // on, the reconnection pings included): the column still mounts, the aggregate is hidden
        // (not shown as 0, no "MRR" label), and nothing is raised or reported.
        connection.offline = true;
        answerProbe(new Response("", { status: 502 }));
        await pipelineDisplayed;
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(".o_kanban_group").toHaveCount(1);
        const bar = progressBars.at(-1);
        expect(status(bar)).toBe("mounted");
        expect(bar.probedRecurringRevenue()).toBe(null);
        expect(bar.showRecurringRevenue).toBe(false);
        expect(MRR_AGGREGATE).toHaveCount(0);
        expect(".o_kanban_counter").not.toHaveText(/\+|MRR/);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // The connection returns and a reconnection ping succeeds. The progress bar asks again,
        // but the session's group cache returns the failed answer without a request: the
        // aggregate stays hidden until the page is reloaded. Received online, that replayed
        // failure is reported as a warning only.
        stepGroupQuestions = true;
        connection.offline = false;
        await runAllTimers();
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect.verifySteps([
            `hasGroup:${RECURRING_REVENUE_GROUP}`,
            `warn:CRM: recurring revenue group probe failed: Connection to "/web/dataset/call_kw/res.users/has_group" couldn't be established or was interrupted`,
        ]);
        expect(bar.probedRecurringRevenue()).toBe(null);
        expect(bar.showRecurringRevenue).toBe(false);
        expect(MRR_AGGREGATE).toHaveCount(0);
        expect(".o_kanban_counter").not.toHaveText(/\+|MRR/);
        expect(queuedEntries()).toHaveLength(0);
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
        // So does Enter on the focused button.
        queryOne(".o_crm_pls_tooltip_button").focus();
        expect(".o_crm_pls_tooltip_button").toBeFocused();
        await press("Enter");
        await animationFrame();
        expect.verifySteps(["crm.lead/prepare_pls_tooltip_data", "crm.lead/web_read"]);
        expect(".o_crm_pls_tooltip").toHaveCount(1);
        plsButton.popover.close();
        await animationFrame();
        expect(".o_crm_pls_tooltip").toHaveCount(0);

        // A pending edit: a click that got through would save it first.
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (unsaved)");
        await setOffline(true);
        expect(isDisabledOffline(".o_crm_pls_tooltip_button")).toBe(true);
        // Keyboard: the disabled button cannot take the keyboard focus, so neither Enter nor
        // Space reaches it. The edited name gives the focus up first, so that the keys are not
        // typed into it. The button has no hotkey, so there is no hotkey route to exercise.
        queryOne(".o_field_widget[name=name] input").blur();
        queryOne(".o_crm_pls_tooltip_button").focus();
        expect(".o_crm_pls_tooltip_button").not.toBeFocused();
        await pressEnterAndSpace();
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
     * @returns {ScheduledMessage | undefined} the mounted one showing a scheduled message of
     *  `model`
     */
    function mountedScheduledMessage(instances, model) {
        return instances.findLast(
            (instance) =>
                status(instance) === "mounted" &&
                instance.props.scheduledMessage.thread?.model === model
        );
    }

    /**
     * Asserts the presentation of the Send Now, Edit and Cancel controls of the one scheduled
     * message shown: disabled (`disabled o_disabled_offline`, `aria-disabled="true"`), or
     * rendered without any of these.
     *
     * @param {boolean} disabled
     */
    function expectScheduledMessageActionsDisabled(disabled) {
        for (const label of ["Send Now", "Edit", "Cancel"]) {
            const action = `.o-mail-Scheduled-Message-buttons > span.btn:contains('${label}')`;
            expect(action).toHaveCount(1);
            if (disabled) {
                expect(action).toHaveClass(["disabled", "o_disabled_offline"]);
                expect(action).toHaveAttribute("aria-disabled", "true");
            } else {
                expect(action).not.toHaveClass("disabled");
                expect(action).not.toHaveClass("o_disabled_offline");
                expect(action).not.toHaveAttribute("aria-disabled");
            }
        }
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

    test("lead message offline: no context menu, long-press sheet or placeholder glyph; other threads keep them", async () => {
        const { pyEnv } = await seedLeadThread();
        const partnerId = pyEnv["res.partner"].create({ name: "Customer" });
        pyEnv["mail.message"].create({
            author_id: serverState.partnerId,
            body: "Hello partner",
            message_type: "comment",
            model: "res.partner",
            res_id: partnerId,
        });
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        const messages = captureInstances(Message);
        const messageActions = captureInstances(MessageAction);
        await start();
        const PARTNER_CHATTER_FORM_ARCH = /* xml */ `
            <form>
                <sheet><field name="name"/></sheet>
                <chatter/>
            </form>`;
        const leadMessage = ".o-mail-Message:contains('Hello lead')";
        const partnerMessage = ".o-mail-Message:contains('Hello partner')";
        const selectedMessage = ".o-mail-Message.o-selected";
        // The `mail.Message.emptyQuickAction` placeholder glyph.
        const placeholder = "[data-icon='question_mark']";
        // The message context menu and mobile actions sheet, as a popover or a bottom sheet. The
        // discuss class sets them apart from the lead form's own menus, such as the many2one
        // suggestions a small screen shows inline offline.
        const actionsMenu = ".o-dropdown--menu.o-discuss-dropdownMenu";
        /**
         * @param {string} model
         * @returns {Message} the mounted message component showing a message of `model`
         */
        const mountedMessage = (model) =>
            messages.findLast(
                (message) =>
                    status(message) === "mounted" && message.props.message.thread?.model === model
            );
        /** Waits for the one actions menu, and asserts that it lists message actions. */
        const expectActionsMenuListingActions = async () => {
            await mailContains(actionsMenu);
            expect(queryAll(`${actionsMenu} .o-dropdown-item`).length).toBeGreaterThan(0);
        };

        // Desktop OS, online: a right-click on a lead message opens its context menu, listing the
        // message actions, and selects the message.
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(leadMessage);
        const leadComponent = mountedMessage("crm.lead");
        // The message reuses the offline hook result of the actions it owns.
        const ownedActions = messageActions.filter(({ owner }) => owner === leadComponent);
        expect(ownedActions.length).toBeGreaterThan(0);
        for (const action of ownedActions) {
            expect(action.crmOffline).toBe(leadComponent.crmOffline, { message: action.id });
        }
        await rightClick(leadMessage);
        await expectActionsMenuListingActions();
        expect(selectedMessage).toHaveCount(1);

        // The connection drops: the context menu opened online closes and the selection clears.
        await setOffline(true);
        await animationFrame();
        await mailContains(actionsMenu, { count: 0 });
        expect(selectedMessage).toHaveCount(0);
        await mailContains(".o-mail-Message[data-right-clicking]", { count: 0 });

        // Offline, a right-click opens no menu and selects nothing: the browser's own menu shows.
        const contextMenuEvent = (await rightClick(leadMessage)).get("contextmenu");
        await animationFrame();
        expect(contextMenuEvent.defaultPrevented).toBe(false);
        expect(actionsMenu).toHaveCount(0);
        expect(selectedMessage).toHaveCount(0);
        expect(".o-mail-Message[data-right-clicking]").toHaveCount(0);
        expect(mountedMessage("crm.lead").rightClickMenu.menuProps.dropdownState.isOpen).toBe(
            false
        );
        // Offline, a hovered lead message renders no placeholder glyph next to its (no) actions.
        await hover(leadMessage);
        expect(`${leadMessage} .o-mail-Message-actions`).toHaveCount(1);
        expect(`${leadMessage} ${placeholder}`).toHaveCount(0);

        // A partner message offline still opens its context menu, listing its actions.
        await setOffline(false);
        await openFormView("res.partner", partnerId, { arch: PARTNER_CHATTER_FORM_ARCH });
        await mailContains(partnerMessage);
        await setOffline(true);
        await animationFrame();
        await rightClick(partnerMessage);
        await expectActionsMenuListingActions();
        expect(`${selectedMessage}:contains('Hello partner')`).toHaveCount(1);
        mountedMessage("res.partner").rightClickMenu.menuProps.dropdownState.close();
        await mailContains(actionsMenu, { count: 0 });

        // Mobile OS, online: a long press on a lead message opens its actions sheet, and the
        // message renders the upstream placeholder after its actions.
        await setOffline(false);
        mockUserAgent("android");
        mockTouch(true);
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(leadMessage);
        expect(`${leadMessage} ${placeholder}`).toHaveCount(1);
        await pointerDown(leadMessage);
        await advanceTime(LONG_PRESS_DELAY);
        await expectActionsMenuListingActions();
        expect(mountedMessage("crm.lead").optionsDropdown.isOpen).toBe(true);

        // The connection drops: the sheet opened online closes.
        await setOffline(true);
        await animationFrame();
        await mailContains(actionsMenu, { count: 0 });
        expect(mountedMessage("crm.lead").optionsDropdown.isOpen).toBe(false);

        // Offline, no placeholder glyph, and neither a long press nor a direct call opens a sheet.
        expect(`${leadMessage} ${placeholder}`).toHaveCount(0);
        await pointerDown(leadMessage);
        await advanceTime(LONG_PRESS_DELAY);
        mountedMessage("crm.lead").openMobileActions(NO_EVENT);
        await animationFrame();
        expect(actionsMenu).toHaveCount(0);
        expect(mountedMessage("crm.lead").optionsDropdown.isOpen).toBe(false);

        // A partner message offline on a mobile OS keeps its placeholder and its actions sheet.
        await setOffline(false);
        await openFormView("res.partner", partnerId, { arch: PARTNER_CHATTER_FORM_ARCH });
        await mailContains(partnerMessage);
        await setOffline(true);
        await animationFrame();
        expect(`${partnerMessage} ${placeholder}`).toHaveCount(1);
        await pointerDown(partnerMessage);
        await advanceTime(LONG_PRESS_DELAY);
        await expectActionsMenuListingActions();
        expect(mountedMessage("res.partner").optionsDropdown.isOpen).toBe(true);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
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
        // Online, Send Now, Edit and Cancel render as upstream does.
        expectScheduledMessageActionsDisabled(false);

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
        // Offline, Send Now, Edit and Cancel are shown disabled, as the framework shows the
        // buttons it disables.
        expectScheduledMessageActionsDisabled(true);

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
        // The clicks leave them disabled.
        expectScheduledMessageActionsDisabled(true);

        // Each reconnection removes the disabled state, and each disconnection restores it.
        await setOffline(false);
        expectScheduledMessageActionsDisabled(false);
        await setOffline(true);
        expectScheduledMessageActionsDisabled(true);

        // Back online, the same handlers reach the server again.
        await setOffline(false);
        expectScheduledMessageActionsDisabled(false);
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

    test("chatter file drop on an offline lead saves, uploads, reloads and queues nothing", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        // Every chatter write and every reload of the lead is stepped, online or offline.
        watchRpcs([...MAIL_WRITES, "crm.lead/web_read"]);
        const chatters = captureInstances(Chatter);
        const leadChatter = () =>
            chatters.findLast((c) => c.threadModel() === "crm.lead" && status(c) === "mounted");
        const file = new File(["hello"], "dropped.txt", { type: "text/plain" });
        const dropFile = async () => {
            await dragenterFiles(".o-mail-Chatter", [file]);
            await dropFiles(".o-Dropzone", [file]);
            await animationFrame();
        };
        // The chatter saves and reloads the form once its attachments change.
        const arch = /* xml */ `
            <form js_class="crm_form">
                <sheet>
                    <field name="name"/>
                </sheet>
                <chatter reload_on_post="True" reload_on_attachment="True"/>
            </form>`;
        await start();

        // 1. A saved lead with unsaved edits, offline: the drop saves, uploads and reloads
        // nothing, so the edits stay in the form.
        await openFormView("crm.lead", 1, { arch });
        await mailContains(".o-mail-Chatter");
        expect.verifySteps(["crm.lead/web_read"]);
        let chatter = leadChatter();
        const savedLead = chatter.webChatterProps.record;
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (unsaved)");
        await setOffline(true);
        await animationFrame();
        await dropFile();
        expect.verifySteps([]);
        expect(queuedEntries()).toHaveLength(0);
        expect(savedLead.dirty).toBe(true);
        expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 (unsaved)");
        // Called directly, the parent reload and the record-save callback do nothing.
        expect(chatter.reloadParentView()).toBe(undefined);
        const offlineSaveRecord = chatter.webChatterProps.saveRecord;
        expect(await offlineSaveRecord()).toBe(false);
        await animationFrame();
        expect.verifySteps([]);
        expect(queuedEntries()).toHaveLength(0);
        expect(savedLead.dirty).toBe(true);

        // 2. Online again, the callback no longer refuses: it is the chatter's stable wrapper of
        // the form's own save, and the drop uploads, then saves and reloads the lead through it.
        await setOffline(false);
        const onlineSaveRecord = chatter.webChatterProps.saveRecord;
        expect(onlineSaveRecord).not.toBe(offlineSaveRecord);
        expect(onlineSaveRecord).not.toBe(
            Object.getPrototypeOf(chatter.webChatterProps).saveRecord
        );
        expect(chatter.webChatterProps.saveRecord).toBe(onlineSaveRecord);
        await dropFile();
        await expect.waitForSteps([
            "/mail/attachment/upload",
            "crm.lead/web_save",
            "crm.lead/web_read",
        ]);
        expect(savedLead.dirty).toBe(false);
        expect(queuedEntries()).toHaveLength(0);

        // 3. A valid unsaved lead, offline: the drop does not save it, so it stays new, and it
        // uploads nothing and switches no panel.
        await openFormView("crm.lead", undefined, { arch });
        await mailContains(".o-mail-Chatter");
        chatter = leadChatter();
        expect(chatter.webChatterProps.record.isNew).toBe(true);
        await contains(".o_field_widget[name=name] input").edit("Dropped lead");
        await setOffline(true);
        await animationFrame();
        const panel = chatter.state.activePanel;
        await dropFile();
        expect.verifySteps([]);
        expect(queuedEntries()).toHaveLength(0);
        expect(chatter.webChatterProps.record.isNew).toBe(true);
        expect(chatter.state.activePanel).toBe(panel);
        expect(".o_field_widget[name=name] input").toHaveValue("Dropped lead");

        // 4. Online again, the same drop saves the new lead before uploading, as before.
        await setOffline(false);
        await dropFile();
        await expect.waitForSteps([
            "crm.lead/web_save",
            "/mail/attachment/upload",
            "crm.lead/web_read",
        ]);
        expect(leadChatter().webChatterProps.record.isNew).toBe(false);
        expect(queuedEntries()).toHaveLength(0);
    });

    /**
     * Holds the next `crm.lead/web_save` request in flight once armed, until the test answers it.
     * Register it before the route watchers: they run first, so they still step the held request.
     *
     * @returns {() => PromiseWithResolvers<Response>} arms the hold for the next lead save
     */
    function holdLeadSaves() {
        let held = null;
        onRpc("/web/dataset/call_kw/crm.lead/web_save", () => {
            if (held) {
                const answer = held.promise;
                held = null;
                return answer;
            }
        });
        return () => (held = Promise.withResolvers());
    }

    /**
     * Answers a held request as a lost connection, and makes every following request fail too
     * until the test reconnects: the client goes offline on that answer and stays offline.
     *
     * @param {{ offline: boolean }} connection the state of `mockConnectionDrop()`
     * @param {PromiseWithResolvers<Response>} held
     */
    function loseConnection(connection, held) {
        connection.offline = true;
        held.resolve(new Response("", { status: 502 }));
    }

    /**
     * @param {Chatter[]} chatters captured chatter components
     * @returns {Chatter | undefined} the mounted lead chatter
     */
    function mountedLeadChatter(chatters) {
        return chatters.findLast((c) => c.threadModel() === "crm.lead" && status(c) === "mounted");
    }

    test("chatter save of a new lead that loses the connection: a file drop and Attach Files save, upload and queue nothing", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const connection = mockConnectionDrop();
        const holdNextSave = holdLeadSaves();
        // Every chatter write, the lead saves included, and every reload of the lead is stepped.
        watchRpcs([...MAIL_WRITES, "crm.lead/web_read"]);
        const chatters = captureInstances(Chatter);
        const file = new File(["hello"], "dropped.txt", { type: "text/plain" });
        await start();
        await openFormView("crm.lead", undefined, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Chatter");
        const chatter = mountedLeadChatter(chatters);
        const record = chatter.webChatterProps.record;
        expect(record.isNew).toBe(true);
        await contains(".o_field_widget[name=name] input").edit("Dropped lead");
        const panel = chatter.state.activePanel;

        // 1. A file drop started online: the save of the new lead loses the connection, so the
        // drop uploads nothing, switches no panel and queues nothing.
        let held = holdNextSave();
        await dragenterFiles(".o-mail-Chatter", [file]);
        await dropFiles(".o-Dropzone", [file]);
        await expect.waitForSteps(["crm.lead/web_save"]);
        loseConnection(connection, held);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queuedEntries()).toHaveLength(0);
        expect(record.isNew).toBe(true);
        expect(record.dirty).toBe(true);
        expect(chatter.state.activePanel).toBe(panel);
        expect(".o_field_widget[name=name] input").toHaveValue("Dropped lead");
        expect.verifySteps([]);

        // 2. Attach Files started online: the save loses the connection, so the file selection
        // stops (`false`) and nothing is queued.
        connection.offline = false;
        await setOffline(false);
        held = holdNextSave();
        const attaching = chatter.onClickAttachFile();
        await expect.waitForSteps(["crm.lead/web_save"]);
        loseConnection(connection, held);
        await expect(attaching).resolves.toBe(false);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queuedEntries()).toHaveLength(0);
        expect(record.isNew).toBe(true);
        expect(record.dirty).toBe(true);
        expect(chatter.state.activePanel).toBe(panel);
        expect(".o_field_widget[name=name] input").toHaveValue("Dropped lead");
        expect.verifySteps([]);

        // 3. The form's own Save, offline now, still queues the new lead with its edits.
        await contains(".o_form_button_save").click();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save"]);
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args[0]).toEqual([]);
        expect(saves[0].args[1]).toMatchObject({ name: "Dropped lead" });
    });

    test("chatter save of a new lead that loses the connection: Send message, Log note and Schedule Activity queue nothing and open nothing once the lead is saved", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const connection = mockConnectionDrop();
        const holdNextSave = holdLeadSaves();
        watchRpcs(MAIL_WRITES);
        // The schedule-activity dialog opens through the action service: stepped instead.
        mockService("action", {
            doAction(action) {
                if (action?.res_model === "mail.activity.schedule") {
                    expect.step(`doAction:${action.res_model}`);
                    return Promise.resolve();
                }
                return super.doAction(...arguments);
            },
        });
        const chatters = captureInstances(Chatter);
        await start();
        await openFormView("crm.lead", undefined, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Chatter");
        let chatter = mountedLeadChatter(chatters);
        const record = chatter.webChatterProps.record;
        await contains(".o_field_widget[name=name] input").edit("New lead");

        // Each button, clicked online, saves the new lead before opening its composer or dialog;
        // that save loses the connection, so the pending continuation is dropped.
        for (const button of [
            ".o-mail-Chatter-sendMessage",
            ".o-mail-Chatter-logNote",
            ".o-mail-Chatter-activity",
        ]) {
            const held = holdNextSave();
            await mailClick(button);
            await expect.waitForSteps(["crm.lead/web_save"]);
            expect(typeof chatter.onThreadCreated).toBe("function", { message: button });
            loseConnection(connection, held);
            await animationFrame();
            expect(getService(OfflinePlugin).isOffline()).toBe(true, { message: button });
            expect(chatter.onThreadCreated).toBe(null, { message: button });
            expect(chatter.state.composerType).toBe(false, { message: button });
            expect(".o-mail-Chatter .o-mail-Composer").toHaveCount(0);
            expect(".modal").toHaveCount(0);
            expect(record.isNew).toBe(true, { message: button });
            expect(queuedEntries()).toHaveLength(0, { message: button });
            expect(".o_field_widget[name=name] input").toHaveValue("New lead");
            expect.verifySteps([]);
            connection.offline = false;
            await setOffline(false);
        }

        // Online, the form saves the lead: its thread is created, and the dropped continuations
        // open no composer and no schedule-activity dialog.
        await contains(".o_form_button_save").click();
        await expect.waitForSteps(["crm.lead/web_save"]);
        await mailContains(".o-mail-Message:contains('Creating a new record...')", { count: 0 });
        await animationFrame();
        expect(record.isNew).toBe(false);
        chatter = mountedLeadChatter(chatters);
        expect(chatter.state.thread.id).toBe(record.resId);
        expect(chatter.state.composerType).toBe(false);
        expect(".o-mail-Chatter .o-mail-Composer").toHaveCount(0);
        expect(".modal").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // A continuation still pending when a lead thread appears offline is dropped; online it
        // runs.
        const thread = chatter.state.thread;
        await setOffline(true);
        chatter.onThreadCreated = () => expect.step("continuation");
        chatter.changeThread("crm.lead", thread.id);
        expect(chatter.onThreadCreated).toBe(null);
        expect.verifySteps([]);
        await setOffline(false);
        chatter.onThreadCreated = () => expect.step("continuation");
        chatter.changeThread("crm.lead", thread.id);
        expect.verifySteps(["continuation"]);

        // Online with a connected save, Log note on a new lead saves it and opens the composer.
        await openFormView("crm.lead", undefined, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Chatter");
        await contains(".o_field_widget[name=name] input").edit("Connected lead");
        await mailClick(".o-mail-Chatter-logNote");
        await expect.waitForSteps(["crm.lead/web_save"]);
        await mailContains(".o-mail-Chatter .o-mail-Composer");
        expect(mountedLeadChatter(chatters).state.composerType).toBe("note");
        expect(queuedEntries()).toHaveLength(0);
    });

    test("chatter parent reload of an edited lead whose save loses the connection: nothing queued or reloaded, the edits stay", async () => {
        // The form's own offline save below carries the email partner-sync copy as well.
        CrmLead._records[0].partner_email_update = true;
        const setOffline = mockOffline();
        keepPingsFailing();
        const connection = mockConnectionDrop();
        const holdNextSave = holdLeadSaves();
        // Every chatter write, the lead saves included, and every reload of the lead is stepped.
        watchRpcs([...MAIL_WRITES, "crm.lead/web_read"]);
        const chatters = captureInstances(Chatter);
        await start();
        await openFormView("crm.lead", 1, {
            arch: /* xml */ `
                <form js_class="crm_form">
                    <sheet>
                        <field name="name"/>
                        <field name="email_from"/>
                        <field name="partner_email_update" invisible="1"/>
                    </sheet>
                    <chatter reload_on_post="True"/>
                </form>`,
        });
        await mailContains(".o-mail-Chatter");
        expect.verifySteps(["crm.lead/web_read"]);
        const chatter = mountedLeadChatter(chatters);
        const record = chatter.webChatterProps.record;
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (unsaved)");

        // 1. A parent reload called online: its save loses the connection, so the reload
        // resolves without loading the lead, and nothing is queued.
        let held = holdNextSave();
        const reloading = chatter.reloadParentView();
        await expect.waitForSteps(["crm.lead/web_save"]);
        loseConnection(connection, held);
        await expect(reloading).resolves.toBe(undefined);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queuedEntries()).toHaveLength(0);
        expect(record.dirty).toBe(true);
        expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 (unsaved)");
        expect.verifySteps([]);

        // 2. A note posted online reloads the lead (`reload_on_post`): the post succeeds, the
        // reload's save loses the connection, and the edits stay.
        connection.offline = false;
        await setOffline(false);
        await mailClick(".o-mail-Chatter-logNote");
        await mailContains(".o-mail-Composer-input");
        await insertText(".o-mail-Composer-input", "Posted online");
        held = holdNextSave();
        await mailClick(".o-mail-Composer-send:enabled");
        await expect.waitForSteps(["/mail/message/post", "crm.lead/web_save"]);
        loseConnection(connection, held);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        await mailContains(".o-mail-Message:contains('Posted online')");
        expect(queuedEntries()).toHaveLength(0);
        expect(record.dirty).toBe(true);
        expect(".o_field_widget[name=name] input").toHaveValue("Lead 1 (unsaved)");
        expect.verifySteps([]);

        // 3. The form's own Save, offline now, still queues the lead write with the edits and
        // the partner-sync copy.
        await contains(".o_form_button_save").click();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save"]);
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args).toEqual([
            [1],
            { name: "Lead 1 (unsaved)", email_from: "lead1@example.com" },
        ]);
        expect(record.dirty).toBe(false);
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
        // The CRM save-callback guard returns the form's own callback for other models.
        expect(chatter.webChatterProps.saveRecord).toBe(
            Object.getPrototypeOf(chatter.webChatterProps).saveRecord
        );
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
        // A partner scheduled message keeps its Send Now, Edit and Cancel as they are online.
        expectScheduledMessageActionsDisabled(false);
        // A partner scheduled message still asks to confirm its cancellation.
        const partnerScheduledMessage = mountedScheduledMessage(scheduledMessages, "res.partner");
        expect(partnerScheduledMessage.props.scheduledMessage.thread.id).toBe(partnerId);
        partnerScheduledMessage.onClickCancel();
        await mailContains(".modal-footer button:contains('Cancel Message')");
    });

    test("chatter load that loses the connection: a lead chatter keeps what it shows; other errors and other threads still raise", async () => {
        const { pyEnv } = await seedLeadThread();
        const partnerId = pyEnv["res.partner"].create({ name: "Customer" });
        const setOffline = mockOffline();
        keepPingsFailing();
        // Once the lead load loses the connection, every request fails. Registered before the
        // held-load handler below, which runs first and so still answers the request it holds.
        const connection = mockConnectionDrop();
        // The loads under test request what the chatter reloads after followers were added.
        const requestList = ["followers", "suggestedRecipients"];
        // Their thread data request is stepped as `"thread data:<model>"` and held in flight,
        // then answered as the test decides.
        let heldLoad = null;
        onRpc("/mail/store", async (request) => {
            const { params } = await request.clone().json();
            const threadRequest = params.fetch_params.find(
                (fetchParam) =>
                    Array.isArray(fetchParam) &&
                    fetchParam[0] === "mail.thread" &&
                    JSON.stringify(fetchParam[1].request_list) === JSON.stringify(requestList)
            );
            if (heldLoad && threadRequest) {
                expect.step(`thread data:${threadRequest[1].thread_model}`);
                const answer = heldLoad.promise;
                heldLoad = null;
                return answer;
            }
        });
        const holdNextLoad = () => (heldLoad = Promise.withResolvers());
        // Every chatter write is stepped: there is none.
        watchRpcs(MAIL_WRITES);
        const chatters = captureInstances(Chatter);
        await start();

        // Another model: a lost connection during its chatter load is not swallowed by CRM.
        await openFormView("res.partner", partnerId, {
            arch: /* xml */ `
                <form>
                    <sheet><field name="name"/></sheet>
                    <chatter/>
                </form>`,
        });
        await mailContains(".o-mail-Chatter");
        const partnerChatter = chatters.find(
            (c) => c.threadModel() === "res.partner" && status(c) === "mounted"
        );
        let held = holdNextLoad();
        const partnerLoad = partnerChatter.load(partnerChatter.state.thread, requestList);
        await expect.waitForSteps(["thread data:res.partner"]);
        held.resolve(new Response("", { status: 502 }));
        await expect(partnerLoad).rejects.toThrow(/Connection to "\/mail\/store"/);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        await setOffline(false);

        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Message:contains('Hello lead')");
        await mailContains(".o-mail-Activity");
        await mailContains(".o-mail-Followers-counter:text('2')");
        const chatter = chatters.find(
            (c) => c.threadModel() === "crm.lead" && status(c) === "mounted"
        );
        const thread = chatter.state.thread;

        // A lead chatter load the server rejects for another reason still raises.
        held = holdNextLoad();
        const refusedLoad = chatter.load(thread, requestList);
        await expect.waitForSteps(["thread data:crm.lead"]);
        held.reject(makeServerError({ message: "Thread data refused" }));
        await expect(refusedLoad).rejects.toThrow(/Thread data refused/);
        expect(getService(OfflinePlugin).isOffline()).toBe(false);

        // A lead chatter load whose request loses the connection: no error, the chatter keeps
        // what it shows, nothing is written or queued. The connection stays down for the rest of
        // the test, so every request the now offline form issues fails too: on small screens the
        // lead's partner field switches to its cached autocomplete, which stays closed and
        // searches nothing until it is used.
        held = holdNextLoad();
        const lostLoad = chatter.load(thread, requestList);
        await expect.waitForSteps(["thread data:crm.lead"]);
        connection.offline = true;
        held.resolve(new Response("", { status: 502 }));
        await expect(lostLoad).resolves.toBe(undefined);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(".o-mail-Message:contains('Hello lead')").toHaveCount(1);
        expect(".o-mail-Activity").toHaveCount(1);
        expect(".o-mail-Followers-counter").toHaveText("2");
        expect(".modal").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test("message delete confirmation opened online closes on disconnect and removes nothing", async () => {
        await seedLeadThread();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        watchRpcs(MAIL_WRITES);
        const deleteDialogs = captureInstances(MessageDeleteDialog);
        const messageActions = captureInstances(MessageAction);
        await start();
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Message:contains('Hello lead')");
        const deleteAction = () =>
            [...messageActionsByOwner(messageActions, "crm.lead").values()]
                .flat()
                .find(
                    (action) =>
                        action.id === "delete" && action.owner.constructor.name === "Message"
                );
        const DELETE_DIALOG =
            ".modal:contains('Are you sure you want to permanently delete this message?')";

        // Opened online through the message "delete" action, then the connection drops.
        const owner = deleteAction().owner;
        deleteAction().onSelected();
        await mailContains(DELETE_DIALOG);
        const openedOnline = deleteDialogs.at(-1);
        await setOffline(true);
        await animationFrame();
        expect(DELETE_DIALOG).toHaveCount(0);
        // Its confirmation, called directly once offline, removes nothing.
        openedOnline.onClickConfirm();
        // Opened offline by the message itself (an emptied edit composer does so): it closes, and
        // its confirmation removes nothing either.
        openedOnline.props.message.showDeleteConfirm(owner);
        await animationFrame();
        expect(deleteDialogs.at(-1)).not.toBe(openedOnline);
        deleteDialogs.at(-1).onClickConfirm();
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect(".o-mail-Message:contains('Hello lead')").toHaveCount(1);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // Online, the confirmation still removes the message.
        await setOffline(false);
        await animationFrame();
        deleteAction().onSelected();
        await mailContains(DELETE_DIALOG);
        await mailClick(".modal-footer button:contains('Delete')");
        await expect.waitForSteps(["/mail/message/update_content"]);
        await mailContains(DELETE_DIALOG, { count: 0 });
    });

    test("composer mass-mention confirmation answered after disconnection posts nothing", async () => {
        await seedLeadThread();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        watchRpcs(MAIL_WRITES);
        const components = captureChatterComponents();
        await start();
        // The composer counts the users of the mentioned roles: above 50, it asks before posting.
        // No "@" is typed, so no mention suggestion is looked up.
        patchWithCleanup(getService("mail.store"), {
            getMentionsFromText(body, options) {
                const mentions = super.getMentionsFromText(...arguments);
                // The post itself (which passes its thread) keeps the real mentions.
                return options?.thread
                    ? mentions
                    : { ...mentions, roles: [{ name: "Sales", user_ids_count: 51 }] };
            },
        });
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Message:contains('Hello lead')");
        const CONFIRM_BUTTON = ".modal-footer button:contains('Send Message')";

        // The confirmation is opened online, then the connection drops before it is answered.
        await mailClick(".o-mail-Chatter-logNote");
        await insertText(".o-mail-Composer-input", "Notify the whole team");
        await mailClick(".o-mail-Composer-send:enabled");
        await mailContains(".modal-body:contains('about to notify 51 people')");
        const composer = components.composers.find(
            (c) => c.props.composer?.thread?.model === "crm.lead" && !c.props.composer.message
        );
        await setOffline(true);
        await animationFrame();
        expect(".o-mail-Chatter .o-mail-Composer").toHaveCount(0);
        await contains(CONFIRM_BUTTON).click();
        await animationFrame();
        // The continuation, called directly offline, runs nothing either.
        await composer.processMessage(async () => expect.step("processed"));
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect(".o-mail-Message:contains('Notify the whole team')").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // Online, the confirmed note is posted.
        await setOffline(false);
        await animationFrame();
        await mailClick(".o-mail-Chatter-logNote");
        await insertText(".o-mail-Composer-input", "Notify the whole team", { replace: true });
        await mailClick(".o-mail-Composer-send:enabled");
        await mailClick(CONFIRM_BUTTON);
        await expect.waitForSteps(["/mail/message/post"]);
        await mailContains(".o-mail-Message:contains('Notify the whole team')");
    });

    test("edit composer opened online uploads and unlinks nothing after disconnection", async () => {
        const { pyEnv, messageId } = await seedLeadThread();
        const postedId = pyEnv["ir.attachment"].create({
            mimetype: "text/plain",
            name: "posted.txt",
            res_id: 1,
            res_model: "crm.lead",
        });
        pyEnv["mail.message"].write([messageId], { attachment_ids: [[4, postedId]] });
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        watchRpcs(MAIL_WRITES);
        const components = captureChatterComponents();
        const messageActions = captureInstances(MessageAction);
        await start();
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Message:contains('Hello lead')");
        const editComposer = () =>
            components.composers
                .filter((c) => c.props.composer?.message && status(c) === "mounted")
                .at(-1);
        const attachmentNames = () =>
            editComposer()
                .props.composer.attachments.map(({ name }) => name)
                .sort();
        const EDIT_ATTACHMENTS = ".o-mail-Message .o-mail-Composer .o-mail-AttachmentContainer";
        const textFile = (name) => new File(["hello"], name, { type: "text/plain" });

        // Opened online through the message "edit" action; a pasted file is uploaded.
        [...messageActionsByOwner(messageActions, "crm.lead").values()]
            .flat()
            .find((action) => action.id === "edit" && action.owner.constructor.name === "Message")
            .onSelected();
        await mailContains(".o-mail-Message .o-mail-Composer-input");
        await pasteFiles(".o-mail-Message .o-mail-Composer-input", [textFile("draft.txt")]);
        await mailContains(`${EDIT_ATTACHMENTS}:not(.o-isUploading):contains('draft.txt')`);
        expect.verifySteps(["/mail/attachment/upload"]);
        expect(attachmentNames()).toEqual(["draft.txt", "posted.txt"]);

        // The connection drops: the textarea paste and the drop zone upload nothing.
        await setOffline(true);
        await animationFrame();
        const file = textFile("offline.txt");
        await pasteFiles(".o-mail-Message .o-mail-Composer-input", [file]);
        await dragenterFiles(".o-mail-Message-body", [file]);
        await dropFiles(".o-Dropzone.o-mail-Composer-dropzone", [file]);
        // The same handlers and the uploader (also behind the file input and voice messages),
        // called directly; the unlink covers the posted attachment and the uploaded one.
        const transfer = { files: [file], items: [], types: ["Files"] };
        editComposer().onDropFile({ dataTransfer: transfer });
        editComposer().onPaste({
            clipboardData: transfer,
            preventDefault: () => expect.step("paste prevented"),
        });
        await editComposer().attachmentUploader.uploadFile(file);
        await editComposer().attachmentUploader.uploadData({
            data: "aGVsbG8=",
            name: "offline.txt",
            type: "text/plain",
        });
        await editComposer().unlinkAttachments([...editComposer().props.composer.attachments]);
        await animationFrame();
        expect(attachmentNames()).toEqual(["draft.txt", "posted.txt"]);
        expect(EDIT_ATTACHMENTS).toHaveCount(2);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);

        // The html composer's editor pastes through the same handler: online it uploads,
        // offline it does not.
        await setOffline(false);
        await animationFrame();
        getService("mail.composer").setHtmlComposer();
        const EDITABLE = ".o-mail-Message .o-mail-Composer-html.odoo-editor-editable";
        await mailContains(EDITABLE);
        await pasteFiles(EDITABLE, [textFile("html.txt")]);
        await mailContains(`${EDIT_ATTACHMENTS}:not(.o-isUploading):contains('html.txt')`);
        expect.verifySteps(["/mail/attachment/upload"]);
        await setOffline(true);
        await animationFrame();
        await pasteFiles(EDITABLE, [file]);
        await animationFrame();
        expect(attachmentNames()).toEqual(["draft.txt", "html.txt", "posted.txt"]);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
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
        expect(".o_dialog .o_field_widget[name='team']").toHaveCount(0);

        // When the connection returns, the item reads the sales teams of the company by itself,
        // once, and offers the team picker and the default team as a dialog opened online does.
        await setOffline(false);
        await expect.waitForSteps(["crm.team/web_search_read"]);
        await mailContains(".o_dialog .o_field_widget[name='team']");
        expect(offlineItem.state.teams.map(({ id }) => id)).toEqual([1, 2]);
        expect(offlineItem.state.selected_team.id).toBe(1);
        expect(offlineItem.context.default_team_id).toBe(1);
        await animationFrame();
        expect.verifySteps([]);
    });

    test("share target item: a team read that loses the connection keeps the teams; other errors still raise", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        // A team read can be held in flight, then answered as the test decides.
        let heldRead = null;
        onRpc("/web/dataset/call_kw/crm.team/web_search_read", () => {
            if (heldRead) {
                const answer = heldRead.promise;
                heldRead = null;
                return answer;
            }
        });
        const holdNextRead = () => (heldRead = Promise.withResolvers());
        watchRpcs(["crm.team/web_search_read"]);
        const pngFile = new File([new Uint8Array(1)], "text.png", { type: "image/png" });
        const items = captureInstances(CrmShareTargetItem);
        patchWithCleanup(shareTargetService, {
            _getShareTargetFiles: async () => [pngFile],
        });
        const webClient = await mountWithCleanup(WebClient);
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
        // Online, the item reads the sales teams of the company, and the user picks the second.
        expect.verifySteps(["crm.team/web_search_read"]);
        const item = items.at(-1);
        expect(status(item)).toBe("mounted");
        expect(item.state.teams.map(({ id }) => id)).toEqual([1, 2]);
        item.state.selected_team = item.state.teams[1];

        // A read whose request loses the connection: it resolves without an error, and the
        // teams and the selected team keep their values.
        let held = holdNextRead();
        const lostRead = item.updateTeams();
        await expect.waitForSteps(["crm.team/web_search_read"]);
        held.resolve(new Response("", { status: 502 }));
        await expect(lostRead).resolves.toBe(undefined);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(item.state.teams.map(({ id }) => id)).toEqual([1, 2]);
        expect(item.state.selected_team.id).toBe(2);
        expect(".o_dialog button.active").toHaveText("Lead");
        expect(queuedEntries()).toHaveLength(0);

        // Back online, a read the server rejects for another reason still raises.
        await setOffline(false);
        held = holdNextRead();
        const refusedRead = item.updateTeams();
        await expect.waitForSteps(["crm.team/web_search_read"]);
        held.reject(makeServerError({ message: "Team read refused" }));
        await expect(refusedRead).rejects.toThrow(/Team read refused/);
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect(item.state.selected_team.id).toBe(2);
        expect(queuedEntries()).toHaveLength(0);
    });

    test("share target item: the lead creation is inert offline through the save hook or a direct call", async () => {
        const pngFile = new File([new Uint8Array(1)], "text.png", { type: "image/png" });
        // Online, the server stores the shared file as attachment 666, which the creation links
        // to the new lead. Registered first, so the offline mock and the watcher run before them.
        onRpc("/web/binary/upload_attachment", () => [{ id: 666, filename: pngFile.name }]);
        onRpc("/web/dataset/call_kw/ir.attachment/write", () => true);
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["/web/binary/upload_attachment", "crm.lead/name_create", "ir.attachment/write"]);
        // Steps every call that reaches the shared share-target flow. The created lead is not
        // opened, so the dialog stays the only screen.
        patchWithCleanup(ShareTargetItem.prototype, {
            async checkAndActiveIfNeededUserCompany() {
                expect.step("activate company");
                return super.checkAndActiveIfNeededUserCompany(...arguments);
            },
            async process() {
                expect.step("process");
                return super.process(...arguments);
            },
            async openCreatedRecord(resId) {
                expect.step(`open crm.lead ${resId}`);
            },
        });
        const items = captureInstances(CrmShareTargetItem);
        patchWithCleanup(shareTargetService, {
            _getShareTargetFiles: async () => [pngFile],
        });
        const webClient = await mountWithCleanup(WebClient);
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
        const item = items.at(-1);
        expect(item.state.selected_team.id).toBe(1);
        const shareTarget = getService("share_target");
        const sharedLeadIds = () => MockServer.env["crm.lead"].search([["name", "=", "text.png"]]);

        // Offline, the save hook and each of its steps called directly resolve without reaching
        // the shared flow: no upload, no lead, no attachment link, nothing queued, no error.
        await setOffline(true);
        await expect(shareTarget.callHook("save")).resolves.toBe(undefined);
        await expect(item.checkAndActiveIfNeededUserCompany()).resolves.toBe(undefined);
        await expect(item.process()).resolves.toBe(undefined);
        await animationFrame();
        expect.verifySteps([]);
        expect(queuedEntries()).toHaveLength(0);
        expect(sharedLeadIds()).toEqual([]);
        expect(".o_dialog").toHaveCount(1);

        // Online, the same hook runs the shared flow, and the lead is created in the selected team.
        await setOffline(false);
        await shareTarget.callHook("save");
        const [leadId] = sharedLeadIds();
        expect.verifySteps([
            "activate company",
            "process",
            "/web/binary/upload_attachment",
            "crm.lead/name_create",
            "ir.attachment/write",
            `open crm.lead ${leadId}`,
        ]);
        expect(MockServer.env["crm.lead"].browse(leadId)[0].team_id).toBe(1);
        expect(queuedEntries()).toHaveLength(0);
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

/**
 * @param {HTMLElement} el
 * @param {HTMLElement} root `el` or one of its ancestors
 * @returns {number} the opacity `el` renders with inside `root`: the product of the computed
 *  opacities of `el` and of its ancestors up to `root`, both included
 */
function effectiveOpacity(el, root) {
    let opacity = 1;
    for (let node = el; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
        if (node === root) {
            break;
        }
    }
    return opacity;
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
        // The name is a `widget="text"` field: the `web.TextField` <textarea>, not a char <input>.
        expect(".o_field_widget[name=name] textarea").toHaveCount(1);
        expect(".o_field_widget[name=name] input").toHaveCount(0);
        const marked = [
            ".o_field_widget[name=name] textarea",
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
        // are read within the partner field: its autocomplete renders its suggestion list inside
        // the field, as a positioned dropdown on every screen size.
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
        await contains(".o_field_widget[name=name] textarea").edit("Lead 1 (offline)");
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
        // The card compiler turns `type` into a click handler: the anchors are found by label. It
        // copies the arch's offline attribute onto them; the production arch carries it, as the
        // lane-1 `test_offline_availability_view_wiring` asserts.
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

    test.tags("desktop");
    test("unavailable lead card offline: content dimmed, K9 card-menu toggler at full opacity and usable", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/web_save"]);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const cardOf = (name) => queryOne(`.o_kanban_record:contains('${name}')`);
        // The card's first child: the name field, rendered as a <span> by the kanban card.
        const nameOf = (card) => card.firstElementChild;

        // 1. Another model's kanban, visited online: offline, its unavailable cards keep the
        // framework presentation, the whole card dimmed.
        await openView({
            res_model: "res.partner",
            views: [[false, "kanban"]],
            arch: /* xml */ `
                <kanban>
                    <templates>
                        <t t-name="menu">
                            <a role="menuitem" type="open" class="dropdown-item">Edit</a>
                        </t>
                        <t t-name="card">
                            <field name="name"/>
                        </t>
                    </templates>
                </kanban>`,
        });
        expect(".o_kanban_record:not(.o_kanban_ghost)").not.toHaveCount(0);
        expect(".o_kanban_record.o_disabled_offline").toHaveCount(0);
        await setOffline(true);
        expect(".o_opportunity_kanban").toHaveCount(0);
        const partnerCard = queryFirst(".o_kanban_record:not(.o_kanban_ghost)");
        expect(partnerCard).toHaveClass("o_disabled_offline");
        expect(getComputedStyle(partnerCard).opacity).toBe("0.5");
        expect(nameOf(partnerCard)).not.toHaveClass("o_dropdown_kanban");
        expect(getComputedStyle(nameOf(partnerCard)).opacity).toBe("1");
        await setOffline(false);

        // 2. The lead pipeline, online: no card is marked. Of the leads, only the form of Lead 1
        // was visited online.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline(actionId, viewType, resId) {
                return (viewType === "form" && resId === 1) || super.isAvailableOffline(...arguments);
            },
        });
        await openView({
            res_model: "crm.lead",
            views: [[false, "kanban"]],
            arch: PIPELINE_KANBAN_ARCH,
        });
        expect(".o_opportunity_kanban").toHaveCount(1);
        expect(".o_kanban_record:not(.o_kanban_ghost)").not.toHaveCount(0);
        expect(".o_kanban_record.o_disabled_offline").toHaveCount(0);

        // 3. Offline, the card of the visited lead stays available: not marked, not dimmed.
        await setOffline(true);
        const visitedCard = cardOf("Lead 1");
        expect(visitedCard).not.toHaveClass("o_disabled_offline");
        expect(nameOf(visitedCard)).toHaveText("Lead 1");
        expect(effectiveOpacity(nameOf(visitedCard), visitedCard)).toBe(1);

        // 4. The card of a lead not visited online keeps its mark and the framework cursor, but
        // reads as dimmed through its content (fields, color stripe, selection overlay) ...
        const card = cardOf("Lead 2");
        expect(card).toHaveClass("o_disabled_offline");
        expect(getComputedStyle(card).cursor).toBe("not-allowed");
        expect(getComputedStyle(card).opacity).toBe("1");
        const nameField = nameOf(card);
        expect(nameField).toHaveText("Lead 2");
        expect(getComputedStyle(nameField).opacity).toBe("0.5");
        expect(effectiveOpacity(nameField, card)).toBe(0.5);
        expect(getComputedStyle(card, "::before").opacity).toBe("0.5");
        expect(getComputedStyle(card, "::after").opacity).toBe("0.5");
        // ... while its K9 card-menu toggler, usable offline, renders at full opacity.
        const toggler = queryOne(".o_dropdown_kanban button", { root: card });
        expect(toggler.closest(".o_dropdown_kanban").parentElement).toBe(card);
        expect(toggler).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        expect(toggler).toBeEnabled();
        expect(toggler).not.toHaveClass("o_disabled_offline");
        expect(effectiveOpacity(toggler, card)).toBe(1);

        // 5. The toggler opens the menu, whose entries are usable: picking a color queues it.
        await contains(toggler).click();
        expect(getComputedStyle(queryOne(".o-dropdown--menu")).opacity).toBe("1");
        for (const label of ["Edit", "Delete"]) {
            const entry = queryOne(`.o-dropdown--menu a:contains('${label}')`);
            expect(entry).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
            expect(entry).not.toHaveClass("disabled");
            expect(entry).not.toHaveClass("o_disabled_offline");
        }
        const colors = queryAll(".o-dropdown--menu .o_kanban_colorpicker button");
        expect(colors.length).toBeGreaterThan(1);
        for (const color of colors) {
            expect(color).toBeEnabled();
        }
        await contains(".o-dropdown--menu .o_kanban_colorpicker button:eq(3)").click();
        expect.verifySteps(["crm.lead/web_save"]);
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args[0]).toEqual([2]);
        expect(saves[0].args[1]).toEqual({ color: 3 });
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

    test("lead chatter Files toggler stays usable offline; upload launchers stay disabled", async () => {
        const pyEnv = await startServer();
        pyEnv["ir.attachment"].create({
            mimetype: "text/plain",
            name: "lead_notes.txt",
            res_id: 1,
            res_model: "crm.lead",
        });
        const partnerId = pyEnv["res.partner"].create({ name: "Customer" });
        pyEnv["ir.attachment"].create({
            mimetype: "text/plain",
            name: "partner_notes.txt",
            res_id: partnerId,
            res_model: "res.partner",
        });
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        await start();
        const toggler = ".o-mail-Chatter-attachFiles";
        const panel = ".o-mail-AttachmentBox";

        // 1. Lead with a cached attachment: the toggler only opens and closes the read-only Files
        // panel, so it is marked and stays enabled offline.
        await openFormView("crm.lead", 1, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Followers-counter");
        await mailContains(`${toggler} sup:text('1')`);
        expect(toggler).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        await setOffline(true);
        expect(toggler).toBeEnabled();
        expect(toggler).not.toHaveClass("o_disabled_offline");
        await mailClick(toggler);
        await mailContains(`${panel} .o-mail-AttachmentContainer[title='lead_notes.txt']`);
        await animationFrame();
        // The panel's own upload launcher is not marked and stays disabled offline.
        const panelUploader = `${panel} .o-mail-Chatter-attachmentActions button:contains('Attach files')`;
        expect(panelUploader).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
        expect(isDisabledOffline(panelUploader)).toBe(true);
        await mailClick(toggler);
        await mailContains(panel, { count: 0 });
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
        await setOffline(false);

        // 2. Lead without attachments: the same button is the upload launcher of the chatter's
        // `FileUploader`, not marked, so disabled offline.
        await openFormView("crm.lead", 2, { arch: LEAD_CHATTER_FORM_ARCH });
        await mailContains(".o-mail-Followers-counter");
        await mailContains(".o-mail-Chatter-topbar input.o-mail-Chatter-fileUploader");
        expect(`${toggler} sup`).toHaveCount(0);
        expect(toggler).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
        await setOffline(true);
        expect(toggler).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
        expect(isDisabledOffline(toggler)).toBe(true);
        expect.verifySteps([]);
        await setOffline(false);

        // 3. Another model's chatter, with an attachment: never marked, disabled offline as before.
        await openFormView("res.partner", partnerId, {
            arch: /* xml */ `
                <form>
                    <sheet><field name="name"/></sheet>
                    <chatter/>
                </form>`,
        });
        await mailContains(".o-mail-Followers-counter");
        await mailContains(`${toggler} sup:text('1')`);
        expect(toggler).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
        await setOffline(true);
        expect(toggler).not.toHaveAttribute(OFFLINE_ATTRIBUTE);
        expect(isDisabledOffline(toggler)).toBe(true);
        expect(queuedEntries()).toHaveLength(0);
        expect.verifySteps([]);
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

    test("lead date field inputs carry data-available-offline; other models' do not", async () => {
        await startServer();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/web_save"]);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // 1. A lead without dates: the date field and both ends of a range render their <input>.
        // `date_open` and `date_closed` are read-only on the server: the arch makes the range
        // editable, so that its empty end input renders on a lead record.
        await openView({
            res_model: "crm.lead",
            res_id: 1,
            views: [[false, "form"]],
            arch: /* xml */ `
                <form js_class="crm_form">
                    <sheet>
                        <field name="name"/>
                        <field name="date_deadline"/>
                        <field name="date_open" widget="daterange" readonly="0"
                            options="{'end_date_field': 'date_closed', 'always_range': '1'}"/>
                    </sheet>
                </form>`,
        });
        const deadlineInput = ".o_field_widget[name=date_deadline] input";
        const leadInputs = [
            deadlineInput,
            ".o_field_widget[name=date_open] input[data-field=date_open]",
            ".o_field_widget[name=date_open] input[data-field=date_closed]",
        ];
        for (const selector of leadInputs) {
            expect(selector).toHaveCount(1, { message: selector });
            expect(selector).toHaveValue("", { message: selector });
            expect(selector).toHaveAttribute(OFFLINE_ATTRIBUTE, "1", { message: selector });
        }
        await setOffline(true);
        for (const selector of leadInputs) {
            expect(selector).toHaveAttribute(OFFLINE_ATTRIBUTE, "1", { message: selector });
            expect(queryOne(selector)).not.toHaveAttribute("disabled");
            expect(selector).not.toHaveClass("o_disabled_offline");
        }

        // 2. Offline, a date picked in the picker is saved into the queued `web_save`.
        const pickedDate = serializeDate(today().set({ day: 15 }));
        await contains(deadlineInput).click();
        await animationFrame();
        expect(".o_datetime_picker").toHaveCount(1);
        await contains(getPickerCell("15")).click();
        await animationFrame();
        expect(".o_datetime_picker").toHaveCount(0);
        await contains(".o_form_button_save").click();
        expect.verifySteps(["crm.lead/web_save"]);
        expect(queuedCalls("crm.lead", "web_save").map(({ args }) => args)).toEqual([
            [[1], { date_deadline: pickedDate }],
        ]);

        // 3. The filled value renders the framework's marked <button>; focusing it renders the
        // <input> again, which is marked too.
        const deadlineButton = ".o_field_widget[name=date_deadline] button";
        expect(deadlineButton).toHaveAttribute(OFFLINE_ATTRIBUTE);
        await contains(deadlineButton).click();
        await animationFrame();
        expect(deadlineButton).toHaveCount(0);
        expect(deadlineInput).toHaveAttribute(OFFLINE_ATTRIBUTE, "1");
        expect(queryOne(deadlineInput)).not.toHaveAttribute("disabled");

        // The queued edit is replayed on reconnect.
        await setOffline(false);
        await expect.waitForSteps(["crm.lead/web_save"]);
        expect(MockServer.env["crm.lead"].browse(1)[0].date_deadline).toBe(pickedDate);

        // 4. Scoping: the inputs of another model's date range carry no attribute, online or
        // offline. Its filled dates render the framework's <button>s; focusing one renders its
        // <input>.
        await openView({
            res_model: "res.partner",
            res_id: serverState.partnerId,
            views: [[false, "form"]],
            arch: /* xml */ `
                <form>
                    <sheet>
                        <field name="name"/>
                        <field name="create_date" widget="daterange" readonly="0"
                            options="{'end_date_field': 'write_date'}"/>
                    </sheet>
                </form>`,
        });
        for (const offline of [false, true]) {
            await setOffline(offline);
            for (const fieldName of ["create_date", "write_date"]) {
                const input = `.o_field_widget[name=create_date] input[data-field=${fieldName}]`;
                await contains(
                    `.o_field_widget[name=create_date] button[data-field=${fieldName}]`
                ).click();
                await animationFrame();
                expect(input).toHaveCount(1, { message: input });
                expect(input).not.toHaveAttribute(OFFLINE_ATTRIBUTE, null, { message: input });
            }
        }
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

/**
 * Opens the form of lead 2 as an action loaded from the server (its views are cached). Its record,
 * read online, caches the customer `seedLeadCustomer` gives it for the offline partner lookup.
 */
async function openSecondLeadForm() {
    await getService("action").doAction({
        type: "ir.actions.act_window",
        res_model: "crm.lead",
        res_id: 2,
        views: [[false, "form"]],
        cache: true,
    });
}

/**
 * A many2one field with an extra suggestion source, as the partner autocomplete's
 * `res_partner_many2one` widget gives the lead's customer: an external company lookup for
 * requests of three characters or more, after the cached records. Offline, that lookup never
 * settles, as the partner autocomplete's does, waiting on a library it cannot load. The
 * `partner_autocomplete` addon is not a dependency of `crm`, so its widget is not part of this
 * test bundle.
 */
class ExtraSourceMany2OneField extends Component {
    static template = xml`<Many2One t-props="this.m2oProps"/>`;
    static components = { Many2One };
    props = useProps(many2OneFieldProps);

    extraSources = [
        {
            placeholder: "Searching Autocomplete...",
            options: async (request) => (request.length > 2 ? new Promise(() => {}) : []),
        },
    ];

    get m2oProps() {
        return { ...computeM2OProps(this.props), otherSources: this.extraSources };
    }
}

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
        // Offline, small screens render the autocomplete instead of the search-dialog input
        // (`dropdown: false`); large screens keep the framework's props, whose autocomplete
        // already searches the cache.
        if (isSmall()) {
            expect(partnerField().many2XAutocompleteProps.dropdown).toBe(false);
        } else {
            expect("dropdown" in partnerField().many2XAutocompleteProps).toBe(false);
        }
        // Offline, on every screen size, the autocomplete is a closed dropdown until it is used,
        // and searches the cached partners.
        expect(".o_field_widget[name=partner_id] .o-autocomplete").toHaveClass("dropdown");
        expect(input).toHaveAttribute("aria-expanded", "false");
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

    test.tags("mobile");
    test("mobile: offline lead many2one autocompletes stay closed until used, and close on Escape, an outside tap and a pick", async () => {
        // Back in the lead form offline, the framework serves it from its disk cache, and its
        // background refresh fails with a `ConnectionLostError`.
        expect.errors(1);
        await seedLeadCustomer();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["res.partner/web_name_search", "res.users/web_name_search"]);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(LEAD_LOOKUP_ACTION_ID);
        const lookupFields = ["partner_id", "user_id"];
        const input = (name) => `.o_field_widget[name=${name}] input`;
        const menu = (name) => `.o_field_widget[name=${name}] .o-autocomplete--dropdown-menu`;
        const partnerOptions = ".o_field_widget[name=partner_id] .o-autocomplete--dropdown-item";
        // Every lead many2one is a closed dropdown autocomplete that has searched nothing.
        const expectClosedLookups = async () => {
            await runAllTimers();
            for (const name of lookupFields) {
                expect(input(name)).not.toHaveAttribute("readonly", null, { message: name });
                expect(`.o_field_widget[name=${name}] .o-autocomplete`).toHaveClass("dropdown");
                expect(input(name)).toHaveAttribute("aria-expanded", "false", { message: name });
                expect(menu(name)).toHaveCount(0, { message: name });
            }
            expect.verifySteps([]);
        };
        // Online, both fields are the read-only inputs that open the search dialog.
        for (const name of lookupFields) {
            expect(input(name)).toHaveAttribute("readonly", null, { message: name });
        }
        expect(input("partner_id")).toHaveValue("Azure Interior");

        // The connection drops while the form is shown.
        await setOffline(true);
        await expectClosedLookups();

        // The form is opened again offline, from the breadcrumb of lead 2's form, which was read
        // online and so cached lead 2's customer.
        await setOffline(false);
        await openSecondLeadForm();
        expect(input("partner_id")).toHaveValue("Deco Addict");
        await setOffline(true);
        await contains(".o_back_button").click();
        expect(input("partner_id")).toHaveValue("Azure Interior");
        await expectClosedLookups();

        // A tap opens the customer's suggestions only, as a positioned dropdown: it searches the
        // cached partners.
        await contains(input("partner_id")).click();
        await runAllTimers();
        expect(menu("partner_id")).toHaveClass("dropdown-menu");
        expect(menu("partner_id")).not.toHaveClass("list-group");
        expect(input("partner_id")).toHaveAttribute("aria-expanded", "true");
        expect(queryAllTexts(partnerOptions)).toEqual(["Azure Interior", "Deco Addict"]);
        expect(menu("user_id")).toHaveCount(0);
        expect.verifySteps(["res.partner/web_name_search"]);
        // Escape closes it, and only it: the form stays.
        await press("Escape");
        await animationFrame();
        expect(menu("partner_id")).toHaveCount(0);
        expect(input("partner_id")).toHaveAttribute("aria-expanded", "false");
        expect(".o_form_view").toHaveCount(1);
        // A tap outside the field closes it too.
        await contains(input("partner_id")).click();
        await runAllTimers();
        expect(menu("partner_id")).toHaveCount(1);
        await contains(".o_field_widget[name=name] input").click();
        expect(menu("partner_id")).toHaveCount(0);
        expect(input("partner_id")).toHaveAttribute("aria-expanded", "false");
        // A pick closes it and sets the value.
        await contains(input("partner_id")).edit("Deco", { confirm: false });
        await runAllTimers();
        expect(queryAllTexts(partnerOptions)).toEqual(["Deco Addict"]);
        expect.verifySteps(["res.partner/web_name_search"]);
        await contains(`${partnerOptions}:contains('Deco Addict') > *`).click();
        await runAllTimers();
        expect(menu("partner_id")).toHaveCount(0);
        expect(input("partner_id")).toHaveAttribute("aria-expanded", "false");
        expect(input("partner_id")).toHaveValue("Deco Addict");
        // The salesperson's suggestions open on their own tap, and close on Escape.
        await contains(input("user_id")).click();
        await runAllTimers();
        expect(menu("user_id")).toHaveClass("dropdown-menu");
        expect(menu("partner_id")).toHaveCount(0);
        expect.verifySteps(["res.users/web_name_search"]);
        await press("Escape");
        await animationFrame();
        expect(menu("user_id")).toHaveCount(0);

        // Back online, both fields are the search-dialog inputs again.
        await setOffline(false);
        for (const name of lookupFields) {
            expect(input(name)).toHaveAttribute("readonly", null, { message: name });
            expect(menu(name)).toHaveCount(0, { message: name });
        }
        await expect.waitForErrors(["crm.lead/web_read"]);
    });

    test.tags("mobile");
    test("mobile: offline inline autocompletes outside lead views keep the framework's inline list", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        await mountView({
            type: "kanban",
            resModel: "crm.lead",
            arch: /* xml */ `
                <kanban>
                    <templates>
                        <t t-name="card">
                            <field name="name"/>
                            <footer>
                                <field name="user_id" widget="many2one_avatar"/>
                            </footer>
                        </t>
                    </templates>
                </kanban>`,
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        // Lead 2 has no salesperson: its card's quick assign opens the framework's assign
        // popover, an inline (`dropdown: false`) autocomplete rendered outside the lead view.
        const popoverAutocomplete = ".o-overlay-container .o-autocomplete";
        await contains(".o_kanban_record:contains('Lead 2') .o_quick_assign").click();
        await runAllTimers();
        expect(popoverAutocomplete).toHaveCount(1);
        expect(popoverAutocomplete).not.toHaveClass("dropdown");
        expect(`${popoverAutocomplete} .o-autocomplete--dropdown-menu`).toHaveClass("list-group");
        // Offline on a small screen, the CRM lookup patch leaves it as the framework renders it.
        await setOffline(true);
        await runAllTimers();
        expect(popoverAutocomplete).toHaveCount(1);
        expect(popoverAutocomplete).not.toHaveClass("dropdown");
        expect(`${popoverAutocomplete} .o-autocomplete--dropdown-menu`).toHaveClass("list-group");
    });

    test("lead many2one extra sources offer nothing offline: no endless loading row, keyboard selection of a cached record", async () => {
        registry
            .category("fields")
            .add(
                "crm_offline_test_extra_source_many2one",
                buildM2OFieldDescription(ExtraSourceMany2OneField)
            );
        const { otherCustomerId } = await seedLeadCustomer();
        const setOffline = mockOffline();
        keepPingsFailing();
        const many2ones = captureInstances(Many2One);
        const autoCompletes = captureInstances(AutoComplete);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await openSecondLeadForm();
        await getService("action").doAction(LEAD_EXTRA_SOURCE_ACTION_ID);
        const partnerField = () =>
            many2ones.findLast(
                (m2o) => m2o.props.relation === "res.partner" && status(m2o) === "mounted"
            );
        const input = ".o_field_widget[name=partner_id] input";
        const options = ".o_field_widget[name=partner_id] .o-autocomplete--dropdown-item";
        expect(input).toHaveValue("Azure Interior");
        // Online, the extra source reaches the autocomplete as the widget gives it.
        expect(partnerField().many2XAutocompleteProps.otherSources).toBe(
            partnerField().props.otherSources
        );

        await setOffline(true);
        // Offline, on every screen size, the extra source is kept, in its place, with no option;
        // small screens also render the autocomplete instead of the search-dialog input.
        const offlineProps = partnerField().many2XAutocompleteProps;
        expect(offlineProps.otherSources).toHaveLength(1);
        expect(offlineProps.otherSources[0].placeholder).toBe("Searching Autocomplete...");
        expect(offlineProps.otherSources[0].options).toEqual([]);
        if (isSmall()) {
            expect(offlineProps.dropdown).toBe(false);
        } else {
            expect("dropdown" in offlineProps).toBe(false);
        }
        // A request long enough for the external lookup lists the cached partner, with no
        // loading row.
        await contains(input).edit("Deco", { confirm: false });
        await runAllTimers();
        expect(queryAllTexts(options)).toEqual(["Deco Addict"]);
        expect(".o_field_widget[name=partner_id] .o_loading").toHaveCount(0);
        // The extra source is still the last one, and empty: the partner autocomplete adds its
        // worldwide-search entry only after a last source with options.
        const partnerAutoComplete = autoCompletes.findLast(
            (autoComplete) =>
                status(autoComplete) === "mounted" &&
                autoComplete.root()?.closest(".o_field_widget[name=partner_id]")
        );
        expect(partnerAutoComplete.sources).toHaveLength(2);
        expect(partnerAutoComplete.sources.at(-1).isLoading).toBe(false);
        expect(partnerAutoComplete.sources.at(-1).options).toHaveLength(0);
        // Keyboard selection picks the highlighted cached partner at once.
        await press("ArrowDown");
        await press("Enter");
        await animationFrame();
        expect(input).toHaveValue("Deco Addict");
        expect(partnerField().props.value.id).toBe(otherCustomerId);
        expect(".o_field_widget[name=partner_id] .o-autocomplete--dropdown-menu").toHaveCount(0);

        // Back online, the extra source is the widget's again.
        await setOffline(false);
        expect(partnerField().many2XAutocompleteProps.otherSources).toBe(
            partnerField().props.otherSources
        );
    });

    test("lead many2one: picking its current value offline raises no error and changes nothing", async () => {
        const { customerId } = await seedLeadCustomer();
        const setOffline = mockOffline();
        keepPingsFailing();
        watchRpcs(["crm.lead/onchange"]);
        const formControllers = captureInstances(FormController);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(LEAD_LOOKUP_ACTION_ID);
        const record = formControllers.findLast((controller) => status(controller) === "mounted")
            .model.root;
        const input = (name) => `.o_field_widget[name=${name}] input`;
        const option = (name, label) =>
            `.o_field_widget[name=${name}] .o-autocomplete--dropdown-item:contains('${label}') > *`;
        const salesperson = record.data.user_id;
        expect(input("partner_id")).toHaveValue("Azure Interior");
        expect(input("user_id")).toHaveValue(salesperson.display_name);

        await setOffline(true);
        // Each field's current value is picked again from its cached suggestions: its onchange
        // cannot reach the server, and Hoot fails the test on the error it would raise.
        for (const [name, value] of [
            ["partner_id", { id: customerId, display_name: "Azure Interior" }],
            ["user_id", { id: salesperson.id, display_name: salesperson.display_name }],
        ]) {
            await contains(input(name)).click();
            await runAllTimers();
            await contains(option(name, value.display_name)).click();
            await runAllTimers();
            expect.verifySteps(["crm.lead/onchange"]);
            expect(input(name)).toHaveValue(value.display_name);
            expect(record.data[name]).toMatchObject(value);
        }
        expect(".o_error_dialog").toHaveCount(0);
        expect(queuedEntries()).toHaveLength(0);
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
            await contains(".o_list_button_add").click();
            await contains(".o_field_widget[name=name] input").edit(created);
            await contains(".o_form_button_save").click();
            expect(".o_field_widget[name=name] input").toHaveValue(created);
            await contains(".o_breadcrumb .o_back_button").click();
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
        await contains(".o_field_widget[name=name] textarea").edit("Lead 1 (offline)");
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

// -----------------------------------------------------------------------------
// Remaining hook branches (both presets)
// -----------------------------------------------------------------------------

/**
 * Mounts the pipeline kanban online and returns the hook API as a CRM component holds it: the one
 * of a kanban column progress bar. It resolves once the mail store's start-up fetch has landed, so
 * that a disconnection the test starts afterwards cannot make that fetch fail.
 */
async function mountHookApi() {
    listenStoreFetch("init_messaging");
    const progressBars = captureInstances(CrmColumnProgress);
    await mountView({ type: "kanban", resModel: "crm.lead", arch: LEAD_KANBAN_ARCH });
    await waitStoreFetch("init_messaging");
    expect(progressBars.length).toBeGreaterThan(0);
    return progressBars.at(-1).crmOffline;
}

describe("Remaining hook branches", () => {
    test("latestStageWrite ignores a later queued write of the lead that carries no stage_id", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const crmOffline = await mountHookApi();

        // Offline, Lead 1 is moved to Qualified, then another of its fields is saved from another
        // record instance: two queue entries, the later one without `stage_id`, both shaped as
        // the framework queues a record save.
        await setOffline(true);
        const offline = getService(OfflinePlugin);
        const scheduleLeadSave = (values, changes, originalValues, timeStamp) =>
            offline.scheduleORM(
                "crm.lead",
                "web_save",
                [[1], values],
                { context: {}, specification: {} },
                {
                    extras: {
                        actionId: undefined,
                        actionName: undefined,
                        viewType: "kanban",
                        timeStamp,
                        displayName: "Lead 1",
                        changes,
                        originalValues,
                    },
                }
            );
        const stageKey = scheduleLeadSave(
            { stage_id: 2 },
            { stage_id: { id: 2, display_name: "Qualified" } },
            { stage_id: { id: 1, display_name: "New" } },
            1000
        );
        const priorityKey = scheduleLeadSave(
            { priority: "3" },
            { priority: "3" },
            { priority: "0" },
            2000
        );
        expect(
            queuedEntries()
                .map(({ key }) => key)
                .sort()
        ).toEqual([stageKey, priorityKey].sort());
        const stageEntry = queuedEntries().find(({ key }) => key === stageKey);

        // The later entry carries no stage: the stage write is still the latest one, from the live
        // queue and from a copy of it in any order (the pipeline's sync-window entries).
        expect(crmOffline.latestStageWrite(1)).toBe(stageEntry);
        expect(crmOffline.latestStageWrite(1, [...queuedEntries()].reverse())).toBe(stageEntry);
        expect(crmOffline.latestStageWrite(1).value.args).toEqual([[1], { stage_id: 2 }]);

        // Once the move has left the queue (as a systray discard removes it), the lead has no
        // queued stage write, although a write of the lead is still queued.
        offline.removeScheduledORM(stageKey);
        expect(queuedEntries().map(({ key }) => key)).toEqual([priorityKey]);
        expect(crmOffline.latestStageWrite(1)).toBe(undefined);
    });

    test("loadActivityTypes and loadLeadActivities reject with a server error that is not a lost connection", async () => {
        onRpc("mail.activity.type", "web_search_read", () => {
            expect.step("mail.activity.type/web_search_read");
            throw makeServerError({ message: "Activity types are not readable" });
        });
        onRpc("mail.activity", "web_search_read", () => {
            expect.step("mail.activity/web_search_read");
            throw makeServerError({ message: "Lead activities are not readable" });
        });
        const { orm } = await mountHookApi();
        const updates = [];
        const onUpdate = (result) => updates.push(result);

        // Online, with nothing cached: the server's error reaches the caller as it is, where a lost
        // connection resolves to `null`, and no update is delivered.
        const typesError = await loadActivityTypes(orm, onUpdate).catch((error) => error);
        expect(typesError).toBeInstanceOf(RPCError);
        expect(typesError.message).toBe("Activity types are not readable");
        const activitiesError = await loadLeadActivities(orm, 1, onUpdate).catch((error) => error);
        expect(activitiesError).toBeInstanceOf(RPCError);
        expect(activitiesError.message).toBe("Lead activities are not readable");
        expect.verifySteps(["mail.activity.type/web_search_read", "mail.activity/web_search_read"]);
        expect(updates).toEqual([]);
    });

    test("isRecordPendingSync is false without a record, and for a new record whose queue entry is gone", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const crmOffline = await mountHookApi();
        expect(crmOffline.isRecordPendingSync(undefined)).toBe(false);
        expect(crmOffline.isRecordPendingSync(null)).toBe(false);

        // Offline, a lead is created: the framework queues a `web_save` without id and keeps the
        // entry's key on the new record as its `offlineId`.
        await setOffline(true);
        const offline = getService(OfflinePlugin);
        const createKey = offline.scheduleORM(
            "crm.lead",
            "web_save",
            [[], { name: "Offline lead", stage_id: 1 }],
            { context: {}, specification: {} },
            {
                extras: {
                    actionId: undefined,
                    actionName: undefined,
                    viewType: "kanban",
                    timeStamp: 1000,
                    displayName: "Offline lead",
                    changes: { name: "Offline lead" },
                },
            }
        );
        // New records as the predicate reads them: the framework's `resModel`, `resId` (false
        // until the server created the record) and `offlineId`.
        const createdOffline = { resModel: "crm.lead", resId: false, offlineId: createKey };
        const otherNewLead = { resModel: "crm.lead", resId: false, offlineId: undefined };
        expect(crmOffline.isRecordPendingSync(createdOffline)).toBe(true);
        // The queued create, which has no id, is not attributed to another new lead.
        expect(crmOffline.isRecordPendingSync(otherNewLead)).toBe(false);

        // Once the entry has left the queue (replayed, or discarded from the systray), the record's
        // `offlineId` outlives it and no longer counts: with no server id, nothing is pending.
        offline.removeScheduledORM(createKey);
        expect(queuedEntries()).toHaveLength(0);
        expect(crmOffline.isRecordPendingSync(createdOffline)).toBe(false);
    });

    test("runOrQueue rejects a call without a live function, without a model, or whose queued method the systray cannot render, before any live call or queue entry", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        const crmOffline = await mountHookApi();
        const online = async () => {
            expect.step("live call");
            return true;
        };
        const markDone = { model: "mail.activity", method: "action_archive", args: [[1]] };
        const onlineError = "runOrQueue: `online` must be a function performing the live call";
        const methodError = (method) =>
            `runOrQueue: only web_save and action_archive can be queued, got "${method}"`;
        const modelError = "runOrQueue: `queue.model` is required";
        const rename = { model: "crm.lead", method: "write", args: [[1], { name: "Renamed" }] };
        const invalidCalls = [
            [{ queue: markDone }, onlineError],
            [{ online: Promise.resolve(true), queue: markDone }, onlineError],
            [{ online, queue: { ...markDone, method: "action_done" } }, methodError("action_done")],
            [{ online, queue: rename }, methodError("write")],
            [{ online, queue: { ...markDone, model: undefined } }, modelError],
            [{ online, queue: { ...markDone, model: "" } }, modelError],
            [{ online }, methodError("undefined")],
        ];
        const expectEveryInvalidCallRejected = async () => {
            for (const [params, message] of invalidCalls) {
                const error = await crmOffline.runOrQueue(params).catch((error) => error);
                expect(error).toBeInstanceOf(Error);
                expect(error.message).toBe(message);
            }
            expect.verifySteps([]);
            expect(queuedEntries()).toHaveLength(0);
        };

        // Online, no live call is made; offline, nothing is queued and nothing is requested.
        await expectEveryInvalidCallRejected();
        await setOffline(true);
        await expectEveryInvalidCallRejected();

        // The same API queues a valid call offline, the omitted kwargs and extras defaulted.
        const result = await crmOffline.runOrQueue({ online, queue: markDone });
        expect(result.queued).toBe(true);
        expect(queuedEntries()).toHaveLength(1);
        const [entry] = queuedEntries();
        expect(entry.key).toBe(result.key);
        expect(copyOrmCall(entry.value)).toEqual({ ...markDone, kwargs: {} });
        expect(entry.value.extras.displayName).toBe("");
        expect(entry.value.extras.changes).toEqual({});
        expect.verifySteps([]);
    });

    test("offline, a direct call of a CRM wizard's special Cancel button still closes it, while its object button stays inert", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        const buttons = captureInstances(ViewButton);
        listenStoreFetch("init_messaging");
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await waitStoreFetch("init_messaging");
        // The lost wizard, opened online.
        await getService("action").doAction({
            type: "ir.actions.act_window",
            res_model: "crm.lead.lost",
            views: [[false, "form"]],
            target: "new",
        });
        expect(".modal .o_form_view").toHaveCount(1);
        const wizardButton = (matches) =>
            buttons.find(
                ({ props, clickParams }) =>
                    props.record?.resModel === "crm.lead.lost" && matches(clickParams)
            );
        const markLost = wizardButton(({ name }) => name === "action_lost_reason_apply");
        const cancel = wizardButton(({ special }) => special === "cancel");
        expect(markLost.clickParams.type).toBe("object");
        expect(cancel.clickParams.type).toBe(undefined);

        await setOffline(true);
        await markLost.onClick();
        await animationFrame();
        expect(".modal .o_form_view").toHaveCount(1);
        // Cancel calls no server method: the CRM guard leaves it to the framework, which discards
        // the new wizard record and closes the dialog without a request.
        await cancel.onClick();
        await animationFrame();
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);
        expect(queuedEntries()).toHaveLength(0);
    });

    test("pendingLeadCreates places a queued lead create without stage_id in the stage of its context default_stage_id", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const crmOffline = await mountHookApi();

        await setOffline(true);
        const offline = getService(OfflinePlugin);
        const scheduleLeadSave = (ids, values, context, timeStamp) =>
            offline.scheduleORM(
                "crm.lead",
                "web_save",
                [ids, values],
                { context, specification: {} },
                {
                    extras: {
                        actionId: undefined,
                        actionName: undefined,
                        viewType: "kanban",
                        timeStamp,
                        displayName: values.name,
                        changes: values,
                    },
                }
            );
        // A create whose values carry no stage: the server takes it from the context's
        // `default_stage_id`, as for a lead created in a stage column.
        const qualifiedColumn = { default_stage_id: 2 };
        const contextKey = scheduleLeadSave([], { name: "Context lead" }, qualifiedColumn, 1);
        // A create whose values name a stage: the values win over the context default.
        const valuesKey = scheduleLeadSave(
            [],
            { name: "Values lead", stage_id: 1 },
            qualifiedColumn,
            2
        );
        // A write of an existing lead in the same context, and a create with no stage at all.
        scheduleLeadSave([1], { name: "Lead 1 renamed" }, qualifiedColumn, 3);
        scheduleLeadSave([], { name: "Stageless lead" }, {}, 4);
        expect(queuedEntries()).toHaveLength(4);

        const keysOf = (entries) => entries.map(({ key }) => key);
        expect(keysOf(crmOffline.pendingLeadCreates(2))).toEqual([contextKey]);
        expect(keysOf(crmOffline.pendingLeadCreates(1))).toEqual([valuesKey]);
        expect(crmOffline.pendingLeadCreates(3)).toEqual([]);
        // The entry as stored, from the live queue and from a copy of it (sync-window entries).
        const [contextEntry] = crmOffline.pendingLeadCreates(2);
        expect(contextEntry).toBe(queuedEntries().find(({ key }) => key === contextKey));
        expect(crmOffline.pendingLeadCreates(2, [...queuedEntries()].reverse())).toEqual([
            contextEntry,
        ]);
    });

    test("targetsCrmLead falls back to the context's default_res_model, then default_model, when the mail form's own target field is empty", async () => {
        // Records as the predicate reads them: `resModel`, `data` and `context`.
        const mailForm = (resModel, data, context) => ({ resModel, data, context });
        // The target field is empty or not loaded: the dialog's context names the lead.
        const toLead = { default_res_model: "crm.lead" };
        expect(targetsCrmLead(mailForm("mail.activity", { res_model: false }, toLead))).toBe(true);
        expect(targetsCrmLead(mailForm("mail.activity.schedule", {}, toLead))).toBe(true);
        const composerToLead = { default_model: "crm.lead" };
        const emptyComposer = mailForm("mail.compose.message", { model: "" }, composerToLead);
        expect(targetsCrmLead(emptyComposer)).toBe(true);
        // The form's own target field comes first, then `default_res_model`, then `default_model`.
        expect(
            targetsCrmLead(mailForm("mail.followers.edit", { res_model: "res.partner" }, toLead))
        ).toBe(false);
        const partnerFirst = { default_res_model: "res.partner", default_model: "crm.lead" };
        expect(targetsCrmLead(mailForm("mail.compose.message", {}, partnerFirst))).toBe(false);
        // No target anywhere, another target, another model, no model or no record.
        expect(targetsCrmLead(mailForm("mail.activity", { res_model: false }, {}))).toBe(false);
        expect(
            targetsCrmLead(mailForm("mail.compose.message", {}, { default_model: "res.partner" }))
        ).toBe(false);
        expect(targetsCrmLead(mailForm("res.partner", {}, toLead))).toBe(false);
        expect(targetsCrmLead(mailForm(undefined, {}, toLead))).toBe(false);
        expect(targetsCrmLead(undefined)).toBe(false);

        // Framework records of the followers wizard and of the composer opened from a lead, whose
        // forms leave the target field out: offline, their save is refused and nothing is queued.
        const setOffline = mockOffline();
        keepPingsFailing();
        watchOfflineRpcs();
        const forms = captureInstances(FormController);
        listenStoreFetch("init_messaging");
        await mountView({
            type: "form",
            resModel: "mail.followers.edit",
            arch: /* xml */ `<form><field name="res_ids"/></form>`,
            context: toLead,
        });
        await mountView({
            type: "form",
            resModel: "mail.compose.message",
            arch: /* xml */ `<form><field name="subject"/></form>`,
            context: composerToLead,
        });
        await waitStoreFetch("init_messaging");
        const [followers, composer] = forms.map(({ model }) => model.root);
        expect([followers.resModel, composer.resModel]).toEqual([
            "mail.followers.edit",
            "mail.compose.message",
        ]);
        expect("res_model" in followers.data).toBe(false);
        expect("model" in composer.data).toBe(false);
        expect(targetsCrmLead(followers)).toBe(true);
        expect(targetsCrmLead(composer)).toBe(true);

        await setOffline(true);
        expect(await followers.save()).toBe(false);
        expect(await composer.save()).toBe(false);
        expect.verifySteps([
            "offline:mail.followers.edit/web_save",
            "offline:mail.compose.message/web_save",
        ]);
        expect(queuedEntries()).toHaveLength(0);
    });

    /**
     * Queues, as the framework queues a kanban record save, a move of Lead 1 (in New) to a stage,
     * under the given queue key (the `id` option of `scheduleORM`) and timestamp.
     *
     * @param {string | number} key
     * @param {number} stageId
     * @param {string} stageName
     * @param {number} timeStamp
     * @returns {string | number} the queue key
     */
    function scheduleLead1StageWrite(key, stageId, stageName, timeStamp) {
        return getService(OfflinePlugin).scheduleORM(
            "crm.lead",
            "web_save",
            [[1], { stage_id: stageId }],
            { context: {}, specification: {} },
            {
                id: key,
                extras: {
                    actionId: undefined,
                    actionName: undefined,
                    viewType: "kanban",
                    timeStamp,
                    displayName: "Lead 1",
                    changes: { stage_id: { id: stageId, display_name: stageName } },
                    originalValues: { stage_id: { id: 1, display_name: "New" } },
                },
            }
        );
    }

    /**
     * Asserts that `latestStageWrite` returns the stored entry of `key`, a move of Lead 1 to
     * `stageId`, whichever way it reads the queue: the live queue and a reversed copy of it, both
     * scanned, and frozen copies in both orders, indexed. The answer depends on neither the array
     * order nor the reader's path.
     *
     * @param {ReturnType<typeof useCrmOffline>} crmOffline
     * @param {string | number} key
     * @param {number} stageId
     */
    function expectLead1LatestStageWrite(crmOffline, key, stageId) {
        const entries = queuedEntries();
        const stored = entries.find((entry) => entry.key === key);
        expect(stored.value.args).toEqual([[1], { stage_id: stageId }]);
        const reversed = [...entries].reverse();
        expect(crmOffline.latestStageWrite(1)).toBe(stored);
        expect(crmOffline.latestStageWrite(1, reversed)).toBe(stored);
        expect(crmOffline.latestStageWrite(1, Object.freeze([...entries]))).toBe(stored);
        expect(crmOffline.latestStageWrite(1, Object.freeze([...reversed]))).toBe(stored);
    }

    test("latestStageWrite ranks tied stage writes under array-index keys in ascending numeric order, number and string keys alike", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const crmOffline = await mountHookApi();

        // Offline, two moves of Lead 1 share their timestamp, under keys that are array indices:
        // the string "10", queued first, then the number 9. The queue, like the one the replay
        // rebuilds, enumerates such keys first, in ascending numeric order, so 9 replays before
        // "10" and the server keeps Won: neither the later insertion (9) nor string order ("9"
        // after "10") decides.
        await setOffline(true);
        const timeStamp = Date.now();
        expect(scheduleLead1StageWrite("10", 3, "Won", timeStamp)).toBe("10");
        expect(scheduleLead1StageWrite(9, 2, "Qualified", timeStamp)).toBe(9);
        expect(queuedEntries().map(({ key }) => key)).toEqual([9, "10"]);
        expectLead1LatestStageWrite(crmOffline, "10", 3);
    });

    test("latestStageWrite ranks a tied stage write under a number key that is not an array index before one under a string key", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const crmOffline = await mountHookApi();

        // Offline, two moves of Lead 1 share their timestamp, under keys that are not array
        // indices: a hash-shaped string, queued first, then the number 2 ** 32 - 1, one past the
        // greatest array index. The queue enumerates them in insertion order, but the replay
        // rebuilds it from IndexedDB, which returns number keys before string keys: the string
        // replays last and the server keeps Won, although the number was queued later and its
        // digits sort after the string.
        await setOffline(true);
        const timeStamp = Date.now();
        const numberKey = 2 ** 32 - 1;
        expect(scheduleLead1StageWrite("0abcdef0", 3, "Won", timeStamp)).toBe("0abcdef0");
        expect(scheduleLead1StageWrite(numberKey, 2, "Qualified", timeStamp)).toBe(numberKey);
        expect(queuedEntries().map(({ key }) => key)).toEqual(["0abcdef0", numberKey]);
        expectLead1LatestStageWrite(crmOffline, "0abcdef0", 3);
    });

    test("latestStageWrite ranks tied stage writes under number keys that are not array indices in ascending numeric order", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const crmOffline = await mountHookApi();

        // Offline, two moves of Lead 1 share their timestamp, under negative number keys, which
        // are not array indices: -1, queued first, then -2. IndexedDB returns number keys in
        // ascending order, so the replay applies -2 before -1 and the server keeps Won: neither
        // the later insertion (-2) nor string order ("-2" after "-1") decides.
        await setOffline(true);
        const timeStamp = Date.now();
        expect(scheduleLead1StageWrite(-1, 3, "Won", timeStamp)).toBe(-1);
        expect(scheduleLead1StageWrite(-2, 2, "Qualified", timeStamp)).toBe(-2);
        expect(queuedEntries().map(({ key }) => key)).toEqual([-1, -2]);
        expectLead1LatestStageWrite(crmOffline, -1, 3);
    });

    test("the stage index of a frozen entries array skips a queued lead save without ids and still indexes the entries after it, as a scan does", async () => {
        const setOffline = mockOffline();
        keepPingsFailing();
        const crmOffline = await mountHookApi();

        // Offline, the queue holds, in this order: a lead save stored without its arguments, the
        // latest of all, which has no ids and so neither writes a lead nor creates one; a move of
        // Lead 1 to Qualified; and a lead create in Qualified.
        await setOffline(true);
        const offline = getService(OfflinePlugin);
        const timeStamp = Date.now();
        const kanbanSaveExtras = (displayName, changes, at) => ({
            actionId: undefined,
            actionName: undefined,
            viewType: "kanban",
            timeStamp: at,
            displayName,
            changes,
        });
        const argumentlessKey = offline.scheduleORM(
            "crm.lead",
            "web_save",
            undefined,
            { context: {}, specification: {} },
            {
                id: "a0000001",
                extras: kanbanSaveExtras(
                    "Lead 1",
                    { stage_id: { id: 3, display_name: "Won" } },
                    timeStamp + 1
                ),
            }
        );
        const stageKey = scheduleLead1StageWrite("b0000002", 2, "Qualified", timeStamp);
        const createKey = offline.scheduleORM(
            "crm.lead",
            "web_save",
            [[], { name: "Offline lead", stage_id: 2 }],
            { context: {}, specification: {} },
            {
                id: "c0000003",
                extras: kanbanSaveExtras(
                    "Offline lead",
                    { name: "Offline lead", stage_id: { id: 2, display_name: "Qualified" } },
                    timeStamp
                ),
            }
        );
        const entries = queuedEntries();
        expect(entries.map(({ key }) => key)).toEqual([argumentlessKey, stageKey, createKey]);
        const [argumentless, stageWrite, leadCreate] = entries;
        expect(argumentless.value.args).toBe(undefined);

        // The frozen array is indexed in one traversal that skips the save without ids and goes on
        // with the entries after it. Every answer is the one a scan of the live queue gives: the
        // move stays Lead 1's latest stage write, the create is the only one in Qualified, and the
        // skipped save is placed nowhere, not even as a create without a stage.
        const frozen = Object.freeze([...entries]);
        for (const list of [frozen, queuedEntries()]) {
            expect(crmOffline.latestStageWrite(1, list)).toBe(stageWrite);
            const qualifiedCreates = crmOffline.pendingLeadCreates(2, list);
            expect(qualifiedCreates).toHaveLength(1);
            expect(qualifiedCreates[0]).toBe(leadCreate);
            expect(crmOffline.pendingLeadCreates(3, list)).toEqual([]);
            expect(crmOffline.pendingLeadCreates(undefined, list)).toEqual([]);
        }
    });
});

// -----------------------------------------------------------------------------
// Shared hooks contract: plain helpers, loaders, queue readers, `runOrQueue` and the fallback
// and delegation branches of the handler patches (`@crm/mobile/crm_offline_hooks`)
// -----------------------------------------------------------------------------

/** Env config of the hooks harness: `runOrQueue` copies it into the extras of a queued call. */
const HARNESS_CONFIG = Object.freeze({
    actionId: PIPELINE_ACTION_ID,
    actionName: "Pipeline",
    viewType: "kanban",
});

/** The smallest component using the shared hook: its `crmOffline` is the object under test. */
class CrmOfflineHarness extends Component {
    static template = xml`<div class="o_crm_hooks_harness"/>`;

    setup() {
        this.crmOffline = useCrmOffline();
    }
}

/**
 * Mounts the hooks harness in an action env (`HARNESS_CONFIG`) and lets the offline plugin finish
 * its start-up synchronisation, which reloads the queue from its storage: a call scheduled
 * afterwards keeps its stored entry.
 *
 * @returns {Promise<ReturnType<typeof useCrmOffline>>} the harness's `crmOffline`
 */
async function mountHooksHarness() {
    const harness = await mountWithCleanup(CrmOfflineHarness, {
        componentEnv: { config: { ...HARNESS_CONFIG } },
    });
    expect(".o_crm_hooks_harness").toHaveCount(1);
    await runAllTimers(); // flush the start-up synchronisation of the offline plugin
    await animationFrame();
    expect(getService(OfflinePlugin).syncingORM()).toBe(false);
    return harness.crmOffline;
}

/**
 * Schedules a call in the framework offline queue, through the framework, with the extras CRM
 * code gives its calls, and returns its entry exactly as the queue stores it (`{key, value}`).
 *
 * @param {string} model
 * @param {string} method
 * @param {any[]} args
 * @param {Object} [kwargs]
 * @returns {{ key: number | string, value: Object }}
 */
function scheduleQueueFixture(model, method, args, kwargs = {}) {
    const offlinePlugin = getService(OfflinePlugin);
    const key = offlinePlugin.scheduleORM(model, method, args, kwargs, {
        extras: {
            ...HARNESS_CONFIG,
            timeStamp: Date.now(),
            displayName: `${model}/${method} ${JSON.stringify(args)}`,
            changes: {},
        },
    });
    return offlinePlugin._ormToSync()[key];
}

/**
 * Steps, as `"<model>/<method>"` or the path, every request issued once `start()` is called,
 * except the offline plugin's reconnection pings. Registered after `mockOffline()`, it also sees
 * the requests the offline mock answers with a 502.
 *
 * @returns {{ start: () => void }}
 */
function watchRequestsFromNowOn() {
    let watching = false;
    onRpc("/*", (request) => {
        const path = new URL(request.url).pathname;
        if (!watching || path === "/web/webclient/version_info") {
            return;
        }
        const match = path.match(R_CALL_KW);
        expect.step(match ? `${match.groups.model}/${match.groups.method}` : path);
    });
    return {
        start() {
            watching = true;
        },
    };
}

/**
 * @template T
 * @param {T[]} instances captured component instances
 * @returns {T[]} those still mounted
 */
function mountedInstances(instances) {
    return instances.filter((instance) => status(instance) === "mounted");
}

/**
 * @param {Object} kwargs the kwargs of a `web_search_read` request, as the mock server gets them
 * @returns {Object} their named arguments (no mock server marker), the user context left out
 */
function searchKwargs(kwargs) {
    return Object.fromEntries(Object.entries(kwargs).filter(([name]) => name !== "context"));
}

/**
 * @param {{ key: number | string }[]} entries queue entries
 * @returns {(number | string)[]} their keys, sorted
 */
function queueKeys(entries) {
    return entries.map(({ key }) => key).sort();
}

describe("Shared hooks contract", () => {
    test("isOfflineModel: false without a model or offline plugin, else the plugin's state", async () => {
        expect(isOfflineModel(undefined)).toBe(false);
        expect(isOfflineModel(null)).toBe(false);
        expect(isOfflineModel({})).toBe(false);
        expect(isOfflineModel({ offlinePlugin: null })).toBe(false);
        expect(isOfflineModel({ offlinePlugin: { isOffline: () => false } })).toBe(false);
        expect(isOfflineModel({ offlinePlugin: { isOffline: () => true } })).toBe(true);
    });

    test("targetsCrmLead: the form's own target field, else default_res_model ?? default_model", async () => {
        expect(CRM_MAIL_FORM_TARGETS).toEqual({
            "mail.activity": "res_model",
            "mail.activity.schedule": "res_model",
            "mail.followers.edit": "res_model",
            "mail.compose.message": "model",
        });
        /** A record-like object: the guards read only these three keys. */
        const record = (resModel, data = {}, context = {}) => ({ resModel, data, context });

        // Not a record, or not a mail dialog form, whatever it targets.
        expect(targetsCrmLead(undefined)).toBe(false);
        expect(targetsCrmLead(null)).toBe(false);
        expect(targetsCrmLead({})).toBe(false);
        const leadContext = { default_res_model: "crm.lead", default_model: "crm.lead" };
        const leadData = { res_model: "crm.lead", model: "crm.lead" };
        expect(targetsCrmLead(record("res.partner", leadData, leadContext))).toBe(false);
        expect(targetsCrmLead(record("crm.lead", leadData, leadContext))).toBe(false);
        // An inherited key of the map is not a mail dialog form.
        expect(targetsCrmLead(record("constructor", leadData, leadContext))).toBe(false);

        const targets = Object.entries(CRM_MAIL_FORM_TARGETS);
        expect(targets).toHaveLength(4);
        for (const [resModel, field] of targets) {
            const message = { message: `${resModel} (${field})` };
            const isTarget = (data, context) => targetsCrmLead(record(resModel, data, context));
            // The target field decides whenever it holds a value, over a conflicting context.
            expect(isTarget({ [field]: "crm.lead" })).toBe(true, message);
            expect(isTarget({ [field]: "res.partner" }, leadContext)).toBe(false, message);
            // An empty target field defers to the context.
            expect(isTarget({ [field]: false }, { default_res_model: "crm.lead" })).toBe(
                true,
                message
            );
            expect(isTarget({ [field]: "" }, { default_model: "crm.lead" })).toBe(true, message);
            expect(isTarget({}, { default_res_model: "res.partner" })).toBe(false, message);
            expect(isTarget({}, {})).toBe(false, message);
            // `default_model` counts only when `default_res_model` is absent (null or undefined):
            // an explicit false or empty `default_res_model` is the target.
            for (const absent of [null, undefined]) {
                const context = { default_res_model: absent, default_model: "crm.lead" };
                expect(isTarget({}, context)).toBe(true, message);
            }
            for (const explicit of [false, ""]) {
                const context = { default_res_model: explicit, default_model: "crm.lead" };
                expect(isTarget({}, context)).toBe(false, message);
            }
            expect(
                isTarget({}, { default_res_model: "res.partner", default_model: "crm.lead" })
            ).toBe(false, message);
            // A record without data or without context.
            const contextOnly = { resModel, context: { default_res_model: "crm.lead" } };
            expect(targetsCrmLead(contextOnly)).toBe(true, message);
            expect(targetsCrmLead({ resModel, data: {} })).toBe(false, message);
        }

        // The composer names its target in `default_model`, the schedule wizard in
        // `default_res_model`; each form reads its own target field only.
        const composer = record("mail.compose.message", { model: false }, leadContext);
        expect(targetsCrmLead(composer)).toBe(true);
        const composerByModel = { default_model: "crm.lead" };
        expect(targetsCrmLead(record("mail.compose.message", {}, composerByModel))).toBe(true);
        const scheduleContext = { default_res_model: "crm.lead" };
        expect(targetsCrmLead(record("mail.activity.schedule", {}, scheduleContext))).toBe(true);
        expect(targetsCrmLead(record("mail.compose.message", { res_model: "crm.lead" }))).toBe(
            false
        );
        expect(targetsCrmLead(record("mail.activity", { model: "crm.lead" }))).toBe(false);
    });

    test("loadActivityTypes: domain and specification only, cached list first, onUpdate on a changed answer only, errors", async () => {
        let answer = {
            length: 4,
            records: [
                { id: 1, display_name: "Email", category: "default" },
                { id: 2, display_name: "Call", category: "phonecall" },
                { id: 3, display_name: "Meeting", category: "meeting" },
                { id: 4, display_name: "Upload Document", category: "upload_file" },
            ],
        };
        let failure = null;
        const requests = [];
        onRpc("mail.activity.type", "web_search_read", ({ kwargs }) => {
            requests.push(kwargs);
            expect.step("types read");
            if (failure) {
                throw failure;
            }
            return answer;
        });
        // Registered after the server answer: while offline, its 502 comes first.
        const setOffline = mockOffline();
        const { orm } = await mountHooksHarness();
        const onUpdate = (types) => expect.step(`onUpdate ${types.map(({ id }) => id)}`);
        const creatable = [
            { id: 1, display_name: "Email", category: "default" },
            { id: 2, display_name: "Call", category: "phonecall" },
        ];

        // Cold and offline: nothing cached, so the lost connection resolves null.
        await setOffline(true);
        await expect(loadActivityTypes(orm, onUpdate)).resolves.toBe(null);
        expect.verifySteps([]);
        await setOffline(false);

        // Any other server error, nothing cached: rethrown to the caller.
        failure = makeServerError({ message: "Activity types are locked" });
        await expect(loadActivityTypes(orm, onUpdate)).rejects.toThrow(/Activity types are locked/);
        expect.verifySteps(["types read"]);
        failure = null;

        // The first read: the server answer without meeting and upload types, no onUpdate.
        await expect(loadActivityTypes(orm, onUpdate)).resolves.toEqual(creatable);
        expect.verifySteps(["types read"]);
        expect(requests).toHaveLength(2);
        expect(searchKwargs(requests.at(-1))).toEqual({
            domain: [["res_model", "in", [false, "crm.lead"]]],
            specification: { display_name: {}, category: {} },
        });

        // The same answer: the cached list first; the refresh changes nothing, so no onUpdate.
        await expect(loadActivityTypes(orm, onUpdate)).resolves.toEqual(creatable);
        await animationFrame();
        expect.verifySteps(["types read"]);
        expect(searchKwargs(requests.at(-1))).toEqual(searchKwargs(requests.at(-2)));

        // A changed answer: the cached list first, then onUpdate once with the fresh list.
        const followUp = { id: 5, display_name: "Follow-up", category: "default" };
        answer = { length: 5, records: [...answer.records, followUp] };
        await expect(loadActivityTypes(orm, onUpdate)).resolves.toEqual(creatable);
        await expect.waitForSteps(["types read", "onUpdate 1,2,5"]);

        // A changed answer without onUpdate raises nothing; the next read starts from it.
        const todo = { id: 6, display_name: "To-Do", category: "default" };
        answer = { length: 1, records: [todo] };
        await expect(loadActivityTypes(orm)).resolves.toEqual([...creatable, followUp]);
        await animationFrame();
        await expect(loadActivityTypes(orm, onUpdate)).resolves.toEqual([todo]);
        await animationFrame();
        expect.verifySteps(["types read", "types read"]);
    });

    test("loadLeadActivities: per-lead bounded request, limit and withLength options, cached first, errors", async () => {
        let total = 3;
        let failure = null;
        const requests = [];
        /** @param {number} count @returns {Object[]} the first `count` activities of the lead */
        const activities = (count) =>
            Array.from({ length: count }, (_, index) => ({
                id: index + 1,
                summary: `Activity ${index + 1}`,
            }));
        onRpc("mail.activity", "web_search_read", ({ kwargs }) => {
            requests.push(kwargs);
            expect.step(`activities read: lead ${kwargs.domain[1][2]}, limit ${kwargs.limit}`);
            if (failure) {
                throw failure;
            }
            // As the server does: at most `limit` records, and the total count of the lead's.
            return { length: total, records: activities(Math.min(total, kwargs.limit)) };
        });
        // Registered after the server answer: while offline, its 502 comes first.
        const setOffline = mockOffline();
        const { orm } = await mountHooksHarness();
        /** @param {Object[] | { records: Object[], length: number }} value */
        const onUpdate = (value) =>
            expect.step(
                Array.isArray(value)
                    ? `onUpdate ${value.length} records`
                    : `onUpdate ${value.records.length} records of ${value.length}`
            );

        // Invalid limits throw before any request.
        for (const limit of [0, -1, 1.5, "40", null, Number.NaN]) {
            await expect(loadLeadActivities(orm, 7, onUpdate, { limit })).rejects.toThrow(
                /`limit` must be a positive integer/
            );
        }
        expect.verifySteps([]);

        // Cold and offline: nothing cached, so the lost connection resolves null.
        await setOffline(true);
        await expect(loadLeadActivities(orm, 7, onUpdate)).resolves.toBe(null);
        await expect(loadLeadActivities(orm, 7, onUpdate, { withLength: true })).resolves.toBe(
            null
        );
        expect.verifySteps([]);
        await setOffline(false);

        // Any other server error, nothing cached: rethrown to the caller.
        failure = makeServerError({ message: "Activities are locked" });
        await expect(loadLeadActivities(orm, 7, onUpdate)).rejects.toThrow(/Activities are locked/);
        expect.verifySteps(["activities read: lead 7, limit 40"]);
        failure = null;

        // The first read: the lead's own activities, by deadline, 40 at most; no onUpdate.
        await expect(loadLeadActivities(orm, 7, onUpdate)).resolves.toEqual(activities(3));
        expect.verifySteps(["activities read: lead 7, limit 40"]);
        expect(requests).toHaveLength(2);
        expect(searchKwargs(requests.at(-1))).toEqual({
            domain: [
                ["res_model", "=", "crm.lead"],
                ["res_id", "=", 7],
            ],
            specification: {
                activity_type_id: { fields: { display_name: {} } },
                activity_category: {},
                summary: {},
                date_deadline: {},
                state: {},
                user_id: { fields: { display_name: {} } },
            },
            order: "date_deadline ASC, id ASC",
            limit: 40,
        });

        // The same answer: the cached records first; the refresh changes nothing.
        await expect(loadLeadActivities(orm, 7, onUpdate)).resolves.toEqual(activities(3));
        await animationFrame();
        expect.verifySteps(["activities read: lead 7, limit 40"]);
        expect(searchKwargs(requests.at(-1))).toEqual(searchKwargs(requests.at(-2)));

        // A changed answer: the cached records first, then onUpdate once with the fresh ones.
        total = 4;
        await expect(loadLeadActivities(orm, 7, onUpdate)).resolves.toEqual(activities(3));
        await expect.waitForSteps(["activities read: lead 7, limit 40", "onUpdate 4 records"]);

        // A changed answer without onUpdate raises nothing; the next read starts from it.
        total = 5;
        await expect(loadLeadActivities(orm, 7)).resolves.toEqual(activities(4));
        await animationFrame();
        await expect(loadLeadActivities(orm, 7, undefined, null)).resolves.toEqual(activities(5));
        await animationFrame();
        expect.verifySteps([
            "activities read: lead 7, limit 40",
            "activities read: lead 7, limit 40",
        ]);

        // With `withLength`, the same request: the promise and onUpdate also carry the server's
        // total, so a truncated read (45 activities, 40 read) is told apart.
        total = 45;
        await expect(loadLeadActivities(orm, 7, onUpdate, { withLength: true })).resolves.toEqual({
            records: activities(5),
            length: 5,
        });
        await expect.waitForSteps([
            "activities read: lead 7, limit 40",
            "onUpdate 40 records of 45",
        ]);
        await expect(loadLeadActivities(orm, 7, onUpdate, { withLength: true })).resolves.toEqual({
            records: activities(40),
            length: 45,
        });
        await animationFrame();
        expect.verifySteps(["activities read: lead 7, limit 40"]);

        // A larger limit is sent as given: a separate request, read from the server.
        await expect(
            loadLeadActivities(orm, 7, onUpdate, { limit: 45, withLength: true })
        ).resolves.toEqual({ records: activities(45), length: 45 });
        expect.verifySteps(["activities read: lead 7, limit 45"]);
        expect(searchKwargs(requests.at(-1))).toEqual({
            ...searchKwargs(requests.at(-2)),
            limit: 45,
        });

        // Another lead: its own request.
        await expect(loadLeadActivities(orm, 8, onUpdate)).resolves.toEqual(activities(40));
        expect.verifySteps(["activities read: lead 8, limit 40"]);
        expect(searchKwargs(requests.at(-1)).domain).toEqual([
            ["res_model", "=", "crm.lead"],
            ["res_id", "=", 8],
        ]);
    });

    test("isRecordPendingSync: a live offlineId, or a queued pending-method call on the record's model and id", async () => {
        const setOffline = mockOffline();
        const crmOffline = await mountHooksHarness();
        await setOffline(true);
        expect(crmOffline.isOffline()).toBe(true);
        expect(crmOffline.isRecordPendingSync(null)).toBe(false);
        expect(crmOffline.isRecordPendingSync(undefined)).toBe(false);
        expect(crmOffline.isRecordPendingSync({ resModel: "crm.lead", resId: 11 })).toBe(false);

        const create = scheduleQueueFixture("crm.lead", "web_save", [[], { name: "New lead" }], {
            context: {},
            specification: {},
        });
        const discarded = scheduleQueueFixture("crm.lead", "web_save", [[], { name: "Gone" }]);
        getService(OfflinePlugin).removeScheduledORM(discarded.key);
        const pendingCalls = [
            ["web_save", [[11], { priority: "1" }]],
            ["web_unlink", [[12]]],
            ["unlink", [[13]]],
            ["action_archive", [[14, 19]]],
            ["action_unarchive", [[15]]],
        ];
        for (const [method, args] of pendingCalls) {
            scheduleQueueFixture("crm.lead", method, args);
        }
        scheduleQueueFixture("crm.team", "web_save", [[30], { name: "Renamed team" }]);
        // Calls of other method families: framework queue fixtures, no CRM code queues them.
        scheduleQueueFixture("crm.lead", "action_done", [[17]]);
        scheduleQueueFixture("crm.lead", "write", [[18], { priority: "2" }]);
        expect(crmOffline.queuedEntries()).toHaveLength(9);
        expect(getService(OfflinePlugin)._ormToSync()[discarded.key]).toBe(undefined);

        const isPending = (resModel, resId, offlineId) =>
            crmOffline.isRecordPendingSync({ resModel, resId, offlineId });
        // A new record (no id): only its offlineId, while that key is still queued.
        expect(isPending("crm.lead", false, undefined)).toBe(false);
        expect(isPending("crm.lead", false, create.key)).toBe(true);
        expect(isPending("crm.lead", false, discarded.key)).toBe(false);
        // Each pending method family, for the record's model and an id of `args[0]`.
        const pendingIds = [
            [11, "web_save"],
            [12, "web_unlink"],
            [13, "unlink"],
            [14, "action_archive"],
            [19, "action_archive"],
            [15, "action_unarchive"],
        ];
        for (const [resId, method] of pendingIds) {
            const message = { message: `${method} on ${resId}` };
            expect(isPending("crm.lead", resId)).toBe(true, message);
            expect(isPending("crm.lead", resId, discarded.key)).toBe(true, message);
            // The same call on another model.
            expect(isPending("crm.stage", resId)).toBe(false, message);
        }
        expect(isPending("crm.team", 30)).toBe(true);
        expect(isPending("crm.lead", 30)).toBe(false);
        // Another id, and other method families.
        expect(isPending("crm.lead", 16)).toBe(false);
        expect(isPending("crm.lead", 17)).toBe(false);
        expect(isPending("crm.lead", 18)).toBe(false);
    });

    test("pendingLeadCreates: crm.lead creates of a stage, by stage_id ?? context default_stage_id, as stored", async () => {
        const setOffline = mockOffline();
        const crmOffline = await mountHooksHarness();
        await setOffline(true);
        const offlinePlugin = getService(OfflinePlugin);
        const byValues = scheduleQueueFixture(
            "crm.lead",
            "web_save",
            [[], { name: "Stage in values", stage_id: 2 }],
            { context: { default_stage_id: 1 }, specification: {} }
        );
        const byContext = scheduleQueueFixture(
            "crm.lead",
            "web_save",
            [[], { name: "Stage in context" }],
            { context: { default_stage_id: 2 }, specification: {} }
        );
        const firstStage = scheduleQueueFixture(
            "crm.lead",
            "web_save",
            [[], { name: "First stage", stage_id: 1 }],
            { context: {} }
        );
        const noStage = scheduleQueueFixture(
            "crm.lead",
            "web_save",
            [[], { name: "No stage", stage_id: false }],
            { context: { default_stage_id: 2 } }
        );
        // Never a pending create: a write, another model, another method.
        const stageContext = { context: { default_stage_id: 2 } };
        scheduleQueueFixture("crm.lead", "web_save", [[3], { stage_id: 2 }], stageContext);
        scheduleQueueFixture("crm.stage", "web_save", [[], { name: "Stage", stage_id: 2 }]);
        scheduleQueueFixture(
            "mail.activity",
            "web_save",
            [[], { res_model: "crm.lead", res_id: 1, stage_id: 2 }],
            stageContext
        );
        scheduleQueueFixture("crm.lead", "action_unarchive", [[]], stageContext);
        const live = crmOffline.queuedEntries();
        expect(live).toHaveLength(8);
        const stored = JSON.stringify(offlinePlugin._ormToSync());

        const secondStage = crmOffline.pendingLeadCreates(2);
        expect(queueKeys(secondStage)).toEqual(queueKeys([byValues, byContext]));
        // The entries themselves, as the queue stores them: key next to value.
        for (const entry of secondStage) {
            expect(entry).toBe(live.find(({ key }) => key === entry.key));
            expect(entry).toBe(offlinePlugin._ormToSync()[entry.key]);
        }
        const [first] = crmOffline.pendingLeadCreates(1);
        expect(crmOffline.pendingLeadCreates(1)).toHaveLength(1);
        expect(first).toBe(firstStage);
        // An explicit `stage_id: false` is the create's stage, whatever the context says.
        const [unstaged] = crmOffline.pendingLeadCreates(false);
        expect(crmOffline.pendingLeadCreates(false)).toHaveLength(1);
        expect(unstaged).toBe(noStage);
        expect(crmOffline.pendingLeadCreates(3)).toEqual([]);
        // Reading changes nothing in the queue.
        expect(JSON.stringify(offlinePlugin._ormToSync())).toBe(stored);

        // An explicit list (the pipeline's sync-window copy) is read instead of the live queue.
        const snapshot = JSON.parse(stored);
        const copies = Object.values(snapshot);
        offlinePlugin.removeScheduledORM(byContext.key);
        expect(queueKeys(crmOffline.pendingLeadCreates(2))).toEqual([byValues.key]);
        const fromCopies = crmOffline.pendingLeadCreates(2, copies);
        expect(queueKeys(fromCopies)).toEqual(queueKeys([byValues, byContext]));
        for (const entry of fromCopies) {
            expect(copies.includes(entry)).toBe(true);
        }
        expect(crmOffline.pendingLeadCreates(2, [])).toEqual([]);
    });

    test("runOrQueue: an invalid call is refused before anything runs, is requested or is queued", async () => {
        const setOffline = mockOffline();
        const requests = watchRequestsFromNowOn();
        const crmOffline = await mountHooksHarness();
        requests.start();
        const online = async () => expect.step("online call");
        const queue = {
            model: "crm.lead",
            method: "web_save",
            args: [[], { name: "Lead" }],
            kwargs: { context: {}, specification: {} },
        };
        const invalidCalls = [
            [{ queue }, /`online` must be a function/],
            [{ online: "crm.lead/web_save", queue }, /`online` must be a function/],
            [{ online }, /only web_save and action_archive can be queued, got "undefined"/],
            [{ online, queue: { ...queue, model: undefined } }, /`queue.model` is required/],
            [{ online, queue: { ...queue, model: "" } }, /`queue.model` is required/],
            // The method is checked first: an unqueueable call without a model names the method.
            [
                { online, queue: { ...queue, model: undefined, method: "write" } },
                /can be queued, got "write"/,
            ],
            [{ online, queue: { ...queue, method: "write" } }, /can be queued, got "write"/],
            [{ online, queue: { ...queue, method: "unlink" } }, /can be queued, got "unlink"/],
            [{ online, queue: { ...queue, method: undefined } }, /got "undefined"/],
        ];
        for (const offline of [false, true]) {
            await setOffline(offline);
            expect(crmOffline.isOffline()).toBe(offline);
            for (const [params, error] of invalidCalls) {
                await expect(crmOffline.runOrQueue(params)).rejects.toThrow(error);
            }
        }
        expect.verifySteps([]);
        expect(crmOffline.queuedEntries()).toEqual([]);
    });

    test("runOrQueue: online result, connection-loss fallback, propagated errors and the queued call's defaults", async () => {
        const setOffline = mockOffline();
        const requests = watchRequestsFromNowOn();
        const crmOffline = await mountHooksHarness();
        requests.start();
        const offlinePlugin = getService(OfflinePlugin);
        const queue = { model: "crm.lead", method: "web_save", args: [[], { name: "Quick" }] };
        const online = async () => expect.step("online call");
        const extrasKeys = [
            "actionId",
            "actionName",
            "viewType",
            "timeStamp",
            "displayName",
            "changes",
        ];
        /**
         * Asserts that `outcome` is a queued call whose entry holds `value`, the timestamp being
         * taken while the call ran, and returns that entry.
         */
        const expectQueued = (outcome, value, before) => {
            expect(Object.keys(outcome)).toEqual(["queued", "key"]);
            expect(outcome.queued).toBe(true);
            const entry = offlinePlugin._ormToSync()[outcome.key];
            expect(entry.key).toBe(outcome.key);
            expect(Object.keys(entry.value.extras)).toEqual(extrasKeys);
            const { timeStamp } = entry.value.extras;
            expect(typeof timeStamp).toBe("number");
            expect(timeStamp >= before && timeStamp <= Date.now()).toBe(true);
            expect(entry.value).toEqual({
                ...value,
                extras: { ...value.extras, timeStamp },
            });
            return entry;
        };
        const defaultExtras = { ...HARNESS_CONFIG, displayName: "", changes: {} };

        const result = [{ id: 9, name: "Quick" }];
        const done = await crmOffline.runOrQueue({
            online: async () => {
                expect.step("online call");
                return result;
            },
            queue,
        });
        expect(done).toEqual({ queued: false, result });
        expect.verifySteps(["online call"]);
        expect(crmOffline.queuedEntries()).toEqual([]);

        // Online, a live call rejected for another reason than a lost connection: propagated.
        const refusal = makeServerError({ message: "Leads are locked" });
        await expect(
            crmOffline.runOrQueue({
                online: async () => {
                    throw refusal;
                },
                queue,
            })
        ).rejects.toBe(refusal);
        expect(crmOffline.queuedEntries()).toEqual([]);

        // Online, the connection drops during the live call: the call is queued instead, with
        // empty kwargs and the default extras (the env's action and view type).
        let before = Date.now();
        const lost = await crmOffline.runOrQueue({
            online: async () => {
                throw new ConnectionLostError("/web/dataset/call_kw/crm.lead/web_save");
            },
            queue,
        });
        const lostEntry = expectQueued(
            lost,
            { ...queue, kwargs: {}, extras: defaultExtras },
            before
        );
        expect(crmOffline.queuedEntries()).toEqual([lostEntry]);
        offlinePlugin.removeScheduledORM(lost.key);

        // Offline: queued at once, the live call never runs.
        await setOffline(true);
        before = Date.now();
        const queued = await crmOffline.runOrQueue({ online, queue });
        const queuedEntry = expectQueued(
            queued,
            { ...queue, kwargs: {}, extras: defaultExtras },
            before
        );
        // The caller's kwargs, view type, display name and changes override the defaults.
        before = Date.now();
        const archive = {
            model: "mail.activity",
            method: "action_archive",
            args: [[5]],
            kwargs: { context: { active_test: false } },
        };
        const extras = { viewType: "form", displayName: "Call: Lead 1", changes: { done: true } };
        const archived = await crmOffline.runOrQueue({
            online,
            queue: { ...archive, extras },
        });
        const archivedEntry = expectQueued(
            archived,
            { ...archive, extras: { ...HARNESS_CONFIG, ...extras } },
            before
        );
        expect(archived.key).not.toBe(queued.key);
        expect(queueKeys(crmOffline.queuedEntries())).toEqual(
            queueKeys([queuedEntry, archivedEntry])
        );
        expect.verifySteps([]);
    });

    test("runOrQueue: a NonSecureContextError of the framework queue propagates", async () => {
        const setOffline = mockOffline();
        const crmOffline = await mountHooksHarness();
        const offlinePlugin = getService(OfflinePlugin);
        const securityError = new NonSecureContextError(
            "Offline features not available in a non-secure context"
        );
        patchWithCleanup(offlinePlugin, {
            scheduleORM() {
                expect.step("scheduleORM");
                throw securityError;
            },
        });
        const queue = { model: "crm.lead", method: "web_save", args: [[], { name: "Quick" }] };

        // Online, on a lost connection.
        await expect(
            crmOffline.runOrQueue({
                online: async () => {
                    expect.step("online call");
                    throw new ConnectionLostError("/web/dataset/call_kw/crm.lead/web_save");
                },
                queue,
            })
        ).rejects.toBe(securityError);
        expect.verifySteps(["online call", "scheduleORM"]);

        await setOffline(true);
        const error = await crmOffline
            .runOrQueue({ online: async () => expect.step("online call"), queue })
            .catch((rejection) => rejection);
        expect(error).toBeInstanceOf(NonSecureContextError);
        expect(error).toBe(securityError);
        expect.verifySteps(["scheduleORM"]);
        expect(crmOffline.queuedEntries()).toEqual([]);
    });

    test("ViewButton guard: special and non-server buttons run offline; without its hook it reads the record's model", async () => {
        const setOffline = mockOffline();
        watchOfflineRpcs();
        const buttons = captureInstances(ViewButton);
        await mountView({
            type: "form",
            resModel: "crm.lead",
            resId: 1,
            arch: /* xml */ `
                <form>
                    <sheet>
                        <button name="action_set_won_rainbowman" type="object" string="Won"/>
                        <button name="crm.crm_lead_lost_action" type="action" string="Lost"/>
                        <button special="save" string="Save now"/>
                        <button special="cancel" string="Discard now"/>
                        <button name="https://www.odoo.com/app/crm" type="url" string="CRM"/>
                        <field name="name"/>
                    </sheet>
                </form>`,
        });
        const labels = [
            "action_set_won_rainbowman",
            "crm.crm_lead_lost_action",
            "save",
            "cancel",
            "https://www.odoo.com/app/crm",
        ];
        const button = (label) =>
            mountedInstances(buttons).find(
                ({ clickParams }) => (clickParams.special ?? clickParams.name) === label
            );
        // The base handler runs the button (it would save the record first): stepped instead.
        for (const label of labels) {
            expect(button(label).props.record.resModel).toBe("crm.lead", { message: label });
            button(label).handleViewButton = ({ clickParams }) =>
                expect.step(`run ${clickParams.special ?? clickParams.name}`);
        }

        // Online, every button runs.
        for (const label of labels) {
            button(label).onClick();
        }
        expect.verifySteps(labels.map((label) => `run ${label}`));

        // Offline, the server buttons are inert; a special button (save, discard: no type) and a
        // button of another type still run.
        await setOffline(true);
        for (const label of labels) {
            button(label).onClick();
        }
        expect.verifySteps(["run save", "run cancel", "run https://www.odoo.com/app/crm"]);

        // An instance without its hook (`crmOffline`) reads the record's model instead.
        const won = button("action_set_won_rainbowman");
        delete won.crmOffline;
        expect(won.crmOffline).toBe(undefined);
        expect(isOfflineModel(won.props.record.model)).toBe(true);
        won.onClick();
        expect.verifySteps([]);
        await setOffline(false);
        expect(isOfflineModel(won.props.record.model)).toBe(false);
        won.onClick();
        expect.verifySteps(["run action_set_won_rainbowman"]);
    });

    test.tags("desktop");
    test("MultiRecordViewButton guard: without its hook it reads the list's model", async () => {
        const setOffline = mockOffline();
        watchOfflineRpcs();
        const buttons = captureInstances(MultiRecordViewButton);
        await mountView({ type: "list", resModel: "crm.lead" });
        await contains(".o_data_row:first .o_list_record_selector input").click();
        await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
        const lost = mountedInstances(buttons).find(
            ({ clickParams }) => clickParams.name === "crm.crm_lead_lost_action"
        );
        expect(lost.props.list.resModel).toBe("crm.lead");
        // The base handler runs the button on the selected ids: stepped instead.
        lost.handleViewButton = ({ clickParams, getResParams }) => {
            const { resModel, resIds } = getResParams();
            expect.step(`run ${clickParams.name} on ${resModel} ${resIds}`);
        };
        delete lost.crmOffline;
        expect(lost.crmOffline).toBe(undefined);

        await lost.onClick();
        expect.verifySteps(["run crm.crm_lead_lost_action on crm.lead 1,2"]);
        await setOffline(true);
        expect(isOfflineModel(lost.props.list.model)).toBe(true);
        await lost.onClick();
        expect.verifySteps([]);
        await setOffline(false);
        await lost.onClick();
        expect.verifySteps(["run crm.crm_lead_lost_action on crm.lead 1,2"]);
    });

    test.tags("desktop");
    test("MultiRecordViewButton guard: a header button of a non-CRM list runs offline", async () => {
        const setOffline = mockOffline();
        watchOfflineRpcs();
        const buttons = captureInstances(MultiRecordViewButton);
        await mountView({
            type: "list",
            resModel: "res.partner",
            arch: /* xml */ `
                <list>
                    <header>
                        <button name="action_partner_mass_update" type="object" string="Update"/>
                    </header>
                    <field name="name"/>
                </list>`,
        });
        await contains(".o_data_row:first .o_list_record_selector input").click();
        const [update] = mountedInstances(buttons);
        expect(mountedInstances(buttons)).toHaveLength(1);
        const [selectedId] = update.props.list.selection.map(({ resId }) => resId);
        update.handleViewButton = ({ clickParams, getResParams }) => {
            const { resModel, resIds } = getResParams();
            expect.step(`run ${clickParams.name} on ${resModel} ${resIds}`);
        };

        await setOffline(true);
        // With its hook, and without it (the list's model is read instead).
        await update.onClick();
        delete update.crmOffline;
        expect(isOfflineModel(update.props.list.model)).toBe(true);
        await update.onClick();
        const run = `run action_partner_mass_update on res.partner ${selectedId}`;
        expect.verifySteps([run, run]);
    });

    test.tags("desktop");
    test("KanbanRecord team card offline: selection toggles, Alt-click and cancelled clicks are the base's, one selection read per click", async () => {
        const setOffline = mockOffline();
        watchOfflineRpcs();
        mockViewButtonActions();
        let selectionReads = 0;
        patchWithCleanup(KanbanRenderer.prototype, {
            getSelection() {
                selectionReads++;
                return super.getSelection(...arguments);
            },
            toggleSelection(record, isRange) {
                expect.step(`toggleSelection ${record.resId} isRange=${isRange}`);
                return super.toggleSelection(...arguments);
            },
        });
        const records = captureInstances(KanbanRecord);
        await mountView({ type: "kanban", resModel: "crm.team" });
        const teamCards = mountedInstances(records).filter(
            ({ props }) => props.record.resModel === "crm.team"
        );
        expect(teamCards.map(({ props }) => props.record.data.name)).toEqual([
            "Mushroom Kingdom",
            "Hyrule",
        ]);
        const [mushroom, hyrule] = teamCards;
        expect(mushroom.props.openAction.action).toBe("action_primary_channel_button");
        expect(mushroom.props.forceGlobalClick).not.toBe(true);
        /** Runs `click` and returns the number of selection reads it made. */
        const selectionReadsOf = (click) => {
            const before = selectionReads;
            click();
            return selectionReads - before;
        };
        /** An event-like card click that steps the default handling it receives. */
        const clickEvent = (target, modifiers = {}) => ({
            target,
            altKey: false,
            shiftKey: false,
            ...modifiers,
            stopPropagation: () => expect.step("stopPropagation"),
            preventDefault: () => expect.step("preventDefault"),
        });

        // Online, without a selection, a card click runs the team's open action.
        expect(selectionReadsOf(() => mushroom.rootRef().click())).toBe(1);
        await animationFrame();
        expect.verifySteps(["doActionButton:action_primary_channel_button"]);

        await setOffline(true);
        // Offline, without a selection, a click (or a direct call without event) is inert.
        expect(selectionReadsOf(() => mushroom.rootRef().click())).toBe(1);
        expect(selectionReadsOf(() => mushroom.onGlobalClick())).toBe(1);
        await animationFrame();
        expect.verifySteps([]);

        // Alt-click: the base method selects the card.
        const altClick = clickEvent(mushroom.rootRef(), { altKey: true });
        expect(selectionReadsOf(() => mushroom.onGlobalClick(altClick))).toBe(1);
        expect.verifySteps([
            "stopPropagation",
            "preventDefault",
            "toggleSelection 1 isRange=false",
        ]);
        await animationFrame();
        expect(mushroom.props.record.selected).toBe(true);
        expect(document.activeElement).toBe(mushroom.rootRef());

        // With a selection, a click toggles the clicked card as the base method would (Shift for
        // a range), with its event handling and focus, after a single read.
        const shiftClick = clickEvent(hyrule.rootRef(), { shiftKey: true });
        expect(selectionReadsOf(() => hyrule.onGlobalClick(shiftClick))).toBe(1);
        expect.verifySteps(["stopPropagation", "preventDefault", "toggleSelection 2 isRange=true"]);
        await animationFrame();
        expect(hyrule.props.record.selected).toBe(true);
        expect(document.activeElement).toBe(hyrule.rootRef());
        expect(selectionReadsOf(() => hyrule.rootRef().click())).toBe(1);
        expect.verifySteps(["toggleSelection 2 isRange=false"]);
        await animationFrame();
        expect(hyrule.props.record.selected).toBe(false);
        expect(mushroom.props.record.selected).toBe(true);

        // A click on an anchor or a dropdown of the card (CANCEL_GLOBAL_CLICK) does nothing.
        const anchor = hyrule.rootRef().querySelector("a[type]");
        expect(anchor.matches(KanbanRecord.CANCEL_GLOBAL_CLICK)).toBe(true);
        expect(selectionReadsOf(() => hyrule.onGlobalClick(clickEvent(anchor)))).toBe(1);
        expect.verifySteps([]);
        expect(hyrule.props.record.selected).toBe(false);

        // A direct call without an event toggles the card, without event handling.
        expect(selectionReadsOf(() => hyrule.onGlobalClick())).toBe(1);
        expect.verifySteps(["toggleSelection 2 isRange=undefined"]);
        await animationFrame();
        expect(hyrule.props.record.selected).toBe(true);

        // Back online, without a selection, the card runs the open action again.
        mushroom.props.record.toggleSelection(false);
        hyrule.props.record.toggleSelection(false);
        await animationFrame();
        await setOffline(false);
        expect(selectionReadsOf(() => hyrule.rootRef().click())).toBe(1);
        await animationFrame();
        expect.verifySteps(["doActionButton:action_primary_channel_button"]);
    });

    test.tags("desktop");
    test("KanbanRecord team card offline: a forced global click opens the record through the base method", async () => {
        const setOffline = mockOffline();
        watchOfflineRpcs();
        mockViewButtonActions();
        const records = captureInstances(KanbanRecord);
        await mountView({
            type: "kanban",
            resModel: "crm.team",
            forceGlobalClick: true,
            selectRecord: (resId) => expect.step(`selectRecord ${resId}`),
        });
        const [mushroom] = mountedInstances(records);
        expect(mushroom.props.record.resModel).toBe("crm.team");
        expect(mushroom.props.forceGlobalClick).toBe(true);
        expect(mushroom.props.openAction.action).toBe("action_primary_channel_button");

        await setOffline(true);
        mushroom.rootRef().click();
        await animationFrame();
        expect.verifySteps([`selectRecord ${mushroom.props.record.resId}`]);
    });

    test.tags("desktop");
    test("KanbanRecord guard: a card of another model keeps the base click offline", async () => {
        const setOffline = mockOffline();
        watchOfflineRpcs();
        mockViewButtonActions();
        const records = captureInstances(KanbanRecord);
        await mountView({
            type: "kanban",
            resModel: "res.partner",
            arch: /* xml */ `
                <kanban action="action_view_partner_card" type="object">
                    <templates>
                        <t t-name="card">
                            <field name="name"/>
                        </t>
                    </templates>
                </kanban>`,
        });
        const [card] = mountedInstances(records);
        expect(card.props.record.resModel).toBe("res.partner");
        expect(card.props.openAction.action).toBe("action_view_partner_card");

        await setOffline(true);
        card.rootRef().click();
        await animationFrame();
        expect.verifySteps(["doActionButton:action_view_partner_card"]);
    });
});
