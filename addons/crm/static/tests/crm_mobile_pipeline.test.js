/**
 * Small-screen CRM pipeline: lane 2 (Hoot) of the offline/mobile work.
 *
 * These tests prove, under the desktop and mobile presets, that:
 * - the `crm_mobile_pipeline` view is the CRM kanban view with its renderer and controller swapped,
 *   and that on desktop it renders exactly the standard kanban DOM with the same RPCs;
 * - on small screens, while grouped by stage, the pipeline shows one stage at a time behind a
 *   fixed header (stage name, lead count, revenue sum) with button and swipe navigation (a focused
 *   navigation button that disappears hands the focus to the other one, else to the first control
 *   of the pipeline, and to none once the standard renderer replaces the pipeline), keeps the
 *   displayed stage and its scroll across breadcrumbs, opens New in the displayed stage, and falls
 *   back to the standard renderer for any other grouping;
 * - an uncached stage or lead shows the framework offline helper; a lead's helper has a Back that
 *   takes the focus once the stage pipeline renders it and hands it back when left; online, Load
 *   more is busy while it loads, and a failed load (a server rejection is raised) leaves it idle;
 * - a displayed stage left without a lead while other stages hold some (a search whose matches
 *   are all elsewhere) stays displayed and shows a hint with their pending-aware count and a
 *   button displaying the first of them, online and offline, reading nothing; never with sample
 *   data, nor on a pipeline without any lead;
 * - pending stage placement and pending-aware totals are derived from framework state only, survive
 *   remounts and reloads, and end once the write is replayed (or discarded) and reloaded; a
 *   reconnection with nothing queued reloads the pipeline once, at once, before the sync window;
 * - activity reads are bounded pages that carry the lead's total, so the card shows the total and
 *   says what the page misses ("Show all" online, a muted count offline);
 * - the lead card (44x44 touch targets, pending-sync badge, stage list, activities), the six-field
 *   bottom-sheet quick create and the activity controls queue their writes offline through the
 *   shared framework queue, and are disabled when their data is missing; the card's stage list
 *   makes the same queued move by keyboard (Enter on a focused option) as by tap; a lead created
 *   online is added to its stage, or the pipeline reloaded when that stage is gone, only while
 *   the stage pipeline is displayed;
 * - a lead opened online from its card keeps a read-only CRM chatter offline on every mutation
 *   path (composer, followers and subtypes, activities and their popovers, mail templates,
 *   scheduled messages, reactions, message actions), the overlays opened online close on
 *   disconnection, and its notes editor stays usable while the form save is queued.
 *
 * Conventions:
 * - The CRM mock models are local to this file: `crm.stage`, `crm.team`, and a `crm.lead` that
 *   extends the CRM helper's with the fields, records and views these tests need. The shared
 *   fixture of `defineCrmModels()` (the shared mail mocks plus the helper's `crm.lead`) is reused;
 *   no existing test helper is modified.
 * - Offline state is driven only through the offline plugin (`mockOffline()` and
 *   `getService(OfflinePlugin)`); "the connection drops during the call" is a 502 answer.
 * - Hoot fails a test on any undeclared error, which is how "no error" is asserted. Two kinds of
 *   error are declared: those the framework itself produces offline (a read served from the
 *   framework RPC cache while offline still tries the server in the background, and that refresh
 *   rejects with a `ConnectionLostError` nobody awaits; see `cachedReadErrors`), and failures a
 *   test simulates on purpose to check how they are handled: a server rejection (such as a quick
 *   create the server rejects) or a failing callback (a created lead that cannot be added to its
 *   stage). A replayed call the server rejects is parked in the systray, not raised.
 */

import {
    advanceTime,
    after,
    animationFrame,
    beforeEach,
    describe,
    expect,
    getFixture,
    mockDate,
    mockTimeZone,
    queryAll,
    queryAllTexts,
    queryFirst,
    queryOne,
    runAllTimers,
    test,
    waitUntil,
} from "@odoo/hoot";
import { press, resize } from "@odoo/hoot-dom";
import {
    contains as mailContains,
    insertText,
    start,
    startServer,
} from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineActions,
    defineModels,
    destroyApp,
    editSearch,
    fields,
    getService,
    isSmall,
    makeMockServer,
    makeServerError,
    mockOffline,
    models,
    MockServer,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    removeFacet,
    serverState,
    swipeLeft,
    swipeRight,
    toggleMenuItem,
    toggleSearchBarMenu,
    validateSearch,
} from "@web/../tests/web_test_helpers";
import { status } from "@odoo/owl";

import { crmModels, defineCrmModels } from "@crm/../tests/crm_test_helpers";
import { CrmMobileLeadCard } from "@crm/mobile/crm_mobile_lead_card/crm_mobile_lead_card";
import {
    CrmMobilePipeline,
    CrmMobilePipelineController,
    isCrmMobilePipeline,
    orderedStageGroups,
    resolveDisplayedGroup,
} from "@crm/mobile/crm_mobile_pipeline/crm_mobile_pipeline";
import { CrmMobileQuickCreate } from "@crm/mobile/crm_mobile_quick_create/crm_mobile_quick_create";
import { CrmKanbanDynamicGroupList } from "@crm/views/crm_kanban/crm_kanban_model";
import { crmKanbanView } from "@crm/views/crm_kanban/crm_kanban_view";
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
import { deserializeDate, formatDate, serializeDate, today } from "@web/core/l10n/dates";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { UIPlugin } from "@web/core/ui/ui_plugin";
import { getTabableElements } from "@web/core/utils/ui";
import { formatInteger, formatMonetary } from "@web/views/fields/formatters";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { WebClient } from "@web/webclient/webclient";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const R_CALL_KW = /\/web\/dataset\/call_(?:kw|button)\/(?<model>[\w.]+)\/(?<method>\w+)/;

/** Currency of every lead (the mock company currency, USD). */
const CURRENCY_ID = 1;

/**
 * Steps every request whose `model/method` (ORM calls) or path (other routes) is watched, as
 * `"<model>/<method>"` or the path. The watcher returns nothing, so the request goes on to the
 * next handler. Registered after `mockOffline()`, it runs first and therefore also steps the
 * requests the offline mock answers with a 502.
 *
 * @param {Array<string | RegExp>} watched `"model/method"`, a path, or a regex on either
 */
function watchRpcs(watched) {
    const matches = (label) =>
        watched.some((w) => (w instanceof RegExp ? w.test(label) : w === label));
    onRpc("/*", (request) => {
        const path = new URL(request.url).pathname;
        const match = path.match(R_CALL_KW);
        const label = match ? `${match.groups.model}/${match.groups.method}` : path;
        if (matches(label)) {
            expect.step(label);
        }
    });
}

/**
 * Collects, in order, the `model/method` of every ORM request (and the path of every other
 * request but the plugin's reconnection pings) into the returned array.
 *
 * @returns {string[]}
 */
function collectRpcs() {
    const calls = [];
    onRpc("/*", (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/web/webclient/version_info") {
            return;
        }
        const match = path.match(R_CALL_KW);
        calls.push(match ? `${match.groups.model}/${match.groups.method}` : path);
    });
    return calls;
}

/**
 * Steps, as `"activities:<lead id>"`, every per-lead `mail.activity` read, and records the exact
 * request parameters of each lead into the returned map (lead id → JSON of every request).
 *
 * @returns {Map<number, string[]>}
 */
function watchActivityReads() {
    const requests = new Map();
    onRpc("/web/dataset/call_kw/mail.activity/web_search_read", async (request) => {
        const { params } = await request.clone().json();
        const resId = params.kwargs.domain.find(([field]) => field === "res_id")?.[2];
        expect.step(`activities:${resId}`);
        if (!requests.has(resId)) {
            requests.set(resId, []);
        }
        requests.get(resId).push(JSON.stringify(params));
    });
    return requests;
}

/** Steps `"types"` for every `mail.activity.type` read. */
function watchTypeReads() {
    onRpc("/web/dataset/call_kw/mail.activity.type/web_search_read", () => {
        expect.step("types");
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

/**
 * The framework offline queue entries, as stored, in replay order: stable-sorted by
 * `extras.timeStamp`, as `OfflinePlugin._syncORM` replays them. The queue's own enumeration order
 * is not the order of creation, because a key that happens to be an array index (an all-digit
 * hash) is listed before every other key; positional assertions therefore read this order.
 *
 * @returns {Object[]}
 */
function queued() {
    return Object.values(getService(OfflinePlugin)._ormToSync()).sort(
        (entryA, entryB) =>
            (entryA.value.extras?.timeStamp ?? 0) - (entryB.value.extras?.timeStamp ?? 0)
    );
}

/**
 * @param {string} model
 * @param {string} method
 * @returns {Object[]} the queued values of `model.method`
 */
function queuedCalls(model, method) {
    return queued()
        .map(({ value }) => value)
        .filter((value) => value.model === model && value.method === method);
}

/**
 * Keys every call the framework offline queue schedules without a given key with an array index
 * smaller than the previous one, as a hash that happens to be all digits is. The queue then
 * enumerates those calls newest first, the reverse of the order they were made (and replay) in.
 *
 * @returns {string[]} the keys handed out, in the order of the calls
 */
function keyQueuedCallsNewestFirst() {
    const keys = [];
    patchWithCleanup(OfflinePlugin.prototype, {
        scheduleORM(model, method, args, kwargs, options) {
            if (options.id !== undefined && options.id !== null) {
                return super.scheduleORM(...arguments);
            }
            const id = String(99999999 - keys.length);
            keys.push(id);
            return super.scheduleORM(model, method, args, kwargs, { ...options, id });
        },
    });
    return keys;
}

/**
 * The background refresh of a read served from the framework RPC cache while offline rejects with
 * a `ConnectionLostError` nobody awaits: Hoot reports it as an error of the test. This returns the
 * matcher of each such error, in order, for `expect.errors` and `expect.verifyErrors`.
 *
 * @param {string[]} routes `"<model>/<method>"` of each cached read refreshed offline
 * @returns {string[]}
 */
function cachedReadErrors(routes) {
    return routes.map((route) => `Connection to "/web/dataset/call_kw/${route}"`);
}

const LEAD_GROUPS = "crm.lead/web_read_group";
const ACTIVITIES = "mail.activity/web_search_read";
const TYPES = "mail.activity.type/web_search_read";

/** Resolves once the offline plugin has read which items are available offline. */
async function visitedReady() {
    await getService(OfflinePlugin).getVisitedStatus();
    await animationFrame();
}

/**
 * Lets the offline queue replay `count` calls (the framework waits one second between two).
 *
 * @param {number} count
 */
async function letQueueReplay(count) {
    for (let index = 0; index < count; index++) {
        await animationFrame();
        await advanceTime(1000);
    }
    await animationFrame();
}

/**
 * A revenue sum formatted exactly as the desktop kanban column header formats it
 * (`AnimatedNumber.format` with the group currency).
 *
 * @param {number} value
 * @returns {string}
 */
function formatRevenue(value) {
    const formatted = formatMonetary(value, {
        currencyId: CURRENCY_ID,
        humanReadable: true,
        digits: [null, 0],
        minDigits: 3,
    });
    // `toHaveText` compares whitespace-normalized texts (the formatter uses no-break spaces).
    return formatted.replace(/\s+/g, " ");
}

/**
 * Asserts the fixed header of the mobile pipeline.
 *
 * @param {string} stageName
 * @param {number} count
 * @param {number} revenue
 */
function expectHeader(stageName, count, revenue) {
    expect(".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_stage_name").toHaveText(stageName);
    expect(".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_count").toHaveText(String(count));
    expect(".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_revenue").toHaveText(
        formatRevenue(revenue)
    );
}

/** @returns {string[]} the names on the cards of the displayed stage, in display order */
function cardNames() {
    return queryAllTexts(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card_name");
}

/**
 * @param {string} name
 * @returns {string} selector of the mobile card showing that lead name
 */
function cardOf(name) {
    return `.o_crm_mobile_pipeline_body .o_crm_mobile_lead_card:has(.o_crm_mobile_lead_card_name:text(${name}))`;
}

/**
 * Moves a lead to a stage through its mobile card stage list.
 *
 * @param {string} name the lead name
 * @param {number} stageId
 */
async function chooseStage(name, stageId) {
    await contains(`${cardOf(name)} .o_crm_mobile_card_stage`).click();
    await contains(
        `${cardOf(name)} .o_crm_mobile_stage_option[data-stage-value='${stageId}']`
    ).click();
    await animationFrame();
}

/**
 * Displays the stage of the given name through the header navigation.
 *
 * @param {string} stageName
 */
async function goToStage(stageName) {
    const names = ["New", "Qualified", "Proposition", "Won"];
    const target = names.indexOf(stageName);
    for (let guard = 0; guard < names.length; guard++) {
        const current = names.indexOf(
            queryOne(".o_crm_mobile_pipeline_stage_name").textContent.trim()
        );
        if (current === target) {
            return;
        }
        await contains(
            current < target ? ".o_crm_mobile_pipeline_next" : ".o_crm_mobile_pipeline_prev"
        ).click();
        await animationFrame();
    }
}

/**
 * @param {CrmMobilePipeline} renderer
 * @param {number} stageId
 * @returns {Object} the stage group of the renderer's list
 */
function groupOf(renderer, stageId) {
    return renderer.props.list.groups.find((group) => group.serverValue === stageId);
}

/**
 * @param {CrmMobilePipeline} renderer
 * @param {number} resId
 * @returns {Object} the loaded record of a lead, whichever group holds it (folded ones included)
 */
function recordOf(renderer, resId) {
    return renderer.allLoadedRecords().find((record) => record.resId === resId);
}

/**
 * Fills the open mobile quick create. The stage is given by name: its `<select>` options carry
 * group datapoint ids.
 *
 * @param {Object} values input values by control name; `stage_id` is a stage name
 */
async function fillQuickCreate(values) {
    for (const [name, value] of Object.entries(values)) {
        if (name === "stage_id") {
            const option = queryAll(".o_crm_mobile_quick_create select[name=stage_id] option").find(
                (el) => el.textContent.trim() === value
            );
            await contains(".o_crm_mobile_quick_create select[name=stage_id]").select(option.value);
        } else {
            await contains(`.o_crm_mobile_quick_create [name=${name}]`).edit(value, {
                confirm: false,
            });
        }
    }
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

    _records = [
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Qualified", sequence: 2 },
        { id: 3, name: "Proposition", sequence: 3 },
        { id: 4, name: "Won", sequence: 4, is_won: true },
    ];
}

class CrmTeam extends models.Model {
    _name = "crm.team";

    name = fields.Char({ string: "Sales Team" });

    _records = [{ id: 1, name: "Direct Sales" }];
}

/** Pipeline arch mirroring `crm_case_kanban_view_leads` (grouped by stage, sum field). */
const PIPELINE_ARCH = /* xml */ `
    <kanban js_class="crm_mobile_pipeline" default_group_by="stage_id" on_create="quick_create"
        quick_create_view="quick_create_form" archivable="false">
        <field name="stage_id"/>
        <field name="company_currency"/>
        <field name="contact_name"/>
        <progressbar field="activity_state"
            colors='{"planned": "success", "today": "warning", "overdue": "danger"}'
            sum_field="expected_revenue"/>
        <templates>
            <t t-name="card">
                <field class="fw-bold fs-5" name="name"/>
                <field name="expected_revenue" widget="monetary"
                    options="{'currency_field': 'company_currency'}"/>
                <field name="partner_id"/>
                <field name="user_id"/>
            </t>
        </templates>
    </kanban>`;

/** Same pipeline arch without default grouping: the group-by comes from the search only. */
const UNGROUPABLE_PIPELINE_ARCH = PIPELINE_ARCH.replace(' default_group_by="stage_id"', "");

const LEAD_SEARCH_ARCH = /* xml */ `
    <search>
        <field name="name"/>
        <filter name="lead_one" string="Lead One" domain="[('name', '=', 'Lead 1')]"/>
        <filter name="with_revenue" string="With Revenue" domain="[('expected_revenue', '>', 0)]"/>
        <filter name="groupby_stage" string="Stage" context="{'group_by': 'stage_id'}"/>
        <filter name="groupby_user" string="Salesperson" context="{'group_by': 'user_id'}"/>
    </search>`;

/**
 * Lead form with its notes editor and chatter, as `crm_lead_view_form` renders them. Only the
 * chatter pipeline action opens it, so every other test keeps its chatter-less lead form.
 */
const LEAD_CHATTER_FORM_ARCH = /* xml */ `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="partner_id"/>
            <field name="description" widget="html"/>
        </sheet>
        <chatter reload_on_post="True"/>
    </form>`;

class CrmLead extends crmModels.CrmLead {
    // The mock framework memoizes a model's definition per test in a static getter that a
    // subclass would inherit: this class needs its own, or it would resolve to the very
    // definition of the helper's `crm.lead` that it extends and overrides.
    static definitionGetter = null;

    _name = "crm.lead";
    // A lead is a mail thread (through `mail.thread.cc` on the server, which is not mocked): its
    // messages can take reactions.
    _inherit = ["mail.thread"];

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
    phone = fields.Char({ string: "Phone" });
    email_from = fields.Char({ string: "Email" });
    company_currency = fields.Many2one({
        string: "Currency",
        relation: "res.currency",
        default: CURRENCY_ID,
    });
    expected_revenue = fields.Monetary({
        string: "Expected Revenue",
        currency_field: "company_currency",
        aggregator: "sum",
    });
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
    activity_state = fields.Selection({
        selection: [
            ["overdue", "Overdue"],
            ["today", "Today"],
            ["planned", "Planned"],
        ],
    });
    activity_ids = fields.One2many({ string: "Activities", relation: "mail.activity" });
    // Thread fields of the lead chatter (`mail.thread`), and the notes.
    description = fields.Html({ string: "Notes" });
    message_ids = fields.One2many({ relation: "mail.message" });
    message_follower_ids = fields.Many2many({ string: "Followers", relation: "mail.followers" });

    _records = [
        {
            id: 1,
            name: "Lead 1",
            stage_id: 1,
            team_id: 1,
            user_id: serverState.userId,
            partner_id: serverState.partnerId,
            expected_revenue: 100,
        },
        {
            id: 2,
            name: "Lead 2",
            stage_id: 1,
            team_id: 1,
            user_id: serverState.userId,
            contact_name: "Rachel Green",
            expected_revenue: 20,
        },
        {
            id: 3,
            name: "Lead 3",
            stage_id: 2,
            team_id: 1,
            user_id: serverState.userId,
            expected_revenue: 30,
        },
        { id: 4, name: "Lead 4", stage_id: 3, team_id: 1, expected_revenue: 40 },
        {
            id: 5,
            name: "Lead 5",
            stage_id: 4,
            team_id: 1,
            expected_revenue: 50,
            won_status: "won",
        },
    ];

    _views = {
        "kanban,false": PIPELINE_ARCH,
        "kanban,ungroupable": UNGROUPABLE_PIPELINE_ARCH,
        "form,quick_create_form": /* xml */ `
            <form>
                <group>
                    <field name="name"/>
                    <field name="expected_revenue"/>
                </group>
            </form>`,
        "form,false": /* xml */ `
            <form>
                <sheet>
                    <field name="name"/>
                    <field name="stage_id"/>
                    <field name="expected_revenue"/>
                    <field name="company_currency" invisible="1"/>
                </sheet>
            </form>`,
        "form,chatter": LEAD_CHATTER_FORM_ARCH,
        "list,false": /* xml */ `<list><field name="name"/><field name="stage_id"/></list>`,
        "search,false": LEAD_SEARCH_ARCH,
    };

    /** Leads are activity-enabled threads (`mail.activity.mixin`): their chatter lists them. */
    has_activities = true;

    /** Mark-won returns no message here: only the lookup itself is asserted. */
    get_rainbowman_message() {
        return false;
    }
}

defineCrmModels();
defineModels([CrmStage, CrmTeam, CrmLead]);

const PIPELINE_ACTION_ID = 1;
const UNGROUPABLE_PIPELINE_ACTION_ID = 2;
const CHATTER_PIPELINE_ACTION_ID = 3;

defineActions([
    {
        id: PIPELINE_ACTION_ID,
        xml_id: "crm.crm_lead_action_pipeline",
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: { default_type: "opportunity" },
        views: [
            [false, "kanban"],
            [false, "list"],
            [false, "form"],
        ],
    },
    {
        id: UNGROUPABLE_PIPELINE_ACTION_ID,
        name: "Pipeline without default grouping",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: { default_type: "opportunity", search_default_groupby_stage: 1 },
        views: [
            ["ungroupable", "kanban"],
            [false, "form"],
        ],
    },
    {
        id: CHATTER_PIPELINE_ACTION_ID,
        name: "Pipeline with the lead chatter",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: { default_type: "opportunity" },
        views: [
            [false, "kanban"],
            ["chatter", "form"],
        ],
    },
]);

/** Cached activity types: one of each category the pipeline must handle. */
const ACTIVITY_TYPES = [
    { id: 1, display_name: "Email", category: "default" },
    { id: 2, display_name: "Call", category: "phonecall" },
    { id: 28, display_name: "Upload Document", category: "upload_file" },
    { id: 31, display_name: "Meeting", category: "meeting" },
];

/**
 * Answers the activity-type read of the pipeline with the given records (offline, the offline
 * mock answers first, with a 502). The returned state is mutable: `state.records` is what the
 * server answers from then on.
 *
 * @param {Object[]} records
 * @returns {{ records: Object[] }}
 */
function mockActivityTypes(records) {
    const state = { records };
    onRpc("mail.activity.type", "web_search_read", () => ({
        length: state.records.length,
        records: state.records.map((record) => ({ ...record })),
    }));
    return state;
}

/**
 * Creates `mail.activity` records on leads, on the mock server.
 *
 * @param {Object[]} valuesList
 * @returns {Promise<number[]>} the activity ids
 */
async function createActivities(valuesList) {
    if (!MockServer.current) {
        await makeMockServer();
    }
    return valuesList.map((values) =>
        MockServer.env["mail.activity"].create({
            res_model: "crm.lead",
            user_id: serverState.userId,
            date_deadline: "2030-01-10",
            ...values,
        })
    );
}

/**
 * Mounts the pipeline as the pipeline action would (cached, available offline once visited).
 *
 * @param {Object} [params] extra `mountView` params
 */
function mountPipeline(params = {}) {
    return mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: PIPELINE_ARCH,
        searchViewArch: LEAD_SEARCH_ARCH,
        ...params,
        config: { actionId: PIPELINE_ACTION_ID, cache: true, ...params.config },
    });
}

beforeEach(() => {
    patchWithCleanup(AnimatedNumber, { enableAnimations: false });
});

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------

describe("Wiring", () => {
    test("registry entry crm_mobile_pipeline reuses CRM kanban model, arch parser and search model", async () => {
        const view = registry.category("views").get("crm_mobile_pipeline");
        expect(view.Model).toBe(crmKanbanView.Model);
        expect(view.ArchParser).toBe(crmKanbanView.ArchParser);
        expect(view.SearchModel).toBe(crmKanbanView.SearchModel);
        expect(view.ControlPanel).toBe(crmKanbanView.ControlPanel);
        expect(view.buttonTemplate).toBe(crmKanbanView.buttonTemplate);
        expect(view.Controller).toBe(CrmMobilePipelineController);
        expect(CrmMobilePipelineController.prototype instanceof crmKanbanView.Controller).toBe(
            true
        );
        expect(view.Renderer).toBe(CrmMobilePipeline);
        expect(CrmMobilePipeline.prototype instanceof crmKanbanView.Renderer).toBe(true);
        expect(CrmMobilePipeline.components.CrmMobileLeadCard).toBe(CrmMobileLeadCard);

        // The gate: a small screen and a non-empty grouping by stage, nothing else.
        const stageGroup = { value: 1, serverValue: 1, isFolded: false };
        const stageList = {
            isGrouped: true,
            groupByField: { name: "stage_id" },
            groups: [stageGroup],
        };
        expect(isCrmMobilePipeline(stageList, true)).toBe(true);
        expect(isCrmMobilePipeline(stageList, false)).toBe(false);
        expect(isCrmMobilePipeline({ ...stageList, groups: [] }, true)).toBe(false);
        expect(isCrmMobilePipeline({ ...stageList, isGrouped: false }, true)).toBe(false);
        expect(isCrmMobilePipeline({ ...stageList, groupByField: { name: "user_id" } }, true)).toBe(
            false
        );
        expect(isCrmMobilePipeline(null, true)).toBe(false);
        // Display order: the group without a stage first, then the server order.
        const noStage = { value: false, serverValue: false, isFolded: false };
        const folded = { value: 2, serverValue: 2, isFolded: true };
        const list = { groups: [folded, stageGroup, noStage] };
        expect(orderedStageGroups(list)).toEqual([noStage, folded, stageGroup]);
        expect(orderedStageGroups(undefined)).toEqual([]);
        // The displayed stage: the requested one, else the first unfolded group, else the first.
        expect(resolveDisplayedGroup(list, 2)).toBe(folded);
        expect(resolveDisplayedGroup(list, 99)).toBe(stageGroup);
        expect(resolveDisplayedGroup(list, null)).toBe(stageGroup);
        expect(resolveDisplayedGroup({ groups: [folded] }, undefined)).toBe(folded);
        expect(resolveDisplayedGroup(undefined, 1)).toBe(undefined);

        // An arch carrying the js_class mounts the mobile renderer and controller adapter.
        const renderers = captureInstances(CrmMobilePipeline);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline();
        expect(renderers).toHaveLength(1);
        expect(controllers).toHaveLength(1);
        expect(controllers[0].isMobilePipeline).toBe(isSmall());
        expect(renderers[0].isMobilePipeline).toBe(isSmall());
        expect(".o_kanban_renderer").toHaveCount(1);
        expect(".o_crm_mobile_pipeline").toHaveCount(isSmall() ? 1 : 0);
    });

    test("controller root: the CRM kanban class replaces the js_class one in place and once; another view name keeps its classes", async () => {
        registry.category("views").add("crm_mobile_pipeline_alias", {
            ...registry.category("views").get("crm_mobile_pipeline"),
        });
        const controllers = captureInstances(CrmMobilePipelineController);
        /**
         * Mounts the pipeline arch with the given js_class and an arch class list that already
         * holds the CRM kanban class, as a view of its own (the views are cached), and returns the
         * classes of that mount's controller root.
         *
         * @param {string} jsClass
         * @param {number} viewId
         * @returns {Promise<string[]>}
         */
        const mountRootClasses = async (jsClass, viewId) => {
            await mountPipeline({
                arch: PIPELINE_ARCH.replace(
                    'js_class="crm_mobile_pipeline"',
                    `js_class="${jsClass}" class="o_kanban_small_column o_crm_kanban_view"`
                ),
                viewId,
            });
            return queryAll(".o_kanban_view").at(-1).className.split(" ");
        };
        // The base classes after the arch's, the same at both screen sizes but for the small-screen
        // scroll delegation of a grouped kanban.
        const baseClasses = [
            "o_view_controller",
            "o_action",
            ...(isSmall() ? ["o_action_delegate_scroll"] : []),
            "o_kanban_selection_available",
        ];

        const reference = await mountRootClasses("crm_kanban", 111);
        expect(reference).toEqual([
            "o_kanban_view",
            "o_crm_kanban_view",
            "o_kanban_small_column",
            ...baseClasses,
        ]);
        expect(controllers).toHaveLength(0);
        // The CRM kanban class takes the js_class position, and the arch's copy is not repeated.
        expect(await mountRootClasses("crm_mobile_pipeline", 112)).toEqual(reference);
        expect(controllers).toHaveLength(1);
        // Another view name with this controller: nothing to replace, every class is kept.
        expect(await mountRootClasses("crm_mobile_pipeline_alias", 113)).toEqual([
            "o_kanban_view",
            "o_crm_mobile_pipeline_alias_view",
            "o_kanban_small_column",
            "o_crm_kanban_view",
            ...baseClasses,
        ]);
        expect(controllers).toHaveLength(2);
        expect(".o_crm_mobile_pipeline_view").toHaveCount(0);
        expect(".o_crm_mobile_pipeline").toHaveCount(isSmall() ? 2 : 0);
    });
});

// -----------------------------------------------------------------------------
// Desktop non-regression
// -----------------------------------------------------------------------------

describe("Desktop", () => {
    test.tags("desktop");
    test("desktop: crm_mobile_pipeline renders the standard kanban DOM", async () => {
        const calls = collectRpcs();
        // ORM calls of the view itself: the app start-up and the (cached) view loading excluded.
        const viewCalls = () =>
            calls
                .splice(0)
                .filter((call) => /^(crm|mail)\./.test(call) && !call.endsWith("/get_views"));
        const renderers = captureInstances(CrmMobilePipeline);
        const normalize = (el) => el.outerHTML.replace(/datapoint_\d+/g, "datapoint");

        // Reference: the CRM kanban view on the same arch, New included.
        await mountView({
            type: "kanban",
            resModel: "crm.lead",
            arch: PIPELINE_ARCH.replace("crm_mobile_pipeline", "crm_kanban"),
            searchViewArch: LEAD_SEARCH_ARCH,
            viewId: 101,
            config: { actionId: PIPELINE_ACTION_ID, cache: true },
        });
        const [referenceView] = queryAll(".o_action_manager");
        const referenceCalls = viewCalls();
        const referenceRootClass = queryOne(".o_kanban_view", { root: referenceView }).className;
        const referenceHtml = normalize(queryOne(".o_kanban_renderer", { root: referenceView }));
        await contains(queryOne(".o-kanban-button-new", { root: referenceView })).click();
        await animationFrame();
        const referenceQuickCreate = normalize(
            queryOne(".o_kanban_renderer", { root: referenceView })
        );
        const referenceQuickCreateCalls = viewCalls();

        await mountView({
            type: "kanban",
            resModel: "crm.lead",
            arch: PIPELINE_ARCH,
            searchViewArch: LEAD_SEARCH_ARCH,
            viewId: 102,
            config: { actionId: PIPELINE_ACTION_ID, cache: true },
        });
        await animationFrame();
        const [, pipelineView] = queryAll(".o_action_manager");
        const pipelineRenderer = queryOne(".o_kanban_renderer", { root: pipelineView });
        expect(renderers).toHaveLength(1);
        const pipelineCalls = viewCalls();

        // Same DOM, same requests, and none for activities or activity types. The controller root
        // keeps the CRM kanban classes, in the same order, not the one derived from the js_class.
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        const pipelineRoot = queryOne(".o_kanban_view", { root: pipelineView });
        expect(pipelineRoot.className).toBe(referenceRootClass);
        expect(pipelineRoot).toHaveClass("o_crm_kanban_view");
        expect(pipelineRoot).not.toHaveClass("o_crm_mobile_pipeline_view");
        expect(normalize(pipelineRenderer)).toBe(referenceHtml);
        expect(pipelineCalls).toEqual(referenceCalls);
        expect(pipelineCalls).toEqual(["crm.lead/read_progress_bar", "crm.lead/web_read_group"]);
        expect(queryAll(".o_kanban_group", { root: pipelineRenderer })).toHaveLength(4);
        expect(
            queryAllTexts(".o_kanban_group .o_column_title", { root: pipelineRenderer })
        ).toEqual(["New", "Qualified", "Proposition", "Won"]);
        // The desktop header formats the revenue sum as the mobile header does.
        expect(
            queryFirst(".o_kanban_group .o_animated_number", { root: pipelineRenderer })
        ).toHaveText(formatRevenue(120));

        // New: the framework quick create in the first unfolded group, as before.
        await contains(queryOne(".o-kanban-button-new", { root: pipelineView })).click();
        await animationFrame();
        const firstGroup = queryFirst(".o_kanban_group", { root: pipelineRenderer });
        expect(queryAll(".o_kanban_quick_create", { root: firstGroup })).toHaveLength(1);
        expect(queryAll(".o_kanban_quick_create", { root: pipelineRenderer })).toHaveLength(1);
        expect(normalize(pipelineRenderer)).toBe(referenceQuickCreate);
        expect(viewCalls()).toEqual(referenceQuickCreateCalls);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);

        // The renderer's gate is closed by the small-screen signal alone.
        const [renderer] = renderers;
        expect(isCrmMobilePipeline(renderer.props.list, false)).toBe(false);
        expect(isCrmMobilePipeline(renderer.props.list, true)).toBe(true);
        expect(renderer.isMobilePipeline).toBe(false);
        await runAllTimers();
        expect(calls.some((call) => call.startsWith("mail.activity"))).toBe(false);
    });
});

// -----------------------------------------------------------------------------
// Mobile pipeline
// -----------------------------------------------------------------------------

describe("Mobile pipeline", () => {
    test.tags("mobile");
    test("mobile: one stage at a time with fixed header (name, count, revenue) and adjacent navigation", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();

        expect(".o_kanban_renderer.o_kanban_grouped.o_crm_mobile_pipeline").toHaveCount(1);
        // The controller root keeps the CRM kanban class, not the one derived from the js_class,
        // next to the base small-screen classes.
        expect(".o_kanban_view").toHaveClass(["o_crm_kanban_view", "o_action_delegate_scroll"]);
        expect(".o_kanban_view").not.toHaveClass("o_crm_mobile_pipeline_view");
        expect(".o_crm_mobile_pipeline_body").toHaveCount(1);
        expect(".o_kanban_group").toHaveCount(1);
        expect(getComputedStyle(queryOne(".o_crm_mobile_pipeline_header")).position).toBe("sticky");
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(".o_crm_mobile_pipeline_prev").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_next").toHaveCount(1);

        await contains(".o_crm_mobile_pipeline_next").click();
        expectHeader("Qualified", 1, 30);
        expect(cardNames()).toEqual(["Lead 3"]);
        expect(".o_crm_mobile_pipeline_prev").toHaveCount(1);
        await contains(".o_crm_mobile_pipeline_next").click();
        expectHeader("Proposition", 1, 40);
        await contains(".o_crm_mobile_pipeline_next").click();
        expectHeader("Won", 1, 50);
        expect(cardNames()).toEqual(["Lead 5"]);
        expect(".o_crm_mobile_pipeline_next").toHaveCount(0);
        await contains(".o_crm_mobile_pipeline_prev").click();
        expectHeader("Proposition", 1, 40);

        // A swipe on the stage body: to the right shows the previous stage, to the left the next.
        await swipeRight(".o_crm_mobile_pipeline_body");
        expectHeader("Qualified", 1, 30);
        await swipeRight(".o_crm_mobile_pipeline_body");
        expectHeader("New", 2, 120);
        // Nothing before the first stage.
        await swipeRight(".o_crm_mobile_pipeline_body");
        expectHeader("New", 2, 120);
        await swipeLeft(".o_crm_mobile_pipeline_body");
        expectHeader("Qualified", 1, 30);
        // A short horizontal gesture (under the swipe threshold) is not a navigation.
        await swipeLeft(".o_crm_mobile_pipeline_body", {}, { position: { x: -20 } });
        expectHeader("Qualified", 1, 30);
        expect(".o_kanban_group").toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: a focused previous or next button that disappears hands the focus to the other one; a focus held elsewhere is never moved", async () => {
        await makeMockServer();
        // Won is folded: entering it online loads it after the patch that removes Next.
        MockServer.env["crm.stage"].write([4], { fold: true });
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();
        expectHeader("New", 2, 120);

        /** Presses Enter on the focused control and waits for the patch. */
        const pressEnter = async () => {
            await press("Enter");
            await animationFrame();
        };
        /**
         * Swipes on the stage body as a finger does, with touch events only, so the focus stays
         * where it is: to the left shows the next stage, to the right the previous one.
         *
         * @param {"left" | "right"} direction
         * @param {number} times
         */
        const swipe = async (direction, times) => {
            const [fromX, toX] = direction === "left" ? [300, 100] : [100, 300];
            for (let index = 0; index < times; index++) {
                await touchStageBody("touchstart", [[fromX, 200]]);
                await touchStageBody("touchend", [], [[toX, 200]]);
            }
        };

        // Keyboard navigation: Next keeps the focus while there is a next stage.
        queryOne(".o_crm_mobile_pipeline_next").focus();
        await pressEnter();
        expectHeader("Qualified", 1, 30);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();
        await pressEnter();
        expectHeader("Proposition", 1, 40);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();

        // Next to the last stage removes Next: Previous takes the focus, never the document body,
        // and keeps it once the folded stage has loaded.
        await pressEnter();
        expectHeader("Won", 1, 50);
        expect(".o_crm_mobile_pipeline_folded").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_next").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_prev").toBeFocused();

        // Previous to the first stage removes Previous: Next takes the focus.
        await pressEnter();
        expectHeader("Proposition", 1, 40);
        expect(".o_crm_mobile_pipeline_prev").toBeFocused();
        await pressEnter();
        await pressEnter();
        expectHeader("New", 2, 120);
        expect(".o_crm_mobile_pipeline_prev").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();

        // A swipe leaves a focus held elsewhere where it is: on Add, in the header...
        queryOne(".o_crm_mobile_pipeline_add").focus();
        await swipe("left", 3);
        expectHeader("Won", 1, 50);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();
        await swipe("right", 3);
        expectHeader("New", 2, 120);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();
        // ...and on the controller's New button, outside the stage pipeline.
        queryOne(".o-kanban-button-new").focus();
        await swipe("left", 3);
        expectHeader("Won", 1, 50);
        expect(".o-kanban-button-new").toBeFocused();

        // A swipe that removes the focused navigation button hands its focus over as well.
        queryOne(".o_crm_mobile_pipeline_prev").focus();
        await swipe("right", 2);
        expectHeader("Qualified", 1, 30);
        expect(".o_crm_mobile_pipeline_prev").toBeFocused();
        await swipe("right", 1);
        expectHeader("New", 2, 120);
        expect(".o_crm_mobile_pipeline_prev").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();
    });

    test.tags("mobile");
    test("mobile: regrouping by salesperson renders the standard kanban renderer; regrouping by stage restores the pipeline", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`web_save ${JSON.stringify(Object.keys(args[1]).sort())}`);
        });
        const renderers = captureInstances(CrmMobilePipeline);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline();
        expect(".o_crm_mobile_pipeline").toHaveCount(1);

        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        const [renderer] = renderers;
        const [controller] = controllers;
        expect(renderer.props.list.groupByField.name).toBe("user_id");
        expect(renderer.isMobilePipeline).toBe(false);
        expect(controller.isMobilePipeline).toBe(false);
        // The standard grouped kanban, with the framework cards and no mobile control.
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer.o_kanban_grouped").toHaveCount(1);
        expect(".o_kanban_group").toHaveCount(2);
        const loadedRecords = renderer.props.list.groups.flatMap((group) => group.list.records);
        expect(loadedRecords.length).toBeGreaterThan(0);
        expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(loadedRecords.length);
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_header").toHaveCount(0);
        // The mobile quick create is not offered on a salesperson group.
        renderer.onAddClick();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);

        // New: the base controller opens the framework quick create in its first group, a
        // salesperson group, and the record is created there without any stage write.
        await contains(".o-kanban-button-new").click();
        await animationFrame();
        const firstGroup = renderer.props.list.groups.find((group) => !group.isFolded);
        expect(renderer.props.quickCreateState.id).toBe(firstGroup.id);
        expect(`.o_kanban_group[data-id='${firstGroup.id}'] .o_kanban_quick_create`).toHaveCount(1);
        await contains(".o_kanban_quick_create .o_field_widget[name=name] input").edit(
            "Grouped lead",
            { confirm: false }
        );
        await contains(".o_kanban_quick_create .o_kanban_add").click();
        expect.verifySteps(['web_save ["expected_revenue","name"]']);
        const created = MockServer.env["crm.lead"].search_read([["name", "=", "Grouped lead"]]);
        expect(created).toHaveLength(1);
        expect(created[0].stage_id).toBe(false);

        // Back to the stage grouping: the pipeline is rendered again.
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        expect(renderer.props.list.groupByField.name).toBe("stage_id");
        expect(controller.isMobilePipeline).toBe(true);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("New", 2, 120);
    });

    test.tags("mobile");
    test("mobile: clearing the group-by falls back to the standard ungrouped renderer", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchActivityReads();
        watchTypeReads();
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        // This action groups by stage through a search facet only (no default grouping).
        await getService("action").doAction(UNGROUPABLE_PIPELINE_ACTION_ID);
        await animationFrame();
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("New", 2, 120);
        expect.verifySteps(["types", "activities:1", "activities:2"]);

        await removeFacet("Stage");
        await animationFrame();
        const [controller] = controllers;
        expect(controller.model.root.config.groupBy).toEqual([]);
        expect(controller.isMobilePipeline).toBe(false);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer.o_kanban_ungrouped").toHaveCount(1);
        expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(5);
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        // The pipeline effects read nothing outside the stage pipeline.
        await runAllTimers();
        expect.verifySteps([]);

        // New: the base behaviour of an ungrouped kanban, i.e. the form view.
        await contains(".o-kanban-button-new").click();
        await animationFrame();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_back_button").click();
        await animationFrame();
        expect(".o_kanban_renderer.o_kanban_ungrouped").toHaveCount(1);
        expect.verifySteps([]);

        // Grouping by stage again restores the pipeline.
        await toggleSearchBarMenu();
        await toggleMenuItem("Stage");
        await toggleSearchBarMenu();
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("New", 2, 120);
        expect.verifySteps(["types", "activities:1", "activities:2"]);
    });

    test.tags("mobile");
    test("mobile: cached stage renders offline; uncached stage and uncached lead show offline action helper", async () => {
        const errors = cachedReadErrors([
            // the offline reload of the pipeline, then the activities revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // the types revalidated on each stage displayed: Qualified, Proposition, Won,
            // Proposition, Qualified (the leads of Qualified and Proposition were never read)
            TYPES,
            TYPES,
            TYPES,
            TYPES,
            TYPES,
            // back on New: its two leads and the types
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        // The won stage is folded: its leads are never loaded online.
        MockServer.env["crm.stage"].write([4], { fold: true });
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_search_read", "crm.lead/web_read_group"]);
        // Lead 1's form was visited online, Lead 2's was not.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline(actionId, viewType, resId) {
                if (viewType === "form") {
                    return resId === 1;
                }
                return actionId === PIPELINE_ACTION_ID;
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            selectRecord: (resId) => expect.step(`open ${resId}`),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["crm.lead/web_read_group"]);
        expectHeader("New", 2, 120);

        // Offline, the visited stage is reloaded from the framework cache.
        await setOffline(true);
        const [renderer] = renderers;
        await renderer.props.list.model.load();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_read_group"]);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(".o_view_nocontent").toHaveCount(0);

        // The folded won stage holds a lead that was never loaded: the offline helper, no load.
        await goToStage("Won");
        expect(".o_crm_mobile_pipeline_stage_name .o_crm_mobile_pipeline_folded").toHaveCount(1);
        expectHeader("Won", 1, 50);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        expect(groupOf(renderer, 4).isFolded).toBe(true);
        expect.verifySteps([]);

        // A lead whose form is not available offline is dimmed, and opening it shows the helper.
        await goToStage("New");
        expect(`${cardOf("Lead 1")}`).not.toHaveClass("o_crm_mobile_lead_card_unavailable");
        expect(`${cardOf("Lead 2")}`).toHaveClass("o_crm_mobile_lead_card_unavailable");
        // Only the lead's details are dimmed. The article, its open button, and its controls,
        // which all work offline, keep their enabled look.
        const dimmedParts = (name) =>
            [queryOne(cardOf(name)), ...queryAll(`${cardOf(name)} *`)]
                .map((el) => [
                    [...el.classList].find((cls) => cls.startsWith("o_crm_mobile_")) ?? el.tagName,
                    getComputedStyle(el).opacity,
                ])
                .filter(([, opacity]) => opacity !== "1");
        expect(dimmedParts("Lead 1")).toEqual([]);
        expect(dimmedParts("Lead 2")).toEqual([
            ["o_crm_mobile_lead_card_name", "0.5"],
            ["o_crm_mobile_lead_card_partner", "0.5"],
            ["o_crm_mobile_lead_card_revenue", "0.5"],
        ]);
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_back").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_back").not.toHaveAttribute("disabled");
        await contains(".o_crm_mobile_pipeline_back").click();
        expect(".o_view_nocontent").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        // A tap on the card's controls never opens it; a lead visited online opens offline.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect.verifySteps([]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        expect.verifySteps(["open 1"]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: offline, the missing-data helper survives a reload and a move between two stages whose leads were never loaded", async () => {
        const errors = cachedReadErrors([
            // the types revalidated on each stage displayed: Qualified, Proposition
            TYPES,
            TYPES,
            // the offline reload of the pipeline, then the types revalidated after it
            LEAD_GROUPS,
            TYPES,
            // the types revalidated on Won, then on Proposition again
            TYPES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        // Proposition and Won are folded: their leads are never loaded online.
        MockServer.env["crm.stage"].write([3, 4], { fold: true });
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_search_read", "crm.lead/web_read_group"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["crm.lead/web_read_group"]);
        await setOffline(true);
        const [renderer] = renderers;

        // A folded stage holding a lead that was never loaded shows the helper in place of cards.
        await goToStage("Proposition");
        expectHeader("Proposition", 1, 40);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);

        // An offline reload keeps the stage body and its helper.
        const body = queryOne(".o_crm_mobile_pipeline_body");
        const helper = queryOne(".o_crm_mobile_pipeline_body .o_view_nocontent");
        await renderer.props.list.model.load();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_read_group"]);
        expectHeader("Proposition", 1, 40);
        expect(queryOne(".o_crm_mobile_pipeline_body")).toBe(body);
        expect(queryOne(".o_crm_mobile_pipeline_body .o_view_nocontent")).toBe(helper);

        // Moving to the next such stage, and back, rebuilds the stage body with its own helper.
        await contains(".o_crm_mobile_pipeline_next").click();
        await animationFrame();
        expectHeader("Won", 1, 50);
        expect(queryOne(".o_crm_mobile_pipeline_body")).not.toBe(body);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        await contains(".o_crm_mobile_pipeline_prev").click();
        await animationFrame();
        expectHeader("Proposition", 1, 40);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);

        // Neither folded stage was loaded, and both stay folded.
        expect.verifySteps([]);
        expect(groupOf(renderer, 3).isFolded).toBe(true);
        expect(groupOf(renderer, 4).isFolded).toBe(true);
        expect.verifyErrors(errors);
    });

    /**
     * Holds the online load of a stage's leads (the `crm.lead/web_search_read` of that stage's
     * group, as the toggle of a folded stage issues it) until the returned function is called.
     * Steps `"load <stageId>"` when such a load starts.
     *
     * @param {number} stageId
     * @returns {() => void} releases the held loads
     */
    function holdStageLoad(stageId) {
        const { promise, resolve } = Promise.withResolvers();
        onRpc("crm.lead", "web_search_read", async ({ kwargs }) => {
            const inStage = kwargs.domain.some(
                (condition) =>
                    Array.isArray(condition) &&
                    condition[0] === "stage_id" &&
                    condition[2] === stageId
            );
            if (inStage) {
                expect.step(`load ${stageId}`);
                await promise;
            }
        });
        return () => resolve();
    }

    test.tags("mobile");
    test("mobile: New on a folded stage opens nothing when the user moves to another stage during its load", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        const releaseWonLoad = holdStageLoad(4);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline();
        const [controller] = controllers;
        controller.crmMobileStage.serverValue = 4;
        await animationFrame();
        expectHeader("Won", 1, 50);

        await contains(".o-kanban-button-new").click();
        expect.verifySteps(["load 4"]);
        // The user moves on while the folded stage loads.
        await goToStage("Qualified");
        expectHeader("Qualified", 1, 30);
        releaseWonLoad();
        await animationFrame();
        await animationFrame();
        // The displayed stage stays the user's choice, and no quick create opens anywhere.
        expect(controller.crmMobileStage.serverValue).toBe(2);
        expectHeader("Qualified", 1, 30);
        expect(controller.quickCreateState.isOpen).toBe(false);
        expect(controller.quickCreateState.id).toBe(null);
        expect(".o_kanban_quick_create").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: New on a folded stage whose load is overtaken by a reload opens the quick create in the reloaded stage group", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        const releaseWonLoad = holdStageLoad(4);
        const controllers = captureInstances(CrmMobilePipelineController);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [controller] = controllers;
        const [renderer] = renderers;
        controller.crmMobileStage.serverValue = 4;
        await animationFrame();
        const staleWon = groupOf(renderer, 4);

        await contains(".o-kanban-button-new").click();
        expect.verifySteps(["load 4"]);
        // A filter reloads the root meanwhile: every group is rebuilt with a new datapoint id.
        await toggleSearchBarMenu();
        await toggleMenuItem("With Revenue");
        await toggleSearchBarMenu();
        expect(groupOf(renderer, 4).id).not.toBe(staleWon.id);
        releaseWonLoad();
        await animationFrame();
        await animationFrame();
        // The quick create opens in the current group of the stage, so it is rendered there.
        const won = groupOf(renderer, 4);
        expect(controller.crmMobileStage.serverValue).toBe(4);
        expect(controller.quickCreateState.isOpen).toBe(true);
        expect(controller.quickCreateState.id).toBe(won.id);
        expect(".o_crm_mobile_pipeline_body").toHaveAttribute("data-id", won.id);
        expect(".o_crm_mobile_pipeline_body .o_kanban_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("Won");
    });

    test.tags("mobile");
    test("mobile: New on a folded stage opens nothing when the view is regrouped by salesperson during its load", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        const releaseWonLoad = holdStageLoad(4);
        const controllers = captureInstances(CrmMobilePipelineController);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [controller] = controllers;
        const [renderer] = renderers;
        controller.crmMobileStage.serverValue = 4;
        await animationFrame();

        await contains(".o-kanban-button-new").click();
        expect.verifySteps(["load 4"]);
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        expect(controller.isMobilePipeline).toBe(false);
        releaseWonLoad();
        await animationFrame();
        await animationFrame();
        // No quick create opens on a salesperson group: the standard renderer stays as it is.
        expect(controller.quickCreateState.isOpen).toBe(false);
        expect(controller.quickCreateState.id).toBe(null);
        expect(renderer.props.list.groupByField.name).toBe("user_id");
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer.o_kanban_grouped").toHaveCount(1);
        expect(".o_kanban_quick_create").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: New on a folded stage changes nothing once the controller is destroyed during its load", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        const releaseWonLoad = holdStageLoad(4);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline();
        const [controller] = controllers;
        controller.crmMobileStage.serverValue = 4;
        await animationFrame();
        expectHeader("Won", 1, 50);

        await contains(".o-kanban-button-new").click();
        expect.verifySteps(["load 4"]);
        // The view is torn down while the stage loads (the action service itself waits for the
        // model's pending loads before leaving a kanban view): the controller is destroyed, while
        // its model, gate and displayed stage are unchanged.
        destroyApp();
        await animationFrame();
        expect(".o_kanban_view").toHaveCount(0);
        expect(controller.isMobilePipeline).toBe(true);
        releaseWonLoad();
        await animationFrame();
        await animationFrame();
        expect(controller.crmMobileStage.serverValue).toBe(4);
        expect(controller.quickCreateState.isOpen).toBe(false);
        expect(controller.quickCreateState.id).toBe(null);
    });

    test.tags("mobile");
    test("mobile: New on a folded stage changes nothing when the controller is destroyed as its load lands", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        const releaseWonLoad = holdStageLoad(4);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline();
        const [controller] = controllers;
        controller.crmMobileStage.serverValue = 4;
        await animationFrame();
        // The view is torn down right after the folded stage is loaded and unfolded, before New
        // resumes: only the controller's own status tells it not to open the quick create.
        patchWithCleanup(controller.model.constructor.Group.prototype, {
            async toggle() {
                await super.toggle(...arguments);
                if (this.serverValue === 4) {
                    destroyApp();
                }
            },
        });

        await contains(".o-kanban-button-new").click();
        expect.verifySteps(["load 4"]);
        releaseWonLoad();
        await animationFrame();
        await animationFrame();
        expect(".o_kanban_view").toHaveCount(0);
        expect(controller.isMobilePipeline).toBe(true);
        expect(controller.crmMobileStage.serverValue).toBe(4);
        expect(controller.quickCreateState.isOpen).toBe(false);
        expect(controller.quickCreateState.id).toBe(null);
    });

    test.tags("mobile");
    test("mobile: New offline on a folded stage opens the quick create in it without loading it", async () => {
        // the new record of the quick create opened offline
        const errors = cachedReadErrors(["crm.lead/onchange"]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_search_read"]);
        const controllers = captureInstances(CrmMobilePipelineController);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [controller] = controllers;
        const [renderer] = renderers;
        const won = groupOf(renderer, 4);
        // Online, a quick create of the folded stage was opened once and discarded: the
        // framework then makes New available offline, and caches the new record of that stage.
        controller.crmMobileStage.serverValue = 4;
        await animationFrame();
        await controller.quickCreateState.openQuickCreate(won.id);
        await contains(
            ".o_crm_mobile_pipeline_body .o_kanban_quick_create .o_kanban_cancel"
        ).click();
        expect(".o_kanban_quick_create").toHaveCount(0);
        expect(won.isFolded).toBe(true);

        await setOffline(true);
        await visitedReady();
        expect(".o-kanban-button-new").not.toHaveAttribute("disabled");
        await contains(".o-kanban-button-new").click();
        await animationFrame();
        // No load of the folded stage, online or offline: it stays folded, in its config too.
        expect.verifySteps([]);
        expect(won.isFolded).toBe(true);
        expect(won.config.isFolded).toBe(true);
        expect(controller.crmMobileStage.serverValue).toBe(4);
        expect(controller.quickCreateState.isOpen).toBe(true);
        expect(controller.quickCreateState.id).toBe(won.id);
        expect(".o_crm_mobile_pipeline_body").toHaveAttribute("data-id", won.id);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("Won");
        expect(".o_crm_mobile_pipeline_body .o_kanban_quick_create").toHaveCount(1);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: New takes the base path when the pipeline arch does not quick create", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace(' on_create="quick_create"', ""),
            createRecord: () => expect.step("base createRecord"),
        });
        const [controller] = controllers;
        expect(controller.isMobilePipeline).toBe(true);
        expect(controller.canQuickCreate).toBe(true);
        await goToStage("Qualified");

        await contains(".o-kanban-button-new").click();
        await animationFrame();
        // The base behaviour of an arch without `on_create="quick_create"`: the view's own
        // `createRecord`, and no quick create.
        expect.verifySteps(["base createRecord"]);
        expect(controller.quickCreateState.isOpen).toBe(false);
        expect(".o_kanban_quick_create").toHaveCount(0);
        expectHeader("Qualified", 1, 30);
    });

    test.tags("mobile");
    test("mobile: the uncached lead helper focuses Back, describes it with the helper text and hands the focus back when left", async () => {
        const errors = cachedReadErrors([
            // two offline reloads while the helper is displayed, each followed by the activities
            // and the types revalidated on the reloaded stage list
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // the types revalidated when Qualified is displayed (Lead 3's activities were never
            // read, so they are not cached and raise nothing)
            TYPES,
            // New displayed again: its two leads and the types
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // Lead 1's form was visited online, Lead 2's and Lead 3's were not.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline(actionId, viewType, resId) {
                if (viewType === "form") {
                    return resId === 1;
                }
                return actionId === PIPELINE_ACTION_ID;
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const [renderer] = renderers;

        // Tapping the uncached lead moves the focus to Back, described by the helper text.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_crm_mobile_pipeline_back").toBeFocused();
        const back = queryOne(".o_crm_mobile_pipeline_back");
        expect(back).toHaveAttribute("aria-label", "Back");
        expect(back).toHaveAttribute("title", "Back");
        expect(back).toHaveAttribute("data-available-offline", "1");
        // The description is the helper's sentence alone (no icon text, no Reset Filters label),
        // hidden so that it is read only as Back's description.
        const description = document.getElementById(back.getAttribute("aria-describedby"));
        const sentence = "There is no data to display offline for the given filters";
        expect(description.textContent.trim()).toBe(sentence);
        expect(queryAllTexts(".o_crm_mobile_pipeline_body .o_nocontent_help p")).toInclude(
            sentence
        );
        expect(description).not.toBeVisible();
        // Nothing in the stage body is live-announced, and the helper stays positioned against
        // the stage body.
        expect(
            ".o_crm_mobile_pipeline_body[aria-live], .o_crm_mobile_pipeline_body [aria-live]"
        ).toHaveCount(0);
        expect(queryOne(".o_view_nocontent").offsetParent).toBe(
            queryOne(".o_crm_mobile_pipeline_body")
        );
        // Back is drawn above the helper's content, so it precedes the helper in the document:
        // the keyboard order follows the visual order.
        expect(
            back.compareDocumentPosition(queryOne(".o_view_nocontent")) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

        // A reload renews the group datapoint ids but keeps the stage body (keyed by stage), Back
        // and the helper: Back keeps the focus.
        const body = queryOne(".o_crm_mobile_pipeline_body");
        const groupId = body.dataset.id;
        const helper = queryOne(".o_crm_mobile_pipeline_body .o_view_nocontent");
        await renderer.props.list.model.load();
        await animationFrame();
        expect(body.dataset.id).not.toBe(groupId);
        expect(queryOne(".o_crm_mobile_pipeline_body")).toBe(body);
        expect(queryOne(".o_crm_mobile_pipeline_back")).toBe(back);
        expect(queryOne(".o_crm_mobile_pipeline_body .o_view_nocontent")).toBe(helper);
        expect(".o_crm_mobile_pipeline_back").toBeFocused();
        // A re-render never takes the focus back to Back from another control.
        queryOne(".o_crm_mobile_pipeline_next").focus();
        await renderer.props.list.model.load();
        await animationFrame();
        expect(".o_crm_mobile_pipeline_back").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();

        // Back hands the focus to the open control of the tapped lead's card, never to the body.
        await contains(".o_crm_mobile_pipeline_back").click();
        expect(".o_crm_mobile_pipeline_back").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_open`).toBeFocused();

        // Leaving the helper by a stage navigation (a swipe) while Back holds the focus: the
        // displayed stage does not show the lead, so the first header control takes the focus.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_crm_mobile_pipeline_back").toBeFocused();
        await renderer.onNext();
        await animationFrame();
        expectHeader("Qualified", 1, 30);
        expect(".o_crm_mobile_pipeline_back").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_prev").toBeFocused();

        // The displayed stage changes while the helper stays displayed, as after a reload whose
        // groups no longer hold that stage (the shared displayed-stage state is written here):
        // the stage body is rebuilt for the other stage, Back included, and the new Back takes
        // the focus over from the old one.
        await contains(`${cardOf("Lead 3")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_crm_mobile_pipeline_back").toBeFocused();
        const qualifiedBack = queryOne(".o_crm_mobile_pipeline_back");
        renderer.stageState.serverValue = 1;
        await animationFrame();
        expectHeader("New", 2, 120);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(queryOne(".o_crm_mobile_pipeline_back")).not.toBe(qualifiedBack);
        expect(".o_crm_mobile_pipeline_back").toBeFocused();
        // Back then hands the focus to the first header control: New does not show Lead 3.
        await contains(".o_crm_mobile_pipeline_back").click();
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: controller New button opens the framework quick create in the displayed stage", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        onRpc("crm.lead", "web_save", ({ args, kwargs }) => {
            expect.step(`web_save stage ${kwargs.context.default_stage_id}: ${args[1].name}`);
        });
        const controllers = captureInstances(CrmMobilePipelineController);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        await goToStage("Qualified");

        await contains(".o-kanban-button-new").click();
        await animationFrame();
        const qualified = groupOf(renderer, 2);
        expect(".o_crm_mobile_pipeline_body .o_kanban_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_body").toHaveAttribute("data-id", qualified.id);
        expect(renderer.props.quickCreateState.id).toBe(qualified.id);
        expectHeader("Qualified", 1, 30);
        // The framework quick create adds the lead to the displayed stage.
        await contains(".o_kanban_quick_create .o_field_widget[name=name] input").edit(
            "Quick lead",
            { confirm: false }
        );
        await contains(".o_kanban_quick_create .o_kanban_add").click();
        await animationFrame();
        expect.verifySteps(["web_save stage 2: Quick lead"]);
        expect(cardNames()).toInclude("Quick lead");

        // A folded displayed stage is unfolded (online) before the quick create opens in it.
        const [controller] = controllers;
        controller.crmMobileStage.serverValue = 4;
        await animationFrame();
        expect(groupOf(renderer, 4).isFolded).toBe(true);
        await contains(".o-kanban-button-new").click();
        await animationFrame();
        expect(groupOf(renderer, 4).isFolded).toBe(false);
        expect(renderer.props.quickCreateState.id).toBe(groupOf(renderer, 4).id);
        expect(".o_crm_mobile_pipeline_body .o_kanban_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("Won");
    });

    test.tags("mobile");
    test("mobile: later stage scrolled, lead opened, back: the same stage and scroll are restored, no error", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        // Enough leads in Qualified for its stage body to scroll.
        for (let index = 1; index <= 12; index++) {
            MockServer.env["crm.lead"].create({
                name: `Qualified lead ${index}`,
                stage_id: 2,
                expected_revenue: 10,
            });
        }
        const controllers = captureInstances(CrmMobilePipelineController);
        // The restored state also carries the saved scroll of stages the pipeline does not render
        // (New and Proposition): the base restoration would dereference their missing nodes.
        const restoredScrollTops = [];
        patchWithCleanup(CrmMobilePipelineController.prototype, {
            setup() {
                const columnScrollTops = this.props.state?.scrollPositions?.columnScrollTops;
                if (columnScrollTops) {
                    columnScrollTops.push([1, 300], [3, 400]);
                    restoredScrollTops.push([...columnScrollTops]);
                }
                return super.setup(...arguments);
            },
        });
        await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await goToStage("Qualified");
        expectHeader("Qualified", 13, 150);

        const body = queryOne(".o_crm_mobile_pipeline_body");
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight + 200);
        body.scrollTop = 200;
        await animationFrame();
        const scrollTop = body.scrollTop;
        expect(scrollTop).toBe(200);
        await contains(`${cardOf("Qualified lead 3")} .o_crm_mobile_lead_card_name`).click();
        await animationFrame();
        expect(".o_form_view").toHaveCount(1);
        expect(".o_field_widget[name=name] input").toHaveValue("Qualified lead 3");

        await contains(".o_back_button").click();
        await animationFrame();
        expect(controllers).toHaveLength(2);
        // The adapter saved the displayed stage with the local state, then restored it, keeping
        // only the displayed stage's saved scroll.
        expect(restoredScrollTops).toEqual([
            [
                [2, 200],
                [1, 300],
                [3, 400],
            ],
        ]);
        expect(controllers[1].props.state.crmMobileStage).toBe(2);
        expect(controllers[1].props.state.scrollPositions.columnScrollTops).toEqual([[2, 200]]);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("Qualified", 13, 150);
        expect(queryOne(".o_crm_mobile_pipeline_body").scrollTop).toBe(scrollTop);
    });

    test.tags("desktop");
    test("desktop: a restored state with a displayed stage and several column scrolls is left untouched", async () => {
        const controllers = captureInstances(CrmMobilePipelineController);
        const columnScrollTops = [
            [1, 10],
            [2, 20],
            [3, 30],
        ];
        const state = {
            crmMobileStage: 2,
            scrollPositions: { scrollLeft: 0, columnScrollTops: [...columnScrollTops] },
        };
        await mountPipeline({ state });
        const [controller] = controllers;
        expect(controller.props.state).toBe(state);
        expect(controller.isMobilePipeline).toBe(false);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer.o_kanban_grouped").toHaveCount(1);
        expect(".o_kanban_group").toHaveCount(4);
        expect(state).toEqual({
            crmMobileStage: 2,
            scrollPositions: { scrollLeft: 0, columnScrollTops },
        });
    });

    test.tags("mobile");
    test("mobile: grouped by salesperson, the restored stage and column scrolls are left to the standard layout", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        // Enough leads of the current user for that salesperson's column to scroll.
        for (let index = 1; index <= 12; index++) {
            MockServer.env["crm.lead"].create({
                name: `My lead ${index}`,
                stage_id: 1,
                user_id: serverState.userId,
            });
        }
        const controllers = captureInstances(CrmMobilePipelineController);
        // Saved by the standard mobile layout: one entry per salesperson column, plus one whose
        // value equals the saved stage and matches no column.
        const columnScrollTops = [
            [serverState.userId, 120],
            [false, 15],
            [2, 30],
        ];
        const state = {
            crmMobileStage: 2,
            scrollPositions: { scrollLeft: 0, columnScrollTops: [...columnScrollTops] },
        };
        await mountPipeline({ groupBy: ["user_id"], state });
        const [controller] = controllers;
        expect(controller.props.state).toBe(state);
        expect(controller.model.root.groupByField.name).toBe("user_id");
        expect(controller.isMobilePipeline).toBe(false);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer.o_kanban_grouped").toHaveCount(1);
        expect(state.scrollPositions.columnScrollTops).toEqual(columnScrollTops);
        // The standard layout restored the saved scroll of the salesperson's column.
        const myGroup = controller.model.root.groups.find(
            (group) => group.serverValue === serverState.userId
        );
        const column = queryOne(`.o_kanban_group[data-id='${myGroup.id}']`);
        expect(column.scrollHeight).toBeGreaterThan(column.clientHeight + 120);
        expect(column.scrollTop).toBe(120);
    });

    test.tags("mobile");
    test("mobile: restored column scrolls without a saved stage keep only the displayed stage's", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        // Enough leads in New, the first unfolded stage, for its stage body to scroll.
        for (let index = 1; index <= 12; index++) {
            MockServer.env["crm.lead"].create({
                name: `New lead ${index}`,
                stage_id: 1,
                expected_revenue: 10,
            });
        }
        const controllers = captureInstances(CrmMobilePipelineController);
        const state = {
            scrollPositions: {
                scrollLeft: 0,
                columnScrollTops: [
                    [2, 20],
                    [1, 120],
                    [3, 30],
                ],
            },
        };
        await mountPipeline({ state });
        const [controller] = controllers;
        expect(controller.props.state).toBe(state);
        expect(controller.isMobilePipeline).toBe(true);
        expect(controller.crmMobileStage.serverValue).toBe(null);
        expectHeader("New", 14, 240);
        expect(state.scrollPositions.columnScrollTops).toEqual([[1, 120]]);
        const body = queryOne(".o_crm_mobile_pipeline_body");
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight + 120);
        expect(body.scrollTop).toBe(120);
    });

    test.tags("mobile");
    test("mobile: scrolled stage, lead opened, server data changed, back: the stage and scroll survive the refreshed answer", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        // Enough leads in Qualified for its stage body to scroll.
        for (let index = 1; index <= 12; index++) {
            MockServer.env["crm.lead"].create({
                name: `Qualified lead ${index}`,
                stage_id: 2,
                expected_revenue: 10,
            });
        }
        // Holds the server answer of the pipeline read, as network latency does: the answer of
        // the framework RPC cache then lands first, and the server's lands later.
        const pipelineReads = holdRequests(
            "/web/dataset/call_kw/crm.lead/web_read_group",
            "pipeline read"
        );
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await goToStage("Qualified");
        const body = queryOne(".o_crm_mobile_pipeline_body");
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight + 200);
        body.scrollTop = 200;
        await animationFrame();
        expect(body.scrollTop).toBe(200);
        await contains(`${cardOf("Qualified lead 3")} .o_crm_mobile_lead_card_name`).click();
        await animationFrame();
        expect(".o_form_view").toHaveCount(1);

        // Meanwhile, a lead of another stage changes on the server: its answer to the pipeline
        // read now differs from the cached one.
        MockServer.env["crm.lead"].write([4], { expected_revenue: 45 });
        pipelineReads.active = true;
        await contains(".o_back_button").click();
        await animationFrame();
        expect.verifySteps(["held pipeline read"]);
        // Rendered from the cached answer: the stage and its scroll are restored.
        expect(controllers).toHaveLength(2);
        const [, controller] = controllers;
        const cachedGroupId = controller.model.root.groups.find(
            (group) => group.serverValue === 2
        ).id;
        expect(".o_crm_mobile_pipeline_body").toHaveAttribute("data-id", cachedGroupId);
        expectHeader("Qualified", 13, 150);
        expect(queryOne(".o_crm_mobile_pipeline_body").scrollTop).toBe(200);

        // The server answer lands: every group is rebuilt with a new datapoint id, and the
        // displayed stage keeps its body, so its scroll.
        pipelineReads.active = false;
        pipelineReads.release();
        await animationFrame();
        await animationFrame();
        const proposition = controller.model.root.groups.find((group) => group.serverValue === 3);
        expect(proposition.aggregates.expected_revenue).toBe(45);
        const qualified = controller.model.root.groups.find((group) => group.serverValue === 2);
        expect(qualified.id).not.toBe(cachedGroupId);
        expect(".o_crm_mobile_pipeline_body").toHaveAttribute("data-id", qualified.id);
        expectHeader("Qualified", 13, 150);
        expect(queryOne(".o_crm_mobile_pipeline_body").scrollTop).toBe(200);
    });

    test.tags("mobile");
    test("mobile: totals follow offline creation and movement", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified: Lead 1's activities (cached) and the types; Lead 3's
            // activities were never read, so they are not cached and raise nothing
            ACTIVITIES,
            TYPES,
            // back on New: Lead 2's activities and the types
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        expectHeader("New", 2, 120);

        // An offline quick create of 50 in New.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Offline lead", expected_revenue: "50" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queuedCalls("crm.lead", "web_save")).toHaveLength(1);
        expectHeader("New", 3, 170);
        expect(cardNames()).toEqual(["Offline lead", "Lead 1", "Lead 2"]);

        // An offline move of Lead 1 (100) from New to Qualified: the target stage is displayed.
        await chooseStage("Lead 1", 2);
        expect(queuedCalls("crm.lead", "web_save")).toHaveLength(2);
        expectHeader("Qualified", 2, 130);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);
        await goToStage("New");
        expectHeader("New", 2, 70);
        expect(cardNames()).toEqual(["Offline lead", "Lead 2"]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: pending stage placement and totals survive remounts and reloads", async () => {
        const errors = cachedReadErrors([
            // the first move displays Qualified (Lead 1's activities, the types; Lead 3's were
            // never cached)
            ACTIVITIES,
            TYPES,
            // Lead 1's form, then the pipeline rebuilt from the cache with its activities
            "crm.lead/web_read",
            LEAD_GROUPS,
            ACTIVITIES,
            TYPES,
            // the offline reload, then the activities revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            TYPES,
            // the second move displays Proposition (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${JSON.stringify(args)}`);
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        // Online: the pipeline and Lead 1's form are visited, hence available offline.
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_back_button").click();
        expect.verifySteps([LEAD_GROUPS, LEAD_GROUPS]);

        /** Totals of a stage, read from the current renderer (no navigation, no read). */
        const totals = (stageId) => {
            const renderer = renderers.at(-1);
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };
        const expectMovedToQualified = () => {
            expectHeader("Qualified", 2, 130);
            expect(cardNames().sort()).toEqual(["Lead 1", "Lead 3"]);
            expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
            expect(`${cardOf("Lead 3")} .o_crm_mobile_pending_badge`).toHaveCount(0);
            expect(totals(1)).toEqual([1, 20]);
            expect(totals(3)).toEqual([1, 40]);
        };

        // Offline move of Lead 1 (100) from New to Qualified.
        await setOffline(true);
        await visitedReady();
        await chooseStage("Lead 1", 2);
        expect(queued()).toHaveLength(1);
        expectMovedToQualified();

        // Lead form, then back: the pipeline is rebuilt from the framework cache, whose data
        // predate the queued write, and the write still places the card and corrects the totals.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_back_button").click();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        // three pipelines: the first visit, the online back, and this offline back
        expect(renderers).toHaveLength(3);
        const lead1 = recordOf(renderers.at(-1), 1);
        expect(lead1.group.serverValue).toBe(1);
        expect(lead1.serverStageId).toBe(1);
        expectMovedToQualified();

        // An offline reload: the same.
        await renderers.at(-1).props.list.load();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expectMovedToQualified();

        // The rebuilt record is held by New while a queued write places it in Qualified: the
        // card's stage list disables both, since a move into the group already holding the
        // record writes no stage.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).click();
        expect(
            queryAll(`${cardOf("Lead 1")} .o_crm_mobile_stage_option:disabled`).map((el) =>
                Number(el.dataset.stageValue)
            )
        ).toEqual([1, 2]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_stage_list`).toHaveCount(0);

        // A second offline move, made after the remount, from Qualified to Proposition.
        await chooseStage("Lead 1", 3);
        const leadWrites = queued().filter(
            ({ value }) => value.model === "crm.lead" && value.args[0][0] === 1
        );
        expect(leadWrites).toHaveLength(2);
        expect(leadWrites.map(({ value }) => value.args[1].stage_id).sort()).toEqual([2, 3]);
        const expectMovedToProposition = () => {
            expectHeader("Proposition", 2, 140);
            expect(cardNames().sort()).toEqual(["Lead 1", "Lead 4"]);
            expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
            expect(totals(1)).toEqual([1, 20]);
            expect(totals(2)).toEqual([1, 30]);
        };
        expectMovedToProposition();

        // Reconnect: both writes are accepted, in order. During the sync window, the card keeps
        // its placement and the totals do not move, although the first write already left the
        // queue.
        await setOffline(false);
        await expect.waitForSteps(['replayed [[1],{"stage_id":2}]']);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(queued()).toHaveLength(1);
        expectMovedToProposition();
        await letQueueReplay(1);
        // Then the reconciliation reload: the totals are the server aggregates, no correction
        // remains.
        expect.verifySteps(['replayed [[1],{"stage_id":3}]', LEAD_GROUPS]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(false);
        expect(queued()).toHaveLength(0);
        const renderer = renderers.at(-1);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expectHeader("Proposition", 2, 140);
        expect(".o_crm_mobile_pending_badge").toHaveCount(0);
        expect(renderer.allLoadedRecords().some((record) => renderer.isDisplaced(record))).toBe(
            false
        );
        expect(recordOf(renderer, 1).serverStageId).toBe(3);
        expect(totals(1)).toEqual([1, 20]);
        expect(totals(2)).toEqual([1, 30]);
        expect(totals(3)).toEqual([2, 140]);
        const serverGroups = MockServer.env["crm.lead"].formatted_read_group(
            [],
            ["stage_id"],
            ["__count", "expected_revenue:sum"]
        );
        expect(
            serverGroups.map((group) => [
                group.stage_id[0],
                group.__count,
                group["expected_revenue:sum"],
            ])
        ).toEqual([
            [1, 1, 20],
            [2, 1, 30],
            [3, 2, 140],
            [4, 1, 50],
        ]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a parked stage move keeps its placement and totals after reconciliation, and a systray discard ends them", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", () => {
            expect.step("replay rejected");
            throw makeServerError({ message: "This stage is locked" });
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        expect.verifySteps([LEAD_GROUPS]);
        const totals = (stageId) => {
            const renderer = renderers.at(-1);
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };

        await setOffline(true);
        await chooseStage("Lead 1", 2);
        expectHeader("Qualified", 2, 130);

        // Reconnect: the replay is rejected and parked, then the pipeline is reloaded with the
        // server state, in which Lead 1 is still in New.
        await setOffline(false);
        await expect.waitForSteps(["replay rejected", LEAD_GROUPS]);
        await animationFrame();
        expect(queued()).toHaveLength(1);
        const [parked] = queued();
        expect(parked.value.args[1]).toEqual({ stage_id: 2 });
        expect(parked.value.extras.error).toMatch(/This stage is locked/);
        const renderer = renderers.at(-1);
        expect(renderer.mobileState.syncEntries).toBe(null);
        const lead1 = recordOf(renderer, 1);
        expect(lead1.group.serverValue).toBe(1);
        expect(lead1.serverStageId).toBe(1);
        // The parked write still places the card and corrects the totals.
        expectHeader("Qualified", 2, 130);
        expect(cardNames().sort()).toEqual(["Lead 1", "Lead 3"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(totals(1)).toEqual([1, 20]);
        expect(".o_menu_systray .o_offline_systray [data-icon='error']").toHaveCount(1);

        // Discarding it from the systray ends both: the card is back in New, with the server
        // aggregates.
        await contains(".o_menu_systray .o_nav_entry [data-icon='error']").click();
        await contains(".o-dropdown--menu .o-dropdown-item button.btn").click();
        await contains(".modal-dialog .modal-footer button.btn-primary").click();
        expect(queued()).toHaveLength(0);
        expectHeader("Qualified", 1, 30);
        expect(cardNames()).toEqual(["Lead 3"]);
        expect(".o_crm_mobile_pending_badge").toHaveCount(0);
        expect(totals(1)).toEqual([2, 120]);
        await goToStage("New");
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect.verifySteps([]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: stage writes of a lead with the same timestamp are placed where the framework replay leaves it", async () => {
        const errors = cachedReadErrors([
            // the queued writes take Lead 1 out of New (Lead 2's activities, the types), then
            // Qualified is displayed (the types; Lead 3's activities were never cached), then
            // Proposition (Lead 1's activities, the types; Lead 4's were never cached)
            ACTIVITIES,
            TYPES,
            TYPES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${JSON.stringify(args)}`);
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        expect.verifySteps([LEAD_GROUPS]);
        const { crmOffline } = renderers.at(-1);
        const totals = (stageId) => {
            const renderer = renderers.at(-1);
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };

        // Offline, two stage writes of Lead 1 share their timestamp, as two record datapoints
        // saving within one millisecond do. Tied writes replay in the enumeration order of their
        // keys, so "b0000002" (Proposition) is applied after "a0000001" (Qualified) and the server
        // keeps Proposition. A browser's IndexedDB returns the entries in key order, the Hoot
        // IndexedDB mock in insertion order: scheduling them in key order makes the mock replay
        // them as a browser does.
        await setOffline(true);
        const timeStamp = Date.now();
        const scheduleStageWrite = (key, stageId, stageName) =>
            getService(OfflinePlugin).scheduleORM(
                "crm.lead",
                "web_save",
                [[1], { stage_id: stageId }],
                { context: {}, specification: {} },
                {
                    id: key,
                    extras: {
                        actionId: PIPELINE_ACTION_ID,
                        actionName: "Pipeline",
                        viewType: "kanban",
                        timeStamp,
                        displayName: "Lead 1",
                        changes: { stage_id: { id: stageId, display_name: stageName } },
                        originalValues: { stage_id: { id: 1, display_name: "New" } },
                    },
                }
            );
        expect(scheduleStageWrite("a0000001", 2, "Qualified")).toBe("a0000001");
        expect(scheduleStageWrite("b0000002", 3, "Proposition")).toBe("b0000002");
        await animationFrame();
        const entries = queued();
        expect(entries.map(({ key }) => key)).toEqual(["a0000001", "b0000002"]);
        const replayedLast = entries[1];

        // Lead 1 is placed in Proposition, not in Qualified, whichever order the entries are
        // read in.
        expect(crmOffline.latestStageWrite(1)).toBe(replayedLast);
        expect(crmOffline.latestStageWrite(1, entries)).toBe(replayedLast);
        expect(crmOffline.latestStageWrite(1, [...entries].reverse())).toBe(replayedLast);
        expectHeader("New", 1, 20);
        expect(cardNames()).toEqual(["Lead 2"]);
        expect(totals(1)).toEqual([1, 20]);
        expect(totals(2)).toEqual([1, 30]);
        expect(totals(3)).toEqual([2, 140]);
        await goToStage("Qualified");
        expectHeader("Qualified", 1, 30);
        expect(cardNames()).toEqual(["Lead 3"]);
        await goToStage("Proposition");
        expectHeader("Proposition", 2, 140);
        expect(cardNames().sort()).toEqual(["Lead 1", "Lead 4"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);

        // Reconnect: the replay applies both writes in that order, and the server ends with the
        // stage the card was placed in. After the reconciliation reload nothing is displaced.
        await setOffline(false);
        await expect.waitForSteps(['replayed [[1],{"stage_id":2}]']);
        expectHeader("Proposition", 2, 140);
        await letQueueReplay(1);
        expect.verifySteps(['replayed [[1],{"stage_id":3}]', LEAD_GROUPS]);
        expect(queued()).toHaveLength(0);
        expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(3);
        const reconciled = renderers.at(-1);
        expect(reconciled.mobileState.syncEntries).toBe(null);
        expect(recordOf(reconciled, 1).serverStageId).toBe(3);
        expect(reconciled.allLoadedRecords().some((record) => reconciled.isDisplaced(record))).toBe(
            false
        );
        expectHeader("Proposition", 2, 140);
        expect(cardNames().sort()).toEqual(["Lead 1", "Lead 4"]);
        expect(".o_crm_mobile_pending_badge").toHaveCount(0);

        // The tie rule on its own, with no replay: tied keys rank in IndexedDB key order whatever
        // order they are passed in, a key that is an array index ("12345678") ranks before every
        // other key, and a later timestamp outranks any tie.
        const stageWrite = (key, stageId, at = timeStamp) => ({
            key,
            value: {
                model: "crm.lead",
                method: "web_save",
                args: [[1], { stage_id: stageId }],
                kwargs: {},
                extras: { timeStamp: at },
            },
        });
        const keyD = stageWrite("d0000004", 2);
        const keyC = stageWrite("c0000003", 3);
        expect(crmOffline.latestStageWrite(1, [keyD, keyC])).toBe(keyD);
        expect(crmOffline.latestStageWrite(1, [keyC, keyD])).toBe(keyD);
        const indexKey = stageWrite("12345678", 2);
        const hashKey = stageWrite("0abcdef0", 3);
        expect(crmOffline.latestStageWrite(1, [hashKey, indexKey])).toBe(hashKey);
        expect(crmOffline.latestStageWrite(1, [indexKey, hashKey])).toBe(hashKey);
        const later = stageWrite("00000000", 4, timeStamp + 1);
        expect(crmOffline.latestStageWrite(1, [keyD, later, keyC, indexKey, hashKey])).toBe(later);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: after replay, the created lead and activity show as server records without a manual reload", async () => {
        const [activityId] = await createActivities([
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("mail.activity", "action_archive", () => {
            throw makeServerError({ message: "This activity is locked" });
        });
        watchRpcs([
            "crm.lead/web_save",
            "mail.activity/web_save",
            "mail.activity/action_archive",
            LEAD_GROUPS,
            "crm.lead/web_search_read",
        ]);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);

        // Offline: a lead is created, a call is logged on Lead 1 and Lead 2's activity is done.
        await setOffline(true);
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Offline lead", expected_revenue: "50" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await advanceTime(1000);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).click();
        await advanceTime(1000);
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        await contains(
            `${cardOf(
                "Lead 2"
            )} .o_crm_mobile_activity_row[data-activity-id='${activityId}'] .o_crm_mobile_activity_done`
        ).click();
        expect(queued()).toHaveLength(3);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_pending`).toHaveCount(1);
        expect.verifySteps([]);

        // Reconnect: the three calls are replayed in order (the archive is rejected and parked),
        // then the pipeline reloads by itself.
        await setOffline(false);
        await letQueueReplay(3);
        expect.verifySteps([
            "crm.lead/web_save",
            "mail.activity/web_save",
            "mail.activity/action_archive",
            LEAD_GROUPS,
        ]);
        await animationFrame();
        // The created lead is a server card now.
        const created = MockServer.env["crm.lead"].search_read([["name", "=", "Offline lead"]]);
        expect(created).toHaveLength(1);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardOf("Offline lead")).toHaveCount(1);
        expect(`${cardOf("Offline lead")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(cardOf("Offline lead")).toHaveAttribute("data-id");
        expectHeader("New", 3, 170);
        // The logged call is a server activity of Lead 1, offered for Mark done.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_pending`).toHaveCount(0);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_row`).toHaveCount(1);
        expect(
            `${cardOf("Lead 1")} .o_crm_mobile_activity_row .o_crm_mobile_activity_type`
        ).toHaveText("Call");
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_done`).toHaveCount(1);
        // The parked archive is still shown pending.
        expect(queued()).toHaveLength(1);
        expect(queued()[0].value.extras.error).toMatch(/This activity is locked/);
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        expect(
            `${cardOf(
                "Lead 2"
            )} .o_crm_mobile_activity_row[data-activity-id='${activityId}'] .o_crm_mobile_pending_badge`
        ).toHaveCount(1);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_activity_done`).toHaveCount(0);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_pending_badge`).toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: pending cards keep their queue key and leave with their entry", async () => {
        const errors = cachedReadErrors([
            // a stage back and forth: the types on Qualified, then New's leads and the types
            TYPES,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const replays = [];
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`replay ${args[1].name}`);
            const deferred = Promise.withResolvers();
            replays.push(deferred);
            await deferred.promise;
        });
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);

        const quickCreate = async (name) => {
            await contains(".o_crm_mobile_pipeline_add").click();
            await fillQuickCreate({ name, expected_revenue: "10" });
            await contains(".o_crm_mobile_quick_create_save").click();
            await advanceTime(1000);
            return queued().find(({ value }) => value.args[1].name === name).key;
        };
        const pendingCard = (key) => queryOne(`.o_crm_mobile_lead_card[data-pending-key='${key}']`);
        // The mounted card components showing a queued create, in creation order. Unlike
        // `data-pending-key`, which follows the props, they reveal which entry Owl keyed them by.
        const pendingInstances = () =>
            cards.filter((card) => card.props.pendingCall && card.__owl__.status === 1);
        const keyA = await quickCreate("Pending A");
        let cardA = pendingCard(keyA);
        expect(cardA).toHaveClass("o_crm_mobile_lead_card_pending");
        expect(cardA).toHaveText(/Pending A/);
        // Queue changes re-render the stage; the card keeps its node and its key.
        const keyB = await quickCreate("Pending B");
        const keyC = await quickCreate("Pending C");
        expect(pendingCard(keyA)).toBe(cardA);
        expect(new Set([keyA, keyB, keyC]).size).toBe(3);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(3);
        expectHeader("New", 5, 150);

        // Rendering reads the queue without changing it (a stage back and forth renders the
        // stage body again, with new card nodes under the same keys).
        const stored = JSON.stringify(getService(OfflinePlugin)._ormToSync());
        await goToStage("Qualified");
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        await goToStage("New");
        expect(JSON.stringify(getService(OfflinePlugin)._ormToSync())).toBe(stored);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(3);
        cardA = pendingCard(keyA);
        const cardB = pendingCard(keyB);
        const cardC = pendingCard(keyC);
        // One mounted component per entry, in queue order, each showing the entry it is keyed by.
        const [instanceA, instanceB, instanceC] = pendingInstances();
        expect(pendingInstances().map((card) => card.props.pendingCall.key)).toEqual([
            keyA,
            keyB,
            keyC,
        ]);
        expect([instanceA, instanceB, instanceC].map((card) => card.leadLabel)).toEqual([
            "Pending A",
            "Pending B",
            "Pending C",
        ]);
        // B and C keep their node and their component, and each component shows its own entry.
        const expectSurvivorsKept = () => {
            expect(pendingCard(keyB)).toBe(cardB);
            expect(pendingCard(keyC)).toBe(cardC);
            const survivors = pendingInstances();
            expect(survivors).toHaveLength(2);
            expect(survivors[0]).toBe(instanceB);
            expect(survivors[1]).toBe(instanceC);
            for (const [instance, node, key, name] of [
                [instanceB, cardB, keyB, "Pending B"],
                [instanceC, cardC, keyC, "Pending C"],
            ]) {
                expect(instance.props.pendingCall.key).toBe(key);
                expect(node.dataset.pendingKey).toBe(key);
                expect(instance.leadLabel).toBe(name);
                expect(node).toHaveText(new RegExp(name));
            }
        };

        // A discard (the systray's removal of the entry) takes its card away at once. Discarding
        // the first entry moves B and C up one position: keyed by their entry, both keep their
        // node and component; keyed by position, A's would be reused for B and B's for C.
        getService(OfflinePlugin).removeScheduledORM(keyA);
        await animationFrame();
        expect(`.o_crm_mobile_lead_card[data-pending-key='${keyA}']`).toHaveCount(0);
        expect(cardA.isConnected).toBe(false);
        expect(
            queryAll(".o_crm_mobile_lead_card_pending").map((card) => card.dataset.pendingKey)
        ).toEqual([keyB, keyC]);
        expectSurvivorsKept();
        expectHeader("New", 4, 140);

        // Reconnect: the sync re-reads the queue from its storage (new entry objects, same keys)
        // while the first replay is in flight; the cards keep their node and their component.
        await setOffline(false);
        await expect.waitForSteps(["replay Pending B"]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expectSurvivorsKept();
        replays.shift().resolve();
        await letQueueReplay(1);
        expect.verifySteps(["replay Pending C"]);
        replays.shift().resolve();
        await letQueueReplay(1);
        // Both entries left the queue and the reload landed: the server cards replace them.
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(pendingInstances()).toHaveLength(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Pending B", "Pending C"]);
        expectHeader("New", 4, 140);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: placement and totals are derived once per change and shared by every reader", async () => {
        const errors = cachedReadErrors([
            // a queued write places Lead 3 in New: Lead 1's and Lead 2's activities (Lead 3's
            // were never read, so they are not cached and raise nothing) and the types
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // its discard takes Lead 3 out of New again: the same
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // a card move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const mountedCards = () => cards.filter((card) => status(card) === "mounted");
        const shareStages = (stages) =>
            mountedCards().every((card) => card.props.stages === stages);

        // The ordered stages are one array, shared by every card, until the groups change.
        let renderer = renderers.at(-1);
        const loadedStages = renderer.stageGroups;
        expect(renderer.stageGroups).toBe(loadedStages);
        expect(loadedStages.map((group) => group.serverValue)).toEqual([1, 2, 3, 4]);
        expect(mountedCards()).toHaveLength(2);
        expect(shareStages(loadedStages)).toBe(true);
        await renderer.props.list.load();
        await animationFrame();
        renderer = renderers.at(-1);
        const stages = renderer.stageGroups;
        expect(stages).not.toBe(loadedStages);
        expect(stages.map((group) => group.serverValue)).toEqual([1, 2, 3, 4]);
        expect(renderer.stageGroups).toBe(stages);
        expect(shareStages(stages)).toBe(true);

        await setOffline(true);
        await animationFrame();
        const calls = { queuedEntries: 0, latestStageWrite: 0, pendingLeadCreates: 0 };
        patchWithCleanup(renderer.crmOffline, {
            queuedEntries() {
                calls.queuedEntries++;
                return super.queuedEntries(...arguments);
            },
            latestStageWrite() {
                calls.latestStageWrite++;
                return super.latestStageWrite(...arguments);
            },
            pendingLeadCreates() {
                calls.pendingLeadCreates++;
                return super.pendingLeadCreates(...arguments);
            },
        });
        /** @returns {Object} the reader calls since the previous check */
        const takeCalls = () => {
            const taken = { ...calls };
            for (const reader of Object.keys(calls)) {
                calls[reader] = 0;
            }
            return taken;
        };
        const noCall = { queuedEntries: 0, latestStageWrite: 0, pendingLeadCreates: 0 };
        // One derivation: the queue read once, each loaded lead's latest stage write looked up
        // once (5 leads) and each stage's queued creates once (4 stages). The pipeline status
        // region reads the live queue once more per queue change, for its queued lead creates.
        const onePass = { queuedEntries: 2, latestStageWrite: 5, pendingLeadCreates: 4 };

        // A render that changes nothing the placement reads (new activity types) derives
        // nothing again and hands every card the same stages array.
        renderer.mobileState.activityTypes = [...renderer.mobileState.activityTypes];
        const types = renderer.mobileState.activityTypes; // as the template reads it
        await animationFrame();
        expect(mountedCards().every((card) => card.props.activityTypes === types)).toBe(true);
        expect(takeCalls()).toEqual(noCall);
        expect(shareStages(stages)).toBe(true);

        // A queued stage write of Lead 3 into New: one derivation shared by the header count
        // and revenue, both card loops, the helper, the remaining count and the activity
        // revalidation; direct reads afterwards reuse it.
        const offline = getService(OfflinePlugin);
        const key = offline.scheduleORM(
            "crm.lead",
            "web_save",
            [[3], { stage_id: 1 }],
            { context: {}, specification: {} },
            { extras: { timeStamp: Date.now(), viewType: "kanban", displayName: "Lead 3" } }
        );
        await animationFrame();
        expect(takeCalls()).toEqual(onePass);
        expectHeader("New", 3, 150);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Lead 3"]);
        const lead3 = recordOf(renderer, 3);
        expect(renderer.displayStage(lead3)).toBe(1);
        expect(renderer.isDisplaced(lead3)).toBe(true);
        const qualified = groupOf(renderer, 2);
        expect([renderer.stageCount(qualified), renderer.stageRevenueValue(qualified)]).toEqual([
            0, 0,
        ]);
        expect(renderer.isStageDataMissing(qualified)).toBe(false);
        expect(takeCalls()).toEqual(noCall);
        expect(renderer.stageGroups).toBe(stages);
        expect(shareStages(stages)).toBe(true);

        // Its discard: one derivation again, and the placement ends at once.
        offline.removeScheduledORM(key);
        await animationFrame();
        expect(takeCalls()).toEqual(onePass);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(renderer.isDisplaced(lead3)).toBe(false);
        expect([renderer.stageCount(qualified), renderer.stageRevenueValue(qualified)]).toEqual([
            1, 30,
        ]);
        expect(takeCalls()).toEqual(noCall);

        // An offline move through the card: the projection follows the framework move, and the
        // stages array, whose groups did not change, stays the same.
        await chooseStage("Lead 1", 2);
        expectHeader("Qualified", 2, 130);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);
        expect(renderer.displayStage(recordOf(renderer, 1))).toBe(2);
        expect([
            renderer.stageCount(groupOf(renderer, 1)),
            renderer.stageRevenueValue(groupOf(renderer, 1)),
        ]).toEqual([1, 20]);
        expect(renderer.stageGroups).toBe(stages);
        expect(shareStages(stages)).toBe(true);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: one projection pass reads each queue entry once, whatever the number of leads and stages", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const renderer = renderers.at(-1);
        const { crmOffline } = renderer;
        const offline = getService(OfflinePlugin);
        const timeStamp = Date.now();
        const schedule = (model, method, args, kwargs, at) =>
            offline.scheduleORM(model, method, args, kwargs, {
                extras: { timeStamp: at, viewType: "kanban", displayName: "Lead", changes: {} },
            });

        // Offline, none of these changes what New (displayed) shows: stage writes of three leads
        // of other stages (two of Lead 3), lead creates in Qualified (stage in the values) and in
        // Proposition (stage in the context), a lead write without a stage and an activity call.
        schedule("crm.lead", "web_save", [[3], { stage_id: 3 }], {}, timeStamp);
        schedule("crm.lead", "web_save", [[4], { stage_id: 4 }], {}, timeStamp + 1);
        schedule("crm.lead", "web_save", [[5], { stage_id: 2 }], {}, timeStamp + 2);
        schedule("crm.lead", "web_save", [[3], { stage_id: 4 }], {}, timeStamp + 3);
        schedule(
            "crm.lead",
            "web_save",
            [[], { name: "Pending Q", stage_id: 2, expected_revenue: 7 }],
            { context: {} },
            timeStamp + 4
        );
        schedule(
            "crm.lead",
            "web_save",
            [[], { name: "Pending P", expected_revenue: 9 }],
            { context: { default_stage_id: 3 } },
            timeStamp + 5
        );
        schedule("crm.lead", "web_save", [[2], { priority: "1" }], {}, timeStamp + 6);
        schedule("mail.activity", "action_archive", [[999]], {}, timeStamp + 7);
        await animationFrame();
        expect(queued()).toHaveLength(8);

        // The pipeline takes its entries from `queuedEntries`: each entry is handed over behind a
        // wrapper counting the reads of its value.
        let passes = 0;
        let visits = 0;
        patchWithCleanup(crmOffline, {
            queuedEntries() {
                passes++;
                return super.queuedEntries(...arguments).map((entry) => ({
                    key: entry.key,
                    get value() {
                        visits++;
                        return entry.value;
                    },
                }));
            },
        });

        // One more stage write (Lead 4 into Qualified, later than its write into Won): one pass,
        // in which the stage readers read each of the 9 entries once, and the pipeline reads the
        // value of the latest write of each of the 3 leads it places (Leads 3, 4 and 5) and of each
        // of the 2 queued creates (their revenue). Per-lead or per-stage scans of the queue would
        // read every entry again for each of the 5 loaded leads and each of the 4 stages.
        schedule("crm.lead", "web_save", [[4], { stage_id: 2 }], {}, timeStamp + 8);
        await animationFrame();
        const entryCount = queued().length;
        expect(entryCount).toBe(9);
        const loadedLeads = renderer.allLoadedRecords().length;
        expect(loadedLeads).toBe(5);
        // Plus the pipeline status region's own pass over the live queue: each entry once, and
        // the name of each of the 2 queued creates.
        const onePass = { passes: 1 + 1, visits: entryCount + 3 + 2 + (entryCount + 2) };
        expect({ passes, visits }).toEqual(onePass);
        expect(visits).toBeLessThan(loadedLeads * entryCount);

        // The pass placed and counted as the queue says, and every reader shares it.
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        const placedIn = (resId) => renderer.displayStage(recordOf(renderer, resId));
        expect([1, 2, 3, 4, 5].map(placedIn)).toEqual([1, 1, 4, 2, 2]);
        const totals = (stageId) => {
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };
        expect([1, 2, 3, 4].map(totals)).toEqual([
            [2, 120],
            // Lead 3 out, Leads 4 and 5 in, Pending Q
            [3, 30 - 30 + 50 + 40 + 7],
            // Lead 4 out, Pending P
            [1, 40 - 40 + 9],
            // Lead 5 out, Lead 3 in
            [1, 50 - 50 + 30],
        ]);
        expect(renderer.pendingCreatesFor(groupOf(renderer, 2)).map(({ key }) => key)).toEqual([
            queued().find(({ value }) => value.args[1]?.name === "Pending Q").key,
        ]);
        expect({ passes, visits }).toEqual(onePass);

        // The readers answer a frozen array (indexed once) exactly as any other array (scanned on
        // each call): the same entries, in the same order.
        const entries = queued();
        const sameEntries = (left, right) =>
            left.length === right.length && left.every((entry, index) => entry === right[index]);
        const expectSameAnswers = (list, resIds, stageValues) => {
            const frozen = Object.freeze([...list]);
            for (const resId of resIds) {
                expect(crmOffline.latestStageWrite(resId, frozen)).toBe(
                    crmOffline.latestStageWrite(resId, [...list])
                );
            }
            for (const stageValue of stageValues) {
                const indexed = crmOffline.pendingLeadCreates(stageValue, frozen);
                const scanned = crmOffline.pendingLeadCreates(stageValue, [...list]);
                expect(sameEntries(indexed, scanned)).toBe(true);
                // A new array on every call: changing one changes no later answer.
                indexed.push(entries[0]);
                expect(crmOffline.pendingLeadCreates(stageValue, frozen)).not.toBe(indexed);
                expect(crmOffline.pendingLeadCreates(stageValue, frozen)).toHaveLength(
                    indexed.length - 1
                );
            }
        };
        const writeOf = (resId, stageId) =>
            entries.find(
                ({ value }) => value.args[0][0] === resId && value.args[1]?.stage_id === stageId
            );
        const createOf = (name) => entries.find(({ value }) => value.args[1]?.name === name);
        const frozenEntries = Object.freeze([...entries]);
        const latestOf = (list, resIds) =>
            resIds.map((resId) => crmOffline.latestStageWrite(resId, list));
        expect(
            sameEntries(latestOf(frozenEntries, [1, 2, 3, 4, 5]), [
                undefined,
                undefined,
                writeOf(3, 4),
                writeOf(4, 2),
                writeOf(5, 2),
            ])
        ).toBe(true);
        const createsOf = (list, stageValues) =>
            stageValues.flatMap((stageValue) => crmOffline.pendingLeadCreates(stageValue, list));
        expect(
            sameEntries(createsOf(frozenEntries, [1, 2, 3, 4]), [
                createOf("Pending Q"),
                createOf("Pending P"),
            ])
        ).toBe(true);
        expectSameAnswers(entries, [1, 2, 3, 4, 5, 999], [1, 2, 3, 4, false, undefined]);
        expectSameAnswers([...entries].reverse(), [3, 4, 5], [2, 3]);

        // Tied writes rank in replay order (a key that is an array index before any other key,
        // the other keys in key order), the first entry kept on an exact tie; a write of several
        // leads counts for each; a create whose stage is NaN matches no stage.
        const call = (key, args, at = timeStamp, kwargs = {}) => ({
            key,
            value: {
                model: "crm.lead",
                method: "web_save",
                args,
                kwargs,
                extras: { timeStamp: at },
            },
        });
        const keyD = call("d0000004", [[1], { stage_id: 2 }]);
        const keyC = call("c0000003", [[1, 8], { stage_id: 3 }]);
        const indexKey = call("12345678", [[2], { stage_id: 2 }]);
        const hashKey = call("0abcdef0", [[2], { stage_id: 3 }]);
        const sameKeyFirst = call("e0000005", [[6], { stage_id: 2 }]);
        const sameKeySecond = call("e0000005", [[6], { stage_id: 3 }]);
        const nanCreate = call("f0000006", [[], { stage_id: NaN }]);
        const noStageCreate = call("f0000007", [[], { name: "No stage" }]);
        const contextCreate = call("f0000008", [[], {}], timeStamp, {
            context: { default_stage_id: 2 },
        });
        const tied = [
            keyD,
            keyC,
            indexKey,
            hashKey,
            sameKeyFirst,
            sameKeySecond,
            nanCreate,
            noStageCreate,
            contextCreate,
        ];
        const frozenTied = Object.freeze([...tied]);
        expect(
            sameEntries(latestOf(frozenTied, [1, 2, 6, 7, 8]), [
                keyD,
                hashKey,
                sameKeyFirst,
                undefined,
                keyC,
            ])
        ).toBe(true);
        const tiedCreates = createsOf(frozenTied, [NaN, undefined, 2, 3]);
        expect(sameEntries(tiedCreates, [noStageCreate, contextCreate])).toBe(true);
        expectSameAnswers(tied, [1, 2, 6, 7, 8], [NaN, undefined, 2, 3]);
        expectSameAnswers([...tied].reverse(), [1, 2, 6, 8], [undefined, 2]);

        // An array that is not frozen is scanned on each call, so a change shows at once.
        const growing = [...tied];
        expect(crmOffline.latestStageWrite(7, growing)).toBe(undefined);
        const later = call("00000000", [[7], { stage_id: 4 }], timeStamp + 1);
        growing.push(later);
        expect(crmOffline.latestStageWrite(7, growing)).toBe(later);
    });

    test.tags("mobile");
    test("mobile: activities of leads displayed online stay available offline after navigation, filtering and Load more", async () => {
        const errors = cachedReadErrors([
            // offline, Qualified then New are displayed again: every lead's activities and the
            // types were read online, so each read is answered by the cache
            TYPES,
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            ACTIVITIES,
        ]);
        expect.errors(errors.length);
        const [callId] = await createActivities([
            {
                res_id: 1,
                activity_type_id: 2,
                activity_category: "phonecall",
                summary: "Call Mitchell",
            },
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
            { res_id: 3, activity_type_id: 1, activity_category: "default", summary: "Qualify" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const requests = watchActivityReads();
        // One lead per stage page: Lead 2 is reached through Load more.
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" limit="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect(cardNames()).toEqual(["Lead 1"]);
        expect.verifySteps(["activities:1"]);

        // Navigation: each displayed lead is read again, with the same request.
        await goToStage("Qualified");
        expect.verifySteps(["activities:3"]);
        await goToStage("New");
        expect.verifySteps(["activities:1"]);
        await toggleSearchBarMenu();
        await toggleMenuItem("With Revenue");
        await toggleSearchBarMenu();
        expect(cardNames()).toEqual(["Lead 1"]);
        expect.verifySteps(["activities:1"]);
        await contains(".o_crm_mobile_pipeline_load_more button").click();
        await animationFrame();
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect.verifySteps(["activities:1", "activities:2"]);

        // A changed server answer is applied through the cache callback.
        MockServer.env["mail.activity"].write([callId], { summary: "Call Mitchell back" });
        await goToStage("Qualified");
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_summary`).toHaveText(
            "Call Mitchell back"
        );

        // One stable request per lead, whatever displayed it.
        for (const resId of [1, 2, 3]) {
            expect(new Set(requests.get(resId)).size).toBe(1);
        }

        // Offline: the same requests are answered by the cache.
        await setOffline(true);
        await goToStage("Qualified");
        await contains(`${cardOf("Lead 3")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 3")} .o_crm_mobile_activity_summary`).toHaveText("Qualify");
        await goToStage("New");
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_summary`).toHaveText(
            "Call Mitchell back"
        );
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 2")} .o_crm_mobile_activity_summary`).toHaveText("Send offer");
        for (const resId of [1, 2, 3]) {
            expect(new Set(requests.get(resId)).size).toBe(1);
        }
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: Load more is busy and disabled while the next page loads; a second activation loads nothing", async () => {
        await makeMockServer();
        MockServer.env["crm.lead"].create({
            name: "Lead 6",
            stage_id: 1,
            team_id: 1,
            expected_revenue: 60,
        });
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["crm.lead/web_search_read"]);
        let pendingLoad = null;
        onRpc("crm.lead", "web_search_read", async () => {
            await pendingLoad?.promise;
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            loadMore() {
                expect.step("loadMore");
                return super.loadMore(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        // One lead per stage page: New holds three leads, two of them left to load.
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" limit="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const newStage = groupOf(renderer, 1);
        const loadMore = ".o_crm_mobile_pipeline_load_more button";
        expect.verifySteps([]);
        expect(cardNames()).toEqual(["Lead 1"]);
        expect(loadMore).toHaveText("Load more... (2 remaining)");
        expect(loadMore).toHaveAttribute("aria-busy", "false");
        expect(loadMore).not.toHaveAttribute("disabled");
        expect(`${loadMore} .oi-spin`).toHaveCount(0);

        // While the page loads: a spinner, busy and disabled, through the inherited loadMore.
        pendingLoad = Promise.withResolvers();
        await contains(loadMore).click();
        expect.verifySteps(["loadMore", "crm.lead/web_search_read"]);
        expect(renderer.isLoadingMore(newStage)).toBe(true);
        expect(loadMore).toHaveAttribute("aria-busy", "true");
        expect(loadMore).toHaveAttribute("disabled");
        expect(`${loadMore} .oi-spin[aria-hidden='true']`).toHaveCount(1);
        expect(loadMore).toHaveText("Load more... (2 remaining)");
        // A second activation, by a click or by a direct handler call, loads nothing.
        await contains(loadMore).click();
        await renderer.onLoadMoreClick(newStage);
        await animationFrame();
        expect.verifySteps([]);
        expect(cardNames()).toEqual(["Lead 1"]);

        // Loaded: the next page's button is idle and loads again.
        pendingLoad.resolve();
        pendingLoad = null;
        await animationFrame();
        expect(renderer.isLoadingMore(newStage)).toBe(false);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(loadMore).toHaveText("Load more... (1 remaining)");
        expect(loadMore).toHaveAttribute("aria-busy", "false");
        expect(loadMore).not.toHaveAttribute("disabled");
        expect(`${loadMore} .oi-spin`).toHaveCount(0);
        await contains(loadMore).click();
        await animationFrame();
        expect.verifySteps(["loadMore", "crm.lead/web_search_read"]);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Lead 6"]);
        expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: Load more of a folded stage unfolds it through toggleGroup, busy until loaded; a lost connection or offline loads nothing more", async () => {
        await makeMockServer();
        // Every stage folded: the displayed stage, New, is folded online and its leads not loaded.
        MockServer.env["crm.stage"].write([1, 2, 3, 4], { fold: true });
        mockActivityTypes(ACTIVITY_TYPES);
        const connection = mockConnectionDrop();
        watchRpcs(["crm.lead/web_search_read"]);
        let pendingLoad = null;
        onRpc("crm.lead", "web_search_read", async () => {
            await pendingLoad?.promise;
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            toggleGroup(group) {
                expect.step(`toggleGroup ${group.serverValue}`);
                return super.toggleGroup(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const loadMore = ".o_crm_mobile_pipeline_load_more button";
        let newStage = groupOf(renderer, 1);
        expect(newStage.isFolded).toBe(true);
        expect(".o_crm_mobile_pipeline_stage_name .o_crm_mobile_pipeline_folded").toHaveCount(1);
        expect(cardNames()).toEqual([]);
        expect(loadMore).toHaveText("Load more... (2 remaining)");
        expect(loadMore).toHaveAttribute("aria-busy", "false");

        // The connection drops during the load: no error, the stage stays folded and idle.
        connection.offline = true;
        await contains(loadMore).click();
        await animationFrame();
        expect.verifySteps(["toggleGroup 1", "crm.lead/web_search_read"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(renderer.isLoadingMore(newStage)).toBe(false);
        expect(newStage.isFolded).toBe(true);
        expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
        // Offline, a direct call loads nothing: a folded stage is never loaded offline.
        await renderer.onLoadMoreClick(newStage);
        expect.verifySteps([]);
        expect(newStage.isFolded).toBe(true);

        // Back online (the pipeline reloads): the stage is still folded, its button idle.
        connection.offline = false;
        getService(OfflinePlugin).setOffline(false);
        await runAllTimers();
        await animationFrame();
        newStage = groupOf(renderer, 1);
        expect(newStage.isFolded).toBe(true);
        expect(loadMore).toHaveText("Load more... (2 remaining)");
        expect(loadMore).toHaveAttribute("aria-busy", "false");
        expect(loadMore).not.toHaveAttribute("disabled");

        // While the stage loads: a spinner, busy and disabled; a second activation loads nothing.
        pendingLoad = Promise.withResolvers();
        await contains(loadMore).click();
        expect.verifySteps(["toggleGroup 1", "crm.lead/web_search_read"]);
        expect(loadMore).toHaveAttribute("aria-busy", "true");
        expect(loadMore).toHaveAttribute("disabled");
        expect(`${loadMore} .oi-spin[aria-hidden='true']`).toHaveCount(1);
        await contains(loadMore).click();
        await renderer.onLoadMoreClick(newStage);
        await animationFrame();
        expect.verifySteps([]);

        // Loaded: the stage is unfolded and shows its leads, with nothing left to load.
        pendingLoad.resolve();
        pendingLoad = null;
        await animationFrame();
        expect(renderer.isLoadingMore(newStage)).toBe(false);
        expect(newStage.isFolded).toBe(false);
        expect(".o_crm_mobile_pipeline_stage_name .o_crm_mobile_pipeline_folded").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: while entering a folded stage loads it, its Load more is busy and disabled; Load more, entering it again and New neither load nor toggle it again", async () => {
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["crm.lead/web_search_read"]);
        let pendingLoad = null;
        onRpc("crm.lead", "web_search_read", async () => {
            await pendingLoad?.promise;
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            toggleGroup(group) {
                expect.step(`toggleGroup ${group.serverValue}`);
                return super.toggleGroup(...arguments);
            },
        });
        const controllers = captureInstances(CrmMobilePipelineController);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [controller] = controllers;
        const [renderer] = renderers;
        patchWithCleanup(controller.model.constructor.Group.prototype, {
            toggle() {
                expect.step(`toggle ${this.serverValue}`);
                return super.toggle(...arguments);
            },
        });
        const loadMore = ".o_crm_mobile_pipeline_load_more button";
        const won = groupOf(renderer, 4);
        await goToStage("Proposition");
        expect.verifySteps([]);
        expect(won.isFolded).toBe(true);

        // Next enters the folded Won: one toggle and one load, during which Load more is busy.
        pendingLoad = Promise.withResolvers();
        await contains(".o_crm_mobile_pipeline_next").click();
        await animationFrame();
        expect.verifySteps(["toggleGroup 4", "toggle 4", "crm.lead/web_search_read"]);
        expectHeader("Won", 1, 50);
        expect(won.isFolded).toBe(true);
        expect(cardNames()).toEqual([]);
        expect(renderer.isLoadingMore(won)).toBe(true);
        expect(loadMore).toHaveText("Load more... (1 remaining)");
        expect(loadMore).toHaveAttribute("aria-busy", "true");
        expect(loadMore).toHaveAttribute("disabled");
        expect(`${loadMore} .oi-spin[aria-hidden='true']`).toHaveCount(1);

        // Load more, by a click or a direct call, entering Won again (directly, or by leaving it
        // and coming back) and New all wait for that load: no second toggle, no second load.
        await contains(loadMore).click();
        await renderer.onLoadMoreClick(won);
        const reentry = renderer.goToGroup(won);
        await goToStage("Proposition");
        await goToStage("Won");
        expect(loadMore).toHaveAttribute("aria-busy", "true");
        expect(loadMore).toHaveAttribute("disabled");
        await contains(".o-kanban-button-new").click();
        await animationFrame();
        expect.verifySteps([]);
        expect(controller.quickCreateState.isOpen).toBe(false);

        // Loaded: Won is unfolded, in its config too, with its lead and nothing left to load,
        // and New's quick create opens in it.
        pendingLoad.resolve();
        pendingLoad = null;
        await reentry;
        await animationFrame();
        await animationFrame();
        expect.verifySteps([]);
        expect(won.isFolded).toBe(false);
        expect(won.config.isFolded).toBe(false);
        expect(renderer.isLoadingMore(won)).toBe(false);
        expectHeader("Won", 1, 50);
        expect(".o_crm_mobile_pipeline_stage_name .o_crm_mobile_pipeline_folded").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 5"]);
        expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
        expect(controller.quickCreateState.isOpen).toBe(true);
        expect(controller.quickCreateState.id).toBe(won.id);
        expect(".o_crm_mobile_pipeline_body .o_kanban_quick_create").toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: while New loads a folded displayed stage, its Load more is busy across a reload; Load more and entering the stage neither load nor toggle it again", async () => {
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        mockActivityTypes(ACTIVITY_TYPES);
        const releaseWonLoad = holdStageLoad(4);
        patchWithCleanup(CrmMobilePipeline.prototype, {
            toggleGroup(group) {
                expect.step(`toggleGroup ${group.serverValue}`);
                return super.toggleGroup(...arguments);
            },
        });
        const controllers = captureInstances(CrmMobilePipelineController);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [controller] = controllers;
        const [renderer] = renderers;
        patchWithCleanup(controller.model.constructor.Group.prototype, {
            toggle() {
                expect.step(`toggle ${this.serverValue}`);
                return super.toggle(...arguments);
            },
        });
        const loadMore = ".o_crm_mobile_pipeline_load_more button";
        controller.crmMobileStage.serverValue = 4;
        await animationFrame();
        expectHeader("Won", 1, 50);
        expect(loadMore).toHaveAttribute("aria-busy", "false");
        expect(loadMore).not.toHaveAttribute("disabled");

        // New loads the folded stage: the renderer shows that load on the stage's Load more.
        await contains(".o-kanban-button-new").click();
        await animationFrame();
        expect.verifySteps(["toggle 4", "load 4"]);
        const staleWon = groupOf(renderer, 4);
        expect(staleWon.isFolded).toBe(true);
        expect(renderer.isLoadingMore(staleWon)).toBe(true);
        expect(loadMore).toHaveAttribute("aria-busy", "true");
        expect(loadMore).toHaveAttribute("disabled");
        expect(`${loadMore} .oi-spin[aria-hidden='true']`).toHaveCount(1);

        // A filter reloads the root: the rebuilt group of the stage keeps its config, so it is
        // still shown loading, and neither its Load more nor entering it toggles it again.
        await toggleSearchBarMenu();
        await toggleMenuItem("With Revenue");
        await toggleSearchBarMenu();
        const won = groupOf(renderer, 4);
        expect(won.id).not.toBe(staleWon.id);
        expect(won.config).toBe(staleWon.config);
        expect(won.isFolded).toBe(true);
        expect(renderer.isLoadingMore(won)).toBe(true);
        expect(".o_crm_mobile_pipeline_body").toHaveAttribute("data-id", won.id);
        expect(loadMore).toHaveAttribute("aria-busy", "true");
        expect(loadMore).toHaveAttribute("disabled");
        await contains(loadMore).click();
        await renderer.onLoadMoreClick(won);
        const reentry = renderer.goToGroup(won);
        await animationFrame();
        expect.verifySteps([]);

        // Loaded: the stage is unfolded, in its config too, and is idle; New's quick create opens
        // in its current group.
        releaseWonLoad();
        await reentry;
        await animationFrame();
        await animationFrame();
        expect.verifySteps([]);
        expect(won.isFolded).toBe(false);
        expect(won.config.isFolded).toBe(false);
        expect(renderer.isLoadingMore(won)).toBe(false);
        expect(".o_crm_mobile_pipeline_stage_name .o_crm_mobile_pipeline_folded").toHaveCount(0);
        expect(controller.crmMobileStage.serverValue).toBe(4);
        expect(controller.quickCreateState.isOpen).toBe(true);
        expect(controller.quickCreateState.id).toBe(won.id);
        expect(".o_crm_mobile_pipeline_body .o_kanban_quick_create").toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: activities revalidate on model replacement and revisits", async () => {
        const [activityId] = await createActivities([
            {
                res_id: 1,
                activity_type_id: 1,
                activity_category: "default",
                summary: "First summary",
            },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        watchActivityReads();
        watchTypeReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect.verifySteps(["types", "activities:1", "activities:2"]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_summary`).toHaveText("First summary");

        // A filter that returns the same leads replaces the model data: read again.
        const listBefore = renderer.currentGroup.list;
        await toggleSearchBarMenu();
        await toggleMenuItem("With Revenue");
        await toggleSearchBarMenu();
        expect(renderer.currentGroup.list).not.toBe(listBefore);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect.verifySteps(["types", "activities:1", "activities:2"]);

        // Revisiting a stage reads its leads again; a changed answer replaces the activities.
        MockServer.env["mail.activity"].write([activityId], { summary: "Second summary" });
        await goToStage("Qualified");
        expect.verifySteps(["types", "activities:3"]);
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["types", "activities:1", "activities:2"]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_summary`).toHaveText("Second summary");
        MockServer.env["mail.activity"].unlink([activityId]);
        await goToStage("Qualified");
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["types", "activities:3", "types", "activities:1", "activities:2"]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_row`).toHaveCount(0);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_activities`).toHaveText(
            "No activities"
        );
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_activities li`).toHaveClass([
            "text-700",
            "small",
        ]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).toHaveAttribute(
            "aria-label",
            "Activities (0)"
        );

        // An online activity create reads the lead's activities again (no queue involved); the
        // activity list stays open and shows it.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).click();
        await animationFrame();
        expect(queued()).toHaveLength(0);
        expect.verifySteps(["activities:1"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_row`).toHaveCount(1);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_type`).toHaveText("Call");
    });

    test.tags("mobile");
    test("mobile: a cold offline mount without cached activity types recovers on reconnect", async () => {
        const errors = cachedReadErrors([
            // the pipeline mounted offline from the cache, with its leads' cached activities
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
        ]);
        expect.errors(errors.length);
        const setOffline = mockOffline();
        watchTypeReads();
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        // The pipeline is visited online while its activity-type read is withheld: the framework
        // cache then holds the pipeline and its leads' activities, but no activity type.
        const restoreTypeRead = patchWithCleanup(CrmMobilePipeline.prototype, {
            _loadActivityTypes() {},
        });
        await getService("action").doAction(PIPELINE_ACTION_ID);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        restoreTypeRead();
        expect.verifySteps([]);

        // Offline, the pipeline is mounted anew from the cache.
        await setOffline(true);
        await visitedReady();
        await getService("action").doAction(PIPELINE_ACTION_ID, { clearBreadcrumbs: true });
        await animationFrame();
        expect(renderers).toHaveLength(2);
        const renderer = renderers[1];
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("New", 2, 120);
        expect.verifySteps(["types"]);
        expect(renderer.mobileState.activityTypes).toBe(null);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_follow_up`).toHaveAttribute("disabled");

        // Reconnect: the types are read and both controls are enabled, without a manual reload
        // (once on the reconnection itself, once after the reconciliation reload that follows).
        await setOffline(false);
        await animationFrame();
        await animationFrame();
        expect.verifySteps(["types", "types"]);
        expect(renderer.mobileState.activityTypes.map(({ id }) => id)).toEqual([1, 2]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_follow_up`).not.toHaveAttribute("disabled");
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: the activities kept in memory are the loaded leads' only; a late answer for a lead no longer loaded is dropped", async () => {
        await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "First" },
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Second" },
            { res_id: 3, activity_type_id: 1, activity_category: "default", summary: "Third" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        // Lead 2's activity read is answered only once released.
        let holdLead2 = Promise.withResolvers();
        onRpc("/web/dataset/call_kw/mail.activity/web_search_read", async (request) => {
            const { params } = await request.clone().json();
            const resId = params.kwargs.domain.find(([field]) => field === "res_id")?.[2];
            if (resId === 2 && holdLead2) {
                await holdLead2.promise;
            }
        });
        watchActivityReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const leadsInMemory = () =>
            Object.keys(renderer.mobileState.activitiesByLead)
                .map(Number)
                .sort((a, b) => a - b);
        expect.verifySteps(["activities:1", "activities:2"]);
        expect(leadsInMemory()).toEqual([1]);
        await goToStage("Qualified");
        expect.verifySteps(["activities:3"]);
        expect(leadsInMemory()).toEqual([1, 3]);

        // A filter that loads Lead 1 only: the activities of the other leads are forgotten.
        await toggleSearchBarMenu();
        await toggleMenuItem("Lead One");
        await toggleSearchBarMenu();
        expect(renderer.allLoadedRecords().map((record) => record.resId)).toEqual([1]);
        expect.verifySteps(["activities:1"]);
        expect(leadsInMemory()).toEqual([1]);
        // The answer for Lead 2, read before the filter, arrives late: it is dropped.
        const release = holdLead2;
        holdLead2 = null;
        release.resolve();
        await animationFrame();
        expect(leadsInMemory()).toEqual([1]);

        // Without the filter, every lead is loaded again (Qualified, the stage displayed before
        // the filter, is back); once displayed, Lead 2 gets its activities back.
        await toggleSearchBarMenu();
        await toggleMenuItem("Lead One");
        await toggleSearchBarMenu();
        expect(cardNames()).toEqual(["Lead 3"]);
        expect.verifySteps(["activities:3"]);
        await goToStage("New");
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect.verifySteps(["activities:1", "activities:2"]);
        expect(leadsInMemory()).toEqual([1, 2, 3]);
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 2")} .o_crm_mobile_activity_summary`).toHaveText("Second");
    });

    test.tags("mobile");
    test("mobile: a stage reloaded in place forgets the activities of a lead it no longer holds", async () => {
        await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "First" },
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Second" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        watchActivityReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await animationFrame();
        const [renderer] = renderers;
        const leadsInMemory = () =>
            Object.keys(renderer.mobileState.activitiesByLead)
                .map(Number)
                .sort((a, b) => a - b);
        expect.verifySteps(["activities:1", "activities:2"]);
        expect(leadsInMemory()).toEqual([1, 2]);

        // On the server, Lead 2 leaves New for Proposition. New's records are reloaded in place:
        // the group keeps its list datapoint, whose records no longer include Lead 2, and no other
        // loaded group holds it.
        MockServer.env["crm.lead"].write([2], { stage_id: 3 });
        const newList = groupOf(renderer, 1).list;
        await newList.load();
        await animationFrame();
        expect(groupOf(renderer, 1).list).toBe(newList);
        expect(renderer.allLoadedRecords().map((record) => record.resId)).not.toInclude(2);
        expect(cardNames()).toEqual(["Lead 1"]);
        // The displayed lead is revalidated, and Lead 2's activities are forgotten.
        expect.verifySteps(["activities:1"]);
        expect(leadsInMemory()).toEqual([1]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_summary`).toHaveText("First");
    });
});

// -----------------------------------------------------------------------------
// Sync windows and reconciliation
// -----------------------------------------------------------------------------

/** Opens the offline systray dropdown, unless it is open already. */
async function openOfflineSystray() {
    if (!queryAll(".o-dropdown--menu .o_offline_systray_content").length) {
        await contains(".o_menu_systray .o_offline_systray").click();
    }
}

describe("Sync reconciliation", () => {
    test.tags("desktop");
    test("desktop: an offline move and its replay take no sync-window copy, read no queue and reload nothing", async () => {
        const setOffline = mockOffline();
        // The moved cards were visited online: the framework keeps them usable offline.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline() {
                return true;
            },
        });
        const calls = collectRpcs();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(renderer.isMobilePipeline).toBe(false);
        let queueReads = 0;
        const readQueue = renderer.crmOffline.queuedEntries;
        patchWithCleanup(renderer.crmOffline, {
            queuedEntries() {
                queueReads++;
                return readQueue();
            },
        });

        // Offline: two framework kanban moves queue two stage writes.
        await setOffline(true);
        await contains(".o_kanban_group:eq(0) .o_kanban_record:first").dragAndDrop(
            ".o_kanban_group:eq(1) .o_kanban_record"
        );
        await advanceTime(1000);
        await contains(".o_kanban_group:eq(0) .o_kanban_record:first").dragAndDrop(
            ".o_kanban_group:eq(2) .o_kanban_record"
        );
        await animationFrame();
        expect(queued()).toHaveLength(2);
        calls.splice(0);

        // Reconnect: the framework replays both writes, one second apart. The pipeline takes no
        // copy of the queue, reads none of it and issues no request of its own.
        await setOffline(false);
        await animationFrame();
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(renderer.mobileState.syncEntries).toBe(null);
        await letQueueReplay(1);
        expect(getService(OfflinePlugin).syncingORM()).toBe(false);
        expect(queued()).toHaveLength(0);
        await runAllTimers();
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(calls).toEqual(["crm.lead/web_save", "crm.lead/web_save"]);
        expect(queueReads).toBe(0);
    });

    test.tags("mobile");
    test("mobile: a pipeline mounted while a sync replays holds the remaining writes and reloads when the window ends", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types; Lead 3's were never
            // cached)
            ACTIVITIES,
            TYPES,
            // New displayed again (Lead 2's activities, the types)
            ACTIVITIES,
            TYPES,
            // Lead 2's form, from the cache
            "crm.lead/web_read",
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${args[0].length ? JSON.stringify(args) : args[1].name}`);
        });
        // While `heldReload` is set, the next pipeline read is answered with the data of the
        // moment it arrives, but only once released.
        let heldReload = null;
        onRpc("crm.lead", "web_read_group", async ({ parent }) => {
            expect.step(LEAD_GROUPS);
            const held = heldReload;
            if (held) {
                heldReload = null;
                const result = await parent();
                await held.promise;
                return result;
            }
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        // Lead 2's form is visited online, so it opens offline.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_back_button").click();
        expect.verifySteps([LEAD_GROUPS, LEAD_GROUPS]);

        // Offline: Lead 1 is moved to Qualified, then a lead is created in New.
        await setOffline(true);
        await visitedReady();
        await chooseStage("Lead 1", 2);
        await advanceTime(1000);
        await goToStage("New");
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Offline lead", expected_revenue: "50" });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(queued()).toHaveLength(2);
        const createKey = String(queued().find(({ value }) => !value.args[0].length).key);

        // The connection returns in Lead 2's form: the move is replayed, and the sync waits a
        // second before the create.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_form_view").toHaveCount(1);
        await setOffline(false);
        await expect.waitForSteps(['replayed [[1],{"stage_id":2}]']);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);

        // Back to the pipeline inside the window: it is loaded with the replayed move, and copies
        // the write still to replay.
        await contains(".o_back_button").click();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        const renderer = renderers.at(-1);
        expect(renderer.mobileState.syncEntries.map(({ key }) => String(key))).toEqual([createKey]);
        expectHeader("New", 2, 70);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);

        // The create is replayed and leaves the queue; its pending card and totals stay until
        // the reconciliation reload at the end of the window has landed.
        heldReload = Promise.withResolvers();
        const reload = heldReload;
        await letQueueReplay(1);
        expect.verifySteps(["replayed Offline lead", LEAD_GROUPS]);
        expect(queued()).toHaveLength(0);
        expect(getService(OfflinePlugin).syncingORM()).toBe(false);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expectHeader("New", 2, 70);
        reload.resolve();
        await animationFrame();
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames().sort()).toEqual(["Lead 2", "Offline lead"]);
        expect(cardOf("Offline lead")).toHaveAttribute("data-id");
        expectHeader("New", 2, 70);
        await runAllTimers();
        expect.verifySteps([]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a sync that ends outside the stage pipeline owes its reload until the pipeline is shown again", async () => {
        const errors = cachedReadErrors([
            // the first move displays Qualified (Lead 1's activities, the types; Lead 3's were
            // never cached)
            ACTIVITIES,
            TYPES,
            // the second move displays Proposition (the types; Lead 3's and Lead 4's activities
            // were never cached)
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${JSON.stringify(args)}`);
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        let queueReads = 0;
        const readQueue = renderer.crmOffline.queuedEntries;
        patchWithCleanup(renderer.crmOffline, {
            queuedEntries() {
                queueReads++;
                return readQueue();
            },
        });

        await setOffline(true);
        await chooseStage("Lead 1", 2);
        await advanceTime(1000);
        await chooseStage("Lead 3", 3);
        expect(queued()).toHaveLength(2);

        // Reconnect: the first write is replayed, and the window stays open for the second.
        await setOffline(false);
        await expect.waitForSteps(['replayed [[1],{"stage_id":2}]']);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(renderer.mobileState.syncEntries).toHaveLength(2);

        // Regrouping by salesperson during the window leaves the stage pipeline: the copy is
        // released, and the queue is no longer read.
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        expect(renderer.isMobilePipeline).toBe(false);
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.mobileState.syncEntries).toBe(null);
        queueReads = 0;
        // The window ends outside the stage pipeline: nothing is reloaded there.
        await letQueueReplay(1);
        expect.verifySteps(['replayed [[3],{"stage_id":3}]']);
        expect(getService(OfflinePlugin).syncingORM()).toBe(false);
        await runAllTimers();
        expect.verifySteps([]);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(queueReads).toBe(0);

        // Back to the stage grouping: besides the regrouping read, the owed reconciliation
        // reload runs once.
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        await animationFrame();
        expect(renderer.isMobilePipeline).toBe(true);
        expect.verifySteps([LEAD_GROUPS, LEAD_GROUPS]);
        await runAllTimers();
        expect.verifySteps([]);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expectHeader("Proposition", 2, 70);
        expect(".o_crm_mobile_pending_badge").toHaveCount(0);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a reconciliation reload that lands during the next sync window leaves that window's copy in place", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types; Lead 3's were never
            // cached)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${args[0].length ? JSON.stringify(args) : args[1].name}`);
        });
        // While `heldReload` is set, the next pipeline read is answered with the data of the
        // moment it arrives, but only once released.
        let heldReload = null;
        onRpc("crm.lead", "web_read_group", async ({ parent }) => {
            expect.step(LEAD_GROUPS);
            const held = heldReload;
            if (held) {
                heldReload = null;
                const result = await parent();
                await held.promise;
                return result;
            }
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        const totals = (stageId) => {
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };

        // Window A: Lead 1's offline move to Qualified is replayed; the reconciliation reload
        // that follows (reload A) is held.
        await setOffline(true);
        await chooseStage("Lead 1", 2);
        const reloadA = Promise.withResolvers();
        heldReload = reloadA;
        await setOffline(false);
        await expect.waitForSteps(['replayed [[1],{"stage_id":2}]', LEAD_GROUPS]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(false);

        // Window B: offline again, two leads are created in Qualified (a queued create does not
        // wait for the framework model, which reload A holds). On reconnect, the first create is
        // replayed and the window stays open for the second.
        await setOffline(true);
        const quickCreate = async (name, revenue) => {
            await contains(".o_crm_mobile_pipeline_add").click();
            await fillQuickCreate({ name, expected_revenue: revenue });
            await contains(".o_crm_mobile_quick_create_save").click();
        };
        await quickCreate("First lead", "50");
        await advanceTime(1000);
        await quickCreate("Second lead", "60");
        expect(queued()).toHaveLength(2);
        const windowBKeys = queued().map(({ key }) => String(key));
        expectHeader("Qualified", 4, 240);
        await setOffline(false);
        await expect.waitForSteps(["replayed First lead"]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(queued()).toHaveLength(1);
        const heldKeys = () =>
            (renderer.mobileState.syncEntries ?? []).map(({ key }) => String(key));
        expect(windowBKeys.every((key) => heldKeys().includes(key))).toBe(true);

        // Reload A lands now, with data that predate window B's first replay: window B keeps its
        // copy, so the replayed create keeps its pending card and the totals do not move.
        reloadA.resolve();
        await animationFrame();
        expect(recordOf(renderer, 1).serverStageId).toBe(2);
        expect(renderer.allLoadedRecords().map((record) => record.data.name)).not.toInclude(
            "First lead"
        );
        expect(windowBKeys.every((key) => heldKeys().includes(key))).toBe(true);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(2);
        expectHeader("Qualified", 4, 240);

        // The second create is replayed, then window B's own reconciliation reload ends it.
        await letQueueReplay(1);
        expect.verifySteps(["replayed Second lead", LEAD_GROUPS]);
        await animationFrame();
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames().sort()).toEqual(["First lead", "Lead 1", "Lead 3", "Second lead"]);
        expectHeader("Qualified", 4, 240);
        expect(totals(1)).toEqual([1, 20]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: after an interrupted sync, a systray discard ends the placement and totals of a pending create and of a queued move at once", async () => {
        const errors = cachedReadErrors([
            // Lead 1's move displays Qualified (Lead 1's activities, the types; Lead 3's were
            // never cached)
            ACTIVITIES,
            TYPES,
            // New displayed again (Lead 2's activities, the types)
            ACTIVITIES,
            TYPES,
            // Lead 2's move displays Proposition (Lead 2's activities, the types; Lead 4's were
            // never cached)
            ACTIVITIES,
            TYPES,
            // the offline reload, then the activities revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            TYPES,
            // after the interrupted sync, the discard of Lead 2's move (Lead 4's activities, read
            // online during the sync, and the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const connection = mockConnectionDrop();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${JSON.stringify(args)}`);
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        expect.verifySteps([LEAD_GROUPS]);
        const renderer = renderers.at(-1);
        const totals = (stageId) => {
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };

        // Offline: Lead 1 to Qualified, Lead 2 to Proposition, and a lead created in
        // Proposition. An offline reload then rebuilds the records from the cache, so the queue
        // alone places the moved cards.
        await setOffline(true);
        await chooseStage("Lead 1", 2);
        await advanceTime(1000);
        await goToStage("New");
        await chooseStage("Lead 2", 3);
        await advanceTime(1000);
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Offline lead", expected_revenue: "50" });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(queued()).toHaveLength(3);
        const [moveKey] = queued()
            .filter(({ value }) => value.args[0][0] === 1)
            .map(({ key }) => String(key));
        await renderer.props.list.load();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(recordOf(renderer, 2).serverStageId).toBe(1);
        expectHeader("Proposition", 3, 110);
        expect(totals(1)).toEqual([0, 0]);
        expect(totals(2)).toEqual([2, 130]);

        // Reconnect: Lead 1's move is replayed, then the connection drops before Lead 2's.
        await setOffline(false);
        await expect.waitForSteps(['replayed [[1],{"stage_id":2}]']);
        connection.offline = true;
        await letQueueReplay(1);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(getService(OfflinePlugin).syncingORM()).toBe(false);
        expect(queued()).toHaveLength(2);
        // The copy the window began with is held: the replayed move still places Lead 1.
        expect(renderer.mobileState.syncEntries).toHaveLength(3);
        expectHeader("Proposition", 3, 110);
        expect(totals(2)).toEqual([2, 130]);

        // Offline, the pending create is discarded from the systray: its card, count and
        // revenue end at once.
        await openOfflineSystray();
        expect(".o-dropdown--menu .o-dropdown-item").toHaveCount(2);
        await contains(
            ".o-dropdown--menu .o-dropdown-item:eq(1) button[data-icon='delete']"
        ).click();
        await contains(".modal-dialog .modal-footer button.btn-primary").click();
        expect(queued()).toHaveLength(1);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expectHeader("Proposition", 2, 60);
        // So does the queued move of Lead 2: its card is back in New, with its revenue.
        await openOfflineSystray();
        await contains(
            ".o-dropdown--menu .o-dropdown-item:eq(0) button[data-icon='delete']"
        ).click();
        await contains(".modal-dialog .modal-footer button.btn-primary").click();
        expect(queued()).toHaveLength(0);
        expectHeader("Proposition", 1, 40);
        expect(cardNames()).toEqual(["Lead 4"]);
        expect(totals(1)).toEqual([1, 20]);
        // The replayed move alone stays held until the reconciliation reload.
        expect(renderer.mobileState.syncEntries.map(({ key }) => String(key))).toEqual([moveKey]);
        expect(totals(2)).toEqual([2, 130]);

        // Reconnect with nothing queued: one reconciliation reload ends the window.
        connection.offline = false;
        await setOffline(false);
        await animationFrame();
        await runAllTimers();
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(recordOf(renderer, 1).serverStageId).toBe(2);
        expect(totals(1)).toEqual([1, 20]);
        expect(totals(2)).toEqual([2, 130]);
        expectHeader("Proposition", 1, 40);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a parked write discarded while a sync replays another one stops placing its card at once", async () => {
        const errors = cachedReadErrors([
            // Lead 4's move displays Qualified (Lead 3's and Lead 4's activities, read online on
            // the way to Proposition, and the types)
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // Lead 3's move displays Proposition (Lead 3's activities, the types)
            ACTIVITIES,
            TYPES,
            // back to New through Qualified (Lead 4's activities, the types), then New (Lead 1's
            // and Lead 2's activities, the types)
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // Lead 2's move displays Proposition (Lead 3's and Lead 2's activities, the types)
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // the offline reload, then the activities revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${JSON.stringify(args)}`);
            if (args[0][0] === 4) {
                throw makeServerError({ message: "This stage is locked" });
            }
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        expect.verifySteps([LEAD_GROUPS]);
        const renderer = renderers.at(-1);
        const totals = (stageId) => {
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };

        // Lead 4's offline move to Qualified is rejected on replay and parked; after the
        // reconciliation reload, the parked write alone places the card.
        await goToStage("Proposition");
        await setOffline(true);
        await chooseStage("Lead 4", 2);
        await setOffline(false);
        await expect.waitForSteps(['replayed [[4],{"stage_id":2}]', LEAD_GROUPS]);
        await animationFrame();
        expect(queued()).toHaveLength(1);
        const [parked] = queued();
        expect(parked.value.extras.error).toMatch(/This stage is locked/);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(recordOf(renderer, 4).serverStageId).toBe(3);
        expectHeader("Qualified", 2, 70);

        // Offline, Lead 3 is moved to Proposition, then Lead 2 too; an offline reload rebuilds
        // the records from the cache, so the queue alone places the moved cards.
        await setOffline(true);
        await chooseStage("Lead 3", 3);
        await advanceTime(1000);
        await goToStage("New");
        await chooseStage("Lead 2", 3);
        await renderer.props.list.load();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expectHeader("Proposition", 2, 50);
        expect(totals(2)).toEqual([1, 40]);

        // The parked write's discard is asked for from the systray, offline.
        await openOfflineSystray();
        await contains(
            ".o-dropdown--menu .o-dropdown-item:has([data-icon='error']) button[data-icon='delete']"
        ).click();
        expect(".modal-dialog").toHaveCount(1);

        // Reconnect: Lead 3's move is replayed and held by the window's copy; the sync waits a
        // second before Lead 2's.
        await setOffline(false);
        await expect.waitForSteps(['replayed [[3],{"stage_id":3}]']);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        // The discard is confirmed during the sync: the parked write, never replayed, stops
        // placing Lead 4 at once, while Lead 3's replayed move keeps its placement.
        await contains(".modal-dialog .modal-footer button.btn-primary").click();
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(queued().map(({ key }) => String(key))).not.toInclude(String(parked.key));
        const heldKeys = renderer.mobileState.syncEntries.map(({ key }) => String(key));
        expect(heldKeys).not.toInclude(String(parked.key));
        expect(heldKeys).toHaveLength(2);
        expectHeader("Proposition", 3, 90);
        expect(cardNames().sort()).toEqual(["Lead 2", "Lead 3", "Lead 4"]);
        expect(totals(2)).toEqual([0, 0]);

        // Lead 2's move is replayed, then the reconciliation reload ends the window.
        await letQueueReplay(1);
        expect.verifySteps(['replayed [[2],{"stage_id":3}]', LEAD_GROUPS]);
        await animationFrame();
        expect(queued()).toHaveLength(0);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expectHeader("Proposition", 3, 90);
        expect(totals(2)).toEqual([0, 0]);
        expect(MockServer.env["crm.lead"].browse(4)[0].stage_id).toBe(3);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a pending create discarded before its replay call, in a sync the connection then interrupts, ends its card and totals at once and for good", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const connection = mockConnectionDrop();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${args[1].name}`);
        });
        // Steps every write attempt, the ones the dropped connection answers with a 502 included.
        watchRpcs([LEAD_GROUPS, "crm.lead/web_save"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        const plugin = getService(OfflinePlugin);
        const heldKeys = () =>
            (renderer.mobileState.syncEntries ?? []).map(({ key }) => String(key)).sort();
        const queuedKeys = () =>
            queued()
                .map(({ key }) => String(key))
                .sort();
        const quickCreate = async (name, revenue) => {
            await contains(".o_crm_mobile_pipeline_add").click();
            await fillQuickCreate({ name, expected_revenue: revenue });
            await contains(".o_crm_mobile_quick_create_save").click();
        };

        // Offline: A, B and C are created in New, one second apart (the replay order).
        await setOffline(true);
        await quickCreate("Lead A", "50");
        await advanceTime(1000);
        await quickCreate("Lead B", "60");
        await advanceTime(1000);
        await quickCreate("Lead C", "70");
        const keyOf = (name) =>
            String(queued().find(({ value }) => value.args[1].name === name).key);
        const [keyA, keyB, keyC] = ["Lead A", "Lead B", "Lead C"].map(keyOf);
        expectHeader("New", 5, 300);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(3);

        // Reconnect: A is replayed, then the connection drops at B's call: B and C stay queued,
        // and the copy the window began with keeps placing the replayed A.
        await setOffline(false);
        await expect.waitForSteps(["crm.lead/web_save", "replayed Lead A"]);
        connection.offline = true;
        await letQueueReplay(1);
        expect.verifySteps(["crm.lead/web_save"]);
        expect(plugin.isOffline()).toBe(true);
        expect(plugin.syncingORM()).toBe(false);
        expect(queuedKeys()).toEqual([keyB, keyC].sort());
        expect(heldKeys()).toEqual([keyA, keyB, keyC].sort());
        expectHeader("New", 5, 300);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(3);

        // Reconnect: B is replayed, and the sync waits a second before C's call.
        connection.offline = false;
        await setOffline(false);
        await expect.waitForSteps(["crm.lead/web_save", "replayed Lead B"]);
        await animationFrame();
        expect(plugin.syncingORM()).toBe(true);
        expect(queuedKeys()).toEqual([keyC]);
        expect(heldKeys()).toEqual([keyA, keyB, keyC].sort());
        // During that delay, C's discard (a systray confirmation opened earlier) is confirmed:
        // C's card, count and revenue end at once, while A and B keep their presentation.
        plugin.removeScheduledORM(keyC);
        await animationFrame();
        expect(plugin.syncingORM()).toBe(true);
        expect(queued()).toHaveLength(0);
        expect(heldKeys()).toEqual([keyA, keyB].sort());
        expect(`.o_crm_mobile_lead_card_pending[data-pending-key='${keyC}']`).toHaveCount(0);
        expect(cardNames()).not.toInclude("Lead C");
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(2);
        expectHeader("New", 4, 230);

        // The connection drops before C's call, which the framework still sends (and which
        // fails): the window ends offline, C stays gone, and A and B stay presented until the
        // reconciliation reload.
        connection.offline = true;
        await letQueueReplay(1);
        expect.verifySteps(["crm.lead/web_save"]);
        expect(plugin.isOffline()).toBe(true);
        expect(plugin.syncingORM()).toBe(false);
        expect(heldKeys()).toEqual([keyA, keyB].sort());
        expect(cardNames()).not.toInclude("Lead C");
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(2);
        expectHeader("New", 4, 230);

        // The next reconnection, with nothing queued, reloads once: A and B are server cards,
        // and C, never written, is not there.
        connection.offline = false;
        await setOffline(false);
        await animationFrame();
        await runAllTimers();
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames().sort()).toEqual(["Lead 1", "Lead 2", "Lead A", "Lead B"]);
        expect(cardOf("Lead A")).toHaveAttribute("data-id");
        expect(cardOf("Lead B")).toHaveAttribute("data-id");
        expectHeader("New", 4, 230);
        expect(
            MockServer.env["crm.lead"]
                .search_read([["name", "in", ["Lead A", "Lead B", "Lead C"]]], ["name"])
                .map(({ name }) => name)
                .sort()
        ).toEqual(["Lead A", "Lead B"]);
    });

    test.tags("mobile");
    test("mobile: a pending create discarded while the sync goes on ends its card at once; the framework still replays it, and the reconciliation reload shows the server state", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${args[1].name}`);
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        const plugin = getService(OfflinePlugin);
        const heldKeys = () =>
            (renderer.mobileState.syncEntries ?? []).map(({ key }) => String(key)).sort();
        const quickCreate = async (name, revenue) => {
            await contains(".o_crm_mobile_pipeline_add").click();
            await fillQuickCreate({ name, expected_revenue: revenue });
            await contains(".o_crm_mobile_quick_create_save").click();
        };

        // Offline: X and Y are created in New, one second apart (the replay order).
        await setOffline(true);
        await quickCreate("Lead X", "50");
        await advanceTime(1000);
        await quickCreate("Lead Y", "60");
        const keyOf = (name) =>
            String(queued().find(({ value }) => value.args[1].name === name).key);
        const [keyX, keyY] = ["Lead X", "Lead Y"].map(keyOf);
        expectHeader("New", 4, 230);

        // Reconnect: X is replayed and keeps its presentation; the sync waits a second before
        // Y's call.
        await setOffline(false);
        await expect.waitForSteps(["replayed Lead X"]);
        await animationFrame();
        expect(plugin.syncingORM()).toBe(true);
        expect(queued().map(({ key }) => String(key))).toEqual([keyY]);
        expect(heldKeys()).toEqual([keyX, keyY].sort());
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(2);
        expectHeader("New", 4, 230);

        // Y, never replayed, is discarded while the sync goes on: its card, count and revenue
        // end at once, while the replayed X keeps its presentation.
        plugin.removeScheduledORM(keyY);
        await animationFrame();
        expect(plugin.syncingORM()).toBe(true);
        expect(heldKeys()).toEqual([keyX]);
        expect(`.o_crm_mobile_lead_card_pending[data-pending-key='${keyY}']`).toHaveCount(0);
        expect(cardNames()).not.toInclude("Lead Y");
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expectHeader("New", 3, 170);

        // The framework still sends the call it listed when the window began, so Y reaches the
        // server: the reconciliation reload that ends the window shows the server state, X and
        // Y as server cards.
        await letQueueReplay(1);
        expect.verifySteps(["replayed Lead Y", LEAD_GROUPS]);
        await animationFrame();
        expect(plugin.syncingORM()).toBe(false);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames().sort()).toEqual(["Lead 1", "Lead 2", "Lead X", "Lead Y"]);
        expect(cardOf("Lead Y")).toHaveAttribute("data-id");
        expectHeader("New", 4, 230);
        await runAllTimers();
        expect.verifySteps([]);
    });
});

// -----------------------------------------------------------------------------
// Bounded activity pages
// -----------------------------------------------------------------------------

/**
 * Creates `count` activities on a lead, all due the same day, so their per-lead order is their id.
 *
 * @param {number} resId
 * @param {number} count
 * @returns {Promise<number[]>} the activity ids
 */
function createLeadActivities(resId, count) {
    return createActivities(
        Array.from({ length: count }, (_, index) => ({
            res_id: resId,
            activity_type_id: 1,
            activity_category: "default",
            summary: `Task ${index + 1}`,
        }))
    );
}

/**
 * @param {string} name the lead name
 * @returns {string} selector of the activity count of that lead's card
 */
function activityBadgeOf(name) {
    return `${cardOf(name)} .o_crm_mobile_card_activities .badge`;
}

describe("Mobile activity pages", () => {
    test.tags("mobile");
    test("mobile: activity reads: 40 activities per lead in a fixed order; activity types with no order and no limit", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const typeReads = [];
        onRpc("/web/dataset/call_kw/mail.activity.type/web_search_read", async (request) => {
            const { params } = await request.clone().json();
            typeReads.push(params.kwargs);
        });
        const requests = watchActivityReads();
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        for (const resId of [1, 2]) {
            expect(requests.get(resId)).toHaveLength(1);
            const { kwargs } = JSON.parse(requests.get(resId)[0]);
            expect(kwargs.domain).toEqual([
                ["res_model", "=", "crm.lead"],
                ["res_id", "=", resId],
            ]);
            expect(kwargs.order).toBe("date_deadline ASC, id ASC");
            expect(kwargs.limit).toBe(40);
        }
        expect(typeReads).toHaveLength(1);
        expect(typeReads[0].domain).toEqual([["res_model", "in", [false, "crm.lead"]]]);
        expect(typeReads[0].specification).toEqual({ display_name: {}, category: {} });
        // Only the domain and the specification (plus the ORM's context): no order, no limit.
        expect(Object.keys(typeReads[0]).sort()).toEqual(["context", "domain", "specification"]);
    });

    test.tags("mobile");
    test("mobile: a lead with more activities than the page shows its total and Show all online, kept on revisits", async () => {
        await createLeadActivities(1, 45);
        mockActivityTypes(ACTIVITY_TYPES);
        const requests = watchActivityReads();
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        const card = cardOf("Lead 1");
        expect(activityBadgeOf("Lead 1")).toHaveText("45");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect(`${card} .o_crm_mobile_activities_more`).toHaveCount(1);
        const showAll = `${card} .o_crm_mobile_activities_show_all`;
        expect(showAll).toHaveText("Show all (45)");
        expect(showAll).toHaveAttribute("data-available-offline", "1");
        expect(showAll).toHaveAttribute("aria-label", "Show all (45)");
        expect(showAll).toHaveAttribute("title", "Show all (45)");
        expectTouchTarget(queryOne(showAll), "show all");
        // The theme corner of every card button, not the small-button one.
        expect(getComputedStyle(queryOne(showAll)).borderTopLeftRadius).toBe(
            getComputedStyle(queryOne(`${card} .o_crm_mobile_card_activities`)).borderTopLeftRadius
        );

        // Show all reads the whole list once, with the known total as its limit.
        await contains(showAll).click();
        await animationFrame();
        expect.verifySteps(["activities:1"]);
        expect(JSON.parse(requests.get(1).at(-1)).kwargs.limit).toBe(45);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(`${card} .o_crm_mobile_activities_more`).toHaveCount(0);
        expect(activityBadgeOf("Lead 1")).toHaveText("45");

        // A later revisit reissues the expanded request; the other leads keep the bounded one.
        await goToStage("Qualified");
        expect.verifySteps(["activities:3"]);
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:1", "activities:2"]);
        expect(JSON.parse(requests.get(1).at(-1)).kwargs.limit).toBe(45);
        expect(JSON.parse(requests.get(2).at(-1)).kwargs.limit).toBe(40);
        expect(new Set(requests.get(1)).size).toBe(2);
        expect(new Set(requests.get(2)).size).toBe(1);
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(`${card} .o_crm_mobile_activities_show_all`).toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: offline, a lead whose bounded page is cached says how many more activities are not available offline", async () => {
        const errors = cachedReadErrors([
            // offline, Qualified then New are displayed again: every lead's bounded page and the
            // types were read online, so each read is answered by the cache
            TYPES,
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            ACTIVITIES,
        ]);
        expect.errors(errors.length);
        await createLeadActivities(1, 45);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchActivityReads();
        const renderers = captureInstances(CrmMobilePipeline);
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect.verifySteps(["activities:1", "activities:2"]);
        await goToStage("Qualified");
        await goToStage("New");
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);

        // Offline, the revisits are answered by the cached bounded pages.
        await setOffline(true);
        await goToStage("Qualified");
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        const card = cardOf("Lead 1");
        expect(activityBadgeOf("Lead 1")).toHaveText("45");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect(`${card} .o_crm_mobile_activities_more`).toHaveText(
            "5 more activities are not available offline"
        );
        expect(`${card} .o_crm_mobile_activities_more span`).toHaveClass(["text-700", "small"]);
        expect(`${card} .o_crm_mobile_activities_show_all`).toHaveCount(0);

        // Direct calls read nothing offline: the expanded request was never cached.
        const leadCard = cards.filter((instance) => instance.props.record?.resId === 1).at(-1);
        await leadCard.onShowAllActivities();
        await renderer.onShowAllActivities(1);
        await animationFrame();
        expect.verifySteps([]);
        expect(Object.keys(renderer.mobileState.activityLimitsByLead)).toEqual([]);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a lead with no more activities than the page shows them all and no extra line", async () => {
        await createLeadActivities(1, 40);
        await createLeadActivities(2, 3);
        mockActivityTypes(ACTIVITY_TYPES);
        const requests = watchActivityReads();
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        expect(JSON.parse(requests.get(1)[0]).kwargs.limit).toBe(40);
        for (const [name, count] of [
            ["Lead 1", 40],
            ["Lead 2", 3],
        ]) {
            const card = cardOf(name);
            expect(activityBadgeOf(name)).toHaveText(String(count));
            await contains(`${card} .o_crm_mobile_card_activities`).click();
            expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(count);
            expect(`${card} .o_crm_mobile_activities_more`).toHaveCount(0);
        }
    });

    test.tags("mobile");
    test("mobile: a first Show all whose read loses the connection keeps the page, and the lead goes back to its default request", async () => {
        await createLeadActivities(1, 45);
        mockActivityTypes(ACTIVITY_TYPES);
        // Every read limited to 45 activities (Lead 1's Show all) loses the connection. Route
        // listeners run last-registered first: the drop is registered before the watcher, which
        // still steps it.
        onRpc("/web/dataset/call_kw/mail.activity/web_search_read", async (request) => {
            const { params } = await request.clone().json();
            if (params.kwargs.limit === 45) {
                return new Response("", { status: 502 });
            }
        });
        const requests = watchActivityReads();
        const limitsOf = (resId) =>
            requests.get(resId).map((json) => JSON.parse(json).kwargs.limit);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["activities:1", "activities:2"]);
        const card = cardOf("Lead 1");
        const showAll = `${card} .o_crm_mobile_activities_show_all`;
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect(showAll).toHaveText("Show all (45)");

        // The expanded read loses the connection, and nothing is cached for it: the page and the
        // total stay as they were.
        await contains(showAll).click();
        await animationFrame();
        expect.verifySteps(["activities:1"]);
        expect(limitsOf(1)).toEqual([40, 45]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect(activityBadgeOf("Lead 1")).toHaveText("45");
        expect(`${card} .o_crm_mobile_activities_more`).toHaveText(
            "5 more activities are not available offline"
        );

        // The connection returns: the reads it triggers (the reconnection itself, then the
        // reconciliation reload) use the lead's default request, not the expansion that never
        // landed.
        await getService(OfflinePlugin).checkConnection();
        await animationFrame();
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect.verifySteps(["activities:1", "activities:2", "activities:1", "activities:2"]);
        expect(limitsOf(1)).toEqual([40, 45, 40, 40]);

        // So does a revisit, and Show all is offered again with the same page and total.
        await goToStage("Qualified");
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        expect(limitsOf(1)).toEqual([40, 45, 40, 40, 40]);
        expect(activityBadgeOf("Lead 1")).toHaveText("45");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect(showAll).toHaveText("Show all (45)");
    });

    test.tags("mobile");
    test("mobile: a later Show all whose read loses the connection keeps the page, and the lead goes back to its previous expansion", async () => {
        await createLeadActivities(1, 45);
        mockActivityTypes(ACTIVITY_TYPES);
        // Every read limited to 50 activities (Lead 1's second Show all) loses the connection (the
        // watcher, registered after, still steps it).
        onRpc("/web/dataset/call_kw/mail.activity/web_search_read", async (request) => {
            const { params } = await request.clone().json();
            if (params.kwargs.limit === 50) {
                return new Response("", { status: 502 });
            }
        });
        const requests = watchActivityReads();
        const limitsOf = (resId) =>
            requests.get(resId).map((json) => JSON.parse(json).kwargs.limit);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["activities:1", "activities:2"]);
        const card = cardOf("Lead 1");
        const showAll = `${card} .o_crm_mobile_activities_show_all`;

        // A first expansion succeeds: all 45 activities.
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        await contains(showAll).click();
        await animationFrame();
        expect.verifySteps(["activities:1"]);
        expect(limitsOf(1)).toEqual([40, 45]);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(showAll).toHaveCount(0);

        // The lead reaches 50 activities: a revisit reissues the expansion, which now misses 5.
        await createLeadActivities(1, 5);
        await goToStage("Qualified");
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        expect(limitsOf(1)).toEqual([40, 45, 45]);
        expect(activityBadgeOf("Lead 1")).toHaveText("50");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(showAll).toHaveText("Show all (50)");

        // The second expansion loses the connection, and nothing is cached for it: the page and
        // the total stay as they were.
        await contains(showAll).click();
        await animationFrame();
        expect.verifySteps(["activities:1"]);
        expect(limitsOf(1)).toEqual([40, 45, 45, 50]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(activityBadgeOf("Lead 1")).toHaveText("50");
        expect(`${card} .o_crm_mobile_activities_more`).toHaveText(
            "5 more activities are not available offline"
        );

        // The connection returns: the reads it triggers reissue the previous expansion (45), not
        // the default request nor the expansion that never landed.
        await getService(OfflinePlugin).checkConnection();
        await animationFrame();
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(false);
        expect.verifySteps(["activities:1", "activities:2", "activities:1", "activities:2"]);
        expect(limitsOf(1)).toEqual([40, 45, 45, 50, 45, 45]);

        // So does a revisit, and Show all is offered again with the same page and total.
        await goToStage("Qualified");
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        expect(limitsOf(1)).toEqual([40, 45, 45, 50, 45, 45, 45]);
        expect(activityBadgeOf("Lead 1")).toHaveText("50");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(showAll).toHaveText("Show all (50)");
    });

    test.tags("mobile");
    test("mobile: a bounded read answered after Show all never replaces the expanded page", async () => {
        await createLeadActivities(1, 45);
        mockActivityTypes(ACTIVITY_TYPES);
        // Lead 1's bounded reads (limit 40) are held while `hold.armed`: the watcher, registered
        // after, still steps them when they are issued.
        const hold = { armed: false, reads: [] };
        onRpc("/web/dataset/call_kw/mail.activity/web_search_read", async (request) => {
            const { params } = await request.clone().json();
            const resId = params.kwargs.domain.find(([field]) => field === "res_id")?.[2];
            if (hold.armed && resId === 1 && params.kwargs.limit === 40) {
                const deferred = Promise.withResolvers();
                hold.reads.push(deferred);
                await deferred.promise;
            }
        });
        const requests = watchActivityReads();
        const limitsOf = (resId) =>
            requests.get(resId).map((json) => JSON.parse(json).kwargs.limit);
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        const card = cardOf("Lead 1");
        const showAll = `${card} .o_crm_mobile_activities_show_all`;

        // A revisit issues Lead 1's bounded read again and its answer is held; the cached page
        // answers meanwhile.
        await goToStage("Qualified");
        hold.armed = true;
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        expect(hold.reads).toHaveLength(1);
        expect(limitsOf(1)).toEqual([40, 40]);
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect(showAll).toHaveText("Show all (45)");

        // Show all reads every activity while the bounded read is still in flight.
        await contains(showAll).click();
        await animationFrame();
        expect.verifySteps(["activities:1"]);
        expect(limitsOf(1)).toEqual([40, 40, 45]);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(`${card} .o_crm_mobile_activities_more`).toHaveCount(0);
        expect(activityBadgeOf("Lead 1")).toHaveText("45");

        // The lead gains 3 activities, then the held bounded answer lands. It differs from the
        // cached page, so the cache delivers it through its callback: it is dropped, and neither
        // the expanded rows nor the total are replaced by the bounded page.
        await createLeadActivities(1, 3);
        hold.reads[0].resolve();
        await animationFrame();
        await animationFrame();
        expect.verifySteps([]);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(`${card} .o_crm_mobile_activities_more`).toHaveCount(0);
        expect(activityBadgeOf("Lead 1")).toHaveText("45");

        // The lead's current request, the expanded one, brings the new total on the next revisit.
        hold.armed = false;
        await goToStage("Qualified");
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        expect(limitsOf(1)).toEqual([40, 40, 45, 45]);
        expect(activityBadgeOf("Lead 1")).toHaveText("48");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(45);
        expect(showAll).toHaveText("Show all (48)");
    });
});

// -----------------------------------------------------------------------------
// Mobile pipeline branches
// -----------------------------------------------------------------------------

/**
 * Holds the requests of a route while `holder.active` is set, until `holder.release()`. A held
 * request steps `"held <label>"`; once released, it goes on to the next handler (the mock server
 * by default). Handlers registered later run first: registered before `mockOffline()`, the holder
 * only sees the requests sent while the offline mock lets them through, and a released request is
 * answered by the server whatever the connection state meanwhile; registered after it, the holder
 * holds a request before the offline mock answers it.
 *
 * @param {string} route the request path
 * @param {string} label
 * @returns {{ active: boolean, release: () => void }}
 */
function holdRequests(route, label) {
    const pending = [];
    const holder = {
        active: false,
        release() {
            for (const { resolve } of pending.splice(0)) {
                resolve();
            }
        },
    };
    onRpc(route, async () => {
        if (holder.active) {
            const deferred = Promise.withResolvers();
            pending.push(deferred);
            expect.step(`held ${label}`);
            await deferred.promise;
        }
    });
    return holder;
}

/**
 * Queues a `crm.lead` save in the framework offline queue with the extras of a form save made
 * offline in the pipeline action, as another view of the action would queue it.
 *
 * @param {number[]} resIds `[]` for a create
 * @param {Object} values
 * @returns {string | number} the queue key
 */
function queueLeadSave(resIds, values) {
    return getService(OfflinePlugin).scheduleORM(
        "crm.lead",
        "web_save",
        [resIds, values],
        { context: {}, specification: {} },
        {
            extras: {
                actionId: PIPELINE_ACTION_ID,
                actionName: "Pipeline",
                viewType: "form",
                timeStamp: Date.now(),
                displayName: values.name ?? `Lead ${resIds[0]}`,
                changes: values,
            },
        }
    );
}

/**
 * Dispatches a touch event on the stage body, as a finger on a phone does.
 *
 * @param {"touchstart" | "touchmove" | "touchend"} type
 * @param {number[][]} touches `[clientX, clientY]` of the touches still on the screen
 * @param {number[][]} [changedTouches] those of the touches that changed (default: `touches`)
 */
async function touchStageBody(type, touches, changedTouches = touches) {
    const target = queryOne(".o_crm_mobile_pipeline_body");
    const toTouches = (points) =>
        points.map(
            ([clientX, clientY], identifier) => new Touch({ identifier, target, clientX, clientY })
        );
    target.dispatchEvent(
        new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: toTouches(touches),
            targetTouches: toTouches(touches),
            changedTouches: toTouches(changedTouches),
        })
    );
    await animationFrame();
}

/**
 * Creates a lead through the mobile quick create of the displayed stage.
 *
 * @param {string} name
 * @param {string} revenue
 */
async function quickCreateLead(name, revenue) {
    await contains(".o_crm_mobile_pipeline_add").click();
    await fillQuickCreate({ name, expected_revenue: revenue });
    await contains(".o_crm_mobile_quick_create_save").click();
    await advanceTime(1000);
}

/** @returns {string[]} the names on the pending-create cards of the displayed stage */
function pendingCardNames() {
    return queryAllTexts(
        ".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card_pending .o_crm_mobile_lead_card_name"
    );
}

/** Toggles the grouping by salesperson through the search panel. */
async function toggleSalespersonGrouping() {
    await toggleSearchBarMenu();
    await toggleMenuItem("Salesperson");
    await toggleSearchBarMenu();
}

describe("Mobile pipeline branches", () => {
    test.tags("mobile");
    test("mobile: activity and type answers arriving after a regrouping or after the pipeline is destroyed are dropped", async () => {
        const [activityId] = await createActivities([
            {
                res_id: 1,
                activity_type_id: 1,
                activity_category: "default",
                summary: "First summary",
            },
        ]);
        const activityTypes = mockActivityTypes(ACTIVITY_TYPES);
        // Registered after the type answer: they run first and hold the reads.
        const activityReads = holdRequests(
            "/web/dataset/call_kw/mail.activity/web_search_read",
            "activities"
        );
        const typeReads = holdRequests(
            "/web/dataset/call_kw/mail.activity.type/web_search_read",
            "types"
        );
        activityReads.active = true;
        typeReads.active = true;
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await animationFrame();
        expect.verifySteps(["held activities", "held activities", "held types"]);
        const [renderer] = renderers;
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");

        // The view is regrouped by salesperson before the answers arrive: they are dropped.
        await toggleSalespersonGrouping();
        expect(renderer.isMobilePipeline).toBe(false);
        activityReads.release();
        typeReads.release();
        await animationFrame();
        await animationFrame();
        expect(renderer.mobileState.activitiesByLead).toEqual({});
        expect(renderer.mobileState.activityTypes).toBe(null);

        // Grouped by stage again: the answers, cached since, are applied at once (the refreshing
        // reads are held again).
        await toggleSalespersonGrouping();
        await animationFrame();
        expect.verifySteps(["held activities", "held activities", "held types"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_activities .badge`).toHaveText("1");
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");

        // The server answers change, then the lead's form is opened, which destroys the pipeline,
        // before the refreshed answers arrive: they are dropped as well.
        MockServer.env["mail.activity"].write([activityId], { summary: "Second summary" });
        activityTypes.records = ACTIVITY_TYPES.filter(({ category }) => category !== "phonecall");
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        await animationFrame();
        expect(".o_form_view").toHaveCount(1);
        activityReads.active = false;
        typeReads.active = false;
        activityReads.release();
        typeReads.release();
        await animationFrame();
        await animationFrame();
        expect(renderer.mobileState.activitiesByLead[1].map(({ summary }) => summary)).toEqual([
            "First summary",
        ]);
        expect(renderer.mobileState.activityTypes.map(({ id }) => id)).toEqual([1, 2]);

        // Back to the pipeline: the new one shows the server answers.
        await contains(".o_back_button").click();
        await animationFrame();
        expect(renderers).toHaveLength(2);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_summary`).toHaveText("Second summary");
    });

    test.tags("mobile");
    test("mobile: a reconciliation reload that loses the connection keeps the sync snapshot, and the next sync window starts from it", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
            // the offline reload, then the activities revalidated after it (Lead 3's activities
            // were never read online, so they are not cached and raise nothing)
            LEAD_GROUPS,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        // Registered before the offline mock, so they only see the requests it lets through: the
        // connection is lost right after a replay, for every request until it is restored.
        const connection = { lostAfterReplay: false, lost: false };
        onRpc("/web/dataset/call_kw/crm.lead/web_save", () => {
            if (connection.lostAfterReplay) {
                connection.lostAfterReplay = false;
                connection.lost = true;
            }
        });
        onRpc("/*", () => {
            if (connection.lost) {
                return new Response("", { status: 502 });
            }
        });
        const replays = holdRequests("/web/dataset/call_kw/crm.lead/web_save", "replay");
        const setOffline = mockOffline();
        watchRpcs([LEAD_GROUPS, "crm.lead/web_save"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        const totals = (stageId) => {
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };
        const expectPlacedInQualified = () => {
            expectHeader("Qualified", 2, 130);
            expect(cardNames().sort()).toEqual(["Lead 1", "Lead 3"]);
            expect(totals(1)).toEqual([1, 20]);
        };

        // Offline, Lead 1 moves to Qualified, then the pipeline is reloaded from the cache: the
        // rebuilt record is in New again, and the queued write places it.
        await setOffline(true);
        await chooseStage("Lead 1", 2);
        await renderer.props.list.load();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save", LEAD_GROUPS]);
        expect(recordOf(renderer, 1).group.serverValue).toBe(1);
        expectPlacedInQualified();

        // Reconnect: the write is replayed, then the connection is lost again, so the
        // reconciliation reload fails. The snapshot is kept: the replayed write still places the
        // card and corrects the totals, although it left the queue.
        connection.lostAfterReplay = true;
        await setOffline(false);
        await expect.waitForSteps(["crm.lead/web_save", LEAD_GROUPS]);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queued()).toHaveLength(0);
        expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(2);
        expect(recordOf(renderer, 1).group.serverValue).toBe(1);
        expectPlacedInQualified();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(0);

        // Still offline, another lead is edited.
        await setOffline(true);
        queueLeadSave([4], { priority: "1" });

        // The connection is back: the next sync window starts from the kept snapshot, so Lead 1
        // keeps its placement while the new write is replayed.
        connection.lost = false;
        replays.active = true;
        await setOffline(false);
        await expect.waitForSteps(["crm.lead/web_save", "held replay"]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expectPlacedInQualified();

        // Once it is replayed, the reconciliation reload lands: the server data place the card.
        replays.active = false;
        replays.release();
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(queued()).toHaveLength(0);
        expect(MockServer.env["crm.lead"].browse(4)[0].priority).toBe("1");
        const lead1 = recordOf(renderer, 1);
        expect(lead1.group.serverValue).toBe(2);
        expect(lead1.serverStageId).toBe(2);
        expect(renderer.isDisplaced(lead1)).toBe(false);
        expectPlacedInQualified();
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a reconciliation reload failing for another reason than the connection propagates its error", async () => {
        const errors = [
            ...cachedReadErrors([
                // the move displays Qualified (Lead 1's activities, the types)
                ACTIVITIES,
                TYPES,
            ]),
            /The pipeline cannot be reloaded/,
        ];
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        // Registered before the offline mock: it only sees the requests sent online.
        const reload = { rejectNext: false };
        onRpc("crm.lead", "web_read_group", () => {
            if (reload.rejectNext) {
                reload.rejectNext = false;
                throw makeServerError({ message: "The pipeline cannot be reloaded" });
            }
        });
        const setOffline = mockOffline();
        watchRpcs([LEAD_GROUPS, "crm.lead/web_save"]);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);

        await setOffline(true);
        await chooseStage("Lead 1", 2);
        expect.verifySteps(["crm.lead/web_save"]);
        expectHeader("Qualified", 2, 130);

        // Reconnect: the write is replayed, then the reconciliation reload is refused: the
        // failure is not a connection loss, so it is not swallowed.
        reload.rejectNext = true;
        await setOffline(false);
        await expect.waitForSteps(["crm.lead/web_save", LEAD_GROUPS]);
        await animationFrame();
        expect(queued()).toHaveLength(0);
        expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(2);
        expectHeader("Qualified", 2, 130);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: outside the stage grouping, the reconciliation takes no sync snapshot and reloads only once the stage pipeline is shown again", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs([LEAD_GROUPS, "crm.lead/web_save"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        await toggleSalespersonGrouping();
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        expect(renderer.isMobilePipeline).toBe(false);

        // Offline, a lead create of New enters the shared queue (from another view of the action:
        // the standard grouped kanban shows no mobile quick create).
        await setOffline(true);
        queueLeadSave([], { name: "Queued lead", stage_id: 1, expected_revenue: 25 });

        // Reconnect: it is replayed, and the closed gate ends the sync window without a reload.
        await setOffline(false);
        await letQueueReplay(1);
        expect.verifySteps(["crm.lead/web_save"]);
        expect(queued()).toHaveLength(0);
        expect(renderer.isMobilePipeline).toBe(false);
        expect(renderer.mobileState.syncEntries).toBe(null);

        // Grouped by stage again: besides the regrouping read, the reconciliation reload the
        // window owed runs once. The created lead is a server card, and no pending card of the
        // ended window is left.
        await toggleSalespersonGrouping();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS, LEAD_GROUPS]);
        await runAllTimers();
        expect.verifySteps([]);
        expectHeader("New", 3, 145);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Queued lead"]);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a reconciliation reload landing after the pipeline is destroyed leaves its sync snapshot alone", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        // Registered before the offline mock: it only holds the reload sent online.
        const reloads = holdRequests("/web/dataset/call_kw/crm.lead/web_read_group", "reload");
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;

        await setOffline(true);
        await chooseStage("Lead 1", 2);
        reloads.active = true;
        await setOffline(false);
        await expect.waitForSteps(["held reload"]);
        expect(queued()).toHaveLength(0);
        expect(renderer.mobileState.syncEntries).toHaveLength(1);
        expect.verifyErrors(errors);

        // The application is torn down while the reload is in flight, then the reload lands.
        destroyApp();
        reloads.release();
        await animationFrame();
        await animationFrame();
        expect(renderer.mobileState.syncEntries).toHaveLength(1);
    });

    test.tags("mobile");
    test("mobile: with sample data, no activity is read, and reconnecting reloads once and leaves sample mode", async () => {
        await makeMockServer();
        MockServer.env["crm.lead"].unlink(MockServer.env["crm.lead"].search([]));
        // The server expands the stage grouping to every stage, empty ones included (the CRM
        // stage group expansion), which the mock server does not do by itself: an empty group
        // answers 0 for counts and sums, and an empty list for array aggregates.
        onRpc("crm.lead", "web_read_group", ({ kwargs }) => {
            const stageSpec = kwargs.groupby_read_specification?.stage_id;
            const stages = MockServer.env["crm.stage"].search_read([], ["name"]);
            return {
                groups: stages.map(({ id, name }) => ({
                    ...Object.fromEntries(
                        kwargs.aggregates.map((aggregate) => [
                            aggregate,
                            aggregate.includes(":array_agg") ? [] : 0,
                        ])
                    ),
                    stage_id: [id, name],
                    __count: 0,
                    __extra_domain: [["stage_id", "=", id]],
                    __records: [],
                    ...(stageSpec && {
                        __values: MockServer.env["crm.stage"].web_read([id], stageSpec)[0],
                    }),
                })),
                length: stages.length,
            };
        });
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchActivityReads();
        watchTypeReads();
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" sample="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        // No lead matches: the pipeline shows sample leads in sample stages.
        expect(renderer.props.list.model.useSampleModel).toBe(true);
        expect(renderer.isMobilePipeline).toBe(true);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        const sampleRecords = renderer.cardsFor(renderer.currentGroup);
        expect(sampleRecords.length).toBeGreaterThan(0);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(
            sampleRecords.length
        );
        // Their ids are fake: neither the activities nor the types are read, even after a card
        // reports an activity change.
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.onActivitiesChanged(sampleRecords[0].resId)).toBe(undefined);
        await animationFrame();
        expect.verifySteps([]);

        // Going offline reads nothing. Reconnecting reloads the pipeline once, through the
        // framework model: the server still holds no lead, so sample mode ends on the empty
        // stages and the framework no-content helper. The reloaded stage then revalidates the
        // activity types (it shows no lead to read activities for).
        await setOffline(true);
        await animationFrame();
        expect.verifySteps([]);
        await setOffline(false);
        await runAllTimers();
        expect.verifySteps([LEAD_GROUPS, "types"]);
        expect(renderer.props.list.model.useSampleModel).toBe(false);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(renderer.isMobilePipeline).toBe(true);
        expect(".o_view_sample_data").toHaveCount(0);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
        expect(".o_crm_mobile_pipeline_count").toHaveText("0");
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline .o_view_nocontent").toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: with sample data, a lead create queued outside the pipeline shows as a server card after replay", async () => {
        await makeMockServer();
        MockServer.env["crm.lead"].unlink(MockServer.env["crm.lead"].search([]));
        // No lead: the stages are still listed, empty, as the stage group expansion lists them,
        // each aggregate with the server's empty value (`_read_group_empty_value`). Once a lead
        // exists, the server answers as it is.
        onRpc("crm.lead", "web_read_group", async ({ kwargs, parent }) => {
            const result = await parent();
            if (result.groups.length) {
                return result;
            }
            const emptyValue = (spec) => {
                if (/:array_agg(_distinct)?$/.test(spec)) {
                    return [];
                }
                return /:count(_distinct)?$/.test(spec) ? 0 : false;
            };
            const groups = MockServer.env["crm.stage"]
                .search_read([], ["display_name"])
                .map((stage) => ({
                    ...Object.fromEntries(
                        kwargs.aggregates.map((spec) => [spec, emptyValue(spec)])
                    ),
                    stage_id: [stage.id, stage.display_name],
                    __count: 0,
                    __extra_domain: [["stage_id", "=", stage.id]],
                    __records: [],
                }));
            return { groups, length: groups.length };
        });
        mockActivityTypes(ACTIVITY_TYPES);
        // Registered before the offline mock: it only holds the reload sent online.
        const reloads = holdRequests("/web/dataset/call_kw/crm.lead/web_read_group", "reload");
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_save", LEAD_GROUPS, ACTIVITIES, TYPES]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" sample="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(renderer.props.list.model.useSampleModel).toBe(true);
        expect(".o_view_sample_data .o_crm_mobile_pipeline").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
        const sampleCount = renderer.cardsFor(renderer.currentGroup).length;
        expect(sampleCount).toBeGreaterThan(0);
        expect.verifySteps([LEAD_GROUPS]);

        // Offline, a lead create of New enters the shared queue from the lead form of the action
        // (its offline save): the pending card shows among the sample cards, and is counted.
        await setOffline(true);
        const key = queueLeadSave([], { name: "Offline lead", stage_id: 1, expected_revenue: 25 });
        await animationFrame();
        const pending = `.o_crm_mobile_pipeline_body .o_crm_mobile_lead_card[data-pending-key='${key}']`;
        expect(pending).toHaveCount(1);
        expect(`${pending} .o_crm_mobile_lead_card_name`).toHaveText("Offline lead");
        expect(".o_crm_mobile_pipeline_count").toHaveText(String(sampleCount + 1));
        expect.verifySteps([]);

        // Reconnect: the create is replayed, then the pipeline reloads by itself through the
        // framework model. Until that reload lands, the sync window's copy keeps the pending card
        // and its count among the sample cards.
        reloads.active = true;
        await setOffline(false);
        await letQueueReplay(1);
        expect.verifySteps(["crm.lead/web_save", LEAD_GROUPS, "held reload"]);
        expect(queued()).toHaveLength(0);
        expect(renderer.mobileState.syncEntries).toHaveLength(1);
        expect(renderer.props.list.model.useSampleModel).toBe(true);
        expect(pending).toHaveCount(1);
        expect(".o_crm_mobile_pipeline_count").toHaveText(String(sampleCount + 1));

        // The reload lands: sample mode ends and the window closes. The created lead is a server
        // card, the only one and counted once, and its activities and the types are read.
        reloads.release();
        await animationFrame();
        await animationFrame();
        const created = MockServer.env["crm.lead"].search_read([["name", "=", "Offline lead"]]);
        expect(created).toHaveLength(1);
        expect.verifySteps([ACTIVITIES, TYPES]);
        expect(renderer.props.list.model.useSampleModel).toBe(false);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(".o_view_sample_data").toHaveCount(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames()).toEqual(["Offline lead"]);
        expect(cardOf("Offline lead")).toHaveAttribute("data-id");
        expect(`${cardOf("Offline lead")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(renderer.allLoadedRecords().map((record) => record.resId)).toEqual([created[0].id]);
        expectHeader("New", 1, 25);
        expect(".o_view_nocontent").toHaveCount(0);
        await runAllTimers();
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: online, entering a folded stage loads and unfolds it; a lost connection is swallowed, another failure propagates", async () => {
        await makeMockServer();
        MockServer.env["crm.stage"].write([3, 4], { fold: true });
        mockActivityTypes(ACTIVITY_TYPES);
        const stageLoads = { next: null };
        onRpc("crm.lead", "web_search_read", () => {
            if (stageLoads.next === "error") {
                stageLoads.next = null;
                throw makeServerError({ message: "This stage cannot be read" });
            }
        });
        onRpc("/web/dataset/call_kw/crm.lead/web_search_read", () => {
            if (stageLoads.next === "drop") {
                stageLoads.next = null;
                return new Response("", { status: 502 });
            }
        });
        watchRpcs(["crm.lead/web_search_read"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const proposition = groupOf(renderer, 3);
        const won = groupOf(renderer, 4);
        expect(proposition.isFolded).toBe(true);
        expect(won.isFolded).toBe(true);

        // Entering a folded stage online loads and unfolds it.
        await goToStage("Proposition");
        expect.verifySteps(["crm.lead/web_search_read"]);
        expect(proposition.isFolded).toBe(false);
        expectHeader("Proposition", 1, 40);
        expect(cardNames()).toEqual(["Lead 4"]);

        // A failure that is not a connection loss propagates; the stage is displayed, folded.
        stageLoads.next = "error";
        await expect(renderer.goToGroup(won)).rejects.toThrow(/This stage cannot be read/);
        expect.verifySteps(["crm.lead/web_search_read"]);
        await animationFrame();
        expect(won.isFolded).toBe(true);
        expect(".o_crm_mobile_pipeline_stage_name .o_crm_mobile_pipeline_folded").toHaveCount(1);
        expectHeader("Won", 1, 50);

        // A connection lost during the load is swallowed: the stage stays folded, and the client
        // is offline, so the stage shows the offline helper.
        stageLoads.next = "drop";
        await renderer.goToGroup(won);
        expect.verifySteps(["crm.lead/web_search_read"]);
        await animationFrame();
        expect(won.isFolded).toBe(true);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        expectHeader("Won", 1, 50);

        // Nothing follows the last stage, and no stage is no navigation.
        expect(renderer.hasNextStage).toBe(false);
        expect(renderer.onNext()).toBe(undefined);
        await renderer.goToGroup(undefined);
        await animationFrame();
        expectHeader("Won", 1, 50);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: an arch without sum field, creation or loaded stage shows no revenue and no Add, and places cards by their group", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const sheets = captureInstances(CrmMobileQuickCreate);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace(' sum_field="expected_revenue"', "")
                .replace('<field name="stage_id"/>', "")
                .replace('archivable="false"', 'archivable="false" create="0"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const newStage = groupOf(renderer, 1);

        // No sum field: the header shows the lead count only.
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
        expect(".o_crm_mobile_pipeline_revenue").toHaveCount(0);
        expect(renderer.stageRevenueValue(newStage)).toBe(0);

        // No creation: neither New nor Add, and a direct Add opens nothing.
        expect(".o-kanban-button-new").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_add").toHaveCount(0);
        renderer.onAddClick();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(sheets).toHaveLength(0);

        // The stage is not loaded: a queued stage write of Lead 1 cannot be told apart from its
        // loaded stage, so the card stays in its framework group, shown pending.
        const lead1 = recordOf(renderer, 1);
        expect(lead1.data.stage_id).toBe(undefined);
        queueLeadSave([1], { stage_id: 2 });
        await animationFrame();
        expect(renderer.displayStage(lead1)).toBe(1);
        expect(renderer.isDisplaced(lead1)).toBe(false);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        await goToStage("Qualified");
        expect(cardNames()).toEqual(["Lead 3"]);
        expect(".o_crm_mobile_pipeline_count").toHaveText("1");
    });

    test.tags("mobile");
    test("mobile: a sum field without currency formats the stage revenue as an integer, online and offline", async () => {
        const errors = cachedReadErrors([
            // the offline reload, then the activities and the types revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        await makeMockServer();
        MockServer.env["crm.lead"].write([1], { color: 3 });
        MockServer.env["crm.lead"].write([2], { color: 4 });
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('sum_field="expected_revenue"', 'sum_field="color"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const newStage = groupOf(renderer, 1);
        const expected = formatInteger(7, { humanReadable: true, minDigits: 3 });
        expect(renderer.props.progressBarState.getGroupInfo(newStage).isReady).toBe(true);
        expect(".o_crm_mobile_pipeline_revenue").toHaveText(expected);
        expect(renderer.stageRevenueValue(newStage)).toBe(7);

        // Offline, the progress-bar counts are not cached: the stage's own loaded aggregate is
        // used, still without currency.
        await setOffline(true);
        await renderer.props.list.load();
        await animationFrame();
        expect(renderer.props.progressBarState.getGroupInfo(groupOf(renderer, 1)).isReady).toBe(
            false
        );
        expect(".o_crm_mobile_pipeline_revenue").toHaveText(expected);
        expect(renderer.stageRevenueValue(groupOf(renderer, 1))).toBe(7);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a stage revenue in several currencies is formatted in the company currency, online and offline", async () => {
        const errors = cachedReadErrors([
            // the offline reload, then the activities and the types revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        await makeMockServer();
        // Lead 1 (100) in EUR, Lead 2 (20) in the company currency (USD): the stage's first
        // currency is not the company one.
        MockServer.env["crm.lead"].write([1], { company_currency: 2 });
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(groupOf(renderer, 1).aggregates.company_currency).toEqual([2, CURRENCY_ID]);
        expectHeader("New", 2, 120);

        // Offline, from the stage's own loaded aggregate: the same.
        await setOffline(true);
        await renderer.props.list.load();
        await animationFrame();
        expect(renderer.props.progressBarState.getGroupInfo(groupOf(renderer, 1)).isReady).toBe(
            false
        );
        expectHeader("New", 2, 120);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: an active progress-bar filter keeps its aggregate in the header when the progress-bar counts are missing", async () => {
        await makeMockServer();
        MockServer.env["crm.lead"].write([1], { activity_state: "planned" });
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const { progressBarState } = renderer.props;
        const newStage = groupOf(renderer, 1);
        expectHeader("New", 2, 120);

        // The planned bar of New is selected, through the progress-bar state the desktop column
        // uses: the stage shows its planned leads, and the header the bar's aggregate.
        await progressBarState.selectBar(newStage.id, { value: "planned" });
        await animationFrame();
        expect(progressBarState.activeBars[1].value).toBe("planned");
        expect(cardNames()).toEqual(["Lead 1"]);
        expect(".o_crm_mobile_pipeline_revenue").toHaveText(formatRevenue(100));

        // Offline, the progress-bar counts cannot be read again: the header keeps the bar's
        // aggregate rather than the whole stage's loaded one.
        await setOffline(true);
        const { context, domain, groupBy, resModel } = renderer.props.list;
        await progressBarState.loadProgressBar({ context, domain, groupBy, resModel });
        await animationFrame();
        expect(progressBarState.getGroupInfo(newStage).isReady).toBe(false);
        expect(newStage.aggregates.expected_revenue).toBe(120);
        expect(".o_crm_mobile_pipeline_revenue").toHaveText(formatRevenue(100));
        expect(renderer.stageRevenueValue(newStage)).toBe(100);
    });

    test.tags("mobile");
    test("mobile: queue entries that collide with or follow a held sync snapshot are placed at once and once each", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        // Registered before the holder and the offline mock, so it answers the requests they let
        // through: a held replay released once the connection is lost fails with a lost connection.
        const connection = { lost: false };
        onRpc("/*", () => {
            if (connection.lost) {
                return new Response("", { status: 502 });
            }
        });
        // Registered before the offline mock: a replay sent online is held until released.
        const replays = holdRequests("/web/dataset/call_kw/crm.lead/web_save", "replay");
        const setOffline = mockOffline();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const serverLeadNames = () =>
            MockServer.env["crm.lead"]
                .search_read([["name", "in", ["Pending A", "Pending B"]]], ["name"])
                .map(({ name }) => name)
                .sort();

        // Offline, a lead is created in New.
        await setOffline(true);
        await quickCreateLead("Pending A", "10");
        expect(pendingCardNames()).toEqual(["Pending A"]);
        expectHeader("New", 3, 130);

        // Reconnect: its replay is held. The sync snapshot and the live queue both hold an entry
        // of its key: one card, counted once.
        replays.active = true;
        await setOffline(false);
        await expect.waitForSteps(["held replay"]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(queued()).toHaveLength(1);
        expect(pendingCardNames()).toEqual(["Pending A"]);
        expectHeader("New", 3, 130);

        // The connection drops again during the sync, and a second lead is created: it is placed
        // at once, next to the held one.
        connection.lost = true;
        await setOffline(true);
        await quickCreateLead("Pending B", "5");
        expect(queued()).toHaveLength(2);
        expect(pendingCardNames()).toEqual(["Pending A", "Pending B"]);
        expectHeader("New", 4, 135);

        // The held replay then fails with the lost connection: the sync window ends offline,
        // nothing is reloaded, and both leads keep their single pending card.
        replays.active = false;
        replays.release();
        await animationFrame();
        expect(getService(OfflinePlugin).syncingORM()).toBe(false);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queued()).toHaveLength(2);
        expect(serverLeadNames()).toEqual([]);
        expect(pendingCardNames()).toEqual(["Pending A", "Pending B"]);
        expectHeader("New", 4, 135);

        // The connection is back for good: both are replayed once each, then shown as server
        // cards.
        connection.lost = false;
        await setOffline(false);
        await letQueueReplay(2);
        expect(queued()).toHaveLength(0);
        expect(serverLeadNames()).toEqual(["Pending A", "Pending B"]);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Pending A", "Pending B"]);
        expectHeader("New", 4, 135);
    });

    test.tags("mobile");
    test("mobile: pending lead cards keep the order the leads were created in, whatever their queue keys", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${args[1].name}`);
        });
        const keys = keyQueuedCallsNewestFirst();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // Offline, three leads are created in New, one second apart. Each create gets an array
        // index key smaller than the previous one: the queue lists them newest first.
        await setOffline(true);
        await quickCreateLead("Pending A", "10");
        await quickCreateLead("Pending B", "5");
        await quickCreateLead("Pending C", "1");
        const madeInOrder = ["Pending A", "Pending B", "Pending C"];
        const offline = getService(OfflinePlugin);
        expect(keys).toHaveLength(3);
        expect(Object.keys(offline._ormToSync())).toEqual([...keys].reverse());
        expect(Object.values(offline._ormToSync()).map(({ value }) => value.args[1].name)).toEqual(
            [...madeInOrder].reverse()
        );

        // The stage shows them, and every reader returns them, in the order they were created
        // in, which is the order they replay in.
        expect(pendingCardNames()).toEqual(madeInOrder);
        expectHeader("New", 5, 136);
        const renderer = renderers.at(-1);
        const { crmOffline } = renderer;
        const keysOf = (entries) => entries.map(({ key }) => key);
        expect(keysOf(renderer.pendingCreatesFor(groupOf(renderer, 1)))).toEqual(keys);
        expect(keysOf(crmOffline.pendingLeadCreates(1))).toEqual(keys);
        const live = crmOffline.queuedEntries();
        expect(keysOf(crmOffline.pendingLeadCreates(1, Object.freeze([...live])))).toEqual(keys);
        expect(keysOf(crmOffline.pendingLeadCreates(1, [...live].reverse()))).toEqual(keys);

        // Reconnect: the framework replays the creates in that same order.
        await setOffline(false);
        await letQueueReplay(3);
        expect.verifySteps(madeInOrder.map((name) => `replayed ${name}`));
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", ...madeInOrder]);
        expectHeader("New", 5, 136);
    });

    test.tags("mobile");
    test("mobile: a mostly vertical swipe, a touch end without coordinates and stray touch events", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();
        expectHeader("New", 2, 120);

        // A swipe more vertical than horizontal (a scroll) changes nothing, however long.
        await touchStageBody("touchstart", [[300, 100]]);
        await touchStageBody("touchmove", [[150, 400]]);
        await touchStageBody("touchend", [], [[150, 400]]);
        expectHeader("New", 2, 120);

        // A touch end without coordinates ends the gesture where the last move was.
        await touchStageBody("touchstart", [[300, 200]]);
        await touchStageBody("touchmove", [[150, 210]]);
        await touchStageBody("touchend", [], []);
        expectHeader("Qualified", 1, 30);

        // A touch end with no gesture started, a touch start without touch and a move without
        // gesture do nothing.
        await touchStageBody("touchend", [], [[0, 200]]);
        expectHeader("Qualified", 1, 30);
        await touchStageBody("touchstart", []);
        await touchStageBody("touchmove", [[0, 200]]);
        await touchStageBody("touchend", [], [[0, 200]]);
        expectHeader("Qualified", 1, 30);

        // A horizontal swipe to the right still shows the previous stage.
        await touchStageBody("touchstart", [[100, 200]]);
        await touchStageBody("touchend", [], [[300, 205]]);
        expectHeader("New", 2, 120);
    });

    test.tags("mobile");
    test("mobile: a queued write to a stage the pipeline does not show, a record without id and a record that is not a lead keep their framework stage", async () => {
        await makeMockServer();
        const lostStageId = MockServer.env["crm.stage"].create({ name: "Lost", sequence: 5 });
        mockActivityTypes(ACTIVITY_TYPES);
        watchActivityReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["activities:1", "activities:2"]);
        const [renderer] = renderers;
        const newStage = groupOf(renderer, 1);
        const lead1 = recordOf(renderer, 1);
        // No lead is in Lost: the pipeline has no group for it.
        expect(groupOf(renderer, lostStageId)).toBe(undefined);

        // A write queued elsewhere (a form saved offline) moves Lead 1 to Lost: its card stays in
        // New, shown pending, and the totals are unchanged.
        queueLeadSave([1], { stage_id: lostStageId });
        await animationFrame();
        expect(renderer.displayStage(lead1)).toBe(1);
        expect(renderer.isDisplaced(lead1)).toBe(false);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expectHeader("New", 2, 120);

        // A record the framework adds to New without an id yet is placed in its group and has
        // no activity to read.
        await newStage.addNewRecord();
        await animationFrame();
        const idless = newStage.list.records.find((record) => !record.resId);
        expect(Boolean(idless)).toBe(true);
        expect(renderer.displayStage(idless)).toBe(1);
        expect(renderer.isDisplaced(idless)).toBe(false);
        expect(renderer.cardsFor(newStage)).toInclude(idless);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(3);
        expectHeader("New", 3, 120);
        await runAllTimers();
        expect.verifySteps([]);

        // A record of another model, with a stage field, has no stage tracked by the CRM model
        // (only leads carry one): it stays in its group and is never counted as displaced.
        const notALead = {
            resModel: "res.partner",
            resId: 99,
            group: newStage,
            activeFields: { stage_id: {} },
            data: { stage_id: false },
        };
        expect(renderer.displayStage(notALead)).toBe(1);
        expect(renderer.isDisplaced(notALead)).toBe(false);
    });

    test.tags("mobile");
    test("mobile: direct handler calls without a stage, record, target, event or valid lead do nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchActivityReads();
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            moveRecords() {
                expect.step("moveRecords");
                return super.moveRecords(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({ selectRecord: (resId) => expect.step(`open ${resId}`) });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["activities:1", "activities:2"]);
        const [renderer] = renderers;
        const lead1 = recordOf(renderer, 1);
        const qualified = groupOf(renderer, 2);

        // An explicit request for the stage without value is honoured, not defaulted.
        const stage = { value: 1, serverValue: 1, isFolded: false };
        const noStage = { value: false, serverValue: false, isFolded: false };
        expect(resolveDisplayedGroup({ groups: [stage, noStage] }, false)).toBe(noStage);

        // Without a stage, the stage readers are empty.
        expect(renderer.cardsFor(undefined)).toEqual([]);
        expect(renderer.pendingCreatesFor(undefined)).toEqual([]);
        expect(renderer.stageCount(undefined)).toBe(0);
        expect(renderer.stageRevenueValue(undefined)).toBe(0);
        expect(renderer.isStageDataMissing(undefined)).toBe(false);
        expect(renderer.unavailableMoreCount(undefined)).toBe(0);

        // Without a record or a target, nothing opens, moves or navigates.
        expect(renderer.onCardOpen(undefined)).toBe(undefined);
        await renderer.onCardMove(undefined, qualified);
        await renderer.onCardMove(lead1, undefined);
        await renderer.goToGroup(undefined);
        await animationFrame();
        expect.verifySteps([]);
        expect(lead1.group.serverValue).toBe(1);
        expect(queued()).toHaveLength(0);
        expectHeader("New", 2, 120);

        // Activity results: a list, or an object with records, is applied; anything else is not.
        const records = [{ id: 7 }];
        expect(renderer._normalizeRecords(records)).toBe(records);
        expect(renderer._normalizeRecords({ length: 1, records })).toBe(records);
        expect(renderer._normalizeRecords({ length: 0 })).toBe(null);
        expect(renderer._normalizeRecords(null)).toBe(null);

        // A card reporting an activity change without a valid lead id reads nothing; with one,
        // that lead's activities are read.
        expect(renderer.onActivitiesChanged(0)).toBe(undefined);
        expect(renderer.onActivitiesChanged(undefined)).toBe(undefined);
        await animationFrame();
        expect.verifySteps([]);
        await renderer.onActivitiesChanged(1);
        expect.verifySteps(["activities:1"]);

        // Add without an event: the bottom sheet opens, anchored to the pipeline.
        renderer.onAddClick();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        await contains(".o_crm_mobile_quick_create_discard").click();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);

        // Grouped by salesperson, a card's activity change reads nothing.
        await toggleSalespersonGrouping();
        expect(renderer.onActivitiesChanged(1)).toBe(undefined);
        await animationFrame();
        expect.verifySteps([]);

        // Grouped by stage with no lead at all: no stage group, hence no displayed stage, no
        // navigation and no Add.
        MockServer.env["crm.lead"].unlink(MockServer.env["crm.lead"].search([]));
        await toggleSalespersonGrouping();
        expect(renderer.props.list.groupByField.name).toBe("stage_id");
        expect(renderer.props.list.groups).toHaveLength(0);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(renderer.currentGroup).toBe(undefined);
        expect(renderer.currentIndex).toBe(-1);
        expect(renderer.hasPrevStage).toBe(false);
        expect(renderer.hasNextStage).toBe(false);
        expect(renderer.onPrev()).toBe(undefined);
        expect(renderer.onNext()).toBe(undefined);
        renderer.onAddClick();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: the pipeline renderer without the controller adapter keeps its own displayed stage, the stage without value included", async () => {
        await makeMockServer();
        MockServer.env["crm.lead"].create({
            name: "Lead without stage",
            stage_id: false,
            expected_revenue: 5,
        });
        registry.category("views").add("crm_mobile_pipeline_renderer_only", {
            ...crmKanbanView,
            Renderer: CrmMobilePipeline,
        });
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace(
                'js_class="crm_mobile_pipeline"',
                'js_class="crm_mobile_pipeline_renderer_only"'
            ),
        });
        const [renderer] = renderers;
        expect(controllers).toHaveLength(0);
        expect(renderer.env.crmMobileStage).toBe(undefined);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expect(renderer.stageGroups.map((group) => group.serverValue)).toEqual([false, 1, 2, 3, 4]);

        // Navigation works on the renderer's own stage state.
        await renderer.goToGroup(groupOf(renderer, 1));
        await animationFrame();
        expectHeader("New", 2, 120);
        await contains(".o_crm_mobile_pipeline_next").click();
        expectHeader("Qualified", 1, 30);
        await swipeRight(".o_crm_mobile_pipeline_body");
        expectHeader("New", 2, 120);
        // The stage before New is the one without value: displayed when chosen.
        await contains(".o_crm_mobile_pipeline_prev").click();
        expectHeader("None", 1, 5);
        expect(cardNames()).toEqual(["Lead without stage"]);
        expect(".o_crm_mobile_pipeline_prev").toHaveCount(0);
        await contains(".o_crm_mobile_pipeline_next").click();
        expectHeader("New", 2, 120);
    });

    test.tags("mobile");
    test("mobile: an offline move out of a stage it leaves empty subtracts nothing from that stage's zero aggregate", async () => {
        const errors = cachedReadErrors([
            // the move displays Proposition (Lead 3's activities, the types; Lead 4's were never
            // read, so they are not cached)
            ACTIVITIES,
            TYPES,
            // back on the emptied Qualified: the types
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        await goToStage("Qualified");
        expectHeader("Qualified", 1, 30);

        // Offline, Lead 3, the only lead of Qualified, moves to Proposition.
        await setOffline(true);
        await chooseStage("Lead 3", 3);
        expectHeader("Proposition", 2, 70);
        const qualified = groupOf(renderer, 2);
        expect(qualified.count).toBe(0);
        expect(renderer.isDisplaced(recordOf(renderer, 3))).toBe(true);
        // The framework aggregate of the emptied stage is already 0: its revenue is not lowered
        // below it.
        expect(renderer.stageCount(qualified)).toBe(0);
        expect(renderer.stageRevenueValue(qualified)).toBe(0);
        await goToStage("Qualified");
        // No lead it counts is left: 0 without currency, as the synced header of an empty stage.
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("Qualified");
        expect(".o_crm_mobile_pipeline_count").toHaveText("0");
        expect(".o_crm_mobile_pipeline_revenue").toHaveText("0");
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a card move failing for another reason than the connection propagates, and a move ending after the pipeline is destroyed changes nothing", async () => {
        const errors = cachedReadErrors([
            // offline, the move displays Qualified while the source reload is held: Lead 1's and
            // Lead 3's activities, read online while the refused move displayed them, and the
            // types
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        // Registered before the offline mock: it only sees the saves sent online.
        const saves = { rejectNext: false };
        onRpc("crm.lead", "web_save", () => {
            if (saves.rejectNext) {
                saves.rejectNext = false;
                throw makeServerError({ message: "This lead cannot move" });
            }
        });
        const setOffline = mockOffline();
        // Registered after the offline mock: it holds the reload before the offline mock answers.
        const sourceReloads = holdRequests(
            "/web/dataset/call_kw/crm.lead/web_search_read",
            "source reload"
        );
        watchRpcs(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        const renderers = captureInstances(CrmMobilePipeline);
        // One lead per stage page: New is truncated, so a move out of it reloads it.
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" limit="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const lead1 = recordOf(renderer, 1);
        const qualified = groupOf(renderer, 2);
        const displayedStage = renderer.env.crmMobileStage;
        expect(displayedStage.serverValue).toBe(null);

        // Online, the server refuses the stage write: the move is undone and the error reaches
        // the caller.
        saves.rejectNext = true;
        await expect(renderer.onCardMove(lead1, qualified)).rejects.toThrow(
            /This lead cannot move/
        );
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save"]);
        expect(lead1.group.serverValue).toBe(1);
        expect(displayedStage.serverValue).toBe(null);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1"]);
        expect(queued()).toHaveLength(0);

        // Offline, the move is queued, then the reload of the truncated source stage is held
        // while the application is torn down: once that reload ends, the displayed stage is left
        // alone.
        await setOffline(true);
        sourceReloads.active = true;
        const move = renderer.onCardMove(lead1, qualified);
        await expect.waitForSteps(["crm.lead/web_save", "held source reload"]);
        expect(queuedCalls("crm.lead", "web_save").map(({ args }) => args)).toEqual([
            [[1], { stage_id: 2 }],
        ]);
        expect(lead1.group).toBe(qualified);
        await expect.waitForErrors(errors);
        destroyApp();
        sourceReloads.release();
        await move;
        expect(displayedStage.serverValue).toBe(null);
    });
});

// -----------------------------------------------------------------------------
// Empty stage hint
// -----------------------------------------------------------------------------

/** The hint of a displayed stage that shows no lead while other stages hold some. */
const EMPTY_STAGE_HINT = ".o_crm_mobile_pipeline_body .o_crm_mobile_pipeline_empty_stage";
const EMPTY_STAGE_HINT_TEXT = `${EMPTY_STAGE_HINT} .o_crm_mobile_pipeline_empty_stage_text`;
const EMPTY_STAGE_HINT_BUTTON = `${EMPTY_STAGE_HINT} .o_crm_mobile_pipeline_empty_stage_target`;

/**
 * Lists every stage in the grouped reads of the lead pipeline, as the CRM stage group expansion
 * does on the server: the mock server lists only the stages holding a matching lead. A stage
 * without one answers 0 leads, the server's empty aggregate values (`_read_group_empty_value`),
 * and an empty record list unless it is folded (the stage's fold, or the opening info the client
 * sends for it).
 */
function expandStageGroups() {
    onRpc("crm.lead", "web_read_group", async ({ kwargs, parent }) => {
        const result = await parent();
        if (kwargs.groupby?.[0] !== "stage_id") {
            return result;
        }
        const emptyValue = (spec) => {
            if (/:array_agg(_distinct)?$/.test(spec)) {
                return [];
            }
            return /:count(_distinct)?$/.test(spec) ? 0 : false;
        };
        const stageSpec = kwargs.groupby_read_specification?.stage_id;
        const byStage = new Map(
            result.groups.map((group) => [group.stage_id?.[0] ?? false, group])
        );
        const stages = MockServer.env["crm.stage"].search_read([], ["display_name", "fold"]);
        const groups = stages.map((stage) => {
            if (byStage.has(stage.id)) {
                return byStage.get(stage.id);
            }
            const opening = kwargs.opening_info?.find((info) => info.value === stage.id);
            const folded = opening ? opening.folded : stage.fold;
            return {
                ...Object.fromEntries(kwargs.aggregates.map((spec) => [spec, emptyValue(spec)])),
                stage_id: [stage.id, stage.display_name],
                __count: 0,
                __extra_domain: [["stage_id", "=", stage.id]],
                ...(!folded && { __records: [] }),
                ...(stageSpec && {
                    __values: MockServer.env["crm.stage"].web_read([stage.id], stageSpec)[0],
                }),
            };
        });
        if (byStage.has(false)) {
            groups.unshift(byStage.get(false));
        }
        return { groups, length: groups.length };
    });
}

/**
 * Asserts the fixed header of a stage the server lists without any lead (see
 * `expandStageGroups`): such a stage aggregates no currency, so its revenue sum is formatted as a
 * plain number, as the desktop column header formats it.
 *
 * @param {string} stageName
 * @param {number} count
 * @param {number} revenue
 */
function expectEmptyStageHeader(stageName, count, revenue) {
    expect(".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_stage_name").toHaveText(stageName);
    expect(".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_count").toHaveText(String(count));
    expect(".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_revenue").toHaveText(
        formatInteger(revenue, { humanReadable: true, minDigits: 3 })
    );
}

/**
 * Asserts the empty-stage hint of the displayed stage.
 *
 * @param {string} text its sentence
 * @param {string} action the label of its button
 */
function expectEmptyStageHint(text, action) {
    expect(EMPTY_STAGE_HINT).toHaveCount(1);
    expect(EMPTY_STAGE_HINT_TEXT).toHaveText(text);
    expect(EMPTY_STAGE_HINT_BUTTON).toHaveText(action);
}

describe("Empty stage hint", () => {
    test.tags("mobile");
    test("mobile: a search whose only match is in another stage keeps the displayed stage, whose hint gives the count and displays the stage holding the match", async () => {
        expandStageGroups();
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs([LEAD_GROUPS, "crm.lead/web_search_read"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);
        expectHeader("New", 2, 120);
        // A stage holding leads shows no hint.
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
        expect(renderer.emptyStageHint(renderer.currentGroup)).toBe(null);

        // A search whose only match, Lead 4, is in Proposition: the server still lists every
        // stage, and New, the displayed stage, now holds no lead.
        await editSearch("Lead 4");
        await validateSearch();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.stageGroups.map((group) => group.serverValue)).toEqual([1, 2, 3, 4]);
        expectEmptyStageHeader("New", 0, 0);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        // The hint says where the match is, and is no framework helper, stage or card.
        expectEmptyStageHint(
            "No lead in this stage. 1 lead is in another stage.",
            "Show Proposition (1)"
        );
        // Gray 700: `text-muted` falls under the 4.5:1 contrast of normal-size text.
        expect(EMPTY_STAGE_HINT_TEXT).toHaveClass("text-700");
        expect(EMPTY_STAGE_HINT_TEXT).not.toHaveClass("text-muted");
        expect(".o_view_nocontent").toHaveCount(0);
        expect(".o_kanban_group").toHaveCount(1);
        expect(".o_kanban_record").toHaveCount(0);
        const button = queryOne(EMPTY_STAGE_HINT_BUTTON);
        expect(button.tagName).toBe("BUTTON");
        expect(button).toHaveAttribute("type", "button");
        expect(button).toHaveAttribute("data-available-offline", "1");
        expect(button).not.toHaveAttribute("disabled");
        expectTouchTarget(button, "the empty-stage hint button");
        // Rendering the hint read nothing.
        await runAllTimers();
        expect.verifySteps([]);

        // Its button displays Proposition, already loaded: its card, no read and no hint.
        await contains(EMPTY_STAGE_HINT_BUTTON).click();
        await animationFrame();
        expect.verifySteps([]);
        expectHeader("Proposition", 1, 40);
        expect(cardNames()).toEqual(["Lead 4"]);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);

        // Another empty stage shows the hint as well. Activated by keyboard, its button leaves
        // with the stage it was shown in, and hands the focus to the first header control.
        await goToStage("Qualified");
        expectEmptyStageHeader("Qualified", 0, 0);
        expectEmptyStageHint(
            "No lead in this stage. 1 lead is in another stage.",
            "Show Proposition (1)"
        );
        queryOne(EMPTY_STAGE_HINT_BUTTON).focus();
        await press("Enter");
        await animationFrame();
        expectHeader("Proposition", 1, 40);
        expect(cardNames()).toEqual(["Lead 4"]);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
        expect(".o_crm_mobile_pipeline_prev").toBeFocused();

        // The framework quick create open in the empty stage replaces the hint until it closes.
        await goToStage("New");
        expect(EMPTY_STAGE_HINT).toHaveCount(1);
        await contains(".o-kanban-button-new").click();
        await animationFrame();
        expect(".o_crm_mobile_pipeline_body .o_kanban_quick_create").toHaveCount(1);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
        await contains(
            ".o_crm_mobile_pipeline_body .o_kanban_quick_create .o_kanban_cancel"
        ).click();
        await animationFrame();
        expect(".o_kanban_quick_create").toHaveCount(0);
        expectEmptyStageHint(
            "No lead in this stage. 1 lead is in another stage.",
            "Show Proposition (1)"
        );

        // With sample data, or while the unavailable-lead helper is displayed, there is no hint.
        const group = renderer.currentGroup;
        const { model } = renderer.props.list;
        model.useSampleModel = true;
        expect(renderer.emptyStageHint(group)).toBe(null);
        model.useSampleModel = false;
        renderer.mobileState.unavailableLeadId = 4;
        expect(renderer.emptyStageHint(group)).toBe(null);
        renderer.mobileState.unavailableLeadId = null;
        const hint = renderer.emptyStageHint(group);
        expect(hint.target).toBe(groupOf(renderer, 3));
        expect(hint.targetCount).toBe(1);
        expect(hint.otherCount).toBe(1);

        // Without the search, the displayed stage holds leads again: no hint.
        expect(".o_searchview_facet").toHaveCount(1);
        await contains(".o_searchview_facet .o_facet_remove").click();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expectHeader("New", 2, 120);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a reload whose matches are in several stages counts them all and displays the first one, a folded stage loaded and unfolded online", async () => {
        await makeMockServer();
        // Proposition is folded: its leads are loaded only once it is displayed.
        MockServer.env["crm.stage"].write([3], { fold: true });
        expandStageGroups();
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs([LEAD_GROUPS, "crm.lead/web_search_read"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);
        expectHeader("New", 2, 120);

        // A reload whose domain matches Lead 4 (folded Proposition) and Lead 5 (Won) only.
        await renderer.props.list.model.load({ domain: [["id", "in", [4, 5]]] });
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expectEmptyStageHeader("New", 0, 0);
        expect(groupOf(renderer, 3).isFolded).toBe(true);
        // Both leads are counted; the button displays the first stage holding one.
        expectEmptyStageHint(
            "No lead in this stage. 2 leads are in other stages.",
            "Show Proposition (1)"
        );

        // Online, the folded stage is loaded and unfolded as every navigation does.
        await contains(EMPTY_STAGE_HINT_BUTTON).click();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_search_read"]);
        expect(groupOf(renderer, 3).isFolded).toBe(false);
        expectHeader("Proposition", 1, 40);
        expect(cardNames()).toEqual(["Lead 4"]);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);

        // Won holds a lead: no hint there. Qualified holds none: the same hint.
        await goToStage("Won");
        expectHeader("Won", 1, 50);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
        await goToStage("Qualified");
        expectEmptyStageHint(
            "No lead in this stage. 2 leads are in other stages.",
            "Show Proposition (1)"
        );
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: no hint when every stage is empty (the framework no-content helper); offline, a queued lead create is counted and its stage displayed with nothing loaded", async () => {
        const errors = cachedReadErrors([
            // the types revalidated when Qualified is displayed offline
            TYPES,
        ]);
        expect.errors(errors.length);
        expandStageGroups();
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs([LEAD_GROUPS, "crm.lead/web_search_read", "crm.lead/web_save"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);

        // A search that matches no lead: every stage is empty, and the framework no-content
        // helper covers the pipeline instead of any hint.
        await editSearch("Nobody");
        await validateSearch();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.stageGroups.map((group) => group.serverValue)).toEqual([1, 2, 3, 4]);
        expectEmptyStageHeader("New", 0, 0);
        expect(".o_crm_mobile_pipeline .o_view_nocontent").toHaveCount(1);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
        for (const group of renderer.stageGroups) {
            expect(renderer.emptyStageHint(group)).toBe(null);
        }
        await goToStage("Won");
        expect(".o_crm_mobile_pipeline .o_view_nocontent").toHaveCount(1);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
        await goToStage("New");

        // Offline, a lead create is queued in Qualified: the pending-aware counts place it there,
        // so New's hint counts it and its button displays Qualified, with nothing loaded.
        await setOffline(true);
        queueLeadSave([], { name: "Queued lead", stage_id: 2, expected_revenue: 15 });
        await animationFrame();
        expect(".o_view_nocontent").toHaveCount(0);
        expectEmptyStageHeader("New", 0, 0);
        expectEmptyStageHint(
            "No lead in this stage. 1 lead is in another stage.",
            "Show Qualified (1)"
        );
        expect(EMPTY_STAGE_HINT_BUTTON).not.toHaveAttribute("disabled");
        expect(EMPTY_STAGE_HINT_BUTTON).not.toHaveClass("o_disabled_offline");
        await contains(EMPTY_STAGE_HINT_BUTTON).click();
        await animationFrame();
        // The stage the server reports empty shows the queued amount in the currency its synced
        // header carries, the pending card's.
        expectHeader("Qualified", 1, 15);
        expect(pendingCardNames()).toEqual(["Queued lead"]);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
        expect.verifySteps([]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: offline, the hint still displays the folded stage holding the match, which is never loaded", async () => {
        const errors = cachedReadErrors([
            // the types revalidated when Proposition is displayed offline (its lead was never
            // loaded, so no activity is read)
            TYPES,
        ]);
        expect.errors(errors.length);
        await makeMockServer();
        // Proposition is folded: its leads are never loaded online.
        MockServer.env["crm.stage"].write([3], { fold: true });
        expandStageGroups();
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs([LEAD_GROUPS, "crm.lead/web_search_read"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);
        await editSearch("Lead 4");
        await validateSearch();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expectEmptyStageHeader("New", 0, 0);

        // The connection drops: the hint stays, usable offline.
        await setOffline(true);
        await animationFrame();
        expectEmptyStageHint(
            "No lead in this stage. 1 lead is in another stage.",
            "Show Proposition (1)"
        );
        expect(EMPTY_STAGE_HINT_BUTTON).not.toHaveAttribute("disabled");
        expect(EMPTY_STAGE_HINT_BUTTON).not.toHaveClass("o_disabled_offline");

        // Its button displays Proposition without loading it: the stage stays folded, and the
        // offline action helper says its lead is not available.
        await contains(EMPTY_STAGE_HINT_BUTTON).click();
        await animationFrame();
        expect.verifySteps([]);
        expectHeader("Proposition", 1, 40);
        expect(groupOf(renderer, 3).isFolded).toBe(true);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        expect(EMPTY_STAGE_HINT).toHaveCount(0);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: with sample data, no stage shows the hint", async () => {
        await makeMockServer();
        MockServer.env["crm.lead"].unlink(MockServer.env["crm.lead"].search([]));
        expandStageGroups();
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" sample="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(renderer.props.list.model.useSampleModel).toBe(true);
        expect(".o_view_sample_data .o_crm_mobile_pipeline").toHaveCount(1);
        for (const group of renderer.stageGroups) {
            await renderer.goToGroup(group);
            await animationFrame();
            expect(".o_crm_mobile_pipeline_stage_name").toHaveText(group.displayName);
            expect(renderer.emptyStageHint(group)).toBe(null);
            expect(EMPTY_STAGE_HINT).toHaveCount(0);
        }
    });

    test.tags("desktop");
    test("desktop: a search whose only match is in another stage renders the standard kanban columns, with no hint", async () => {
        expandStageGroups();
        await mountPipeline();
        await editSearch("Lead 4");
        await validateSearch();
        await animationFrame();
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer .o_kanban_group").toHaveCount(4);
        expect(".o_kanban_renderer .o_kanban_record:not(.o_kanban_ghost)").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_empty_stage").toHaveCount(0);
    });
});

// -----------------------------------------------------------------------------
// Mobile lead card
// -----------------------------------------------------------------------------

/**
 * Asserts an element is at least one 44x44 CSS-pixel touch target.
 *
 * @param {Element} el
 * @param {string} label
 */
function expectTouchTarget(el, label) {
    const { width, height } = el.getBoundingClientRect();
    expect(width >= 44 && height >= 44).toBe(true, {
        message: `${label} is ${width}x${height}, at least 44x44 expected`,
    });
}

/**
 * Asserts a card button shows its icon, then its label, with a visible gap between them.
 *
 * @param {Element} button
 * @param {string} label
 * @returns {number} the gap, in CSS pixels, from the end of the icon to the start of the label
 */
function iconLabelGap(button, label) {
    const icon = button.querySelector(":scope > .oi-fw");
    const text = icon?.nextElementSibling;
    expect(Boolean(icon && text)).toBe(true, { message: `${label} has an icon, then a label` });
    const gap = text.getBoundingClientRect().left - icon.getBoundingClientRect().right;
    expect(gap > 0).toBe(true, { message: `${label} has a ${gap}px icon-label gap` });
    return gap;
}

/**
 * @param {Element} el
 * @returns {string} the computed top, right, bottom and left paddings of an element
 */
function boxPadding(el) {
    const style = getComputedStyle(el);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(" ");
}

/**
 * @param {number} value
 * @returns {string} an amount as the card shows it (lead currency, whitespace-normalized)
 */
function formatCardRevenue(value) {
    return formatMonetary(value, { currencyId: CURRENCY_ID }).replace(/\s+/g, " ");
}

/** Every server call by which a lead chatter could write, by route or by `model/method`. */
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
    /\/post_message$/,
    /\/open_edit_form$/,
    /\/unlink$/,
    /\/write$/,
    /\/web_save$/,
];

/** Stands for the DOM event of a template handler called directly. */
const NO_EVENT = { stopPropagation() {}, preventDefault() {} };

/**
 * Seeds the thread of lead 1 with every kind of chatter content: followers (the current user and
 * another partner), an activity without assignee whose type has a mail template, an attachment, a
 * message carrying a reaction of the current user, and a scheduled message.
 *
 * @returns {Promise<{ pyEnv: Object, mailTemplateId: number }>}
 */
async function seedLeadThread() {
    const pyEnv = await startServer();
    const otherPartnerId = pyEnv["res.partner"].create({
        name: "Follower Partner",
        email: "follower@example.com",
    });
    for (const partnerId of [serverState.partnerId, otherPartnerId]) {
        pyEnv["mail.followers"].create({
            partner_id: partnerId,
            res_model: "crm.lead",
            res_id: 1,
            is_active: true,
        });
    }
    const mailTemplateId = pyEnv["mail.template"].create({ name: "Offer template" });
    const [emailType] = pyEnv["mail.activity.type"].search_read([["name", "=", "Email"]]);
    pyEnv["mail.activity.type"].write([emailType.id], { mail_template_ids: [mailTemplateId] });
    const activityId = pyEnv["mail.activity"].create({
        activity_type_id: emailType.id,
        can_write: true,
        res_id: 1,
        res_model: "crm.lead",
        summary: "Send the offer",
        user_id: false,
    });
    // The mock lead has no server-side inverse for the activity link: set it.
    pyEnv["crm.lead"].write([1], { activity_ids: [[4, activityId]] });
    pyEnv["ir.attachment"].create({
        mimetype: "text/plain",
        name: "offer.txt",
        res_id: 1,
        res_model: "crm.lead",
    });
    const messageId = pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "Hello lead",
        message_type: "comment",
        model: "crm.lead",
        res_id: 1,
    });
    pyEnv["mail.message.reaction"].create({
        content: "👍",
        message_id: messageId,
        partner_id: serverState.partnerId,
    });
    pyEnv["mail.scheduled.message"].create({
        body: "<p>Reminder for the offer</p>",
        model: "crm.lead",
        res_id: 1,
        scheduled_date: "2030-01-10 10:00:00",
    });
    return { pyEnv, mailTemplateId };
}

/**
 * Message actions are set up again each time their owner re-renders: only the actions of owners
 * still mounted are the ones the user can reach.
 *
 * @param {MessageAction[]} actions captured message actions
 * @returns {Map<Object, MessageAction[]>} the actions of the mounted owners showing a lead message
 */
function leadMessageActionsByOwner(actions) {
    const byOwner = new Map();
    for (const action of actions) {
        if (
            action.messageFn?.()?.thread?.model !== "crm.lead" ||
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

/**
 * The precondition of a direct-handler check: the component was instantiated, and an instance
 * targets a lead.
 *
 * @template T
 * @param {T[]} instances captured instances
 * @param {(instance: T) => string | undefined} getModel the target model of an instance
 * @param {string} label
 * @returns {T} the last instance targeting a lead
 */
function leadInstance(instances, getModel, label) {
    expect(instances.length).toBeGreaterThan(0, { message: `${label} is instantiated` });
    const instance = instances.findLast((candidate) => getModel(candidate) === "crm.lead");
    expect(Boolean(instance)).toBe(true, { message: `${label} targets crm.lead` });
    return instance;
}

describe("Mobile lead card", () => {
    test.tags("mobile");
    test("mobile: card shows name, partner, revenue; touch targets >= 44x44", async () => {
        await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
            { res_id: 2, activity_type_id: 2, activity_category: "phonecall" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        expect(cards.length).toBeGreaterThan(1);

        // Content: name, partner (or contact name), expected revenue in the lead currency.
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_partner`).toHaveText(
            serverState.partnerName
        );
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_revenue`).toHaveText(
            formatCardRevenue(100)
        );
        expect(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_partner`).toHaveText("Rachel Green");
        expect(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_revenue`).toHaveText(
            formatCardRevenue(20)
        );
        // Secondary text uses the darker gray utility: text-muted falls below 4.5:1 on white.
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_partner`).toHaveClass("text-700");
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_partner`).not.toHaveClass("text-muted");
        // The truncated name and partner keep their full text as a title.
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).toHaveAttribute(
            "title",
            "Lead 1"
        );
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_partner`).toHaveAttribute(
            "title",
            serverState.partnerName
        );
        expect(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_partner`).toHaveAttribute(
            "title",
            "Rachel Green"
        );
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        // The upstream mobile main flow opens a lead through its name span.
        expect(".o_kanban_group .o_kanban_record span:contains(Lead 1)").toHaveCount(1);

        // Touch targets: the card, its body and every control, panel by panel.
        const card = cardOf("Lead 1");
        expectTouchTarget(queryOne(card), "card");
        expectTouchTarget(queryOne(`${card} .o_crm_mobile_lead_card_body`), "card body");
        for (const el of queryAll(`${card} .o_crm_mobile_lead_card_actions button`)) {
            expectTouchTarget(el, el.getAttribute("aria-label"));
        }
        expect(queryAll(`${card} .o_crm_mobile_lead_card_actions button`)).toHaveLength(4);
        // Theme: the card border is the pipeline header's theme border, and every action shows
        // its icon, then its label, with one gap and one padding (Mark done included, below).
        expect(getComputedStyle(queryOne(card)).borderTopColor).toBe(
            getComputedStyle(queryOne(".o_crm_mobile_pipeline_header")).borderBottomColor
        );
        const actions = queryAll(`${card} .o_crm_mobile_lead_card_actions button`);
        const actionGap = iconLabelGap(actions[0], actions[0].className);
        const actionPadding = boxPadding(actions[0]);
        for (const el of actions) {
            expect(iconLabelGap(el, el.className)).toBe(actionGap);
            expect(boxPadding(el)).toBe(actionPadding, { message: `${el.className} padding` });
        }
        await contains(`${card} .o_crm_mobile_card_stage`).click();
        expect(`${card} .o_crm_mobile_stage_option`).toHaveCount(4);
        expect(queryAllTexts(`${card} .o_crm_mobile_stage_option`)).toEqual([
            "New",
            "Qualified",
            "Proposition",
            "Won",
        ]);
        expect(`${card} .o_crm_mobile_lead_card_stage_list`).toHaveAttribute("role", "listbox");
        expect(`${card} .o_crm_mobile_stage_option[aria-selected=true]`).toHaveText("New");
        for (const el of queryAll(`${card} .o_crm_mobile_stage_option`)) {
            expectTouchTarget(el, `stage option ${el.textContent}`);
        }
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(`${card} .o_crm_mobile_lead_card_stage_list`).toHaveCount(0);
        const followUpControls = ["select", "input", "button"].flatMap((tag) =>
            queryAll(`${card} .o_crm_mobile_lead_card_follow_up ${tag}`)
        );
        // the type select, the summary and date inputs, Save and Cancel
        expect(followUpControls).toHaveLength(5);
        for (const el of followUpControls) {
            expectTouchTarget(el, `follow-up ${el.className}`);
        }
        // Theme corners: the summary input and every card button keep the select's corner, which
        // the framework input reset would strip from the text input.
        const themeRadius = getComputedStyle(
            queryOne(`${card} .o_crm_mobile_follow_up_type`)
        ).borderTopLeftRadius;
        expect(themeRadius).not.toBe("0px");
        for (const el of [...followUpControls, ...actions]) {
            expect(getComputedStyle(el).borderTopLeftRadius).toBe(themeRadius, {
                message: `${el.className} has the theme corner`,
            });
        }
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(1);
        expect(`${card} .o_crm_mobile_activity_deadline`).toHaveClass(["text-700", "small"]);
        expect(`${card} .o_crm_mobile_activity_deadline`).not.toHaveClass("text-muted");
        expect(`${card} .o_crm_mobile_activity_type`).toHaveAttribute("title", "Email");
        expect(`${card} .o_crm_mobile_activity_summary`).toHaveText("Send offer");
        expect(`${card} .o_crm_mobile_activity_summary`).toHaveClass("text-break");
        expect(`${card} .o_crm_mobile_activity_summary`).not.toHaveClass("text-truncate");
        expectTouchTarget(queryOne(`${card} .o_crm_mobile_activity_done`), "mark done");
        const markDone = queryOne(`${card} .o_crm_mobile_activity_done`);
        expect(iconLabelGap(markDone, "mark done")).toBe(actionGap);
        expect(boxPadding(markDone)).toBe(actionPadding, { message: "mark done padding" });
        expect(getComputedStyle(markDone).borderTopLeftRadius).toBe(themeRadius);
        // Accessible names start with the visible label and add what it shows or targets: the
        // Activities count, the activity a Mark done completes (its summary when it has one).
        expect(`${card} .o_crm_mobile_card_activities`).toHaveAttribute(
            "aria-label",
            "Activities (1)"
        );
        expect(`${card} .o_crm_mobile_card_activities`).toHaveAttribute(
            "title",
            "Show the lead's activities"
        );
        for (const attribute of ["aria-label", "title"]) {
            expect(`${card} .o_crm_mobile_activity_done`).toHaveAttribute(
                attribute,
                "Mark done: Email – Send offer"
            );
        }
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_lead_card_activities`).toHaveCount(0);
        const lead2Card = cardOf("Lead 2");
        await contains(`${lead2Card} .o_crm_mobile_card_activities`).click();
        expect(`${lead2Card} .o_crm_mobile_card_activities`).toHaveAttribute(
            "aria-label",
            "Activities (1)"
        );
        expect(`${lead2Card} .o_crm_mobile_activity_summary`).toHaveCount(0);
        for (const attribute of ["aria-label", "title"]) {
            expect(`${lead2Card} .o_crm_mobile_activity_done`).toHaveAttribute(
                attribute,
                "Mark done: Call"
            );
        }
        await contains(`${lead2Card} .o_crm_mobile_card_activities`).click();
        await goToStage("Qualified");
        for (const selector of [
            ".o_crm_mobile_pipeline_prev",
            ".o_crm_mobile_pipeline_next",
            ".o_crm_mobile_pipeline_add",
        ]) {
            const el = queryOne(selector);
            expectTouchTarget(el, selector);
            expect(el).toHaveAttribute("aria-label");
            expect(el).toHaveAttribute("title");
        }
    });

    test.tags("mobile");
    test("mobile: a long lead name and partner keep their full text as a title; a long activity summary wraps beside Mark done", async () => {
        const longName = `Lead 1 ${"with a name far too long for one line ".repeat(6)}`.trim();
        const longPartner = `Contact ${"with a name far too long as well ".repeat(6)}`.trim();
        // Words and an unbroken token (a reference number) wider than the screen.
        const reference = `ref-${"0123456789".repeat(8)}`;
        const words = "and the delivery dates ".repeat(8);
        const longSummary = `Call back about the renewal terms ${reference} ${words}`.trim();
        await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: longSummary },
        ]);
        MockServer.env["crm.lead"].write([1], {
            name: longName,
            partner_id: false,
            contact_name: longPartner,
        });
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();
        const card = cardOf(longName);

        // The name and partner are truncated to one line each, their full text in a title.
        const name = queryOne(`${card} .o_crm_mobile_lead_card_name`);
        expect(name).toHaveAttribute("title", longName);
        expect(name.scrollWidth > name.clientWidth).toBe(true, {
            message: "the long name is truncated",
        });
        const partner = queryOne(`${card} .o_crm_mobile_lead_card_partner`);
        expect(partner).toHaveText(longPartner);
        expect(partner).toHaveAttribute("title", longPartner);
        expect(partner.scrollWidth > partner.clientWidth).toBe(true, {
            message: "the long partner is truncated",
        });
        // The upstream mobile main flow still finds the name as the card's first, leaf span.
        expect(queryAll(`${card} span`)[0]).toBe(name);
        expect(name.childElementCount).toBe(0);

        // The summary wraps in the expanded list: shown in full on several lines, never wider
        // than its column, with Mark done kept at the end of the row as a full touch target.
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        const row = queryOne(`${card} .o_crm_mobile_activity_row`);
        const type = queryOne(`${card} .o_crm_mobile_activity_type`);
        const summary = queryOne(`${card} .o_crm_mobile_activity_summary`);
        const done = queryOne(`${card} .o_crm_mobile_activity_done`);
        expect(summary).toHaveText(longSummary);
        expect(summary.scrollWidth <= summary.clientWidth).toBe(true, {
            message: `the summary (${summary.scrollWidth}px) fits its ${summary.clientWidth}px column`,
        });
        const summaryRect = summary.getBoundingClientRect();
        expect(summaryRect.height > 2 * type.getBoundingClientRect().height).toBe(true, {
            message: "the summary wraps over several lines",
        });
        const rowRect = row.getBoundingClientRect();
        const doneRect = done.getBoundingClientRect();
        expect(Math.abs(rowRect.right - doneRect.right) <= 1).toBe(true, {
            message: "Mark done stays at the end of the row",
        });
        expect(summaryRect.right <= doneRect.left).toBe(true, {
            message: "the summary never runs under Mark done",
        });
        expectTouchTarget(done, "mark done");
        expect(rowRect.height >= 44).toBe(true, { message: "the row is a full touch target" });
        expect(queryOne(card).scrollWidth <= queryOne(card).clientWidth).toBe(true, {
            message: "the card never overflows the screen",
        });
        expect(done).toHaveAttribute("aria-label", `Mark done: Email – ${longSummary}`);
    });

    test.tags("mobile");
    test("mobile: offline stage move via card queues web_save and shows pending-sync indicator", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
            // the keyboard move displays Proposition (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs([
            "crm.lead/web_save",
            "crm.lead/web_search_read",
            "crm.lead/get_rainbowman_message",
        ]);
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            moveRecords(recordIds, refId, targetGroupId) {
                expect.step({ moveRecords: [recordIds, refId, targetGroupId] });
                return super.moveRecords(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        // One lead per stage page: New is truncated (Lead 2 is not loaded).
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" limit="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const lead1 = recordOf(renderer, 1);
        const newStage = groupOf(renderer, 1);
        const qualified = groupOf(renderer, 2);
        expect(cardNames()).toEqual(["Lead 1"]);

        await setOffline(true);
        await chooseStage("Lead 1", 2);
        // The framework kanban move, with its current three-argument API, queues the write.
        // Its reload of the truncated source stage then loses the connection: the queued write
        // and the in-memory move stay, and nothing surfaces.
        expect.verifySteps([
            { moveRecords: [[lead1.id], null, qualified.id] },
            "crm.lead/web_save",
            "crm.lead/web_search_read",
        ]);
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args).toEqual([[1], { stage_id: 2 }]);
        expect(saves[0].extras.viewType).toBe("kanban");
        expect(lead1.group).toBe(qualified);
        expect(lead1.serverStageId).toBe(1);
        // The target stage is displayed, with the moved card and its badge.
        expectHeader("Qualified", 2, 130);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(`${cardOf("Lead 3")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        // The card's stage list: the displayed stage is selected and cannot be chosen again.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).click();
        expect(
            `${cardOf("Lead 1")} .o_crm_mobile_stage_option[data-stage-value='2']`
        ).toHaveAttribute("aria-selected", "true");
        expect(`${cardOf("Lead 1")} .o_crm_mobile_stage_option:disabled`).toHaveCount(1);
        expect(
            `${cardOf("Lead 1")} .o_crm_mobile_stage_option[data-stage-value='2']`
        ).toHaveAttribute("disabled");
        // Lead 3's activities were never read online: offline, the card says so.
        await contains(`${cardOf("Lead 3")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 3")} .o_crm_mobile_lead_card_activities`).toHaveText(
            "Activities are not available offline"
        );
        // New lost its only loaded lead: its unloaded one is reported as missing offline.
        expect(renderer.stageCount(newStage)).toBe(1);
        expect(renderer.stageRevenueValue(newStage)).toBe(20);
        expect(renderer.isStageDataMissing(newStage)).toBe(true);
        expect.verifySteps([]);

        // Keyboard selection: Enter on the focused Stage toggle closes and reopens the stage
        // list, and Enter on a focused option makes the same queued move as a tap.
        const stageToggle = queryOne(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`);
        stageToggle.focus();
        await press("Enter");
        await animationFrame();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_stage_list`).toHaveCount(0);
        await press("Enter");
        await animationFrame();
        expect(`${cardOf("Lead 1")} [role=listbox]`).toHaveCount(1);
        const proposition = groupOf(renderer, 3);
        queryOne(`${cardOf("Lead 1")} .o_crm_mobile_stage_option[data-stage-value='3']`).focus();
        await press("Enter");
        await animationFrame();
        // The same framework move as the tap: the write is queued, and the stage reload that
        // follows loses the connection.
        expect.verifySteps([
            { moveRecords: [[lead1.id], null, proposition.id] },
            "crm.lead/web_save",
            "crm.lead/web_search_read",
        ]);
        // One coalesced entry for the lead, now carrying the stage chosen with the keyboard.
        expect(queuedCalls("crm.lead", "web_save").map(({ args }) => args)).toEqual([
            [[1], { stage_id: 3 }],
        ]);
        expect(lead1.group).toBe(proposition);
        expectHeader("Proposition", 2, 140);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: pending indicator clears after successful replay and after a systray discard", async () => {
        const errors = cachedReadErrors([
            // first move: Qualified is displayed (Lead 1 and Lead 3, both visited online, and
            // the types)
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // second move: Proposition is displayed (Lead 3, the types; Lead 4's activities
            // were never cached)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${JSON.stringify(args)}`);
        });
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await goToStage("Qualified");
        await goToStage("New");

        await setOffline(true);
        await chooseStage("Lead 1", 2);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        await advanceTime(1000);
        await chooseStage("Lead 3", 3);
        expectHeader("Proposition", 2, 70);
        expect(`${cardOf("Lead 3")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(queued()).toHaveLength(2);

        // Discarding Lead 3's write from the systray clears its badge at once.
        await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
        expect(".o-dropdown--menu .o-dropdown-item").toHaveCount(2);
        await contains(
            ".o-dropdown--menu .o-dropdown-item:eq(1) button[data-icon='delete']"
        ).click();
        await contains(".modal-dialog .modal-footer button.btn-primary").click();
        expect(queued()).toHaveLength(1);
        expect(queued()[0].value.args).toEqual([[1], { stage_id: 2 }]);
        expect(`${cardOf("Lead 3")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(".o_crm_mobile_pending_badge").toHaveCount(0);

        // Reconnect: Lead 1's write is replayed and its badge clears.
        await setOffline(false);
        await letQueueReplay(1);
        expect.verifySteps(['replayed [[1],{"stage_id":2}]']);
        expect(queued()).toHaveLength(0);
        await goToStage("Qualified");
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);
        expect(".o_crm_mobile_pending_badge").toHaveCount(0);
        // The discarded write never reached the server: the reload shows Lead 3 in Qualified.
        expect(MockServer.env["crm.lead"].browse(3)[0].stage_id).toBe(2);
        expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(2);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: mark won via card stage list offline (no rainbowman), online issues rainbowman", async () => {
        const errors = cachedReadErrors([
            // the move displays Won (Lead 1, types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // Offline, choosing the won stage is mark-won: the stage write is queued, the won stage
        // is displayed with the pending card, and the rainbowman lookup is skipped.
        await setOffline(true);
        await chooseStage("Lead 1", 4);
        expect.verifySteps(["crm.lead/web_save"]);
        expect(queuedCalls("crm.lead", "web_save").map(({ args }) => args)).toEqual([
            [[1], { stage_id: 4 }],
        ]);
        expectHeader("Won", 2, 150);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        await runAllTimers();
        expect.verifySteps([]);

        // Online, the same choice issues the rainbowman lookup after the save.
        await setOffline(false);
        await letQueueReplay(1);
        expect.verifySteps(["crm.lead/web_save"]);
        expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(4);
        await goToStage("New");
        await chooseStage("Lead 2", 4);
        expect.verifySteps(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
        expectHeader("Won", 3, 170);
        expect(queued()).toHaveLength(0);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: offline move to a folded won stage shows the won header and the pending card, with no uncached read and no rainbowman call, and the card can move out again", async () => {
        const errors = cachedReadErrors([
            // the move displays Won (Lead 1, types)
            ACTIVITIES,
            TYPES,
            // the move out of Won displays Qualified (Lead 1, types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs([
            "crm.lead/web_save",
            "crm.lead/web_search_read",
            LEAD_GROUPS,
            "crm.lead/get_rainbowman_message",
        ]);
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            moveRecords(recordIds, refId, targetGroupId) {
                expect.step({ moveRecords: [recordIds, refId, targetGroupId] });
                return super.moveRecords(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        const won = groupOf(renderer, 4);
        const lead1 = recordOf(renderer, 1);
        expect(won.isFolded).toBe(true);
        expect(won.list.records).toHaveLength(0);

        await setOffline(true);
        await chooseStage("Lead 1", 4);
        expect.verifySteps([{ moveRecords: [[lead1.id], null, won.id] }, "crm.lead/web_save"]);
        // The won header (folded), the pending card, and the lead the stage holds but never
        // loaded counted as not available offline.
        expect(".o_crm_mobile_pipeline_stage_name .o_crm_mobile_pipeline_folded").toHaveCount(1);
        expectHeader("Won", 2, 150);
        expect(cardNames()).toEqual(["Lead 1"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(".o_crm_mobile_pipeline_unavailable_more").toHaveText(
            "1 more leads are not available offline"
        );
        expect(".o_crm_mobile_pipeline_load_more").toHaveCount(0);
        // The won group stays folded, in its config too (sent with the next group read).
        expect(won.isFolded).toBe(true);
        expect(won.config.isFolded).toBe(true);
        expect(lead1.group).toBe(won);

        // The card moves out of the folded stage, through the same framework move.
        const qualified = groupOf(renderer, 2);
        await chooseStage("Lead 1", 2);
        expect.verifySteps([
            { moveRecords: [[lead1.id], null, qualified.id] },
            "crm.lead/web_save",
        ]);
        expect(lead1.group).toBe(qualified);
        expectHeader("Qualified", 2, 130);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);
        // One coalesced entry for the lead, now carrying the last stage.
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args).toEqual([[1], { stage_id: 2 }]);
        expect(renderer.stageCount(won)).toBe(1);
        expect(renderer.stageRevenueValue(won)).toBe(50);
        expect(won.isFolded).toBe(true);
        await runAllTimers();
        expect.verifySteps([]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a move the framework does not make changes nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            async moveRecords() {
                expect.step("moveRecords (not made)");
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;

        await chooseStage("Lead 1", 2);
        expect.verifySteps(["moveRecords (not made)"]);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(renderer.stageCount(groupOf(renderer, 2))).toBe(1);
        expect(renderer.stageRevenueValue(groupOf(renderer, 2))).toBe(30);
        expect(recordOf(renderer, 1).group.serverValue).toBe(1);
        expect(queued()).toHaveLength(0);
        // A move into the group that already holds the card is not even attempted.
        await renderer.onCardMove(recordOf(renderer, 1), groupOf(renderer, 1));
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a lead opened from its pipeline card keeps a read-only chatter and editable notes offline", async () => {
        const { pyEnv, mailTemplateId } = await seedLeadThread();
        const setOffline = mockOffline();
        // Registered after the offline mock, the watcher also steps what it answers with a 502:
        // any chatter write, online or offline, fails the final `verifySteps`.
        watchRpcs(MAIL_WRITES);
        const chatters = captureInstances(Chatter);
        const followerLists = captureInstances(FollowerList);
        const followers = captureInstances(Follower);
        const subtypeDialogs = captureInstances(FollowerSubtypeDialog);
        const activities = captureInstances(Activity);
        const markDonePopovers = captureInstances(ActivityMarkAsDone);
        const assignPopovers = captureInstances(ActivityAssignPopover);
        const mailTemplates = captureInstances(ActivityMailTemplate);
        const scheduledMessages = captureInstances(ScheduledMessage);
        const composers = captureInstances(Composer);
        const messageActions = captureInstances(MessageAction);
        const quickReactionMenus = captureInstances(QuickReactionMenu);
        const reactionLists = captureInstances(MessageReactionList);
        const reactionMenus = captureInstances(MessageReactionMenu);
        const htmlFields = captureInstances(HtmlField);
        await start();
        await getService("action").doAction(CHATTER_PIPELINE_ACTION_ID);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);

        // Online, the lead is opened from its card: its form, notes and thread are loaded.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        await mailContains(".o-mail-Message:contains('Hello lead')");
        await mailContains(".o-mail-Activity");
        await mailContains(".o-mail-Scheduled-Message");
        await mailContains(".o-mail-MessageReaction:contains('👍')");
        await mailContains(".o_field_widget[name=description] [contenteditable='true']");
        const chatter = leadInstance(chatters, (c) => c.threadModel(), "Chatter");
        const thread = chatter.state.thread;
        expect(thread.attachments).toHaveLength(1);

        // Online, every overlay is opened once, so each component holding a mutation exists:
        // the composer (with a draft), the follower list, the mark-done and assign popovers, the
        // subtype dialog and the reaction menu.
        await contains(".o-mail-Chatter-sendMessage").click();
        await mailContains(".o-mail-Composer-input");
        await insertText(".o-mail-Composer-input", "Draft written online");
        // The message's first action, "Add a Reaction", is its quick reaction menu.
        await mailContains(".o-mail-Message .o-mail-QuickReactionMenu-toggler");
        await contains(".o-mail-Followers-button").click();
        await mailContains(".o-mail-Follower:contains('Follower Partner')");
        const followerList = leadInstance(
            followerLists,
            (f) => f.props.thread?.model,
            "FollowerList"
        );
        const otherFollower = leadInstance(
            followers.filter((f) => f.props.follower.partner_id?.name === "Follower Partner"),
            (f) => f.props.follower.thread?.model,
            "Follower"
        );
        await contains(".o-mail-Activity-markDone").click();
        await mailContains(".o-mail-ActivityMarkAsDone");
        await contains(".o-mail-Activity-assign").click();
        await mailContains(".o-mail-ActivityAssignPopover");
        await otherFollower.onClickEdit();
        await mailContains(".o-mail-FollowerSubtypeDialog");
        const messageActionOwners = leadMessageActionsByOwner(messageActions);
        const reactionsAction = [...messageActionOwners.values()]
            .flat()
            .find(
                (action) => action.id === "reactions" && action.owner.constructor.name === "Message"
            );
        reactionsAction.onSelected();
        await mailContains(".o-mail-MessageReactionMenu");
        expect(".o-mail-Chatter .o-mail-Composer").toHaveCount(1);
        expect(".o-mail-ActivityAssignPopover").toHaveCount(1);
        expect(".o-mail-FollowerSubtypeDialog").toHaveCount(1);
        expect.verifySteps([]);

        await setOffline(true);
        await animationFrame();
        // Every overlay left open closes when the connection drops.
        expect(".o-mail-Chatter .o-mail-Composer").toHaveCount(0);
        expect(".o-mail-FollowerSubtypeDialog").toHaveCount(0);
        expect(".o-mail-MessageReactionMenu").toHaveCount(0);
        expect(".o-mail-ActivityAssignPopover").toHaveCount(0);
        expect(".modal").toHaveCount(0);
        expect(chatter.isDisabled).toBe(true);

        chatter.toggleComposer("message");
        chatter.toggleComposer("note");
        await chatter.scheduleActivity();
        chatter.onAddFollowers();
        expect(await chatter.onClickAttachFile()).toBe(false);
        const uploadedData = { data: "aGVsbG8=", name: "offline.txt", type: "text/plain" };
        expect(chatter.onUploaded({ thread })(uploadedData)).toBe(undefined);
        chatter.state.selectedAttachmentIds = thread.attachments.map(({ id }) => id);
        chatter.onClickDeleteSelectedAttachments();
        await chatter.unlinkAttachments(thread.attachments);
        await followerList.onClickFollow();
        await followerList.onClickUnfollow();
        followerList.onClickAddFollowers();
        await followerList.onClickEdit();
        await otherFollower.onClickRemove();
        await otherFollower.onClickEdit();
        // FollowerSubtypeDialog, opened online.
        const subtypeDialog = leadInstance(
            subtypeDialogs,
            (d) => d.props.follower.thread?.model,
            "FollowerSubtypeDialog"
        );
        await subtypeDialog.updateSubscription();
        await subtypeDialog.onClickUpdateAll();
        // Activity, and its mark-done popover, assign popover and mail templates.
        const activity = leadInstance(activities, (a) => a.activity()?.res_model, "Activity");
        activity.onClickMarkAsDone({ currentTarget: queryOne(".o-mail-Activity") });
        activity.onClickAssign({ currentTarget: queryOne(".o-mail-Activity") });
        await activity.onClickMail();
        await activity.onFileUploaded(uploadedData);
        await activity.edit();
        const markDone = leadInstance(
            markDonePopovers,
            (p) => p.activity()?.res_model,
            "ActivityMarkAsDone"
        );
        await markDone.onClickDone();
        await markDone.onClickDoneAndScheduleNext();
        const assignPopover = leadInstance(
            assignPopovers,
            (p) => p.activity()?.res_model,
            "ActivityAssignPopover"
        );
        await assignPopover.onClickAssign();
        const mailTemplate = leadInstance(
            mailTemplates,
            (m) => m.activity()?.res_model,
            "ActivityMailTemplate"
        );
        const [template] = pyEnv["mail.template"].search_read([["id", "=", mailTemplateId]]);
        mailTemplate.onClickPreview(NO_EVENT, template);
        await mailTemplate.onClickSend(NO_EVENT, template);
        const scheduledMessage = leadInstance(
            scheduledMessages,
            (s) => s.props.scheduledMessage.thread?.model,
            "ScheduledMessage"
        );
        await scheduledMessage.cancel();
        await scheduledMessage.onClickAttachmentUnlink(thread.attachments);
        scheduledMessage.onClickCancel();
        await scheduledMessage.onClickEdit();
        await scheduledMessage.onClickSendNow();
        // Composer, holding the draft written online.
        const composer = leadInstance(composers, (c) => c.thread?.model, "Composer");
        await composer.sendMessage();
        await composer.editMessage();
        // Reactions: the quick reaction menu, the reaction list and the reaction menu.
        const quickReactionMenu = leadInstance(
            quickReactionMenus,
            (q) => q.props.message?.thread?.model,
            "QuickReactionMenu"
        );
        quickReactionMenu.toggleReaction("👍");
        quickReactionMenu.toggleReaction("🤣");
        quickReactionMenu.onClick();
        const reactionList = leadInstance(
            reactionLists,
            (r) => r.message()?.thread?.model,
            "MessageReactionList"
        );
        reactionList.onClickReaction(NO_EVENT, {
            messageAtRender: reactionList.message(),
            reactionAtRender: reactionList.reaction(),
        });
        leadInstance(reactionMenus, (r) => r.props.message?.thread?.model, "MessageReactionMenu");
        // MessageAction: none is listed for a lead message, and each selection is inert.
        const ownersOffline = leadMessageActionsByOwner(messageActions);
        expect(ownersOffline.size).toBeGreaterThan(0);
        for (const [owner, actions] of ownersOffline) {
            if (owner.constructor.name === "Message") {
                expect(owner.messageActions.actions).toHaveLength(0);
            }
            for (const action of actions) {
                expect(action.onSelected()).toBe(true, { message: action.id });
            }
        }
        await animationFrame();
        expect(".o-mail-Chatter .o-mail-Composer").toHaveCount(0);
        expect(".o-mail-ActivityMarkAsDone").toHaveCount(0);
        expect(".o-mail-ActivityAssignPopover").toHaveCount(0);
        expect(".o-EmojiPicker").toHaveCount(0);
        expect(".o-mail-MessageReaction:contains('🤣')").toHaveCount(0);
        expect(".o-mail-Scheduled-Message").toHaveCount(1);
        expect(".modal").toHaveCount(0);
        expect(queued()).toHaveLength(0);
        expect.verifySteps([]);

        // HtmlField: the lead notes stay editable offline, and the form saves through the queue.
        leadInstance(htmlFields, (h) => h.props.record?.resModel, "HtmlField");
        const notes = ".o_field_widget[name=description] [contenteditable='true']";
        expect(notes).toHaveAttribute("data-available-offline", "1");
        expect(notes).not.toHaveClass("o_disabled_offline");
        await contains(".o_field_widget[name=name] input").edit("Lead 1 (offline)");
        await contains(".o_form_button_save").click();
        // The framework tries the lead save, which the lost connection turns into a queued one.
        expect.verifySteps(["crm.lead/web_save"]);
        expect(queuedCalls("crm.lead", "web_save").map(({ args }) => args)).toEqual([
            [[1], { name: "Lead 1 (offline)" }],
        ]);
        expect(queued()).toHaveLength(1);
        expect(".modal").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a replayed pending create keeps its card until the reconciliation reload, but its badge clears with its queue entry", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // Each lead create replay is held until the test resolves it.
        const replays = [];
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`replay ${args[1].name}`);
            const deferred = Promise.withResolvers();
            replays.push(deferred);
            await deferred.promise;
        });
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);

        const quickCreate = async (name) => {
            await contains(".o_crm_mobile_pipeline_add").click();
            await fillQuickCreate({ name, expected_revenue: "10" });
            await contains(".o_crm_mobile_quick_create_save").click();
            await advanceTime(1000);
            return queued().find(({ value }) => value.args[1].name === name).key;
        };
        const pendingCard = (key) => `.o_crm_mobile_lead_card[data-pending-key='${key}']`;
        const keyA = await quickCreate("Pending A");
        const keyB = await quickCreate("Pending B");
        expect(`${pendingCard(keyA)} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(`${pendingCard(keyB)} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expectHeader("New", 4, 140);

        // Reconnect: A is replayed while B's replay is still in flight. The sync window keeps
        // both cards and the totals, but A's entry has left the live queue: its badge is gone.
        await setOffline(false);
        await expect.waitForSteps(["replay Pending A"]);
        replays.shift().resolve();
        await letQueueReplay(1);
        expect.verifySteps(["replay Pending B"]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(queued().map(({ key }) => String(key))).toEqual([String(keyB)]);
        expect(pendingCard(keyA)).toHaveCount(1);
        expect(pendingCard(keyA)).toHaveClass("o_crm_mobile_lead_card_pending");
        expect(`${pendingCard(keyA)} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(`${pendingCard(keyB)} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expectHeader("New", 4, 140);

        // B is replayed and the reconciliation reload lands: both leads are server cards.
        replays.shift().resolve();
        await letQueueReplay(1);
        expect(getService(OfflinePlugin).syncingORM()).toBe(false);
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(".o_crm_mobile_pending_badge").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Pending A", "Pending B"]);
        expect(cardOf("Pending A")).toHaveAttribute("data-id");
        expect(cardOf("Pending B")).toHaveAttribute("data-id");
        expectHeader("New", 4, 140);
    });

    test.tags("mobile");
    test("mobile: pending activity markers read the queue once per queue change and follow every change", async () => {
        const [firstId, secondId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Call back" },
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send terms" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const card = cardOf("Lead 1");
        const row = (id) => `${card} .o_crm_mobile_activity_row[data-activity-id='${id}']`;
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(3);
        expect(`${card} .o_crm_mobile_activity_done`).toHaveCount(3);
        expect(`${card} .o_crm_mobile_pending_badge`).toHaveCount(0);

        // From now on, every read of the shared activity queue reader by Lead 1's card is a step.
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && instance.__owl__.status === 1
        );
        patchWithCleanup(lead1Card.crmOffline, {
            pendingActivityCalls(resId) {
                expect.step(`pendingActivityCalls ${resId}`);
                return super.pendingActivityCalls(resId);
            },
        });

        // Re-rendering the list without a queue change reads nothing again.
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(3);
        expect.verifySteps([]);

        // Each queued mark-done is one read for the whole card (count, rows and their badges),
        // whatever the number of rows.
        await contains(`${row(firstId)} .o_crm_mobile_activity_done`).click();
        expect.verifySteps(["pendingActivityCalls 1"]);
        expect(`${row(firstId)} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(`${row(firstId)} .o_crm_mobile_activity_done`).toHaveCount(0);
        expect(`${card} .o_crm_mobile_activity_done`).toHaveCount(2);
        await advanceTime(1000);
        await contains(`${row(secondId)} .o_crm_mobile_activity_done`).click();
        expect.verifySteps(["pendingActivityCalls 1"]);
        expect(`${card} .o_crm_mobile_activity_row .o_crm_mobile_pending_badge`).toHaveCount(2);
        expect(`${card} .o_crm_mobile_activity_done`).toHaveCount(1);

        // Removing the first entry from the queue (as a systray discard does) restores its
        // Mark done at once; the second stays pending.
        const firstKey = queued().find(({ value }) => value.args[0][0] === firstId).key;
        getService(OfflinePlugin).removeScheduledORM(firstKey);
        await animationFrame();
        expect.verifySteps(["pendingActivityCalls 1"]);
        expect(queued()).toHaveLength(1);
        expect(`${row(firstId)} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(`${row(firstId)} .o_crm_mobile_activity_done`).toHaveCount(1);
        expect(`${row(secondId)} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(`${card} .o_crm_mobile_activity_done`).toHaveCount(2);
    });
});

// -----------------------------------------------------------------------------
// Mobile quick create
// -----------------------------------------------------------------------------

const QUICK_CREATE_FIELDS = [
    "name",
    "contact_name",
    "phone",
    "email_from",
    "expected_revenue",
    "stage_id",
];

/**
 * Sets the value of a date input as a user picking a date does (Hoot types keys, which a date
 * input does not take character by character).
 *
 * @param {string} selector
 * @param {string} value a `YYYY-MM-DD` date, or an empty string to clear it
 */
async function setDateInput(selector, value) {
    const input = queryOne(selector);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await animationFrame();
}

/** @returns {HTMLElement[]} the controls of the open quick create, in document order */
function quickCreateControls() {
    return queryAll(".o_crm_mobile_quick_create [name]");
}

/**
 * @returns {string[]} the labels of the open quick create, in document order, without their
 *   `aria-hidden` content (the required marker): the names assistive technologies give the controls
 */
function quickCreateLabelNames() {
    return queryAll(".o_crm_mobile_quick_create label").map((label) =>
        [...label.childNodes]
            .filter((node) => !(node instanceof Element && node.ariaHidden === "true"))
            .map((node) => node.textContent)
            .join("")
            .trim()
    );
}

describe("Mobile quick create", () => {
    test.tags("mobile");
    test("mobile: quick create bottom sheet has exactly six offline-available fields and queues a create", async () => {
        // offline, Qualified is displayed: the types are cached (Lead 3's activities are not)
        const errors = cachedReadErrors([TYPES]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_save"]);
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline({ selectRecord: (resId) => expect.step(`open ${resId}`) });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);

        await contains(".o_crm_mobile_pipeline_add").click();
        expect(sheets).toHaveLength(1);
        expect(".o_bottom_sheet .o_crm_mobile_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_quick_create h4").toHaveText("New Lead");
        // Exactly six labelled controls, in this order, all usable offline.
        const controls = quickCreateControls();
        expect(controls.map((el) => el.getAttribute("name"))).toEqual(QUICK_CREATE_FIELDS);
        expect(quickCreateLabelNames()).toEqual([
            "Lead Name",
            "Contact Name",
            "Phone",
            "Email",
            "Expected Revenue",
            "Stage",
        ]);
        for (const el of controls) {
            expect(el).toHaveAttribute("data-available-offline");
            expect(el).not.toHaveAttribute("disabled");
            expect(el).not.toHaveClass("o_disabled_offline");
            expect(el.getBoundingClientRect().height >= 44).toBe(true, {
                message: `${el.getAttribute("name")} is at least 44px high`,
            });
        }
        // Theme corners: every input keeps the stage select's corner, which the framework input
        // reset would strip from the text, tel, email and number inputs.
        const selectRadius = getComputedStyle(
            queryOne(".o_crm_mobile_quick_create select[name=stage_id]")
        ).borderTopLeftRadius;
        expect(selectRadius).not.toBe("0px");
        for (const el of controls) {
            expect(getComputedStyle(el).borderTopLeftRadius).toBe(selectRadius, {
                message: `${el.getAttribute("name")} has the theme corner`,
            });
        }
        expect(".o_crm_mobile_quick_create [name=phone]").toHaveAttribute("type", "tel");
        expect(".o_crm_mobile_quick_create [name=email_from]").toHaveAttribute("type", "email");
        expect(".o_crm_mobile_quick_create [name=expected_revenue]").toHaveAttribute(
            "type",
            "number"
        );
        expect(".o_crm_mobile_quick_create [name=expected_revenue]").toHaveAttribute(
            "inputmode",
            "decimal"
        );
        expect(queryAllTexts(".o_crm_mobile_quick_create select[name=stage_id] option")).toEqual([
            "New",
            "Qualified",
            "Proposition",
            "Won",
        ]);
        expect(
            queryOne(".o_crm_mobile_quick_create select[name=stage_id]").selectedOptions[0]
        ).toHaveText("New");
        for (const selector of [
            ".o_crm_mobile_quick_create_save",
            ".o_crm_mobile_quick_create_discard",
        ]) {
            const button = queryOne(selector);
            expect(button).toHaveAttribute("data-available-offline");
            expect(button).not.toHaveAttribute("disabled");
            expect(button.getBoundingClientRect().height >= 44).toBe(true, {
                message: `${selector} is at least 44px high`,
            });
        }

        // An empty name: an inline error, nothing queued.
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveText("The lead name is required.");
        // The darker danger utility: text-danger falls below 4.5:1 on the sheet background.
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveClass([
            "text-danger-emphasis",
            "small",
        ]);
        expect(".o_crm_mobile_quick_create [name=name]").toHaveAttribute("aria-invalid", "true");
        expect(queued()).toHaveLength(0);

        // The six values, offline: one queued create, in the chosen stage.
        await fillQuickCreate({
            name: "Mobile lead",
            contact_name: "Ross Geller",
            phone: "+32 555 06",
            email_from: "ross@example.com",
            expected_revenue: "75",
            stage_id: "Qualified",
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queued()).toHaveLength(1);
        const [{ key, value }] = queued();
        expect(value.model).toBe("crm.lead");
        expect(value.method).toBe("web_save");
        expect(value.args).toEqual([
            [],
            {
                name: "Mobile lead",
                contact_name: "Ross Geller",
                phone: "+32 555 06",
                email_from: "ross@example.com",
                expected_revenue: 75,
                stage_id: 2,
            },
        ]);
        expect(Object.keys(value.args[1]).sort()).toEqual([...QUICK_CREATE_FIELDS].sort());
        expect(value.kwargs.specification).toEqual({});
        expect(value.kwargs.context.default_stage_id).toBe(2);
        expect(value.extras.viewType).toBe("kanban");
        expect(value.extras.actionId).toBe(PIPELINE_ACTION_ID);
        expect(value.extras.displayName).toBe("Mobile lead");
        expect(value.extras.changes.stage_id).toEqual({ id: 2, display_name: "Qualified" });
        // The chosen stage is displayed at once, as after a card move, with the pending card.
        expectHeader("Qualified", 2, 105);
        const pending = `.o_crm_mobile_lead_card[data-pending-key='${key}']`;
        expect(pending).toHaveCount(1);
        expect(`${pending} .o_crm_mobile_lead_card_name`).toHaveText("Mobile lead");
        expect(`${pending} .o_crm_mobile_lead_card_partner`).toHaveText("Ross Geller");
        expect(`${pending} .o_crm_mobile_lead_card_revenue`).toHaveText(formatCardRevenue(75));
        expect(`${pending} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        // A pending lead has no server id: no control at all, and nothing to open.
        expect(`${pending} button`).toHaveCount(0);
        await contains(`${pending} .o_crm_mobile_lead_card_name`).click();
        expect.verifySteps([]);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Not created" });
        await contains(".o_crm_mobile_quick_create_discard").click();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queued()).toHaveLength(1);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: quick create online uses the id from the webSave result", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`web_save ${JSON.stringify(args)}`);
            if (args[1].name === "Rejected lead") {
                throw makeServerError({ message: "This lead name is reserved" });
            }
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate(recordId, mode, group) {
                expect.step({ validateQuickCreate: [recordId, mode, group.serverValue] });
                return super.validateQuickCreate(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Online lead", expected_revenue: "60" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [created] = MockServer.env["crm.lead"].search_read([["name", "=", "Online lead"]]);
        expect.verifySteps([
            `web_save [[],{"name":"Online lead","contact_name":false,"phone":false,"email_from":false,"expected_revenue":60,"stage_id":1}]`,
            { validateQuickCreate: [created.id, "close", 1] },
        ]);
        expect(created.stage_id[0]).toBe(1);
        // Added to its stage as the framework quick create adds a record, nothing queued.
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queued()).toHaveLength(0);
        expect(cardOf("Online lead")).toHaveCount(1);
        expect(cardOf("Online lead")).toHaveAttribute("data-id");
        expect(`${cardOf("Online lead")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expectHeader("New", 3, 180);

        // The chosen stage survives a reload of the pipeline while the sheet is open (the groups
        // are rebuilt with new ids): the lead goes to the live group of that stage.
        const [renderer] = renderers;
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "After reload", stage_id: "Qualified" });
        const qualifiedBefore = groupOf(renderer, 2);
        await renderer.props.list.load();
        await animationFrame();
        const qualifiedAfter = groupOf(renderer, 2);
        expect(qualifiedAfter).not.toBe(qualifiedBefore);
        expect(
            queryOne(".o_crm_mobile_quick_create select[name=stage_id]").selectedOptions[0]
        ).toHaveText("Qualified");
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [afterReload] = MockServer.env["crm.lead"].search_read([
            ["name", "=", "After reload"],
        ]);
        expect.verifySteps([
            `web_save [[],{"name":"After reload","contact_name":false,"phone":false,"email_from":false,"expected_revenue":0,"stage_id":2}]`,
            { validateQuickCreate: [afterReload.id, "close", 2] },
        ]);
        expect(afterReload.stage_id[0]).toBe(2);
        // The stage the lead went to is displayed, with its card.
        expectHeader("Qualified", 2, 30);
        expect(cardOf("After reload")).toHaveCount(1);

        // A server error leaves the sheet open with its values, ready for another try, and the
        // displayed stage (where the sheet opened) as it is.
        expect.errors(1);
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Rejected lead", stage_id: "New" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([
            `web_save [[],{"name":"Rejected lead","contact_name":false,"phone":false,"email_from":false,"expected_revenue":0,"stage_id":1}]`,
        ]);
        expect.verifyErrors(["This lead name is reserved"]);
        await contains(".modal .modal-footer .btn-primary").click();
        expectHeader("Qualified", 2, 30);
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_quick_create [name=name]").toHaveValue("Rejected lead");
        expect(".o_crm_mobile_quick_create_save").not.toHaveAttribute("disabled");
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: quick create whose connection drops during the call queues the create", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const connection = mockConnectionDrop();
        watchRpcs(["crm.lead/web_save"]);
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate() {
                expect.step("validateQuickCreate");
                return super.validateQuickCreate(...arguments);
            },
        });
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Dropped lead", expected_revenue: "25" });
        connection.offline = true;
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        // The call was attempted, failed with a lost connection, and was queued instead.
        expect.verifySteps(["crm.lead/web_save"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args).toEqual([
            [],
            {
                name: "Dropped lead",
                contact_name: false,
                phone: false,
                email_from: false,
                expected_revenue: 25,
                stage_id: 1,
            },
        ]);
        expect(saves[0].extras.viewType).toBe("kanban");
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expect(".o_crm_mobile_lead_card_pending .o_crm_mobile_lead_card_name").toHaveText(
            "Dropped lead"
        );
        expect(".o_crm_mobile_lead_card_pending .o_crm_mobile_pending_badge").toHaveCount(1);
        expectHeader("New", 3, 145);
        expect(MockServer.env["crm.lead"].search_read([["name", "=", "Dropped lead"]])).toEqual([]);
    });

    const NAME_ERROR = "The lead name is required.";
    const EMAIL_ERROR = "The email address is not valid.";
    const REVENUE_ERROR = "The expected revenue must be a number.";

    /**
     * Asserts the inline error of a quick-create field and its association with the input.
     *
     * @param {string} name the control name
     * @param {string} message
     */
    function expectFieldError(name, message) {
        const errorId = `o_crm_mobile_quick_create_${name}_error`;
        const input = `.o_crm_mobile_quick_create [name=${name}]`;
        expect(`.o_crm_mobile_quick_create #${errorId}`).toHaveText(message);
        expect(`.o_crm_mobile_quick_create #${errorId}`).toHaveAttribute("role", "alert");
        expect(`.o_crm_mobile_quick_create #${errorId}`).toHaveClass("text-danger-emphasis");
        expect(input).toHaveAttribute("aria-invalid", "true");
        expect(input).toHaveAttribute("aria-describedby", errorId);
        expect(input).toHaveClass("is-invalid");
    }

    /** @param {string} name the control name of a field shown without an error */
    function expectNoFieldError(name) {
        const input = `.o_crm_mobile_quick_create [name=${name}]`;
        expect(`#o_crm_mobile_quick_create_${name}_error`).toHaveCount(0);
        expect(input).not.toHaveAttribute("aria-invalid");
        expect(input).not.toHaveAttribute("aria-describedby");
        expect(input).not.toHaveClass("is-invalid");
    }

    /**
     * @param {CrmMobilePipeline} renderer
     * @returns {Array<number | false>} the stage id of each group of the renderer's list
     */
    function stageValues(renderer) {
        return renderer.props.list.groups.map((group) => group.serverValue);
    }

    /**
     * @param {string} name
     * @returns {Object[]} the leads of that name on the server
     */
    function leadsNamed(name) {
        return MockServer.env["crm.lead"].search_read([["name", "=", name]]);
    }

    /**
     * @param {Object} values the values a quick create writes besides its name
     * @returns {Object} the six values written, empty ones as the sheet sends them
     */
    function leadVals(values) {
        return {
            contact_name: false,
            phone: false,
            email_from: false,
            expected_revenue: 0,
            stage_id: 1,
            ...values,
        };
    }

    /**
     * Holds every `crm.lead` `web_save` until `release()`, stepping `{ web_save: vals }` when
     * the request arrives. With `afterCreate`, the lead is created on the server at once and only
     * the answer is held. With `answer`, the released request is answered by what it returns (a
     * `Response` included) or fails with what it throws, and no lead is created.
     *
     * @param {{ afterCreate?: boolean, answer?: () => unknown }} [options]
     * @returns {{ release: () => void }}
     */
    function holdLeadSaves({ afterCreate = false, answer } = {}) {
        const held = Promise.withResolvers();
        onRpc("crm.lead", "web_save", async ({ args, parent }) => {
            expect.step({ web_save: args[1] });
            if (afterCreate) {
                const result = await parent();
                await held.promise;
                return result;
            }
            await held.promise;
            return answer?.();
        });
        return { release: () => held.resolve() };
    }

    /**
     * Steps every `validateQuickCreate` call of the pipeline as `{ validateQuickCreate: [id,
     * mode, stage id] }`, and collects the groups it receives.
     *
     * @param {{ error?: Error }} [options] an error each call throws after stepping
     * @returns {Object[]} the groups received, in call order
     */
    function watchValidateQuickCreate({ error } = {}) {
        const groups = [];
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate(recordId, mode, group) {
                expect.step({ validateQuickCreate: [recordId, mode, group.serverValue] });
                groups.push(group);
                if (error) {
                    throw error;
                }
                return super.validateQuickCreate(...arguments);
            },
        });
        return groups;
    }

    test.tags("mobile");
    test("mobile: quick create rejects a malformed email or expected revenue with associated inline errors and sends nothing; a negative revenue is written as typed", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // Online, a malformed email and an overflowing number: both errors at once, nothing sent.
        await contains(".o_crm_mobile_pipeline_add").click();
        const [sheet] = sheets;
        await fillQuickCreate({ name: "Checked lead", email_from: "not-an-email" });
        sheet.state.expected_revenue = "1e400";
        await animationFrame();
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(2);
        expectFieldError("email_from", EMAIL_ERROR);
        expectFieldError("expected_revenue", REVENUE_ERROR);
        expectNoFieldError("name");
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_quick_create_save").not.toHaveAttribute("disabled");

        // A partly numeric text, through a direct call (a number input never holds one).
        sheet.state.expected_revenue = "12junk";
        await sheet.save();
        await animationFrame();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(2);
        expectFieldError("expected_revenue", REVENUE_ERROR);

        // A valid email clears its own error only; a lone sign is still rejected.
        await fillQuickCreate({ email_from: "checked@example.com" });
        sheet.state.expected_revenue = "-";
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(1);
        expectNoFieldError("email_from");
        expectFieldError("expected_revenue", REVENUE_ERROR);

        // A text the browser cannot parse: the number input reports an empty value.
        sheet.state.expected_revenue = "";
        await animationFrame();
        const revenueInput = queryOne(".o_crm_mobile_quick_create [name=expected_revenue]");
        Object.defineProperty(revenueInput, "validity", {
            configurable: true,
            value: { badInput: true },
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(1);
        expectFieldError("expected_revenue", REVENUE_ERROR);
        delete revenueInput.validity;
        expect.verifySteps([]);
        expect(leadsNamed("Checked lead")).toEqual([]);

        // An empty email and an empty revenue are valid: false and 0 are written.
        await fillQuickCreate({ email_from: "" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([{ web_save: leadVals({ name: "Checked lead" }) }]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(sheet.state.errors).toEqual({ name: "", email_from: "", expected_revenue: "" });

        // A complete number in exponent notation is accepted.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Exponent lead", email_from: "exp@example.com" });
        sheets.at(-1).state.expected_revenue = "1.5e2";
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([
            {
                web_save: leadVals({
                    name: "Exponent lead",
                    email_from: "exp@example.com",
                    expected_revenue: 150,
                }),
            },
        ]);

        // A negative number is a valid expected revenue: it is sent as typed, with no error.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Negative lead" });
        // Entered at once: a lone "-" typed on the way is not a number the input can hold.
        await contains(".o_crm_mobile_quick_create [name=expected_revenue]").edit("-5", {
            confirm: false,
            instantly: true,
        });
        expect(".o_crm_mobile_quick_create [name=expected_revenue]").not.toHaveAttribute("min");
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([
            { web_save: leadVals({ name: "Negative lead", expected_revenue: -5 }) },
        ]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(leadsNamed("Negative lead")[0].expected_revenue).toBe(-5);

        // Offline, the same rules: a malformed email is rejected and nothing is queued, while the
        // negative revenue shows no error; once the email is valid, the create is queued with it.
        await setOffline(true);
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Offline checked", email_from: "still wrong" });
        sheets.at(-1).state.expected_revenue = "-0.5";
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(1);
        expectFieldError("email_from", EMAIL_ERROR);
        expectNoFieldError("expected_revenue");
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(queued()).toHaveLength(0);
        expect.verifySteps([]);
        await fillQuickCreate({ email_from: "offline@example.com" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queuedCalls("crm.lead", "web_save").map((call) => call.args)).toEqual([
            [
                [],
                leadVals({
                    name: "Offline checked",
                    email_from: "offline@example.com",
                    expected_revenue: -0.5,
                }),
            ],
        ]);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: quick create keeps a revenue text the browser cannot parse and rejects it on Save", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        const [sheet] = sheets;
        await fillQuickCreate({ name: "Typed lead", expected_revenue: "1" });
        expect(sheet.state.expected_revenue).toBe("1");

        // "e" typed next: the browser keeps "1e" in the input, reports an empty value and flags
        // `badInput`. A script cannot put a number input in that state, so the element stands in
        // for it; any value the component writes into the input is stepped.
        const revenueInput = queryOne(".o_crm_mobile_quick_create [name=expected_revenue]");
        Object.defineProperty(revenueInput, "value", {
            configurable: true,
            get: () => "",
            set: () => {
                expect.step("value written");
            },
        });
        Object.defineProperty(revenueInput, "validity", {
            configurable: true,
            value: { badInput: true },
        });
        try {
            revenueInput.dispatchEvent(new Event("input", { bubbles: true }));
            await animationFrame();
            expect(sheet.state.expected_revenue).toBe("");
            // The text is kept (nothing is written back), so Save sees it as invalid, not empty.
            await contains(".o_crm_mobile_quick_create_save").click();
            expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(1);
            expectFieldError("expected_revenue", REVENUE_ERROR);
            expect(".o_crm_mobile_quick_create").toHaveCount(1);
            expect(".o_crm_mobile_quick_create_save").not.toHaveAttribute("disabled");
            expect.verifySteps([]);
        } finally {
            delete revenueInput.value;
            delete revenueInput.validity;
        }
        expect(leadsNamed("Typed lead")).toEqual([]);

        // The complete exponent, entered through the input, is a number: 1e3 is saved as 1000.
        await contains(".o_crm_mobile_quick_create [name=expected_revenue]").edit("1e3", {
            confirm: false,
            instantly: true,
        });
        expect(sheet.state.expected_revenue).toBe("1e3");
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([
            { web_save: leadVals({ name: "Typed lead", expected_revenue: 1000 }) },
        ]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(sheet.state.errors).toEqual({ name: "", email_from: "", expected_revenue: "" });
    });

    test.tags("mobile");
    test("mobile: quick create errors clear as their field is corrected, invalid inputs are marked, the first takes the focus, and Lead Name shows an aria-hidden required marker", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        const [sheet] = sheets;
        const nameInput = queryOne(".o_crm_mobile_quick_create [name=name]");
        // A visual required marker, hidden from assistive technologies: the input is required.
        const marker =
            ".o_crm_mobile_quick_create label[for=o_crm_mobile_quick_create_name] > span";
        expect(marker).toHaveText("*");
        // The darker danger utility, as the inline errors: text-danger falls below 4.5:1.
        expect(marker).toHaveClass(["text-danger-emphasis", "ms-1"]);
        expect(marker).toHaveAttribute("aria-hidden", "true");
        expect(".o_crm_mobile_quick_create label span").toHaveCount(1);
        expect(nameInput).toHaveAttribute("required");

        // Nothing is checked before the first Save, whatever is typed.
        await fillQuickCreate({ email_from: "not-an-email" });
        sheet.state.expected_revenue = "12junk";
        await animationFrame();
        for (const name of ["name", "email_from", "expected_revenue"]) {
            expectNoFieldError(name);
        }
        // Only the name, the email and the revenue are checked, and only they take the focus.
        expect(sheet.getFieldError("contact_name")).toBe("");
        expect(sheet.getFieldInput("contact_name")).toBe(null);
        expect(sheet.getFieldInput("email_from")).toBe(
            queryOne(".o_crm_mobile_quick_create [name=email_from]")
        );

        // Save: every invalid field is marked, and the first of them, the name, takes the focus.
        await contains(".o_crm_mobile_quick_create_save").click();
        expectFieldError("name", NAME_ERROR);
        expectFieldError("email_from", EMAIL_ERROR);
        expectFieldError("expected_revenue", REVENUE_ERROR);
        expect(nameInput).toBeFocused();

        // A single character typed into the name is one input event, whose `t-model` handler
        // runs before the re-check: the error clears at once.
        nameInput.value = "A";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        await animationFrame();
        expect(sheet.state.name).toBe("A");
        expectNoFieldError("name");
        expectFieldError("email_from", EMAIL_ERROR);

        // An email still malformed keeps its error; emptied, it is valid and its error clears.
        const emailInput = queryOne(".o_crm_mobile_quick_create [name=email_from]");
        emailInput.value = "still-wrong";
        emailInput.dispatchEvent(new Event("input", { bubbles: true }));
        await animationFrame();
        expect(sheet.state.email_from).toBe("still-wrong");
        expectFieldError("email_from", EMAIL_ERROR);
        await contains(".o_crm_mobile_quick_create [name=email_from]").clear({ confirm: false });
        expectNoFieldError("email_from");
        expectFieldError("expected_revenue", REVENUE_ERROR);

        // The revenue corrected through its input clears its error.
        await contains(".o_crm_mobile_quick_create [name=expected_revenue]").edit("40", {
            confirm: false,
            instantly: true,
        });
        expectNoFieldError("expected_revenue");
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(0);

        // A field without an error gets none while typing: an emptied name, a malformed email.
        await contains(".o_crm_mobile_quick_create [name=name]").clear({ confirm: false });
        await contains(".o_crm_mobile_quick_create [name=email_from]").edit("bad", {
            confirm: false,
        });
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(0);
        expectNoFieldError("name");
        expectNoFieldError("email_from");

        // The next Save checks them again, and focuses the first invalid field each time.
        await contains(".o_crm_mobile_quick_create_save").click();
        expectFieldError("name", NAME_ERROR);
        expectFieldError("email_from", EMAIL_ERROR);
        expectNoFieldError("expected_revenue");
        expect(nameInput).toBeFocused();
        await fillQuickCreate({ name: "Corrected lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(".o_crm_mobile_quick_create [name=email_from]").toBeFocused();
        await fillQuickCreate({ email_from: "corrected@example.com" });
        sheet.state.expected_revenue = "12junk";
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(1);
        expectFieldError("expected_revenue", REVENUE_ERROR);
        expect(".o_crm_mobile_quick_create [name=expected_revenue]").toBeFocused();
        expect.verifySteps([]);

        // Corrected, the lead is created.
        await contains(".o_crm_mobile_quick_create [name=expected_revenue]").edit("40", {
            confirm: false,
            instantly: true,
        });
        expectNoFieldError("expected_revenue");
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([
            {
                web_save: leadVals({
                    name: "Corrected lead",
                    email_from: "corrected@example.com",
                    expected_revenue: 40,
                }),
            },
        ]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: quick create sends a single web_save while a save is pending", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves();
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Single lead", expected_revenue: "5" });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps([{ web_save: leadVals({ name: "Single lead", expected_revenue: 5 }) }]);
        expect(".o_crm_mobile_quick_create_save").toHaveAttribute("disabled");
        // A second save while the first is pending (a direct call: the button is disabled).
        await sheets[0].save();
        await animationFrame();
        expect.verifySteps([]);

        saves.release();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(leadsNamed("Single lead")).toHaveLength(1);
        expect(cardOf("Single lead")).toHaveCount(1);
        expectHeader("New", 3, 125);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: while a quick create saves, Save is busy with a spinner and every control is disabled; a server error makes them usable again", async () => {
        expect.errors(1);
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves({
            answer: () => {
                throw makeServerError({ message: "This lead name is reserved" });
            },
        });
        await mountPipeline();
        const save = ".o_crm_mobile_quick_create_save";
        const discard = ".o_crm_mobile_quick_create_discard";
        const spinner = `${save} i.oi.oi-spin`;
        /** @returns {HTMLElement[]} the six controls, Save and Discard */
        const sheetControls = () => [...quickCreateControls(), queryOne(save), queryOne(discard)];

        await contains(".o_crm_mobile_pipeline_add").click();
        expect(save).toHaveText("Save");
        expect(save).toHaveAttribute("aria-busy", "false");
        expect(spinner).toHaveCount(0);

        await fillQuickCreate({ name: "Busy lead", expected_revenue: "3" });
        await contains(save).click();
        expect.verifySteps([{ web_save: leadVals({ name: "Busy lead", expected_revenue: 3 }) }]);
        // Saving: Save is busy, and no control can be used, each keeping its offline marker and
        // its touch-target size.
        expect(save).toHaveText("Saving...");
        expect(save).toHaveAttribute("aria-busy", "true");
        expect(spinner).toHaveClass("me-1");
        expect(spinner).toHaveAttribute("data-icon", "autorenew");
        expect(spinner).toHaveAttribute("aria-hidden", "true");
        expect(quickCreateControls()).toHaveLength(6);
        for (const el of sheetControls()) {
            expect(el).toHaveAttribute("disabled");
            expect(el).toHaveAttribute("data-available-offline");
            expect(el.getBoundingClientRect().height >= 44).toBe(true, {
                message: `${el.getAttribute("name") ?? el.className} is at least 44px high`,
            });
        }

        // The server refuses the lead: its error is raised, and the sheet, still open with its
        // values, is usable again.
        saves.release();
        await animationFrame();
        expect.verifyErrors(["This lead name is reserved"]);
        await contains(".modal .modal-footer .btn-primary").click();
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(save).toHaveText("Save");
        expect(save).toHaveAttribute("aria-busy", "false");
        expect(spinner).toHaveCount(0);
        for (const el of sheetControls()) {
            expect(el).not.toHaveAttribute("disabled");
        }
        expect(".o_crm_mobile_quick_create [name=name]").toHaveValue("Busy lead");
        expect(leadsNamed("Busy lead")).toEqual([]);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: a lead created online while its sheet is dismissed still reaches the pipeline", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves();
        watchValidateQuickCreate();
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Dismissed lead", expected_revenue: "7" });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps([
            { web_save: leadVals({ name: "Dismissed lead", expected_revenue: 7 }) },
        ]);
        // Discard is disabled while the save runs; the sheet can still be dismissed.
        expect(".o_crm_mobile_quick_create_discard").toHaveAttribute("disabled");
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Dismissed lead")).toHaveCount(0);

        // The answer arrives after the dismissal: the card shows without a manual reload.
        saves.release();
        await animationFrame();
        const [created] = leadsNamed("Dismissed lead");
        expect.verifySteps([{ validateQuickCreate: [created.id, "close", 1] }]);
        expect(leadsNamed("Dismissed lead")).toHaveLength(1);
        expect(cardOf("Dismissed lead")).toHaveCount(1);
        expectHeader("New", 3, 127);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: the stage a quick-created lead goes to is displayed through the pipeline's shared stage, unless the answer has no id or the sheet was dismissed during the call", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        let held = null;
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`web_save ${args[1].name}`);
            await held?.promise;
            if (args[1].name === "Lead without id") {
                return [];
            }
        });
        const controllers = captureInstances(CrmMobilePipelineController);
        const renderers = captureInstances(CrmMobilePipeline);
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();
        const [controller] = controllers;

        // The sheet, opened with the pipeline's scope, sees the displayed stage that the
        // controller provides to the renderer through the env.
        await contains(".o_crm_mobile_pipeline_add").click();
        expect(sheets[0].env.crmMobileStage).toBe(controller.crmMobileStage);
        expect(renderers[0].stageState).toBe(controller.crmMobileStage);

        // Online, into another stage: once the lead is added, its stage is displayed with its card.
        await fillQuickCreate({
            name: "Qualified lead",
            expected_revenue: "5",
            stage_id: "Qualified",
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps(["web_save Qualified lead"]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(controller.crmMobileStage.serverValue).toBe(2);
        expectHeader("Qualified", 2, 35);
        expect(cardOf("Qualified lead")).toHaveCount(1);
        expect(`${cardOf("Qualified lead")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();

        // An answer without an id adds nothing, and the displayed stage stays.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Lead without id", stage_id: "Won" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps(["web_save Lead without id"]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expectHeader("Qualified", 2, 35);

        // Dismissed during the call: the lead reaches its stage, and the stage the user is on
        // stays displayed.
        held = Promise.withResolvers();
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({
            name: "Dismissed lead",
            expected_revenue: "4",
            stage_id: "Proposition",
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps(["web_save Dismissed lead"]);
        await press("Escape");
        await animationFrame();
        expect(status(sheets.at(-1))).toBe("destroyed");
        held.resolve();
        await animationFrame();
        expect(leadsNamed("Dismissed lead")).toHaveLength(1);
        expect(controller.crmMobileStage.serverValue).toBe(2);
        expectHeader("Qualified", 2, 35);
        await goToStage("Proposition");
        expect(cardOf("Dismissed lead")).toHaveCount(1);
        expectHeader("Proposition", 2, 44);
    });

    test.tags("mobile");
    test("mobile: a pipeline reload during a pending quick create adds the lead to the live group of its stage", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves();
        const validatedGroups = watchValidateQuickCreate();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({
            name: "Reloaded lead",
            expected_revenue: "10",
            stage_id: "Qualified",
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps([
            { web_save: leadVals({ name: "Reloaded lead", expected_revenue: 10, stage_id: 2 }) },
        ]);
        // The groups are rebuilt while the call runs.
        const qualifiedBefore = groupOf(renderer, 2);
        await renderer.props.list.load();
        await animationFrame();
        expect(groupOf(renderer, 2)).not.toBe(qualifiedBefore);

        saves.release();
        await animationFrame();
        const [created] = leadsNamed("Reloaded lead");
        expect.verifySteps([{ validateQuickCreate: [created.id, "close", 2] }]);
        expect(validatedGroups).toHaveLength(1);
        expect(validatedGroups[0] === groupOf(renderer, 2)).toBe(true, {
            message: "validateQuickCreate receives the live Qualified group",
        });
        expect(validatedGroups[0].id).not.toBe(qualifiedBefore.id);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        await goToStage("Qualified");
        expect(cardOf("Reloaded lead")).toHaveCount(1);
        expectHeader("Qualified", 2, 40);
    });

    test.tags("mobile");
    test("mobile: a lead that a reload loaded during the call is not added twice", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves({ afterCreate: true });
        watchValidateQuickCreate();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Preloaded lead", expected_revenue: "15" });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps([
            { web_save: leadVals({ name: "Preloaded lead", expected_revenue: 15 }) },
        ]);
        // The lead exists on the server, and a reload brings it in before the answer arrives.
        expect(leadsNamed("Preloaded lead")).toHaveLength(1);
        await renderers[0].props.list.load();
        await animationFrame();
        expect(cardOf("Preloaded lead")).toHaveCount(1);
        expectHeader("New", 3, 135);

        saves.release();
        await animationFrame();
        expect.verifySteps([]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Preloaded lead")).toHaveCount(1);
        expect(groupOf(renderers[0], 1).count).toBe(3);
        expectHeader("New", 3, 135);
    });

    test.tags("mobile");
    test("mobile: a lead whose stage is no longer listed when the call returns reloads the pipeline instead of being added", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves();
        watchValidateQuickCreate();
        watchRpcs([LEAD_GROUPS, "crm.lead/web_read"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({
            name: "Orphan lead",
            expected_revenue: "12",
            stage_id: "Qualified",
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps([
            { web_save: leadVals({ name: "Orphan lead", expected_revenue: 12, stage_id: 2 }) },
        ]);
        // While the call runs, a reload with a domain that leaves Qualified empty drops its group
        // (the framework keeps an emptied group only for a reload with the same parameters).
        await renderer.props.list.load({ domain: [["name", "!=", "Lead 3"]] });
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(stageValues(renderer)).toEqual([1, 3, 4]);

        // No live group for the stage written: the list is reloaded, nothing is created again.
        saves.release();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(leadsNamed("Orphan lead")).toHaveLength(1);
        // The reload, with the same domain, lists the stage again with the lead created.
        expect(stageValues(renderer)).toEqual([1, 2, 3, 4]);
        expect(groupOf(renderer, 2).count).toBe(1);
        await goToStage("Qualified");
        expect(cardNames()).toEqual(["Orphan lead"]);
        expectHeader("Qualified", 1, 12);
    });

    test.tags("mobile");
    test("mobile: when adding the created lead to the pipeline fails, the sheet still closes and nothing is created twice", async () => {
        expect.errors(1);
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        watchValidateQuickCreate({ error: new Error("The card could not be added") });
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Failing card" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [created] = leadsNamed("Failing card");
        expect.verifySteps([
            { web_save: leadVals({ name: "Failing card" }) },
            { validateQuickCreate: [created.id, "close", 1] },
        ]);
        expect.verifyErrors(["The card could not be added"]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(leadsNamed("Failing card")).toHaveLength(1);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: quick create sends missing values as false, and a web_save answer without an id adds nothing and closes the sheet", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
            return [];
        });
        watchValidateQuickCreate();
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        const [sheet] = sheets;
        sheet.state.name = "Answer without id";
        sheet.state.contact_name = null;
        sheet.state.phone = undefined;
        sheet.state.email_from = null;
        await sheet.save();
        await animationFrame();
        expect.verifySteps([{ web_save: leadVals({ name: "Answer without id" }) }]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Answer without id")).toHaveCount(0);
        expectHeader("New", 2, 120);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: quick create stage selection falls back to the remembered stage, the initial stage, then the first stage", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        const renderers = captureInstances(CrmMobilePipeline);
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();
        const [renderer] = renderers;
        const selectedStage = () =>
            queryOne(".o_crm_mobile_quick_create select[name=stage_id]").selectedOptions[0];

        await contains(".o_crm_mobile_pipeline_add").click();
        const [sheet] = sheets;
        await fillQuickCreate({ name: "Staged lead", stage_id: "Qualified" });
        expect(sheet.targetGroup.id).toBe(groupOf(renderer, 2).id);

        // An unknown selected id: the remembered stage, then the selection is re-synced.
        sheet.state.stageGroupId = "unknown";
        expect(sheet.targetGroup.id).toBe(groupOf(renderer, 2).id);
        await animationFrame();
        expect(sheet.state.stageGroupId).toBe(groupOf(renderer, 2).id);
        expect(selectedStage()).toHaveText("Qualified");

        // Consecutive reloads: the selection follows its stage each time.
        for (let reload = 0; reload < 2; reload++) {
            const before = groupOf(renderer, 2).id;
            await renderer.props.list.load();
            await animationFrame();
            expect(groupOf(renderer, 2).id).not.toBe(before);
            expect(sheet.state.stageGroupId).toBe(groupOf(renderer, 2).id);
            expect(selectedStage()).toHaveText("Qualified");
            expect(sheet.targetGroup.id).toBe(groupOf(renderer, 2).id);
        }

        // Neither the selected id nor the remembered stage is listed: the initial stage.
        sheet.state.stageGroupId = "unknown";
        sheet.selectedStageValue = 99;
        expect(sheet.targetGroup.id).toBe(groupOf(renderer, 1).id);
        await animationFrame();
        expect(selectedStage()).toHaveText("New");

        // The selected stage disappears in a reload (a domain without its only lead): the
        // selection moves to the first stage.
        await fillQuickCreate({ stage_id: "Qualified" });
        await renderer.props.list.load({ domain: [["stage_id", "!=", 2]] });
        await animationFrame();
        expect(stageValues(renderer)).toEqual([1, 3, 4]);
        expect(queryAllTexts(".o_crm_mobile_quick_create select[name=stage_id] option")).toEqual([
            "New",
            "Proposition",
            "Won",
        ]);
        expect(selectedStage()).toHaveText("New");
        expect(sheet.targetGroup.id).toBe(groupOf(renderer, 1).id);

        // The initial stage disappears too: the initial group itself is the last resort.
        await renderer.props.list.load({ domain: [["stage_id", "not in", [1, 2]]] });
        await animationFrame();
        expect(stageValues(renderer)).toEqual([3, 4]);
        expect(selectedStage()).toHaveText("Proposition");
        sheet.state.stageGroupId = "unknown";
        sheet.selectedStageValue = 99;
        expect(sheet.targetGroup.id).toBe(sheet.props.group.id);
        expect(sheet.targetGroup.serverValue).toBe(1);
        await animationFrame();
        expect(selectedStage()).toHaveText("Proposition");

        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([{ web_save: leadVals({ name: "Staged lead", stage_id: 3 }) }]);
    });

    test.tags("mobile");
    test("mobile: a queued quick create keeps its own copy of the stage context", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Detached lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const groupContext = groupOf(renderers[0], 1).context;
        const [save] = queuedCalls("crm.lead", "web_save");
        expect(save.kwargs.context).not.toBe(groupContext);
        expect(save.kwargs.context).toEqual(JSON.parse(JSON.stringify(groupContext)));
        expect(save.kwargs.context.default_stage_id).toBe(1);
        const queuedContext = JSON.stringify(save.kwargs.context);

        // A later change of the group context does not reach the call already queued.
        groupContext.default_stage_id = 3;
        groupContext.default_type = "lead";
        const [after] = queuedCalls("crm.lead", "web_save");
        expect(JSON.stringify(after.kwargs.context)).toBe(queuedContext);
        expect(after.kwargs.context.default_stage_id).toBe(1);

        // A group without a context: the call is queued without any group default (the
        // framework queue adds the user context only).
        groupOf(renderers[0], 1).config.context = undefined;
        expect(groupOf(renderers[0], 1).context).toBe(undefined);
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Contextless lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const contextless = queuedCalls("crm.lead", "web_save").find(
            (call) => call.args[1].name === "Contextless lead"
        );
        expect(contextless.args).toEqual([[], leadVals({ name: "Contextless lead" })]);
        expect(contextless.kwargs.context.default_stage_id).toBe(undefined);
        expect(queuedCalls("crm.lead", "web_save")).toHaveLength(2);
    });

    test.tags("mobile");
    test("mobile: quick create lists the stage-less group first, in the pipeline's stage order", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.lead"].create({ name: "Lead without stage", stage_id: false });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;

        await contains(".o_crm_mobile_pipeline_add").click();
        const options = queryAllTexts(".o_crm_mobile_quick_create select[name=stage_id] option");
        expect(options).toEqual(renderer.stageGroups.map((group) => group.displayName));
        expect(options).toEqual([
            groupOf(renderer, false).displayName,
            "New",
            "Qualified",
            "Proposition",
            "Won",
        ]);
    });

    test.tags("mobile");
    test("mobile: card open control is a labelled button reached by Tab, opened by Enter once; Space keeps its native activation", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            selectRecord: (resId) => expect.step(`open ${resId}`),
        });
        const [renderer] = renderers;
        const card = cardOf("Lead 1");
        const open = `${card} .o_crm_mobile_lead_card_open`;

        // A native button around the name, named by it, outside the action row, usable offline.
        expect(open).toHaveCount(1);
        expect(open).toHaveAttribute("type", "button");
        expect(open).toHaveAttribute("data-available-offline", "1");
        expect(open).toHaveText("Lead 1");
        expect(`${open} > .o_crm_mobile_lead_card_name`).toHaveCount(1);
        const actionRow = `${card} .o_crm_mobile_lead_card_actions`;
        expect(`${actionRow} .o_crm_mobile_lead_card_open`).toHaveCount(0);
        expectTouchTarget(queryOne(open), "open control");
        // The article stays out of the Tab order (the kanban Space hotkey selects a focused
        // record), and the name stays the first span of the card.
        expect(card).not.toHaveAttribute("tabindex");
        expect(card).not.toHaveAttribute("role");
        expect(queryFirst(`${card} span`)).toHaveClass("o_crm_mobile_lead_card_name");

        // Tab from the header reaches the first card's open control; Enter opens the lead, once.
        queryOne(".o_crm_mobile_pipeline_add").focus();
        await press("Tab");
        expect(open).toBeFocused();
        await press("Enter");
        await animationFrame();
        expect.verifySteps(["open 1"]);

        // Space and Shift+Space from the card's controls keep their default action (the native
        // button activation) and select no kanban record.
        let events = await press(" ");
        expect(events.get("keydown").defaultPrevented).toBe(false);
        events = await press(["Shift", " "]);
        const shiftSpace = events.get((ev) => ev.type === "keydown" && ev.key === " ");
        expect(shiftSpace.shiftKey).toBe(true);
        expect(shiftSpace.defaultPrevented).toBe(false);
        queryOne(`${card} .o_crm_mobile_card_stage`).focus();
        events = await press(" ");
        expect(events.get("keydown").defaultPrevented).toBe(false);
        expect(renderer.props.list.selection).toHaveLength(0);
        // The header controls keep it too: Space and Shift+Space stop at the pipeline root, so the
        // inherited kanban Space hotkey neither cancels their activation nor selects a record.
        for (const control of [".o_crm_mobile_pipeline_next", ".o_crm_mobile_pipeline_add"]) {
            queryOne(control).focus();
            events = await press(" ");
            expect(events.get("keydown").defaultPrevented).toBe(false);
            events = await press(["Shift", " "]);
            const shifted = events.get((ev) => ev.type === "keydown" && ev.key === " ");
            expect(shifted.shiftKey).toBe(true);
            expect(shifted.defaultPrevented).toBe(false);
        }
        expect(renderer.props.list.selection).toHaveLength(0);
        expect.verifySteps([]);

        // Taps open the lead once, on the name and anywhere else on the card body.
        await contains(`${card} .o_crm_mobile_lead_card_name`).click();
        expect.verifySteps(["open 1"]);
        await contains(`${card} .o_crm_mobile_lead_card_partner`).click();
        expect.verifySteps(["open 1"]);
    });

    test.tags("mobile");
    test("mobile: offline, an uncached lead opened from the keyboard focuses the helper's Back, and Back returns the focus to its card; a pending create has no open control", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // Lead 1's form was visited online, Lead 2's was not.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline(actionId, viewType, resId) {
                if (viewType === "form") {
                    return resId === 1;
                }
                return actionId === PIPELINE_ACTION_ID;
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            selectRecord: (resId) => expect.step(`open ${resId}`),
        });
        const [renderer] = renderers;
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const open = `${cardOf("Lead 2")} .o_crm_mobile_lead_card_open`;

        // The unavailable state is announced inside the open control, after the visible name.
        expect(cardOf("Lead 2")).toHaveClass("o_crm_mobile_lead_card_unavailable");
        expect(`${open} .o_crm_mobile_lead_card_name + .visually-hidden`).toHaveText(
            /not available offline/
        );
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_open .visually-hidden`).toHaveCount(0);
        expect(open).not.toHaveAttribute("disabled");

        queryOne(open).focus();
        await press("Enter");
        await animationFrame();
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_back").toBeFocused();
        // Space and Shift+Space on Back keep their native activation and select no record: they
        // stop at the pipeline root, before the inherited kanban Space hotkey.
        let events = await press(" ");
        expect(events.get("keydown").defaultPrevented).toBe(false);
        events = await press(["Shift", " "]);
        const shiftSpace = events.get((ev) => ev.type === "keydown" && ev.key === " ");
        expect(shiftSpace.shiftKey).toBe(true);
        expect(shiftSpace.defaultPrevented).toBe(false);
        expect(renderer.props.list.selection).toHaveLength(0);
        expect(".o_crm_mobile_pipeline_back").toBeFocused();
        await press("Enter");
        await animationFrame();
        expect(".o_view_nocontent").toHaveCount(0);
        expect(open).toBeFocused();
        expect.verifySteps([]);

        // A queued lead create has nothing to open: its name stays a plain span, no control.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Pending A" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect(".o_crm_mobile_lead_card_pending .o_crm_mobile_lead_card_name").toHaveText(
            "Pending A"
        );
        expect(".o_crm_mobile_lead_card_pending button").toHaveCount(0);
        expect(".o_crm_mobile_lead_card_open").toHaveCount(2);
    });

    test.tags("mobile");
    test("mobile: stage listbox keyboard model: focus on open, roving tabindex over enabled options, Escape back to Stage, Enter moves the card, no kanban navigation", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        patchWithCleanup(CrmMobilePipeline.prototype, {
            focusNextCard() {
                expect.step("focusNextCard");
                return super.focusNextCard(...arguments);
            },
        });
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            moveRecords(recordIds, refId, targetGroupId) {
                expect.step({ moveRecords: [recordIds, refId, targetGroupId] });
                return super.moveRecords(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        await goToStage("Qualified");
        const card = cardOf("Lead 3");
        const stageButton = `${card} .o_crm_mobile_card_stage`;
        const option = (stageId) =>
            `${card} .o_crm_mobile_stage_option[data-stage-value='${stageId}']`;
        const tabIndexes = () =>
            queryAll(`${card} .o_crm_mobile_stage_option`).map((el) => el.getAttribute("tabindex"));

        // Opened from the keyboard, the list focuses its first enabled option; the displayed
        // stage stays selected and disabled, and only the active option is a Tab stop.
        queryOne(stageButton).focus();
        await press("Enter");
        await animationFrame();
        expect(`${card} .o_crm_mobile_lead_card_stage_list`).toHaveAttribute("role", "listbox");
        expect(stageButton).toHaveAttribute("aria-expanded", "true");
        expect(option(2)).toHaveAttribute("aria-selected", "true");
        expect(option(2)).toHaveAttribute("disabled");
        expect(option(1)).toBeFocused();
        expect(tabIndexes()).toEqual(["0", "-1", "-1", "-1"]);

        // ArrowDown skips the disabled displayed stage, and the Tab stop follows the focus.
        const events = await press("ArrowDown");
        expect(events.get("keydown").defaultPrevented).toBe(true);
        await animationFrame();
        expect(option(3)).toBeFocused();
        expect(tabIndexes()).toEqual(["-1", "-1", "0", "-1"]);
        // The focused option shows the theme focus ring, not the browser's outline, raised above
        // the selected option (z-index 2 in Bootstrap's list group). Stage shows the same ring
        // once the focus is back on it (below).
        expect(queryOne(option(3)).matches(":focus-visible")).toBe(true);
        const optionStyle = getComputedStyle(queryOne(option(3)));
        expect(optionStyle.outlineStyle).toBe("none");
        expect(optionStyle.zIndex).toBe("3");
        const optionRing = optionStyle.boxShadow;
        expect(optionRing).not.toBe("none");
        await press("ArrowDown");
        expect(option(4)).toBeFocused();
        // No wrap at either end; ArrowUp from the first option does not focus the search.
        await press("ArrowDown");
        expect(option(4)).toBeFocused();
        await press("ArrowUp");
        expect(option(3)).toBeFocused();
        await press("ArrowUp");
        expect(option(1)).toBeFocused();
        await press("ArrowUp");
        expect(option(1)).toBeFocused();
        await press("End");
        expect(option(4)).toBeFocused();
        await press("Home");
        expect(option(1)).toBeFocused();
        // A modified arrow is not the list's: the focus stays.
        const shifted = await press(["Shift", "ArrowDown"]);
        const shiftedArrow = shifted.get((ev) => ev.type === "keydown" && ev.key === "ArrowDown");
        expect(shiftedArrow.defaultPrevented).toBe(false);
        expect(option(1)).toBeFocused();
        // The inherited kanban arrow hotkeys never ran inside the list.
        expect.verifySteps([]);

        // Escape closes the list and gives the focus back to Stage.
        await press("ArrowDown");
        await animationFrame();
        await press("Escape");
        await animationFrame();
        expect(`${card} .o_crm_mobile_lead_card_stage_list`).toHaveCount(0);
        expect(stageButton).toBeFocused();
        expect(stageButton).toHaveAttribute("aria-expanded", "false");
        expect(queryOne(stageButton).matches(":focus-visible")).toBe(true);
        expect(getComputedStyle(queryOne(stageButton)).boxShadow).toBe(optionRing);
        // Outside the list, the card's other keys still reach the inherited kanban hotkeys.
        await press("ArrowDown");
        expect.verifySteps(["focusNextCard"]);

        // Reopened with a tap, the list focuses the option it left active.
        await contains(stageButton).click();
        expect(option(3)).toBeFocused();
        expect(tabIndexes()).toEqual(["-1", "-1", "0", "-1"]);

        // Enter chooses the focused option through the framework kanban move. The focus follows
        // the moved card: its Stage button, in the target stage now displayed.
        await press("Enter");
        await animationFrame();
        expect.verifySteps([
            { moveRecords: [[recordOf(renderer, 3).id], null, groupOf(renderer, 3).id] },
        ]);
        expectHeader("Proposition", 2, 70);
        expect(cardNames()).toEqual(["Lead 3", "Lead 4"]);
        expect(`${card} .o_crm_mobile_lead_card_stage_list`).toHaveCount(0);
        expect(stageButton).toBeFocused();
        expect(stageButton).toHaveAttribute("aria-expanded", "false");
    });

    test.tags("mobile");
    test("mobile: a stage chosen from the keyboard leaves the focus on the card's Stage button when the move is not made or ends in a connection loss; a focus outside the card stays", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        let outcome = "not made";
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            async moveRecords() {
                expect.step(`moveRecords: ${outcome}`);
                if (outcome === "not made") {
                    return;
                }
                await super.moveRecords(...arguments);
                if (outcome === "connection lost") {
                    // as the framework's reload of a truncated source stage, after the save
                    throw new ConnectionLostError("/web/dataset/call_kw/crm.lead/web_search_read");
                }
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const stageButton = `${cardOf("Lead 1")} .o_crm_mobile_card_stage`;
        const stageList = `${cardOf("Lead 1")} .o_crm_mobile_lead_card_stage_list`;
        const option = (stageId) =>
            `${cardOf("Lead 1")} .o_crm_mobile_stage_option[data-stage-value='${stageId}']`;

        // A move the framework does not make: the displayed stage and the card stay, and the
        // focus goes back to the card's Stage button.
        queryOne(stageButton).focus();
        await press("Enter");
        await animationFrame();
        expect(option(2)).toBeFocused();
        await press("Enter");
        await animationFrame();
        expect.verifySteps(["moveRecords: not made"]);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(stageList).toHaveCount(0);
        expect(stageButton).toBeFocused();
        expect(stageButton).toHaveAttribute("aria-expanded", "false");

        // A move made whose source reload then loses the connection: the card is placed in the
        // target stage, now displayed, and its Stage button there has the focus.
        outcome = "connection lost";
        await press("Enter");
        await animationFrame();
        expect(option(2)).toBeFocused();
        await press("Enter");
        await animationFrame();
        expect.verifySteps(["moveRecords: connection lost"]);
        expectHeader("Qualified", 2, 130);
        expect(recordOf(renderer, 1).group.serverValue).toBe(2);
        expect(stageList).toHaveCount(0);
        expect(stageButton).toBeFocused();

        // A move started while the focus is outside the card leaves the focus where it is.
        outcome = "made";
        queryOne(".o_crm_mobile_pipeline_add").focus();
        await renderer.onCardMove(recordOf(renderer, 3), groupOf(renderer, 3));
        await animationFrame();
        expect.verifySteps(["moveRecords: made"]);
        expectHeader("Proposition", 2, 70);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();
    });

    test.tags("mobile");
    test("mobile: stage listbox with no enabled option (a call in flight) keeps the focus on Stage and handles its keys without error", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        const card = cardOf("Lead 1");
        const cardComponent = cards.findLast((instance) => instance.props.record?.resId === 1);
        const list = `${card} .o_crm_mobile_lead_card_stage_list`;

        // A call is in flight: every option is disabled, so none is focusable.
        cardComponent.state.busy = true;
        await animationFrame();
        await contains(`${card} .o_crm_mobile_card_stage`).click();
        expect(`${card} .o_crm_mobile_stage_option:not(:disabled)`).toHaveCount(0);
        expect(
            queryAll(`${card} .o_crm_mobile_stage_option`).map((el) => el.getAttribute("tabindex"))
        ).toEqual(["-1", "-1", "-1", "-1"]);
        expect(cardComponent.activeStageOption).toBe(null);
        expect(`${card} .o_crm_mobile_card_stage`).toBeFocused();
        for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
            const keydown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
            queryOne(list).dispatchEvent(keydown);
            expect(keydown.defaultPrevented).toBe(true);
        }
        expect(`${card} .o_crm_mobile_card_stage`).toBeFocused();

        // The call ends: the enabled options are back, the first one holds the Tab stop.
        cardComponent.state.busy = false;
        await animationFrame();
        expect(
            queryAll(`${card} .o_crm_mobile_stage_option`).map((el) => el.getAttribute("tabindex"))
        ).toEqual(["-1", "0", "-1", "-1"]);
        // A direct call while the list is closed does nothing.
        await contains(`${card} .o_crm_mobile_card_stage`).click();
        expect(list).toHaveCount(0);
        cardComponent.onStageListKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        expect(`${card} .o_crm_mobile_card_stage`).toBeFocused();
    });

    test.tags("mobile");
    test("mobile: follow-up Cancel, tapped or from the keyboard, gives the focus back to Follow-up, or to Stage while Follow-up is disabled; the toggle and another panel move no focus", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const logCall = Promise.withResolvers();
        onRpc("mail.activity", "web_save", async () => {
            expect.step("mail.activity/web_save");
            await logCall.promise;
        });
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        const card = cardOf("Lead 1");
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
        );
        const followUp = `${card} .o_crm_mobile_card_follow_up`;
        const form = `${card} .o_crm_mobile_lead_card_follow_up`;
        const cancel = `${card} .o_crm_mobile_follow_up_cancel`;
        const summary = `${card} .o_crm_mobile_follow_up_summary`;
        queryOne(followUp).addEventListener("focus", () => expect.step("Follow-up focused"));

        // A tap on Cancel: the form leaves with the focus, and Follow-up takes it back.
        await contains(followUp).click();
        expect.verifySteps(["Follow-up focused"]);
        expect(form).toHaveCount(1);
        await contains(cancel).click();
        expect(form).toHaveCount(0);
        expect(followUp).toBeFocused();
        expect(followUp).toHaveAttribute("aria-expanded", "false");
        expect.verifySteps(["Follow-up focused"]);

        // From the keyboard: Enter on Follow-up opens the form, Enter on its Cancel closes it.
        await press("Enter");
        await animationFrame();
        expect(form).toHaveCount(1);
        queryOne(cancel).focus();
        await press("Enter");
        await animationFrame();
        expect(form).toHaveCount(0);
        expect(followUp).toBeFocused();
        expect.verifySteps(["Follow-up focused"]);
        expect(queued()).toHaveLength(0);

        // Another panel opened from the form keeps the focus it takes: the stage list its first
        // enabled option, the Activities toggle its own.
        await contains(followUp).click();
        expect(form).toHaveCount(1);
        queryOne(summary).focus();
        await contains(`${card} .o_crm_mobile_card_stage`).click();
        expect(form).toHaveCount(0);
        expect(`${card} .o_crm_mobile_stage_option[data-stage-value='2']`).toBeFocused();
        await contains(followUp).click();
        expect.verifySteps(["Follow-up focused"]);
        queryOne(summary).focus();
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(form).toHaveCount(0);
        expect(`${card} .o_crm_mobile_card_activities`).toBeFocused();
        // The Follow-up toggle closing the form moves no focus either.
        await contains(followUp).click();
        expect.verifySteps(["Follow-up focused"]);
        queryOne(summary).focus();
        lead1Card.toggleFollowUp();
        await animationFrame();
        expect(form).toHaveCount(0);
        expect(document.activeElement).toBe(document.body);
        expect.verifySteps([]);

        // While a Log call is in flight Follow-up is disabled: Cancel focuses Stage instead, and
        // the completed call moves no focus.
        await contains(followUp).click();
        expect.verifySteps(["Follow-up focused"]);
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        await expect.waitForSteps(["mail.activity/web_save"]);
        expect(followUp).toHaveAttribute("disabled");
        await contains(cancel).click();
        expect(form).toHaveCount(0);
        expect(`${card} .o_crm_mobile_card_stage`).toBeFocused();
        logCall.resolve();
        await animationFrame();
        expect(lead1Card.state.busy).toBe(false);
        expect(followUp).not.toHaveAttribute("disabled");
        expect(`${card} .o_crm_mobile_card_stage`).toBeFocused();
        expect.verifySteps([]);

        // Called directly, without a DOM event, while the form is closed: no focus moves, on a
        // lead card as on a pending create's card, which renders no form.
        lead1Card.onCancelFollowUp();
        await animationFrame();
        expect(`${card} .o_crm_mobile_card_stage`).toBeFocused();
        const pending = await mountStandaloneCard({
            pendingCall: { key: "bare", value: { model: "crm.lead", method: "web_save" } },
        });
        queryOne(`${card} .o_crm_mobile_card_stage`).focus();
        pending.onCancelFollowUp();
        await animationFrame();
        expect({ ...pending.state }).toEqual(untouchedCardState());
        expect(`${card} .o_crm_mobile_card_stage`).toBeFocused();
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a completed follow-up Save, online or queued offline, gives the focus back to Follow-up as it closes the form", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        let save = null;
        onRpc("mail.activity", "web_save", async () => {
            expect.step("mail.activity/web_save");
            await save?.promise;
        });
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const card = cardOf("Lead 1");
        const followUp = `${card} .o_crm_mobile_card_follow_up`;
        const form = `${card} .o_crm_mobile_lead_card_follow_up`;
        const saveButton = `${card} .o_crm_mobile_follow_up_save`;
        const summary = `${card} .o_crm_mobile_follow_up_summary`;
        const serverSummaries = () =>
            MockServer.env["mail.activity"]
                .search_read(
                    [
                        ["res_model", "=", "crm.lead"],
                        ["res_id", "=", 1],
                    ],
                    ["summary"]
                )
                .map((activity) => activity.summary);

        // Online: Save is disabled while its call runs, and the completed call closes the form
        // and focuses Follow-up.
        save = Promise.withResolvers();
        await contains(followUp).click();
        await contains(summary).edit("Send the proposal", { confirm: false });
        await contains(saveButton).click();
        await expect.waitForSteps(["mail.activity/web_save"]);
        expect(saveButton).toHaveAttribute("disabled");
        expect(followUp).toHaveAttribute("disabled");
        save.resolve();
        await animationFrame();
        expect(form).toHaveCount(0);
        expect(followUp).toBeFocused();
        expect(serverSummaries()).toEqual(["Send the proposal"]);

        // Online, with the focus moved to the summary while the call runs: still in the form, so
        // it goes back to Follow-up as well.
        save = Promise.withResolvers();
        await contains(followUp).click();
        await contains(summary).edit("Check in", { confirm: false });
        await contains(saveButton).click();
        await expect.waitForSteps(["mail.activity/web_save"]);
        queryOne(summary).focus();
        save.resolve();
        await animationFrame();
        expect(form).toHaveCount(0);
        expect(followUp).toBeFocused();
        expect(serverSummaries()).toEqual(["Send the proposal", "Check in"]);

        // Offline: the queued create closes the form, and Follow-up has the focus.
        await setOffline(true);
        await contains(followUp).click();
        await contains(summary).edit("Call back", { confirm: false });
        await contains(saveButton).click();
        expect(form).toHaveCount(0);
        const queuedSummaries = queuedCalls("mail.activity", "web_save").map(
            ({ args }) => args[1].summary
        );
        expect(queuedSummaries).toEqual(["Call back"]);
        expect(followUp).toBeFocused();
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a focus moved out of the follow-up form before its Save completes stays where it was put, and a Save completing after its card was destroyed moves no focus", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        let save = null;
        onRpc("mail.activity", "web_save", async () => {
            expect.step("mail.activity/web_save");
            await save.promise;
        });
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        const card = cardOf("Lead 1");
        const followUp = `${card} .o_crm_mobile_card_follow_up`;
        const form = `${card} .o_crm_mobile_lead_card_follow_up`;
        const saveButton = `${card} .o_crm_mobile_follow_up_save`;
        const startSave = async () => {
            save = Promise.withResolvers();
            await contains(followUp).click();
            await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Send the proposal", {
                confirm: false,
            });
            await contains(saveButton).click();
            await expect.waitForSteps(["mail.activity/web_save"]);
        };

        // Moved to a pipeline control while the call runs: the focus stays there.
        await startSave();
        queryOne(".o_crm_mobile_pipeline_next").focus();
        save.resolve();
        await animationFrame();
        expect(form).toHaveCount(0);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();

        // Moved to another control of the same card: it stays there too.
        await startSave();
        queryOne(`${card} .o_crm_mobile_card_activities`).focus();
        save.resolve();
        await animationFrame();
        expect(form).toHaveCount(0);
        expect(`${card} .o_crm_mobile_card_activities`).toBeFocused();

        // Stage navigation destroys the card while its call runs: the completion writes no state
        // on it and moves no focus.
        await startSave();
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
        );
        await goToStage("Qualified");
        expect(status(lead1Card)).toBe("destroyed");
        const focused = document.activeElement;
        save.resolve();
        await animationFrame();
        expect(lead1Card.state.followUpOpen).toBe(true);
        expect(document.activeElement).toBe(focused);
        expect(
            MockServer.env["mail.activity"].search_read(
                [
                    ["res_model", "=", "crm.lead"],
                    ["res_id", "=", 1],
                ],
                ["summary"]
            )
        ).toHaveLength(3);
    });

    test.tags("mobile");
    test("mobile: quick create on a sample-data pipeline leaves sample mode like the framework quick create", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.lead"].unlink(MockServer.env["crm.lead"].search([]));
        // No lead: the stages are still listed, empty, as the stage group expansion lists them,
        // each aggregate with the server's empty value (`_read_group_empty_value`).
        onRpc("crm.lead", "web_read_group", async ({ kwargs, parent }) => {
            const result = await parent();
            if (result.groups.length) {
                return result;
            }
            const emptyValue = (spec) => {
                if (/:array_agg(_distinct)?$/.test(spec)) {
                    return [];
                }
                return /:count(_distinct)?$/.test(spec) ? 0 : false;
            };
            const groups = MockServer.env["crm.stage"]
                .search_read([], ["display_name"])
                .map((stage) => ({
                    ...Object.fromEntries(
                        kwargs.aggregates.map((spec) => [spec, emptyValue(spec)])
                    ),
                    stage_id: [stage.id, stage.display_name],
                    __count: 0,
                    __extra_domain: [["stage_id", "=", stage.id]],
                    __records: [],
                }));
            return { groups, length: groups.length };
        });
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        watchValidateQuickCreate();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" sample="1"'),
        });
        const [renderer] = renderers;
        const { model } = renderer.props.list;
        const expectEmptyHeader = () => {
            expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
            expect(".o_crm_mobile_pipeline_count").toHaveText("0");
            // An empty stage aggregates no currency: its sum shows as a plain number.
            expect(".o_crm_mobile_pipeline_revenue").toHaveText("0");
        };

        // Sample data: faded sample cards, counted in the header.
        expect(stageValues(renderer)).toEqual([1, 2, 3, 4]);
        expect(model.useSampleModel).toBe(true);
        expect(".o_view_sample_data .o_crm_mobile_pipeline").toHaveCount(1);
        const sampleCards = queryAll(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").length;
        expect(sampleCards > 0).toBe(true, { message: "the displayed stage shows sample cards" });
        expect(".o_crm_mobile_pipeline_count").toHaveText(String(sampleCards));

        // Opening the sheet leaves sample mode, and a Discard does not bring it back.
        await contains(".o_crm_mobile_pipeline_add").click();
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(model.useSampleModel).toBe(false);
        expect(".o_view_sample_data").toHaveCount(0);
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expect(renderer.allLoadedRecords()).toEqual([]);
        expect(renderer.props.list.groups.map((group) => group.count)).toEqual([0, 0, 0, 0]);
        expectEmptyHeader();
        await contains(".o_crm_mobile_quick_create_discard").click();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(model.useSampleModel).toBe(false);
        expect(".o_view_sample_data").toHaveCount(0);
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expectEmptyHeader();

        // A lead created online is the only card, a real one, and the only lead counted.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "First real lead", expected_revenue: "25" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [created] = leadsNamed("First real lead");
        expect.verifySteps([
            { web_save: leadVals({ name: "First real lead", expected_revenue: 25 }) },
            { validateQuickCreate: [created.id, "close", 1] },
        ]);
        expect(leadsNamed("First real lead")).toHaveLength(1);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_view_sample_data").toHaveCount(0);
        expect(cardNames()).toEqual(["First real lead"]);
        expect(cardOf("First real lead")).toHaveAttribute("data-id");
        expect(renderer.allLoadedRecords().map((record) => record.resId)).toEqual([created.id]);
        expectHeader("New", 1, 25);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: an offline quick create on an empty pipeline shows its pending card without the no-content helper", async () => {
        const errors = cachedReadErrors([
            // the types revalidated on each stage displayed offline: Qualified, then New again
            // (there is no lead, so no activity read)
            TYPES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.lead"].unlink(MockServer.env["crm.lead"].search([]));
        // No lead: the stages are still listed, empty, as the stage group expansion lists them,
        // each aggregate with the server's empty value (`_read_group_empty_value`).
        onRpc("crm.lead", "web_read_group", async ({ kwargs, parent }) => {
            const result = await parent();
            if (result.groups.length) {
                return result;
            }
            const emptyValue = (spec) => {
                if (/:array_agg(_distinct)?$/.test(spec)) {
                    return [];
                }
                return /:count(_distinct)?$/.test(spec) ? 0 : false;
            };
            const groups = MockServer.env["crm.stage"]
                .search_read([], ["display_name"])
                .map((stage) => ({
                    ...Object.fromEntries(
                        kwargs.aggregates.map((spec) => [spec, emptyValue(spec)])
                    ),
                    stage_id: [stage.id, stage.display_name],
                    __count: 0,
                    __extra_domain: [["stage_id", "=", stage.id]],
                    __records: [],
                }));
            return { groups, length: groups.length };
        });
        const setOffline = mockOffline();
        watchRpcs(["crm.lead/web_save"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const { model } = renderer.props.list;

        // No lead and no sample data: the framework no-content helper.
        expect(stageValues(renderer)).toEqual([1, 2, 3, 4]);
        expect(model.useSampleModel).toBe(false);
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline .o_view_nocontent").toHaveCount(1);

        // An offline save: the pending card shows in the chosen stage at once, uncovered.
        await setOffline(true);
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "First offline lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queued()).toHaveLength(1);
        const [{ key }] = queued();
        const pending = `.o_crm_mobile_pipeline_body .o_crm_mobile_lead_card[data-pending-key='${key}']`;
        expect(pending).toBeVisible();
        expect(`${pending} .o_crm_mobile_lead_card_name`).toHaveText("First offline lead");
        expect(".o_crm_mobile_pipeline_count").toHaveText("1");
        expect(".o_view_nocontent").toHaveCount(0);
        // The pipeline holds data, so another, empty, stage shows no helper either.
        await goToStage("Qualified");
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_view_nocontent").toHaveCount(0);
        await goToStage("New");
        expect(pending).toBeVisible();
        expect(".o_view_nocontent").toHaveCount(0);

        // Sample data keeps the framework helper, which labels the sample cards.
        model.useSampleModel = true;
        expect(renderer.showNoContentHelper).toBe(true);
        model.useSampleModel = false;

        // The entry leaves the queue (as a systray discard does): no pending card, and the
        // helper of the empty pipeline is back.
        getService(OfflinePlugin).removeScheduledORM(key);
        await animationFrame();
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_count").toHaveText("0");
        expect(".o_crm_mobile_pipeline .o_view_nocontent").toHaveCount(1);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a quick create answered while a pipeline reload is still pending adds the lead to the reloaded live group", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves();
        const validatedGroups = watchValidateQuickCreate();
        watchRpcs([LEAD_GROUPS, "crm.lead/web_read"]);
        // A held reload answers with the data of the moment its request arrived (the lead does
        // not exist yet), once `reloadAnswer` resolves.
        const reloadAnswer = Promise.withResolvers();
        let holdReload = false;
        onRpc("crm.lead", "web_read_group", async ({ parent }) => {
            const result = await parent();
            if (holdReload) {
                expect.step("reload answer held");
                await reloadAnswer.promise;
            }
            return result;
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({
            name: "Pending reload lead",
            expected_revenue: "10",
            stage_id: "Qualified",
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps([
            {
                web_save: leadVals({
                    name: "Pending reload lead",
                    expected_revenue: 10,
                    stage_id: 2,
                }),
            },
        ]);

        // A reload of the pipeline starts while the call runs (the reconciliation that follows a
        // reconnection, for instance), and its answer is held.
        const qualifiedBefore = groupOf(renderer, 2);
        holdReload = true;
        const reloading = renderer.props.list.load();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS, "reload answer held"]);

        // The create is answered first: the lead waits for the reload, nothing is added yet and
        // the sheet stays open, its Save disabled.
        saves.release();
        await animationFrame();
        expect(leadsNamed("Pending reload lead")).toHaveLength(1);
        expect.verifySteps([]);
        expect(groupOf(renderer, 2) === qualifiedBefore).toBe(true, {
            message: "the reload has not landed yet",
        });
        expect(".o_crm_mobile_quick_create_save").toHaveAttribute("disabled");

        // The reload lands and rebuilds the groups; the lead is then added to the live one.
        reloadAnswer.resolve();
        await reloading;
        await animationFrame();
        const [created] = leadsNamed("Pending reload lead");
        expect.verifySteps([
            { validateQuickCreate: [created.id, "close", 2] },
            "crm.lead/web_read",
        ]);
        expect(validatedGroups).toHaveLength(1);
        expect(validatedGroups[0] === groupOf(renderer, 2)).toBe(true, {
            message: "validateQuickCreate receives the live Qualified group",
        });
        expect(validatedGroups[0] === qualifiedBefore).toBe(false, {
            message: "validateQuickCreate does not receive the detached Qualified group",
        });
        expect(groupOf(renderer, 2).list.records.map((record) => record.resId)).toEqual([
            created.id,
            3,
        ]);
        // The detached group of before the reload is left as it was.
        expect(qualifiedBefore.count).toBe(1);
        expect(qualifiedBefore.list.records.map((record) => record.resId)).toEqual([3]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        await goToStage("Qualified");
        expect(cardOf("Pending reload lead")).toHaveCount(1);
        expect(cardNames()).toEqual(["Pending reload lead", "Lead 3"]);
        expectHeader("Qualified", 2, 40);
        expect(queued()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a reload queued just before a quick-created lead is inserted, answered without it, is followed by a reload that shows it", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        watchRpcs([LEAD_GROUPS, "crm.lead/web_read"]);
        // The answer of the mount, from before the lead existed (an answer the framework RPC
        // cache could serve), is served once more to the reload that `serveStale` marks.
        let staleAnswer = null;
        let serveStale = false;
        onRpc("crm.lead", "web_read_group", async ({ parent }) => {
            const result = await parent();
            staleAnswer ??= JSON.parse(JSON.stringify(result));
            if (serveStale) {
                serveStale = false;
                expect.step("stale answer");
                return staleAnswer;
            }
            return result;
        });
        // A reload queued on the model once the pipeline has waited for it, just before the
        // insertion, which then queues behind it.
        const validatedGroups = [];
        let queuedReload = null;
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate(recordId, mode, group) {
                expect.step({ validateQuickCreate: [recordId, mode, group.serverValue] });
                validatedGroups.push(group);
                serveStale = true;
                queuedReload = this.props.list.load();
                return super.validateQuickCreate(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({
            name: "Safety net lead",
            expected_revenue: "5",
            stage_id: "Qualified",
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        await queuedReload;
        await animationFrame();
        const [created] = leadsNamed("Safety net lead");
        // The stale reload lands first and detaches the group the lead is then added to: the
        // pipeline reloads once more, and nothing is created again.
        expect.verifySteps([
            { web_save: leadVals({ name: "Safety net lead", expected_revenue: 5, stage_id: 2 }) },
            { validateQuickCreate: [created.id, "close", 2] },
            LEAD_GROUPS,
            "stale answer",
            "crm.lead/web_read",
            LEAD_GROUPS,
        ]);
        expect(leadsNamed("Safety net lead")).toHaveLength(1);
        expect(validatedGroups).toHaveLength(1);
        expect(validatedGroups[0] === groupOf(renderer, 2)).toBe(false, {
            message: "the group the lead was added to is detached",
        });
        expect(
            groupOf(renderer, 2).list.records.some((record) => record.resId === created.id)
        ).toBe(true, { message: "the live Qualified group holds the lead" });
        expect(groupOf(renderer, 2).count).toBe(2);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        await goToStage("Qualified");
        expect(cardOf("Safety net lead")).toHaveCount(1);
        expectHeader("Qualified", 2, 35);
        expect(queued()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a pending quick create that the server rejects after its sheet was dismissed raises the error once and adds nothing", async () => {
        expect.errors(1);
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves({
            answer: () => {
                throw makeServerError({ message: "This lead name is reserved" });
            },
        });
        watchValidateQuickCreate();
        watchRpcs([LEAD_GROUPS, "crm.lead/web_read"]);
        await mountPipeline();
        expect.verifySteps([LEAD_GROUPS]);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Refused lead", expected_revenue: "9" });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps([{ web_save: leadVals({ name: "Refused lead", expected_revenue: 9 }) }]);
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);

        // The refusal arrives after the dismissal: its error is raised once, and nothing else
        // (the dismissed sheet is not written to). No lead, no card, nothing queued or reloaded.
        saves.release();
        await animationFrame();
        expect.verifyErrors(["This lead name is reserved"]);
        expect.verifySteps([]);
        expect(leadsNamed("Refused lead")).toEqual([]);
        expect(cardOf("Refused lead")).toHaveCount(0);
        expect(queued()).toHaveLength(0);
        expectHeader("New", 2, 120);
    });

    test.tags("mobile");
    test("mobile: a pending quick create whose connection drops after its sheet was dismissed is queued and shows its pending card", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const connection = mockConnectionDrop();
        const saves = holdLeadSaves({ answer: () => new Response("", { status: 502 }) });
        watchValidateQuickCreate();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Dropped after dismissal", expected_revenue: "8" });
        await contains(".o_crm_mobile_quick_create_save").click();
        const vals = leadVals({ name: "Dropped after dismissal", expected_revenue: 8 });
        expect.verifySteps([{ web_save: vals }]);
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);

        // The connection drops before the answer: the call fails as lost, and the create is
        // queued and shown pending although its sheet is gone.
        connection.offline = true;
        saves.release();
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        const queuedSaves = queuedCalls("crm.lead", "web_save");
        expect(queuedSaves).toHaveLength(1);
        expect(queuedSaves[0].args).toEqual([[], vals]);
        expect(queuedSaves[0].extras.viewType).toBe("kanban");
        expect.verifySteps([]);
        expect(leadsNamed("Dropped after dismissal")).toEqual([]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expect(".o_crm_mobile_lead_card_pending .o_crm_mobile_lead_card_name").toHaveText(
            "Dropped after dismissal"
        );
        expect(".o_crm_mobile_lead_card_pending .o_crm_mobile_pending_badge").toHaveCount(1);
        expectHeader("New", 3, 128);
    });

    test.tags("mobile");
    test("mobile: while a created lead is being added, a second save sends nothing, Discard is disabled and a dismissal closes the sheet; a later failure is raised once", async () => {
        expect.errors(1);
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        // Adding the card stays pending until `adding` settles.
        const adding = Promise.withResolvers();
        patchWithCleanup(CrmMobilePipeline.prototype, {
            async validateQuickCreate(recordId, mode, group) {
                expect.step({ validateQuickCreate: [recordId, mode, group.serverValue] });
                await adding.promise;
            },
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Slow card", expected_revenue: "6" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [created] = leadsNamed("Slow card");
        expect.verifySteps([
            { web_save: leadVals({ name: "Slow card", expected_revenue: 6 }) },
            { validateQuickCreate: [created.id, "close", 1] },
        ]);
        // The lead exists and its card is being added: the sheet is open, its Save disabled.
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_quick_create_save").toHaveAttribute("disabled");
        // A second save (a direct call: the button is disabled) sends nothing.
        await sheets[0].save();
        await animationFrame();
        expect.verifySteps([]);
        // Discard is disabled meanwhile; a dismissal closes the sheet while the card is still
        // being added.
        expect(".o_crm_mobile_quick_create_discard").toHaveAttribute("disabled");
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);

        // Adding the card then fails: the error is raised once, and nothing else (closing the
        // dismissed sheet again is skipped). One lead, nothing queued.
        adding.reject(new Error("The card could not be added"));
        await animationFrame();
        expect.verifyErrors(["The card could not be added"]);
        expect.verifySteps([]);
        expect(leadsNamed("Slow card")).toHaveLength(1);
        expect(cardOf("Slow card")).toHaveCount(0);
        expect(queued()).toHaveLength(0);
        expectHeader("New", 2, 120);
    });

    test.tags("mobile");
    test("mobile: the quick-create sheet focuses its lead name input as it opens, a failed save focuses its first invalid field, and a later render keeps the user's focus", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();

        // A failed save moves the focus from Save to the first invalid field, in form order.
        await contains(".o_crm_mobile_quick_create [name=email_from]").edit("not-an-email", {
            confirm: false,
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(2);
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();

        // A render of the open sheet (an error cleared as the name is typed) leaves the focus on
        // the control holding it, and the next failed save focuses the field still invalid.
        await contains(".o_crm_mobile_quick_create [name=name]").edit("Focused lead", {
            confirm: false,
        });
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(1);
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create [name=email_from]").toBeFocused();
        await contains(".o_crm_mobile_quick_create [name=phone]").edit("+32 555 07", {
            confirm: false,
        });
        await animationFrame();
        expect(".o_crm_mobile_quick_create [name=phone]").toBeFocused();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: an offline (queued) quick create returns the focus to Add as its sheet closes", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Queued focus lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queuedCalls("crm.lead", "web_save")).toHaveLength(1);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();
    });

    test.tags("mobile");
    test("mobile: Discard and a dismissal of the quick-create sheet return the focus to Add", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();

        // Discard: the focus was on Discard, in the sheet.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Discarded lead" });
        await contains(".o_crm_mobile_quick_create_discard").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();

        // Escape: the focus was on the lead name input, in the sheet.
        await contains(".o_crm_mobile_pipeline_add").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();

        // A tap on the backdrop: the focus had already fallen to the document body.
        await contains(".o_crm_mobile_pipeline_add").click();
        await animationFrame();
        await contains(".o_bottom_sheet_backdrop").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();
        expect(queued()).toHaveLength(0);
        expect(leadsNamed("Discarded lead")).toEqual([]);
    });

    test.tags("mobile");
    test("mobile: an online quick create leaves the focus on a pipeline control, never on the document body", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchValidateQuickCreate();
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Online focus lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [created] = leadsNamed("Online focus lead");
        expect.verifySteps([{ validateQuickCreate: [created.id, "close", 1] }]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Online focus lead")).toHaveCount(1);
        const active = document.activeElement;
        expect(active).not.toBe(document.body);
        expect(queryOne(".o_crm_mobile_pipeline").contains(active)).toBe(true);
        // Adding the card focuses nothing, so the focus is back on the control that opened it.
        expect(".o_crm_mobile_pipeline_add").toBeFocused();
    });

    test.tags("mobile");
    test("mobile: a focus moved out of the quick-create sheet before it closes stays where it was put", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadSaves({ afterCreate: true });
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Elsewhere lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        expect.verifySteps([{ web_save: leadVals({ name: "Elsewhere lead" }) }]);
        // While the call runs, the user moves the focus to another pipeline control.
        queryOne(".o_crm_mobile_pipeline_next").focus();
        saves.release();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Elsewhere lead")).toHaveCount(1);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();
    });

    test.tags("mobile");
    test("mobile: a quick-create sheet closed because the pipeline is destroyed moves no focus", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();
        const add = queryOne(".o_crm_mobile_pipeline_add");
        add.addEventListener("focus", () => expect.step("Add focused"));
        destroyApp();
        await animationFrame();
        expect(status(renderers[0])).toBe("destroyed");
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect.verifySteps([]);
    });
});

// -----------------------------------------------------------------------------
// Remaining quick create branches
// -----------------------------------------------------------------------------

/** @returns {string[]} the options of the open quick create's stage `<select>`, in order */
function quickCreateStageOptions() {
    return queryAllTexts(".o_crm_mobile_quick_create select[name=stage_id] option");
}

/** @returns {string} the selected option of the open quick create's stage `<select>` */
function quickCreateSelectedStage() {
    return queryOne(".o_crm_mobile_quick_create select[name=stage_id]").selectedOptions[0]
        .textContent;
}

/**
 * @param {string} name
 * @returns {Object[]} the `crm.lead` records of that name on the mock server
 */
function serverLeads(name) {
    return MockServer.env["crm.lead"].search_read([["name", "=", name]]);
}

describe("Online writes whose follow-up read loses the connection", () => {
    /**
     * @param {string} name
     * @returns {string} the notification of a lead created online that the pipeline could not
     *   show
     */
    function savedLeadMessage(name) {
        return `"${name}" was saved. It will show in the pipeline once the connection is back.`;
    }

    /**
     * Makes the next request of a route lose the connection once `armed` is set: the offline
     * plugin goes offline, as with a connection that drops, and the request answers with a 502.
     * Registered after `mockOffline()`, it runs before the offline mock.
     *
     * @param {(offline: boolean) => Promise<void>} setOffline the `mockOffline()` setter
     * @param {string} route the request path
     * @returns {{ armed: boolean }}
     */
    function dropNextRequest(setOffline, route) {
        const drop = { armed: false };
        onRpc(route, () => {
            if (drop.armed) {
                drop.armed = false;
                setOffline(true);
                return new Response("", { status: 502 });
            }
        });
        return drop;
    }

    /**
     * @param {string} name the lead name
     * @returns {string} selector of the Activities count badge of the card of that lead
     */
    function badgeOf(name) {
        return `${cardOf(name)} .o_crm_mobile_card_activities .badge`;
    }

    /**
     * @param {string} name the lead name
     * @returns {string} selector of the status region of the card of that lead
     */
    function statusRegionOf(name) {
        return `${cardOf(name)} .o_crm_mobile_lead_card_status`;
    }

    /**
     * Opens the activity list of a lead's card (closed on mount and on every remount).
     *
     * @param {string} name the lead name
     * @returns {Promise<string[]>} the summaries of its persisted activity rows, in order
     */
    async function openActivities(name) {
        const card = cardOf(name);
        if (!queryFirst(`${card} .o_crm_mobile_lead_card_activities`)) {
            await contains(`${card} .o_crm_mobile_card_activities`).click();
        }
        const persistedRow = ".o_crm_mobile_activity_row:not(.o_crm_mobile_activity_pending)";
        return queryAllTexts(`${card} ${persistedRow} .o_crm_mobile_activity_summary`);
    }

    /**
     * @param {number} resId the lead id
     * @returns {number[]} the ids of the lead's active activities on the server
     */
    function serverActivityIds(resId) {
        return MockServer.env["mail.activity"]
            .search_read(
                [
                    ["res_model", "=", "crm.lead"],
                    ["res_id", "=", resId],
                ],
                ["id"]
            )
            .map(({ id }) => id);
    }

    /**
     * @param {Object[]} writes a lead's confirmed activity writes (`activityWritesByLead`)
     * @returns {Array<[number, number]>} the activity id and the delta of each write, in order
     */
    function writeSteps(writes) {
        return writes.map((write) => [
            write.created ? write.created.id : write.doneId,
            write.delta,
        ]);
    }

    /**
     * @param {number} id
     * @param {string | false} dateDeadline
     * @returns {Object} an activity of a lead, in the shape the pipeline reads
     */
    function activityRow(id, dateDeadline) {
        return {
            id,
            activity_type_id: { id: 1, display_name: "Email" },
            activity_category: "default",
            summary: `Activity ${id}`,
            date_deadline: dateDeadline,
            state: "planned",
            user_id: { id: serverState.userId, display_name: "Mitchell Admin" },
        };
    }

    test.tags("mobile");
    test("mobile: an online quick create whose card read loses the connection closes the sheet, tells the user the lead was saved, queues nothing, and the reconnection shows its card", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const drop = dropNextRequest(setOffline, "/web/dataset/call_kw/crm.lead/web_read");
        watchRpcs(["crm.lead/web_save", "crm.lead/web_read", LEAD_GROUPS]);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);

        // The server creates the lead, then the read that adds its card loses the connection.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Saved before the drop", expected_revenue: "8" });
        drop.armed = true;
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save", "crm.lead/web_read"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(serverLeads("Saved before the drop")).toHaveLength(1);
        expect(queued()).toHaveLength(0);
        // No card and no pending card: the sheet is closed, and the user is told, once, that the
        // lead was saved (no uncaught error either). The notification's close stays usable.
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Saved before the drop")).toHaveCount(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expectHeader("New", 2, 120);
        expect(".o_notification").toHaveCount(1);
        expect(".o_notification").toHaveAttribute("role", "alert");
        expect(".o_notification .o_notification_bar").toHaveClass("bg-info");
        expect(".o_notification .o_notification_content").toHaveText(
            savedLeadMessage("Saved before the drop")
        );
        expect(".o_notification .o_notification_close").toHaveAttribute("data-available-offline");
        expect(".o_notification .o_notification_close").not.toHaveAttribute("disabled");

        // Back online with nothing queued: the reconciliation reload shows the lead, once.
        await setOffline(false);
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(cardOf("Saved before the drop")).toHaveCount(1);
        expect(`${cardOf("Saved before the drop")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expectHeader("New", 3, 128);
        expect(serverLeads("Saved before the drop")).toHaveLength(1);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: the reload that replaces adding a lead created online rejects with a lost connection when, offline, the cache answers it without the lead; one that loses the connection once the stage pipeline is gone resolves quietly", async () => {
        // offline, the reload is answered by the cache and refreshed in the background, and so
        // are the activities of New's two leads and the types, read again for its new groups
        const errors = cachedReadErrors([LEAD_GROUPS, ACTIVITIES, ACTIVITIES, TYPES]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const groupReads = holdRequests("/web/dataset/call_kw/crm.lead/web_read_group", "groups");
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;

        // A lead the server created in Qualified, handed over without a live group (the stage
        // was not listed when its call returned): offline, the reload that replaces adding it is
        // answered by the cache, which predates it. The pipeline stays as it was, and the
        // rejection tells the caller the lead could not be shown.
        const cachedOutId = MockServer.env["crm.lead"].create({
            name: "Cached out",
            stage_id: 2,
            team_id: 1,
            expected_revenue: 7,
        });
        await setOffline(true);
        await expect(renderer.onQuickCreated(cachedOutId, undefined)).rejects.toThrow(
            ConnectionLostError
        );
        await animationFrame();
        expect(recordOf(renderer, cachedOutId)).toBe(undefined);
        expect(groupOf(renderer, 2).count).toBe(1);
        expectHeader("New", 2, 120);

        // Back online: the reconciliation reload shows it.
        await setOffline(false);
        await waitUntil(() => recordOf(renderer, cachedOutId));
        await animationFrame();
        expect(groupOf(renderer, 2).count).toBe(2);

        // The reload made for another lead loses the connection after the screen stopped being
        // small: no stage pipeline shows a lead any more, so it resolves quietly.
        const goneId = MockServer.env["crm.lead"].create({
            name: "Gone pipeline",
            stage_id: 2,
            team_id: 1,
            expected_revenue: 9,
        });
        groupReads.active = true;
        const reload = renderer.onQuickCreated(goneId, undefined);
        await expect.waitForSteps(["held groups"]);
        await resize({ width: 1024 });
        await animationFrame();
        expect(renderer.isMobilePipeline).toBe(false);
        await setOffline(true);
        groupReads.active = false;
        groupReads.release();
        await expect(reload).resolves.toBe(undefined);
        expect(recordOf(renderer, goneId)).toBe(undefined);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: an online Log call whose re-read the cache answers before the connection drops shows the call at once, keeps it offline across stage navigation, and the reconnection replaces it by the server row", async () => {
        // the re-read answered by the cache refreshes in the background; offline, Qualified is
        // displayed (the types are cached, Lead 3's activities are not), then New again (the
        // types and both leads' activities are cached)
        const errors = cachedReadErrors([ACTIVITIES, TYPES, TYPES, ACTIVITIES, ACTIVITIES]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const drop = dropNextRequest(
            setOffline,
            "/web/dataset/call_kw/mail.activity/web_search_read"
        );
        watchActivityReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect.verifySteps(["activities:1", "activities:2"]);
        expect(badgeOf("Lead 1")).toHaveText("0");

        // The server saves the call; its re-read is answered by the cache (no activity), then
        // the refresh loses the connection. The call shows at once, as a server row, and its
        // count is announced.
        drop.armed = true;
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).click();
        await animationFrame();
        expect.verifySteps(["activities:1"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queued()).toHaveLength(0);
        const [callId] = serverActivityIds(1);
        expect(callId).not.toBe(undefined);
        expect(badgeOf("Lead 1")).toHaveText("1");
        expect(statusRegionOf("Lead 1")).toHaveText("Lead 1: 1 activity.");
        expect(await openActivities("Lead 1")).toEqual(["Call"]);
        const row = `${cardOf("Lead 1")} .o_crm_mobile_activity_row[data-activity-id='${callId}']`;
        expect(`${row} .o_crm_mobile_activity_type`).toHaveText("Call");
        expect(`${row} .o_crm_mobile_activity_done`).toHaveCount(1);
        expect(`${row} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_pending`).toHaveCount(0);

        // Offline, another stage is displayed, then New again: the cache answers Lead 1's read
        // with the rows from before the call, which keep it on the new card.
        await goToStage("Qualified");
        await goToStage("New");
        expect.verifySteps(["activities:3", "activities:1", "activities:2"]);
        expect(badgeOf("Lead 1")).toHaveText("1");
        expect(await openActivities("Lead 1")).toEqual(["Call"]);
        expect(row).toHaveCount(1);

        // Back online: the reads list the server row, which takes its place, once.
        await setOffline(false);
        await expect.waitForSteps(["activities:1", "activities:2", "activities:1", "activities:2"]);
        await animationFrame();
        expect(renderer.mobileState.activityWritesByLead).toEqual({});
        expect(renderer.mobileState.activitiesByLead[1].map(({ id }) => id)).toEqual([callId]);
        expect(badgeOf("Lead 1")).toHaveText("1");
        expect(await openActivities("Lead 1")).toEqual(["Call"]);
        expect(row).toHaveCount(1);
        expect(serverActivityIds(1)).toEqual([callId]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: an online follow-up whose re-read the cache answers before the connection drops shows it at once in deadline order, and the reconnection replaces it by the server row", async () => {
        // the re-read answered by the cache refreshes in the background
        const errors = cachedReadErrors([ACTIVITIES]);
        expect.errors(errors.length);
        const [offerId] = await createActivities([
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const drop = dropNextRequest(
            setOffline,
            "/web/dataset/call_kw/mail.activity/web_search_read"
        );
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const card = cardOf("Lead 2");
        expect(badgeOf("Lead 2")).toHaveText("1");

        // A follow-up due before the existing activity (2030-01-10).
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_type`).select("1");
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Book a demo", {
            confirm: false,
        });
        await setDateInput(`${card} .o_crm_mobile_follow_up_date`, "2030-01-05");
        drop.armed = true;
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queued()).toHaveLength(0);
        const demoId = serverActivityIds(2).find((id) => id !== offerId);
        expect(demoId).not.toBe(undefined);
        // Shown at once, in the order the server reads them (deadline, then id).
        expect(badgeOf("Lead 2")).toHaveText("2");
        expect(statusRegionOf("Lead 2")).toHaveText("Lead 2: 2 activities.");
        expect(await openActivities("Lead 2")).toEqual(["Book a demo", "Send offer"]);
        const demoRow = `${card} .o_crm_mobile_activity_row[data-activity-id='${demoId}']`;
        expect(`${demoRow} .o_crm_mobile_activity_type`).toHaveText("Email");
        expect(`${demoRow} .o_crm_mobile_activity_deadline`).toHaveText(
            formatDate(deserializeDate("2030-01-05"))
        );
        expect(`${card} .o_crm_mobile_activity_pending`).toHaveCount(0);

        // Back online: the reads list the server row, which takes its place, once.
        await setOffline(false);
        await waitUntil(() => !(2 in renderer.mobileState.activityWritesByLead));
        await animationFrame();
        expect(renderer.mobileState.activitiesByLead[2].map(({ id }) => id)).toEqual([
            demoId,
            offerId,
        ]);
        expect(badgeOf("Lead 2")).toHaveText("2");
        expect(await openActivities("Lead 2")).toEqual(["Book a demo", "Send offer"]);
        expect(demoRow).toHaveCount(1);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: an online mark done whose re-read the cache answers before the connection drops removes the row and lowers the count at once, also offline across stage navigation, until a read no longer lists it", async () => {
        // the re-read answered by the cache refreshes in the background; offline, Qualified is
        // displayed (the types are cached, Lead 3's activities are not), then New again (the
        // types and both leads' activities are cached)
        const errors = cachedReadErrors([ACTIVITIES, TYPES, TYPES, ACTIVITIES, ACTIVITIES]);
        expect.errors(errors.length);
        const [offerId, callBackId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
            {
                res_id: 1,
                activity_type_id: 2,
                activity_category: "phonecall",
                summary: "Call back",
                date_deadline: "2030-01-20",
            },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "action_done", ({ args }) => {
            MockServer.env["mail.activity"].action_feedback(args[0]);
            return true;
        });
        const setOffline = mockOffline();
        const drop = dropNextRequest(
            setOffline,
            "/web/dataset/call_kw/mail.activity/web_search_read"
        );
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(badgeOf("Lead 1")).toHaveText("2");
        expect(await openActivities("Lead 1")).toEqual(["Send offer", "Call back"]);

        // Done on the server; the re-read is answered by the cache (both rows), then its refresh
        // loses the connection. The row leaves at once and the count falls, announced.
        drop.armed = true;
        const lead1Card = cardOf("Lead 1");
        const offerRow = `${lead1Card} .o_crm_mobile_activity_row[data-activity-id='${offerId}']`;
        await contains(`${offerRow} .o_crm_mobile_activity_done`).click();
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(queued()).toHaveLength(0);
        expect(serverActivityIds(1)).toEqual([callBackId]);
        expect(badgeOf("Lead 1")).toHaveText("1");
        expect(statusRegionOf("Lead 1")).toHaveText("Lead 1: 1 activity.");
        expect(await openActivities("Lead 1")).toEqual(["Call back"]);

        // Offline, another stage is displayed, then New again: the cache answers with both rows,
        // and the one done stays hidden on the new card.
        await goToStage("Qualified");
        await goToStage("New");
        expect(badgeOf("Lead 1")).toHaveText("1");
        expect(await openActivities("Lead 1")).toEqual(["Call back"]);

        // Back online: a read no longer lists it, and nothing is left to hide.
        await setOffline(false);
        await waitUntil(() => !(1 in renderer.mobileState.activityWritesByLead));
        await animationFrame();
        expect(renderer.mobileState.activitiesByLead[1].map(({ id }) => id)).toEqual([callBackId]);
        expect(badgeOf("Lead 1")).toHaveText("1");
        expect(await openActivities("Lead 1")).toEqual(["Call back"]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: confirmed activity writes show over the stored page in the loader's order until a read reflects them, and are forgotten with their lead", async () => {
        const [firstId, secondId] = await createActivities([
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "First" },
            {
                res_id: 2,
                activity_type_id: 1,
                activity_category: "default",
                summary: "Second",
                date_deadline: "2030-01-20",
            },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "action_done", ({ args }) => {
            MockServer.env["mail.activity"].action_feedback(args[0]);
            return true;
        });
        // Registered after the other answers: it runs first and holds the activity reads.
        const activityReads = holdRequests(
            "/web/dataset/call_kw/mail.activity/web_search_read",
            "activities"
        );
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const { mobileState } = renderer;
        /**
         * Creates an activity of a lead on the server, as a card's online call does.
         *
         * @param {number} resId
         * @param {string} summary
         * @param {string | false} dateDeadline
         * @returns {Object} the row the card hands to the pipeline for it
         */
        const createdRow = (resId, summary, dateDeadline) => {
            const id = MockServer.env["mail.activity"].create({
                res_model: "crm.lead",
                res_id: resId,
                activity_type_id: 1,
                activity_category: "default",
                summary,
                date_deadline: dateDeadline,
                user_id: serverState.userId,
            });
            return {
                id,
                activity_type_id: { id: 1, display_name: "Email" },
                activity_category: "default",
                summary,
                date_deadline: dateDeadline,
                user_id: { id: serverState.userId, display_name: "Mitchell Admin" },
            };
        };
        const shownIds = (resId) => renderer.activitiesFor(resId)?.map(({ id }) => id) ?? null;
        const byId = (a, b) => a - b;

        // A lead loaded but never displayed (Won), hence never read: its write shows without a
        // total, and no read starts for it.
        const won = createdRow(5, "Won follow-up", "2030-02-01");
        expect(renderer.onActivitiesChanged(5, { created: won })).toBe(undefined);
        expect(shownIds(5)).toEqual([won.id]);
        expect(renderer.activityTotalFor(5)).toBe(null);
        // Displayed, its card shows the write while the lead is read; the server row then takes
        // its place (the stages passed on the way, Qualified and Proposition, read their lead).
        activityReads.active = true;
        await goToStage("Won");
        expect.verifySteps(["held activities", "held activities", "held activities"]);
        expect(badgeOf("Lead 5")).toHaveText("1");
        expect(await openActivities("Lead 5")).toEqual(["Won follow-up"]);
        activityReads.active = false;
        activityReads.release();
        await animationFrame();
        expect(5 in mobileState.activityWritesByLead).toBe(false);
        expect(shownIds(5)).toEqual([won.id]);
        expect(renderer.activityTotalFor(5)).toBe(1);
        await goToStage("New");
        await animationFrame();
        expect(shownIds(2)).toEqual([firstId, secondId]);
        expect(renderer.activityTotalFor(2)).toBe(2);

        // Lead 2's writes, while its re-reads are held: three activities created (one due
        // first, one due with "First" but created after it, one without deadline), one created
        // and then done before any read, and "Second" done twice. A call without a write, or
        // for a lead no group holds, records nothing.
        activityReads.active = true;
        const early = createdRow(2, "Early", "2030-01-01");
        const sameDay = createdRow(2, "Same day", "2030-01-10");
        const undated = createdRow(2, "Undated", false);
        const transient = createdRow(2, "Transient", "2030-01-15");
        for (const write of [
            { created: sameDay },
            { created: undated },
            { created: early },
            { created: transient },
            { doneId: transient.id },
            { doneId: secondId },
            { doneId: secondId },
            undefined,
        ]) {
            renderer.onActivitiesChanged(2, write);
        }
        MockServer.env["mail.activity"].action_feedback([transient.id, secondId]);
        expect(renderer.onActivitiesChanged(99, { created: { ...early, id: 9999 } })).toBe(
            undefined
        );
        expect(99 in mobileState.activityWritesByLead).toBe(false);
        await animationFrame();
        expect(shownIds(2)).toEqual([early.id, firstId, sameDay.id, undated.id]);
        expect(renderer.activityTotalFor(2)).toBe(4);
        // The answers the cache gave the held re-reads (the rows from before the writes, the
        // same total) keep every write, in order, "Second" done once; the props a card gets
        // keep their identity meanwhile.
        expect(writeSteps(mobileState.activityWritesByLead[2])).toEqual([
            [sameDay.id, 1],
            [undated.id, 1],
            [early.id, 1],
            [transient.id, 1],
            [transient.id, -1],
            [secondId, -1],
        ]);
        expect(renderer.activitiesFor(2)).toBe(renderer.activitiesFor(2));
        expect(badgeOf("Lead 2")).toHaveText("4");
        expect(await openActivities("Lead 2")).toEqual(["Early", "First", "Same day", "Undated"]);

        // The server answers: every write is reflected and forgotten.
        expect.verifySteps(["held activities"]);
        activityReads.active = false;
        activityReads.release();
        await animationFrame();
        expect(2 in mobileState.activityWritesByLead).toBe(false);
        expect(shownIds(2).sort(byId)).toEqual(
            [early.id, firstId, sameDay.id, undated.id].sort(byId)
        );
        expect(renderer.activityTotalFor(2)).toBe(4);
        expect(badgeOf("Lead 2")).toHaveText("4");

        // A write whose re-read is still held when a filter leaves its lead out is forgotten with
        // the lead, and the late answer is dropped.
        activityReads.active = true;
        const late = createdRow(2, "Late", "2030-03-01");
        renderer.onActivitiesChanged(2, { created: late });
        expect(writeSteps(mobileState.activityWritesByLead[2])).toEqual([[late.id, 1]]);
        await toggleSearchBarMenu();
        await toggleMenuItem("Lead One");
        await toggleSearchBarMenu();
        expect(cardNames()).toEqual(["Lead 1"]);
        expect(2 in mobileState.activityWritesByLead).toBe(false);
        expect(2 in mobileState.activitiesByLead).toBe(false);
        activityReads.active = false;
        activityReads.release();
        await animationFrame();
        expect(2 in mobileState.activitiesByLead).toBe(false);
        expect(shownIds(2)).toBe(null);
        expect.verifySteps(["held activities", "held activities"]);
    });

    test.tags("mobile");
    test("mobile: a fresh bounded read after an online follow-up beyond its page and an online mark done shows the server's total, without the activity done and without a second row for the one created", async () => {
        // Lead 1 has 50 activities due the same day: its bounded page lists the first 40, by id.
        const ids = await createLeadActivities(1, 50);
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "action_done", ({ args }) => {
            MockServer.env["mail.activity"].action_feedback(args[0]);
            return true;
        });
        // Registered after the other answers: it runs first and holds the activity reads.
        const activityReads = holdRequests(
            "/web/dataset/call_kw/mail.activity/web_search_read",
            "activities"
        );
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const { mobileState } = renderer;
        const card = cardOf("Lead 1");
        const rowOf = (id) => `${card} .o_crm_mobile_activity_row[data-activity-id='${id}']`;
        expect(badgeOf("Lead 1")).toHaveText("50");
        expect(mobileState.activitiesByLead[1].map(({ id }) => id)).toEqual(ids.slice(0, 40));

        // Online, while the re-reads are held (the cache answers them with the page from
        // before): a follow-up due after every activity, hence beyond the page, then Mark done
        // of the first activity.
        activityReads.active = true;
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_type`).select("1");
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Beyond the page", {
            confirm: false,
        });
        await setDateInput(`${card} .o_crm_mobile_follow_up_date`, "2031-01-01");
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        await animationFrame();
        const createdId = serverActivityIds(1).find((id) => !ids.includes(id));
        expect(createdId).not.toBe(undefined);
        await openActivities("Lead 1");
        await contains(`${rowOf(ids[0])} .o_crm_mobile_activity_done`).click();
        await animationFrame();
        expect.verifySteps(["held activities"]);
        expect(queued()).toHaveLength(0);
        expect(serverActivityIds(1)).toHaveLength(50);
        // Both writes show over the page from before: 50 in all, the activity done gone, the one
        // created last.
        expect(writeSteps(mobileState.activityWritesByLead[1])).toEqual([
            [createdId, 1],
            [ids[0], -1],
        ]);
        expect(badgeOf("Lead 1")).toHaveText("50");
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect(rowOf(ids[0])).toHaveCount(0);
        expect(rowOf(createdId)).toHaveCount(1);

        // The server answers: its page lists the 2nd to the 41st activities, 50 in all. Both
        // writes are reflected and forgotten, so the card shows the server's page and total.
        activityReads.active = false;
        activityReads.release();
        await animationFrame();
        expect(1 in mobileState.activityWritesByLead).toBe(false);
        expect(mobileState.activitiesByLead[1].map(({ id }) => id)).toEqual(ids.slice(1, 41));
        expect(mobileState.activityTotalsByLead[1]).toBe(50);
        expect(renderer.activitiesFor(1).map(({ id }) => id)).toEqual(ids.slice(1, 41));
        expect(renderer.activityTotalFor(1)).toBe(50);
        expect(badgeOf("Lead 1")).toHaveText("50");
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(40);
        expect(rowOf(ids[0])).toHaveCount(0);
        expect(rowOf(createdId)).toHaveCount(0);
        expect(`${card} .o_crm_mobile_activities_show_all`).toHaveText("Show all (50)");
    });

    test.tags("mobile");
    test("mobile: a read issued between two confirmed activity writes forgets only the writes before it, shown by its rows or, beyond its bounded page, by its total", async () => {
        const [firstId] = await createActivities([
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "First" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await animationFrame();
        const [renderer] = renderers;
        const { mobileState } = renderer;
        const writesOfLead = () => writeSteps(mobileState.activityWritesByLead[2] ?? []);
        const shown = () => [
            renderer.activitiesFor(2).map(({ id }) => id),
            renderer.activityTotalFor(2),
        ];
        const [first] = mobileState.activitiesByLead[2];
        expect(shown()).toEqual([[firstId], 1]);
        const [a, b, c, d] = [2, 3, 4, 5].map((month) =>
            activityRow(900 + month, `2030-0${month}-01`)
        );

        // Two activities created (the same one recorded once, a call without a write records
        // nothing): the read issued between them lists the first, not the second although its
        // page would.
        renderer._recordActivityWrite(2, { created: a });
        renderer._recordActivityWrite(2, { created: b });
        renderer._recordActivityWrite(2, { created: b });
        renderer._recordActivityWrite(2, {});
        expect(writesOfLead()).toEqual([
            [a.id, 1],
            [b.id, 1],
        ]);
        expect(shown()).toEqual([[firstId, a.id, b.id], 3]);
        renderer._applyActivities(2, { records: [first, a], length: 2 });
        expect(writesOfLead()).toEqual([[b.id, 1]]);
        expect(shown()).toEqual([[firstId, a.id, b.id], 3]);

        // "First" marked done next: the read issued before it lists the activity created before
        // it, and still "First". The read after it no longer lists "First".
        renderer._recordActivityWrite(2, { doneId: firstId });
        expect(shown()).toEqual([[a.id, b.id], 2]);
        renderer._applyActivities(2, { records: [first, a, b], length: 3 });
        expect(writesOfLead()).toEqual([[firstId, -1]]);
        expect(shown()).toEqual([[a.id, b.id], 2]);
        renderer._applyActivities(2, { records: [a, b], length: 2 });
        expect(2 in mobileState.activityWritesByLead).toBe(false);
        expect(shown()).toEqual([[a.id, b.id], 2]);

        // Two activities created beyond a bounded page of one row: the read issued between them
        // lists neither, and its total counts the first only. A later read whose page leaves the
        // second out counts it too.
        renderer._recordActivityWrite(2, { created: c });
        renderer._recordActivityWrite(2, { created: d });
        expect(shown()).toEqual([[a.id, b.id, c.id, d.id], 4]);
        renderer._applyActivities(2, { records: [a], length: 3 });
        expect(writesOfLead()).toEqual([[d.id, 1]]);
        expect(shown()).toEqual([[a.id, d.id], 4]);
        renderer._applyActivities(2, { records: [a, b], length: 4 });
        expect(2 in mobileState.activityWritesByLead).toBe(false);
        expect(shown()).toEqual([[a.id, b.id], 4]);

        // An activity created ahead of every other one pushes the last row of the full page out
        // of it, and that row is marked done next: the read issued between them lists the first
        // and no longer the row done, which its page would not list anyway. The mark done stays.
        const early = activityRow(906, "2030-01-01");
        renderer._recordActivityWrite(2, { created: early });
        renderer._recordActivityWrite(2, { doneId: b.id });
        expect(shown()).toEqual([[early.id, a.id], 4]);
        renderer._applyActivities(2, { records: [early, a], length: 5 });
        expect(writesOfLead()).toEqual([[b.id, -1]]);
        expect(shown()).toEqual([[early.id, a.id], 4]);
        renderer._applyActivities(2, { records: [early, a], length: 4 });
        expect(2 in mobileState.activityWritesByLead).toBe(false);
        expect(shown()).toEqual([[early.id, a.id], 4]);

        // A read whose total no count of writes gives (activities changed elsewhere meanwhile)
        // forgets only the writes its rows show reflected.
        const listed = activityRow(907, "2030-01-15");
        const beyond = activityRow(908, "2030-06-01");
        renderer._recordActivityWrite(2, { created: listed });
        renderer._recordActivityWrite(2, { created: beyond });
        expect(shown()).toEqual([[early.id, listed.id, a.id, beyond.id], 6]);
        renderer._applyActivities(2, { records: [early, listed], length: 9 });
        expect(writesOfLead()).toEqual([[beyond.id, 1]]);
        expect(shown()).toEqual([[early.id, listed.id, beyond.id], 10]);
        renderer._applyActivities(2, { records: [early, listed], length: 10 });
        expect(2 in mobileState.activityWritesByLead).toBe(false);

        // A mark done confirmed after a read that already reflects it: the card no longer shows
        // its row, the total never falls below 0, and the next read forgets it.
        renderer._applyActivities(2, { records: [], length: 0 });
        renderer._recordActivityWrite(2, { doneId: listed.id });
        expect(mobileState.activityWritesByLead[2][0].row).toBe(undefined);
        expect(shown()).toEqual([[], 0]);
        renderer._applyActivities(2, { records: [], length: 0 });
        expect(2 in mobileState.activityWritesByLead).toBe(false);
        expect(shown()).toEqual([[], 0]);
        await animationFrame();
        expect(badgeOf("Lead 2")).toHaveText("0");
    });

    test.tags("mobile");
    test("mobile: a read the cache answers with the page from before the writes keeps every write, an activity created then marked done included, until a read reflects them", async () => {
        const [firstId] = await createActivities([
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "First" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await animationFrame();
        const [renderer] = renderers;
        const { mobileState } = renderer;
        const writesOfLead = () => writeSteps(mobileState.activityWritesByLead[2] ?? []);
        const shown = () => [
            renderer.activitiesFor(2).map(({ id }) => id),
            renderer.activityTotalFor(2),
        ];
        const [first] = mobileState.activitiesByLead[2];
        const created = activityRow(911, "2030-02-01");

        // "First" marked done, then an activity created and marked done (once).
        renderer._recordActivityWrite(2, { doneId: firstId });
        renderer._recordActivityWrite(2, { created });
        renderer._recordActivityWrite(2, { doneId: created.id });
        renderer._recordActivityWrite(2, { doneId: created.id });
        const writes = [
            [firstId, -1],
            [created.id, 1],
            [created.id, -1],
        ];
        expect(writesOfLead()).toEqual(writes);
        expect(shown()).toEqual([[], 0]);
        await animationFrame();
        expect(badgeOf("Lead 2")).toHaveText("0");

        // The cache answers with the page from before: it still lists "First", and leaves out
        // the activity created after it. Every write stays, and so does what the card shows; a
        // read that lost the connection (`null`) changes nothing either.
        renderer._applyActivities(2, { records: [first], length: 1 });
        expect(writesOfLead()).toEqual(writes);
        expect(shown()).toEqual([[], 0]);
        renderer._applyActivities(2, null);
        expect(writesOfLead()).toEqual(writes);
        expect(mobileState.activitiesByLead[2]).toEqual([first]);
        await animationFrame();
        expect(badgeOf("Lead 2")).toHaveText("0");

        // A fresh read reflects them all.
        renderer._applyActivities(2, { records: [], length: 0 });
        expect(2 in mobileState.activityWritesByLead).toBe(false);
        expect(shown()).toEqual([[], 0]);

        // An activity created then marked done, and a read from before both: it lists neither,
        // so it may reflect both, whose deltas cancel out. They are forgotten, and the card shows
        // the same.
        const transient = activityRow(912, "2030-02-01");
        renderer._recordActivityWrite(2, { created: transient });
        renderer._recordActivityWrite(2, { doneId: transient.id });
        expect(shown()).toEqual([[], 0]);
        renderer._applyActivities(2, { records: [], length: 0 });
        expect(2 in mobileState.activityWritesByLead).toBe(false);
        expect(shown()).toEqual([[], 0]);
        await animationFrame();
        expect(badgeOf("Lead 2")).toHaveText("0");
    });
});

describe("Remaining quick create branches", () => {
    test.tags("mobile");
    test("mobile: quick create lists the no-stage group first, whichever position the server answers it in", async () => {
        // A lead without stage, on this test's mock server only: the pipeline has a "None" group.
        if (!MockServer.current) {
            await makeMockServer();
        }
        MockServer.env["crm.lead"].create({ name: "Unstaged lead", expected_revenue: 10 });
        mockActivityTypes(ACTIVITY_TYPES);
        const serverOrder = { noStageFirst: true };
        onRpc("crm.lead", "web_read_group", async ({ parent }) => {
            const result = await parent();
            const noStage = result.groups.filter((group) => !group.stage_id);
            const staged = result.groups.filter((group) => group.stage_id);
            result.groups = serverOrder.noStageFirst
                ? [...noStage, ...staged]
                : [...staged, ...noStage];
            return result;
        });
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step({ web_save: args[1] });
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const groupNames = () => renderer.props.list.groups.map((group) => group.displayName);
        const sheetOrder = ["None", "New", "Qualified", "Proposition", "Won"];

        // The server answers the no-stage group first.
        expect(groupNames()).toEqual(sheetOrder);
        await contains(".o_crm_mobile_pipeline_add").click();
        expect(quickCreateStageOptions()).toEqual(sheetOrder);

        // A reload whose answer lists it last: the open sheet still lists it first.
        serverOrder.noStageFirst = false;
        await renderer.props.list.load();
        await animationFrame();
        expect(groupNames()).toEqual(["New", "Qualified", "Proposition", "Won", "None"]);
        expect(quickCreateStageOptions()).toEqual(sheetOrder);

        // Chosen, that first option creates a lead without stage.
        await fillQuickCreate({ name: "No stage lead", stage_id: "None" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([
            {
                web_save: {
                    name: "No stage lead",
                    contact_name: false,
                    phone: false,
                    email_from: false,
                    expected_revenue: 0,
                    stage_id: false,
                },
            },
        ]);
        const [created] = serverLeads("No stage lead");
        expect(created.stage_id).toBe(false);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: a second quick create save while the first is pending sends nothing: one web_save, one lead", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const pendingSave = Promise.withResolvers();
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`web_save ${args[1].name}`);
            await pendingSave.promise;
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate(recordId, mode, group) {
                expect.step({ validateQuickCreate: [recordId, mode, group.serverValue] });
                return super.validateQuickCreate(...arguments);
            },
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Double tap" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps(["web_save Double tap"]);
        // While the call is pending, Save is disabled and a direct second save returns at once.
        expect(".o_crm_mobile_quick_create_save").toHaveAttribute("disabled");
        const [sheet] = sheets;
        await sheet.save();
        await animationFrame();
        expect.verifySteps([]);
        expect(".o_crm_mobile_quick_create").toHaveCount(1);

        pendingSave.resolve();
        await animationFrame();
        const created = serverLeads("Double tap");
        expect(created).toHaveLength(1);
        expect.verifySteps([{ validateQuickCreate: [created[0].id, "close", 1] }]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Double tap")).toHaveCount(1);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: quick create dismissed while its save is pending shows the created lead at once, keeps no sheet state, and the next reload neither doubles nor recreates it", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const pendingSave = Promise.withResolvers();
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`web_save ${args[1].name}`);
            await pendingSave.promise;
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate(recordId, mode, group) {
                expect.step({ validateQuickCreate: [recordId, mode, group.serverValue] });
                return super.validateQuickCreate(...arguments);
            },
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Dismissed lead", expected_revenue: "15" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps(["web_save Dismissed lead"]);
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(status(sheets[0])).toBe("destroyed");
        expect(cardOf("Dismissed lead")).toHaveCount(0);

        // The server creates the lead once the sheet is gone. The call outlives the sheet (it
        // does not go through the sheet's own ORM): the pipeline adds the created lead to the live
        // group of its stage, and its card shows at once, as a server record, with no error.
        pendingSave.resolve();
        await animationFrame();
        const created = serverLeads("Dismissed lead");
        expect(created).toHaveLength(1);
        expect.verifySteps([{ validateQuickCreate: [created[0].id, "close", 1] }]);
        expect(cardOf("Dismissed lead")).toHaveCount(1);
        expect(`${cardOf("Dismissed lead")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(queued()).toHaveLength(0);
        expectHeader("New", 3, 135);

        // The dismissed sheet keeps no usable state: a direct save of it sends nothing, and the
        // next sheet is a new one that opens empty.
        await sheets[0].save();
        await animationFrame();
        expect.verifySteps([]);
        await contains(".o_crm_mobile_pipeline_add").click();
        expect(sheets).toHaveLength(2);
        expect(status(sheets[1])).toBe("mounted");
        expect(".o_crm_mobile_quick_create [name=name]").toHaveValue("");
        expect(queryOne(".o_crm_mobile_quick_create [name=expected_revenue]").value).toBe("");
        expect(".o_crm_mobile_quick_create_save").not.toHaveAttribute("disabled");
        await contains(".o_crm_mobile_quick_create_discard").click();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect.verifySteps([]);

        // The next reload shows the lead once, with the same totals, and nothing is created again.
        await renderers[0].props.list.load();
        await animationFrame();
        expect(cardOf("Dismissed lead")).toHaveCount(1);
        expect(`${cardOf("Dismissed lead")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expectHeader("New", 3, 135);
        expect(serverLeads("Dismissed lead")).toHaveLength(1);
        expect(queued()).toHaveLength(0);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a server error answered after the quick create was dismissed still surfaces, and nothing is created or queued", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const pendingSave = Promise.withResolvers();
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`web_save ${args[1].name}`);
            await pendingSave.promise;
            throw makeServerError({ message: "This lead name is reserved" });
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate() {
                expect.step("validateQuickCreate");
                return super.validateQuickCreate(...arguments);
            },
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();
        expect.errors(1);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Reserved lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps(["web_save Reserved lead"]);
        await press("Escape");
        await animationFrame();
        expect(status(sheets[0])).toBe("destroyed");

        pendingSave.resolve();
        await animationFrame();
        expect.verifyErrors(["This lead name is reserved"]);
        await contains(".modal .modal-footer .btn-primary").click();
        expect.verifySteps([]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(serverLeads("Reserved lead")).toEqual([]);
        expect(queued()).toHaveLength(0);
        expectHeader("New", 2, 120);
    });

    test.tags("mobile");
    test("mobile: quick create dismissed while its save is pending, then the connection drops: the create is queued and the closed sheet does nothing more", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const connection = mockConnectionDrop();
        const pendingSave = Promise.withResolvers();
        onRpc("/web/dataset/call_kw/crm.lead/web_save", async () => {
            expect.step("web_save");
            await pendingSave.promise;
            // The connection dropped meanwhile: the call fails as a lost connection.
            return new Response("", { status: 502 });
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate() {
                expect.step("validateQuickCreate");
                return super.validateQuickCreate(...arguments);
            },
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Dropped after dismissal", expected_revenue: "35" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps(["web_save"]);
        await press("Escape");
        await animationFrame();
        expect(status(sheets[0])).toBe("destroyed");

        connection.offline = true;
        pendingSave.resolve();
        await animationFrame();
        // The lead is not lost: its create is queued with the sheet's values, and the closed
        // sheet calls nothing back.
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect.verifySteps([]);
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args).toEqual([
            [],
            {
                name: "Dropped after dismissal",
                contact_name: false,
                phone: false,
                email_from: false,
                expected_revenue: 35,
                stage_id: 1,
            },
        ]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_lead_card_pending .o_crm_mobile_lead_card_name").toHaveText(
            "Dropped after dismissal"
        );
        expectHeader("New", 3, 155);
        expect(serverLeads("Dropped after dismissal")).toEqual([]);
    });

    test.tags("mobile");
    test("mobile: quick create whose onCreated rejects after the lead is created closes the sheet, and no second create follows", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["crm.lead/web_save"]);
        patchWithCleanup(CrmMobilePipeline.prototype, {
            async validateQuickCreate(recordId) {
                expect.step(`validateQuickCreate ${recordId}`);
                throw new Error("The created lead could not be added to its stage");
            },
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();
        expect.errors(1);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Unplaced lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const created = serverLeads("Unplaced lead");
        expect(created).toHaveLength(1);
        expect.verifySteps(["crm.lead/web_save", `validateQuickCreate ${created[0].id}`]);
        expect.verifyErrors(["The created lead could not be added to its stage"]);
        // The lead exists, so the sheet is closed: a second tap cannot create it again, and even
        // a direct save of the closed sheet sends nothing.
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        await sheets[0].save();
        await animationFrame();
        expect.verifySteps([]);
        expect(serverLeads("Unplaced lead")).toHaveLength(1);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: quick create dismissed while its created lead is being added still gets the card, with no error", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["crm.lead/web_save"]);
        const pendingAdd = Promise.withResolvers();
        patchWithCleanup(CrmMobilePipeline.prototype, {
            async validateQuickCreate(recordId) {
                expect.step(`validateQuickCreate ${recordId}`);
                await pendingAdd.promise;
                return super.validateQuickCreate(...arguments);
            },
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Late card", expected_revenue: "5" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [created] = serverLeads("Late card");
        expect.verifySteps(["crm.lead/web_save", `validateQuickCreate ${created.id}`]);
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(status(sheets[0])).toBe("destroyed");

        pendingAdd.resolve();
        await animationFrame();
        expect(cardOf("Late card")).toHaveCount(1);
        expect(`${cardOf("Late card")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expectHeader("New", 3, 125);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: quick create answered without a created record closes the sheet and adds no card", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`web_save ${args[1].name}`);
            return [];
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate() {
                expect.step("validateQuickCreate");
                return super.validateQuickCreate(...arguments);
            },
        });
        await mountPipeline();

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Unanswered lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps(["web_save Unanswered lead"]);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Unanswered lead")).toHaveCount(0);
        expect(queued()).toHaveLength(0);
        expectHeader("New", 2, 120);
    });

    test.tags("mobile");
    test("mobile: quick create whose selected stage leaves the stage list on a reload moves the selection to the first stage and creates the lead there", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args, kwargs }) => {
            expect.step({ web_save: [args[1].stage_id, kwargs.context.default_stage_id] });
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate(recordId, mode, group) {
                expect.step({ validateQuickCreate: [recordId, mode, group.serverValue] });
                return super.validateQuickCreate(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        await goToStage("Qualified");

        await contains(".o_crm_mobile_pipeline_add").click();
        expect(quickCreateSelectedStage()).toBe("Qualified");
        await fillQuickCreate({ name: "Regrouped lead", stage_id: "Proposition" });
        // A reload under another domain leaves out Lead 4, the only lead in Proposition: the
        // answer has no Proposition group. (A reload under the same domain keeps every group the
        // default stage grouping displayed, emptied.)
        await renderer.props.list.load({ domain: [["id", "!=", 4]] });
        await animationFrame();
        expect(renderer.props.list.groups.map((group) => group.serverValue)).toEqual([1, 2, 4]);
        expect(quickCreateStageOptions()).toEqual(["New", "Qualified", "Won"]);
        expect(quickCreateSelectedStage()).toBe("New");

        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [created] = serverLeads("Regrouped lead");
        expect.verifySteps([
            { web_save: [1, 1] },
            { validateQuickCreate: [created.id, "close", 1] },
        ]);
        expect(created.stage_id[0]).toBe(1);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: quick create saved before its stage selection resynchronizes creates the lead in the live group of the initial stage", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args, kwargs }) => {
            expect.step({ web_save: [args[1].stage_id, kwargs.context.default_stage_id] });
        });
        const targets = [];
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate(recordId, mode, group) {
                expect.step({ validateQuickCreate: [recordId, mode, group.serverValue] });
                targets.push(group);
                return super.validateQuickCreate(...arguments);
            },
        });
        const sheets = captureInstances(CrmMobileQuickCreate);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        await goToStage("Qualified");

        await contains(".o_crm_mobile_pipeline_add").click();
        const [sheet] = sheets;
        const initialGroup = sheet.props.group;
        await fillQuickCreate({ name: "Same tick lead", stage_id: "Proposition" });
        // A reload rebuilds every group: the sheet's initial group is no longer a live one.
        await renderer.props.list.load();
        await animationFrame();
        const liveQualified = groupOf(renderer, 2);
        expect(liveQualified === initialGroup).toBe(false);
        expect(quickCreateSelectedStage()).toBe("Proposition");
        // The selected Proposition group then leaves the list and the save starts in the same
        // tick, before the sheet's resynchronization effect (Owl runs effects in a later
        // microtask).
        const { groups } = renderer.props.list;
        groups.splice(groups.indexOf(groupOf(renderer, 3)), 1);
        await sheet.save();
        await animationFrame();
        const [created] = serverLeads("Same tick lead");
        expect.verifySteps([
            { web_save: [2, 2] },
            { validateQuickCreate: [created.id, "close", 2] },
        ]);
        // The live group of the initial stage, not the initial group itself, gets the card.
        expect(targets).toHaveLength(1);
        expect(targets[0] === liveQualified).toBe(true);
        expect(created.stage_id[0]).toBe(2);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(cardOf("Same tick lead")).toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: quick create keeps its initial stage when every stage group disappears while it is open", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Emptied pipeline lead", stage_id: "Qualified" });
        // A reload under a domain no lead matches answers no stage group at all: the view falls
        // back to the standard renderer while the sheet stays open.
        await renderer.props.list.load({ domain: [["id", "in", []]] });
        await animationFrame();
        expect(renderer.props.list.groups).toHaveLength(0);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(quickCreateStageOptions()).toEqual([]);

        await setOffline(true);
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args[1].stage_id).toBe(1);
        expect(saves[0].kwargs.context.default_stage_id).toBe(1);
        expect(saves[0].extras.changes.stage_id).toEqual({ id: 1, display_name: "New" });
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a queued quick create keeps the context it was queued with when the group context changes afterwards", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const [renderer] = renderers;

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Detached lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const newGroup = groupOf(renderer, 1);
        const [queuedSave] = queuedCalls("crm.lead", "web_save");
        expect(queuedSave.kwargs.context).toEqual({ ...newGroup.context });
        expect(queuedSave.kwargs.context).not.toBe(newGroup.context);
        const queuedContext = JSON.stringify(queuedSave.kwargs.context);

        // The group's own context object changes after queueing: the queued call does not.
        newGroup.context.default_stage_id = 4;
        newGroup.context.default_team_id = 1;
        const [afterChange] = queuedCalls("crm.lead", "web_save");
        expect(JSON.stringify(afterChange.kwargs.context)).toBe(queuedContext);
        expect(afterChange.kwargs.context.default_stage_id).toBe(1);
        expect(afterChange.kwargs.context).not.toInclude("default_team_id");
        newGroup.context.default_stage_id = 1;
        delete newGroup.context.default_team_id;
    });

    test.tags("mobile");
    test("mobile: quick create writes sheet values left null or undefined as empty values", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const sheets = captureInstances(CrmMobileQuickCreate);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);

        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Sparse lead" });
        // The inputs only ever write strings; a caller that sets the sheet state directly may
        // leave a value null or undefined.
        Object.assign(sheets[0].state, {
            contact_name: null,
            phone: undefined,
            email_from: null,
            expected_revenue: undefined,
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const saves = queuedCalls("crm.lead", "web_save");
        expect(saves).toHaveLength(1);
        expect(saves[0].args).toEqual([
            [],
            {
                name: "Sparse lead",
                contact_name: false,
                phone: false,
                email_from: false,
                expected_revenue: 0,
                stage_id: 1,
            },
        ]);
        expect(saves[0].extras.changes).toEqual({
            name: "Sparse lead",
            stage_id: { id: 1, display_name: "New" },
        });
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
    });
});

// -----------------------------------------------------------------------------
// Lead card: the session user's day, and the panels a toggle opens
// -----------------------------------------------------------------------------

/** The session user's day at the moment `mockDivergingDays` mocks. */
const USER_DAY = "2019-03-11";
/** The browser's day at that moment, a day behind the user's. */
const BROWSER_DAY = "2019-03-10";

/**
 * Puts the browser 12 hours behind UTC and the session user in the given time zone, at a moment
 * the two are on different days: 2019-03-11 08:00 UTC is 22:00 on March 11 in Pacific/Kiritimati
 * (UTC+14) and 20:00 on March 10 for the browser.
 *
 * @param {string} [userTimeZone] the session user's time zone, `""` for none
 */
function mockDivergingDays(userTimeZone = "Pacific/Kiritimati") {
    mockDate("2019-03-11 08:00:00");
    mockTimeZone(-12);
    serverState.timezone = userTimeZone;
}

describe("Lead card user day and panel reveal", () => {
    test.tags("mobile");
    test("mobile: offline, Log call is queued for the browser's today, while Follow-up defaults to the session user's today", async () => {
        mockDivergingDays();
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const card = cardOf("Lead 1");
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
        );
        const followUp = `${card} .o_crm_mobile_card_follow_up`;
        const dateInput = `${card} .o_crm_mobile_follow_up_date`;
        // The browser is on the previous day; the card starts on the user's.
        expect(serializeDate(today())).toBe(BROWSER_DAY);
        expect(lead1Card.state.date).toBe(USER_DAY);

        // Log call: queued for the browser's today, with the exact values of an activity create.
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        let creates = queuedCalls("mail.activity", "web_save");
        expect(creates).toHaveLength(1);
        expect(creates[0].args).toEqual([
            [],
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: 2,
                summary: "Call",
                date_deadline: BROWSER_DAY,
                user_id: serverState.userId,
            },
        ]);
        expect(creates[0].extras.changes.date_deadline).toBe(BROWSER_DAY);
        await advanceTime(1000);

        // Follow-up opens on the user's today, and a cleared date is saved as that day.
        await contains(followUp).click();
        expect(queryOne(dateInput).value).toBe(USER_DAY);
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Check in", {
            confirm: false,
        });
        await setDateInput(dateInput, "");
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        creates = queuedCalls("mail.activity", "web_save");
        expect(creates).toHaveLength(2);
        expect(creates[1].args).toEqual([
            [],
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: 1,
                summary: "Check in",
                date_deadline: USER_DAY,
                user_id: serverState.userId,
            },
        ]);

        // Cancel resets an edited date to the user's today, and queues nothing.
        await contains(followUp).click();
        await setDateInput(dateInput, "2030-02-15");
        expect(lead1Card.state.date).toBe("2030-02-15");
        await contains(`${card} .o_crm_mobile_follow_up_cancel`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        expect(lead1Card.state.date).toBe(USER_DAY);
        expect(queuedCalls("mail.activity", "web_save")).toHaveLength(2);

        // The pending rows, in the order they were queued, show the day each was queued for.
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(
            queryAllTexts(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_deadline`)
        ).toEqual([
            formatDate(deserializeDate(BROWSER_DAY)),
            formatDate(deserializeDate(USER_DAY)),
        ]);
    });

    test.tags("mobile");
    test("mobile: online, Log call sends the browser's today and a Follow-up with a cleared date the session user's today", async () => {
        mockDivergingDays();
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "web_save", ({ args }) => {
            expect.step(`web_save ${args[1].summary} ${args[1].date_deadline}`);
        });
        await mountPipeline();
        const card = cardOf("Lead 1");

        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        await expect.waitForSteps([`web_save Call ${BROWSER_DAY}`]);
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Check in", {
            confirm: false,
        });
        await setDateInput(`${card} .o_crm_mobile_follow_up_date`, "");
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        await expect.waitForSteps([`web_save Check in ${USER_DAY}`]);
        expect(queued()).toHaveLength(0);
        const saved = MockServer.env["mail.activity"].search_read(
            [
                ["res_model", "=", "crm.lead"],
                ["res_id", "=", 1],
            ],
            ["summary", "date_deadline"]
        );
        expect(saved.map(({ summary, date_deadline }) => [summary, date_deadline])).toEqual([
            ["Call", BROWSER_DAY],
            ["Check in", USER_DAY],
        ]);
    });

    test.tags("mobile");
    test("mobile: without a user time zone, or with one luxon does not know, the card falls back to the browser's today", async () => {
        mockDivergingDays("");
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const card = cardOf("Lead 1");
        const followUp = `${card} .o_crm_mobile_card_follow_up`;
        const dateInput = `${card} .o_crm_mobile_follow_up_date`;
        const queuedDeadlines = () =>
            queuedCalls("mail.activity", "web_save").map(({ args }) => args[1].date_deadline);

        // No user time zone: the browser's day.
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        expect(queuedDeadlines()).toEqual([BROWSER_DAY]);
        await contains(followUp).click();
        expect(queryOne(dateInput).value).toBe(BROWSER_DAY);
        await contains(`${card} .o_crm_mobile_follow_up_cancel`).click();
        await advanceTime(1000);

        // A time zone luxon does not know (the mock session's default): the browser's day too.
        serverState.timezone = "taht";
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        expect(queuedDeadlines()).toEqual([BROWSER_DAY, BROWSER_DAY]);
        await contains(followUp).click();
        expect(queryOne(dateInput).value).toBe(BROWSER_DAY);
    });

    test.tags("mobile");
    test("mobile: Stage, Follow-up and Activities scroll the panel they open into view once, closing scrolls nothing, and only the stage list takes the focus", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const panelClasses = [
            "o_crm_mobile_lead_card_stage_list",
            "o_crm_mobile_lead_card_follow_up",
            "o_crm_mobile_lead_card_activities",
        ];
        /** Every scroll into view of an element of a lead card: its panel class and options. */
        const reveals = [];
        patchWithCleanup(Element.prototype, {
            scrollIntoView(options) {
                if (this.closest(".o_crm_mobile_lead_card")) {
                    const panel = panelClasses.find((name) => this.classList.contains(name));
                    reveals.push([panel ?? this.className, options]);
                }
                return super.scrollIntoView(...arguments);
            },
        });
        const nearest = { block: "nearest" };
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        const card = cardOf("Lead 1");
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
        );
        const stage = `${card} .o_crm_mobile_card_stage`;
        const followUp = `${card} .o_crm_mobile_card_follow_up`;
        const activities = `${card} .o_crm_mobile_card_activities`;
        const [stageList, followUpForm, activityList] = panelClasses.map(
            (name) => `${card} .${name}`
        );

        // Stage: the list is scrolled into view, and its first enabled option has the focus.
        await contains(stage).click();
        expect(stageList).toHaveCount(1);
        expect(reveals).toEqual([[panelClasses[0], nearest]]);
        expect(`${card} .o_crm_mobile_stage_option[data-stage-value='2']`).toBeFocused();
        // A later render of the open list (a keyboard move) scrolls nothing more.
        await press("ArrowDown");
        await animationFrame();
        expect(`${card} .o_crm_mobile_stage_option[data-stage-value='3']`).toBeFocused();
        // Closing it, with Escape or with the toggle, scrolls nothing.
        await press("Escape");
        await animationFrame();
        expect(stageList).toHaveCount(0);
        expect(stage).toBeFocused();
        await contains(stage).click();
        await contains(stage).click();
        expect(stageList).toHaveCount(0);
        expect(reveals).toEqual([
            [panelClasses[0], nearest],
            [panelClasses[0], nearest],
        ]);
        reveals.length = 0;

        // Follow-up: the form is scrolled into view and takes no focus; typing in it, Cancel and
        // the toggle closing it scroll nothing.
        await contains(followUp).click();
        expect(followUpForm).toHaveCount(1);
        expect(reveals).toEqual([[panelClasses[1], nearest]]);
        expect(followUp).toBeFocused();
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Check in", {
            confirm: false,
        });
        await contains(`${card} .o_crm_mobile_follow_up_cancel`).click();
        expect(followUpForm).toHaveCount(0);
        await contains(followUp).click();
        await contains(followUp).click();
        expect(followUpForm).toHaveCount(0);
        expect(reveals).toEqual([
            [panelClasses[1], nearest],
            [panelClasses[1], nearest],
        ]);
        reveals.length = 0;

        // Activities: the list is scrolled into view and takes no focus; the toggle closing it
        // scrolls nothing.
        await contains(activities).click();
        expect(activityList).toHaveCount(1);
        expect(reveals).toEqual([[panelClasses[2], nearest]]);
        expect(activities).toBeFocused();
        await contains(activities).click();
        expect(activityList).toHaveCount(0);
        expect(reveals).toEqual([[panelClasses[2], nearest]]);
        reveals.length = 0;

        // Opening a panel from another one scrolls only the panel it opens.
        await contains(followUp).click();
        await contains(stage).click();
        expect(followUpForm).toHaveCount(0);
        expect(reveals).toEqual([
            [panelClasses[1], nearest],
            [panelClasses[0], nearest],
        ]);
        expect(`${card} .o_crm_mobile_stage_option[data-stage-value='3']`).toBeFocused();
        await contains(stage).click();
        reveals.length = 0;

        // Called directly, without a DOM event: a panel closed before it is rendered is never
        // scrolled to, while a panel opened since keeps its scroll.
        lead1Card.toggleFollowUp();
        lead1Card.onCancelFollowUp();
        lead1Card.toggleActivities();
        lead1Card.toggleActivities();
        await animationFrame();
        expect(followUpForm).toHaveCount(0);
        expect(activityList).toHaveCount(0);
        expect(reveals).toEqual([]);
        lead1Card.toggleStageList();
        lead1Card.onCancelFollowUp();
        await animationFrame();
        expect(stageList).toHaveCount(1);
        expect(reveals).toEqual([[panelClasses[0], nearest]]);
    });
});

// -----------------------------------------------------------------------------
// Mobile activities
// -----------------------------------------------------------------------------

describe("Mobile activities", () => {
    test.tags("mobile");
    test("mobile: schedule follow-up and log call offline queue full mail.activity create, shown pending", async () => {
        await createActivities([
            // an activity without type: listed as a plain "Activity"
            { res_id: 1, activity_type_id: false, summary: "Untyped", date_deadline: "2030-01-05" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs(["mail.activity/web_save", "mail.activity/action_done"]);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const card = cardOf("Lead 1");
        const todayString = serializeDate(today());

        // Log call: the first cached phonecall type, today, the session user.
        expect(`${card} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        let creates = queuedCalls("mail.activity", "web_save");
        expect(creates).toHaveLength(1);
        expect(creates[0].args).toEqual([
            [],
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: 2,
                summary: "Call",
                date_deadline: todayString,
                user_id: serverState.userId,
            },
        ]);
        expect(creates[0].kwargs).toEqual({ context: {}, specification: {} });
        expect(creates[0].extras.displayName).toBe("Call: Lead 1");
        expect(creates[0].extras.actionId).toBe(PIPELINE_ACTION_ID);
        await advanceTime(1000);

        // Follow-up: meeting and upload types are not offered.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(queryAllTexts(`${card} .o_crm_mobile_follow_up_type option`)).toEqual([
            "Email",
            "Call",
        ]);
        expect(queryOne(`${card} .o_crm_mobile_follow_up_date`).value).toBe(todayString);
        // Cancel closes the form and queues nothing.
        await contains(`${card} .o_crm_mobile_follow_up_cancel`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        expect(queued()).toHaveLength(1);
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_type`).select("1");
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Send the proposal", {
            confirm: false,
        });
        await setDateInput(`${card} .o_crm_mobile_follow_up_date`, "2030-02-15");
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        creates = queuedCalls("mail.activity", "web_save");
        expect(creates).toHaveLength(2);
        expect(creates[1].args).toEqual([
            [],
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: 1,
                summary: "Send the proposal",
                date_deadline: "2030-02-15",
                user_id: serverState.userId,
            },
        ]);
        expect(creates[1].kwargs).toEqual({ context: {}, specification: {} });
        await advanceTime(1000);
        // A cleared due date falls back to today.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Check in", {
            confirm: false,
        });
        await setDateInput(`${card} .o_crm_mobile_follow_up_date`, "");
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        creates = queuedCalls("mail.activity", "web_save");
        expect(creates).toHaveLength(3);
        expect(creates[2].args[1]).toMatchObject({
            activity_type_id: 1,
            summary: "Check in",
            date_deadline: todayString,
        });
        // Nothing was sent: offline, the creates are queued directly.
        expect.verifySteps([]);

        // The lead's activity list shows the queued creates as pending, then the cached one.
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_card_activities .badge`).toHaveText("4");
        expect(`${card} .o_crm_mobile_activity_pending`).toHaveCount(3);
        expect(
            queryAllTexts(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_type`)
        ).toEqual(["Call", "Email", "Email"]);
        // A truncated type keeps its full text as a title; summaries wrap instead of truncating.
        expect(
            queryAll(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_type`).map(
                (el) => el.title
            )
        ).toEqual(["Call", "Email", "Email"]);
        expect(
            queryAllTexts(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_summary`)
        ).toEqual(["Call", "Send the proposal", "Check in"]);
        expect(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_summary`).toHaveClass(
            "text-break"
        );
        expect(
            queryAllTexts(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_pending_badge`)
        ).toEqual(["Pending sync", "Pending sync", "Pending sync"]);
        expect(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_done`).toHaveCount(0);
        expect(
            `${card} .o_crm_mobile_activity_row:not(.o_crm_mobile_activity_pending)`
        ).toHaveCount(1);
        expect(
            `${card} .o_crm_mobile_activity_row:not(.o_crm_mobile_activity_pending) .o_crm_mobile_activity_type`
        ).toHaveText("Activity");
        // An untyped activity's Mark done is named after the plain "Activity" label.
        expect(`${card} .o_crm_mobile_activity_done`).toHaveAttribute(
            "aria-label",
            "Mark done: Activity – Untyped"
        );
        // The lead itself has no queued write: no lead badge.
        expect(`${card} .o_crm_mobile_lead_card_body .o_crm_mobile_pending_badge`).toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: pending activity rows keep the order the calls were made in, whatever their queue keys", async () => {
        const [offerId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("mail.activity", "web_save", ({ args }) => {
            expect.step(`replayed ${args[1].summary}`);
        });
        onRpc("mail.activity", "action_archive", ({ args }) => {
            expect.step(`replayed done ${args[0][0]}`);
        });
        const keys = keyQueuedCallsNewestFirst();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const card = cardOf("Lead 1");
        const scheduleFollowUp = async (summary) => {
            await contains(`${card} .o_crm_mobile_card_follow_up`).click();
            await contains(`${card} .o_crm_mobile_follow_up_type`).select("1");
            await contains(`${card} .o_crm_mobile_follow_up_summary`).edit(summary, {
                confirm: false,
            });
            await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        };

        // Offline, one second apart: a logged call, a follow-up, the cached activity marked done
        // and a second follow-up. Each call gets an array index key smaller than the previous
        // one: the queue lists them newest first.
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        await advanceTime(1000);
        await scheduleFollowUp("Send the proposal");
        await advanceTime(1000);
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        await contains(
            `${card} .o_crm_mobile_activity_row[data-activity-id='${offerId}'] .o_crm_mobile_activity_done`
        ).click();
        await advanceTime(1000);
        await scheduleFollowUp("Check in");
        const madeInOrder = ["Call", "Send the proposal", `done ${offerId}`, "Check in"];
        const labelOf = ({ value }) =>
            value.method === "action_archive" ? `done ${value.args[0][0]}` : value.args[1].summary;
        const offline = getService(OfflinePlugin);
        expect(keys).toHaveLength(4);
        expect(Object.keys(offline._ormToSync())).toEqual([...keys].reverse());
        expect(Object.values(offline._ormToSync()).map(labelOf)).toEqual(
            [...madeInOrder].reverse()
        );

        // The readers and the activity list follow the order the calls were made in, which is
        // the order they replay in.
        expect(queued().map(labelOf)).toEqual(madeInOrder);
        const lead1Card = mountedCardOf(cards, 1);
        expect(lead1Card.crmOffline.pendingActivityCalls(1).map(labelOf)).toEqual(madeInOrder);
        expect(lead1Card.pendingActivityCreates.map(({ key }) => key)).toEqual([
            keys[0],
            keys[1],
            keys[3],
        ]);
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(
            queryAllTexts(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_type`)
        ).toEqual(["Call", "Email", "Email"]);
        expect(
            queryAllTexts(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_summary`)
        ).toEqual(["Call", "Send the proposal", "Check in"]);
        expect(
            `${card} .o_crm_mobile_activity_row[data-activity-id='${offerId}'] .o_crm_mobile_pending_badge`
        ).toHaveText("Pending sync");

        // Reconnect: the framework replays the calls in that same order.
        await setOffline(false);
        await letQueueReplay(4);
        expect.verifySteps(madeInOrder.map((label) => `replayed ${label}`));
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: mark done offline queues action_archive only, for meeting and upload activities too", async () => {
        await makeMockServer();
        const meetingTypeId = MockServer.env["mail.activity.type"].create({
            name: "Meeting",
            category: "meeting",
        });
        const activityIds = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
            {
                res_id: 1,
                activity_type_id: meetingTypeId,
                activity_category: "meeting",
                summary: "Meet the client",
            },
            {
                res_id: 1,
                activity_type_id: 28,
                activity_category: "upload_file",
                summary: "Upload the contract",
            },
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Call back" },
        ]);
        const [, , , onlineActivityId] = activityIds;
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("mail.activity", "action_done", ({ args }) => {
            MockServer.env["mail.activity"].action_feedback(args[0]);
            return true;
        });
        watchRpcs([
            "mail.activity/action_done",
            "mail.activity/action_archive",
            "mail.activity/action_feedback",
            "mail.activity/web_save",
            /^calendar\.event\//,
            /upload/,
        ]);
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const card = cardOf("Lead 1");

        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(3);
        expect(`${card} .o_crm_mobile_activity_done`).toHaveCount(3);
        for (const activityId of activityIds.slice(0, 3)) {
            await contains(
                `${card} .o_crm_mobile_activity_row[data-activity-id='${activityId}'] .o_crm_mobile_activity_done`
            ).click();
            await advanceTime(1000);
        }
        // A state change only: one archive per activity, nothing else.
        const archives = queuedCalls("mail.activity", "action_archive");
        expect(archives.map(({ args, kwargs }) => [args, kwargs])).toEqual(
            activityIds.slice(0, 3).map((id) => [[[id]], {}])
        );
        expect(queued()).toHaveLength(3);
        expect(archives[1].extras.displayName).toBe("Meeting: Lead 1");
        expect(`${card} .o_crm_mobile_activity_done`).toHaveCount(0);
        expect(
            queryAllTexts(`${card} .o_crm_mobile_activity_row .o_crm_mobile_pending_badge`)
        ).toEqual(["Pending sync", "Pending sync", "Pending sync"]);
        // Marking an activity done twice queues nothing more.
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && instance.__owl__.status === 1
        );
        await lead1Card.onMarkDone({ id: activityIds[0] });
        expect(queued()).toHaveLength(3);
        expect.verifySteps([]);

        // Reconnect: the archives are replayed; the reload lists no activity for Lead 1.
        await setOffline(false);
        await letQueueReplay(3);
        expect.verifySteps([
            "mail.activity/action_archive",
            "mail.activity/action_archive",
            "mail.activity/action_archive",
        ]);
        const archived = MockServer.env["mail.activity"].search_read(
            [
                ["id", "in", activityIds.slice(0, 3)],
                ["active", "=", false],
            ],
            ["id"]
        );
        expect(archived.map(({ id }) => id)).toEqual(activityIds.slice(0, 3));
        await animationFrame();
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(0);

        // Online, Mark done is the server's own action_done, and nothing is queued.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        await contains(
            `${cardOf(
                "Lead 2"
            )} .o_crm_mobile_activity_row[data-activity-id='${onlineActivityId}'] .o_crm_mobile_activity_done`
        ).click();
        await animationFrame();
        expect.verifySteps(["mail.activity/action_done"]);
        expect(queued()).toHaveLength(0);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_activity_row`).toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: activity controls disabled when no activity type cached; meeting types not offered", async () => {
        // Only meeting and upload types exist for leads: none can be created.
        const types = mockActivityTypes([
            { id: 28, display_name: "Upload Document", category: "upload_file" },
            { id: 31, display_name: "Meeting", category: "meeting" },
        ]);
        const setOffline = mockOffline();
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect(renderers[0].mobileState.activityTypes).toEqual([]);
        const card = cardOf("Lead 1");
        const expectDisabled = () => {
            expect(`${card} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");
            expect(`${card} .o_crm_mobile_card_follow_up`).toHaveAttribute("disabled");
            expect(`${card} .o_crm_mobile_card_stage`).not.toHaveAttribute("disabled");
            expect(`${card} .o_crm_mobile_card_activities`).not.toHaveAttribute("disabled");
        };
        expectDisabled();

        // Offline: still disabled, by the card itself, and the handlers are inert.
        await setOffline(true);
        expectDisabled();
        expect(`${card} .o_crm_mobile_card_log_call`).not.toHaveClass("o_disabled_offline");
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && instance.__owl__.status === 1
        );
        expect(lead1Card.canLogCall).toBe(false);
        expect(lead1Card.canFollowUp).toBe(false);
        await lead1Card.onLogCall();
        lead1Card.toggleFollowUp();
        await lead1Card.onSaveFollowUp();
        await animationFrame();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        expect(queued()).toHaveLength(0);

        // Creatable types come back with the connection: Follow-up offers them, and still never
        // a meeting or an upload type.
        types.records = ACTIVITY_TYPES;
        await setOffline(false);
        await animationFrame();
        await animationFrame();
        expect(`${card} .o_crm_mobile_card_follow_up`).not.toHaveAttribute("disabled");
        expect(`${card} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(queryAllTexts(`${card} .o_crm_mobile_follow_up_type option`)).toEqual([
            "Email",
            "Call",
        ]);
    });

    test.tags("mobile");
    test("mobile: with cached types but no phonecall type, Log call is disabled and its direct handler queues nothing, while Follow-up works", async () => {
        mockActivityTypes([
            { id: 1, display_name: "Email", category: "default" },
            { id: 31, display_name: "Meeting", category: "meeting" },
        ]);
        const setOffline = mockOffline();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const card = cardOf("Lead 1");

        expect(`${card} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");
        expect(`${card} .o_crm_mobile_card_follow_up`).not.toHaveAttribute("disabled");
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && instance.__owl__.status === 1
        );
        const before = JSON.stringify(getService(OfflinePlugin)._ormToSync());
        await lead1Card.onLogCall();
        expect(JSON.stringify(getService(OfflinePlugin)._ormToSync())).toBe(before);
        expect(queued()).toHaveLength(0);

        // Follow-up still queues, with the only creatable type.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(queryAllTexts(`${card} .o_crm_mobile_follow_up_type option`)).toEqual(["Email"]);
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Send the brochure", {
            confirm: false,
        });
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        const creates = queuedCalls("mail.activity", "web_save");
        expect(creates).toHaveLength(1);
        expect(creates[0].args[1]).toEqual({
            res_model: "crm.lead",
            res_id: 1,
            activity_type_id: 1,
            summary: "Send the brochure",
            date_deadline: serializeDate(today()),
            user_id: serverState.userId,
        });
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_type`).toHaveText(
            "Email"
        );
    });

    test.tags("mobile");
    test("mobile: an online log call completing after stage navigation destroyed its card is saved, writes no card state and reads no hidden lead", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const save = Promise.withResolvers();
        onRpc("mail.activity", "web_save", async () => {
            expect.step("mail.activity/web_save");
            await save.promise;
        });
        watchActivityReads();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
        );

        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).click();
        await expect.waitForSteps(["mail.activity/web_save"]);
        expect(lead1Card.state.busy).toBe(true);
        // Displaying another stage destroys the card while its call is in flight.
        await goToStage("Qualified");
        expect.verifySteps(["activities:3"]);
        expect(status(lead1Card)).toBe("destroyed");

        save.resolve();
        await animationFrame();
        // The write reached the server, nothing was queued, the lead no stage displays is not
        // read, and the destroyed card got no state write.
        const created = MockServer.env["mail.activity"].search_read(
            [
                ["res_model", "=", "crm.lead"],
                ["res_id", "=", 1],
            ],
            ["activity_type_id", "summary"]
        );
        expect(
            created.map(({ activity_type_id, summary }) => [activity_type_id[0], summary])
        ).toEqual([[2, "Call"]]);
        expect(queued()).toHaveLength(0);
        expect.verifySteps([]);
        expect(lead1Card.state.busy).toBe(true);

        // Displayed again, the lead is read with its new activity, in a new usable card.
        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:1", "activities:2"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_type`).toHaveText("Call");
    });

    test.tags("mobile");
    test("mobile: an online mark done completing after stage navigation destroyed its card is done on the server, writes no card state and reads no hidden lead", async () => {
        const [activityId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const done = Promise.withResolvers();
        onRpc("mail.activity", "action_done", async ({ args }) => {
            expect.step("mail.activity/action_done");
            await done.promise;
            MockServer.env["mail.activity"].action_feedback(args[0]);
            return true;
        });
        watchActivityReads();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
        );

        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        await contains(
            `${cardOf(
                "Lead 1"
            )} .o_crm_mobile_activity_row[data-activity-id='${activityId}'] .o_crm_mobile_activity_done`
        ).click();
        await expect.waitForSteps(["mail.activity/action_done"]);
        expect(lead1Card.state.busy).toBe(true);
        await goToStage("Qualified");
        expect.verifySteps(["activities:3"]);
        expect(status(lead1Card)).toBe("destroyed");

        done.resolve();
        await animationFrame();
        // Done on the server, nothing queued, no read of the hidden lead, no state write on the
        // destroyed card (still busy, its activity list still open).
        expect(
            MockServer.env["mail.activity"].search_read([["id", "=", activityId]], ["id"])
        ).toHaveLength(0);
        expect(queued()).toHaveLength(0);
        expect.verifySteps([]);
        expect(lead1Card.state.busy).toBe(true);
        expect(lead1Card.state.activitiesOpen).toBe(true);

        await goToStage("New");
        await animationFrame();
        expect.verifySteps(["activities:1", "activities:2"]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_row`).toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: pipeline onActivitiesChanged reads only a lead the displayed stage shows, and nothing once the pipeline is destroyed", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchActivityReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await getService("action").doAction(PIPELINE_ACTION_ID);
        expect.verifySteps(["activities:1", "activities:2"]);
        const renderer = renderers.at(-1);
        expect(renderer.currentGroup.serverValue).toBe(1);

        // Lead 3 (Qualified) and Lead 5 (Won) are not displayed; no lead id, no read either.
        expect(renderer.onActivitiesChanged(3)).toBe(undefined);
        expect(renderer.onActivitiesChanged(5)).toBe(undefined);
        expect(renderer.onActivitiesChanged(false)).toBe(undefined);
        await animationFrame();
        expect.verifySteps([]);
        // A displayed lead is read again, once.
        await renderer.onActivitiesChanged(2);
        expect.verifySteps(["activities:2"]);

        // Another view replaces the pipeline: a late request reads nothing.
        await getService("action").switchView("list");
        await animationFrame();
        expect(".o_list_view").toHaveCount(1);
        expect(status(renderer)).toBe("destroyed");
        expect(renderer.onActivitiesChanged(1)).toBe(undefined);
        await animationFrame();
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: an online follow-up completing after a reload re-keyed its card refreshes the lead still displayed and closes nothing on the old card", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const save = Promise.withResolvers();
        onRpc("mail.activity", "web_save", async () => {
            expect.step("mail.activity/web_save");
            await save.promise;
        });
        watchActivityReads();
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        const [renderer] = renderers;
        const card = cardOf("Lead 1");
        const mountedLead1Card = () =>
            cards.find(
                (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
            );
        const oldCard = mountedLead1Card();

        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Send the proposal", {
            confirm: false,
        });
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        await expect.waitForSteps(["mail.activity/web_save"]);
        // A reload rebuilds the groups and records with new ids: the lead stays displayed in a
        // new card, whose activities are read before the write has landed.
        await renderer.props.list.load();
        await animationFrame();
        expect.verifySteps(["activities:1", "activities:2"]);
        expect(status(oldCard)).toBe("destroyed");
        const newCard = mountedLead1Card();
        expect(newCard).not.toBe(oldCard);

        save.resolve();
        await animationFrame();
        // The completion refreshes the lead the new card shows ...
        expect.verifySteps(["activities:1"]);
        // ... and writes nothing on the destroyed card: its form is left as it was.
        expect(oldCard.state.followUpOpen).toBe(true);
        expect(oldCard.state.summary).toBe("Send the proposal");
        expect(oldCard.state.busy).toBe(true);
        expect(newCard.state.busy).toBe(false);
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_summary`).toHaveText("Send the proposal");
    });

    test.tags("mobile");
    test("mobile: a rejected online log call propagates its error and leaves the live card usable", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "web_save", () => {
            throw makeServerError({ message: "This lead is locked" });
        });
        watchActivityReads();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
        );

        expect.errors(1);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).click();
        await animationFrame();
        expect.verifyErrors(["This lead is locked"]);
        await contains(".modal .modal-footer .btn-primary").click();
        // No refresh and nothing queued; the card is not left busy.
        expect.verifySteps([]);
        expect(queued()).toHaveLength(0);
        expect(status(lead1Card)).toBe("mounted");
        expect(lead1Card.state.busy).toBe(false);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
    });

    test.tags("mobile");
    test("mobile: an online stage move whose card is destroyed before the save returns writes no card state", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const save = Promise.withResolvers();
        onRpc("crm.lead", "web_save", async () => {
            expect.step("crm.lead/web_save");
            await save.promise;
        });
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        const lead1Card = cards.find(
            (instance) => instance.props.record?.resId === 1 && status(instance) === "mounted"
        );

        await chooseStage("Lead 1", 2);
        await expect.waitForSteps(["crm.lead/web_save"]);
        // The framework moves the record in memory before saving: its card left the stage.
        expect(status(lead1Card)).toBe("destroyed");
        expect(lead1Card.state.busy).toBe(true);

        save.resolve();
        await animationFrame();
        // The move completed without a state write on the destroyed card; the target stage is
        // displayed with the lead's new card, which is usable.
        expect(lead1Card.state.busy).toBe(true);
        expect(MockServer.env["crm.lead"].search_read([["id", "=", 1]], ["stage_id"])).toEqual([
            { id: 1, stage_id: [2, "Qualified"] },
        ]);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("Qualified");
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).not.toHaveAttribute("disabled");
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
    });

    /**
     * @param {string} name the lead name
     * @returns {string} selector of the status region of the mobile card showing that lead
     */
    function statusOf(name) {
        return `${cardOf(name)} .o_crm_mobile_lead_card_status`;
    }

    /**
     * Holds every `crm.lead` `web_read_group` while `hold.promise` is set: the reconciliation
     * reload that follows a replay rebuilds the groups, and so remounts the cards. Holding it keeps
     * the cards the replay updated mounted while they are asserted.
     *
     * @returns {{ promise: Promise<void> | null }}
     */
    function holdGroupReads() {
        const hold = { promise: null };
        onRpc("crm.lead", "web_read_group", async () => {
            await hold.promise;
        });
        return hold;
    }

    test.tags("mobile");
    test("mobile: card status region announces queued activity creates and mark done, their sync and count changes, never the mount state", async () => {
        const [sendOfferId, callBackId, qualifyId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Call back" },
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Qualify" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const hold = holdGroupReads();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin

        // Every card has one polite, atomic, visually hidden status region, empty at mount,
        // outside its controls; neither the card nor any other element is a live region of its
        // own, and the lead name stays the only span carrying the name.
        const cards = queryAll(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card");
        expect(cards).toHaveLength(2);
        for (const card of cards) {
            const regions = card.querySelectorAll(".o_crm_mobile_lead_card_status");
            expect(regions).toHaveLength(1);
            const [region] = regions;
            expect(region).toHaveAttribute("role", "status");
            expect(region).toHaveAttribute("aria-live", "polite");
            expect(region).toHaveAttribute("aria-atomic", "true");
            expect(region).toHaveClass("visually-hidden");
            expect(region.closest("button, .o_crm_mobile_lead_card_controls")).toBe(null);
            expect(region.textContent).toBe("");
            expect(card.querySelectorAll("[aria-live]")).toHaveLength(1);
        }
        expect(".o_crm_mobile_lead_card[aria-live], .o_crm_mobile_lead_card[role]").toHaveCount(0);

        // Offline Log call: a pending row, and one more activity.
        await setOffline(true);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).click();
        expect(statusOf("Lead 1")).toHaveText("Lead 1: new activity pending sync, 3 activities.");
        expect(queryOne(statusOf("Lead 2")).textContent).toBe("");
        expect(".o_kanban_group .o_kanban_record span:contains(Lead 1)").toHaveCount(1);
        await advanceTime(1000);

        // Offline Mark done, twice: the same message is rendered in a new node, so it is
        // announced again.
        // (activity ids are unique on the page: the row selector needs no card)
        const markDone = (activityId) =>
            contains(
                `.o_crm_mobile_activity_row[data-activity-id='${activityId}'] .o_crm_mobile_activity_done`
            ).click();
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        await markDone(sendOfferId);
        expect(statusOf("Lead 1")).toHaveText("Lead 1: completed activity pending sync.");
        const firstNode = queryOne(`${statusOf("Lead 1")} > div`);
        await advanceTime(1000);
        await markDone(callBackId);
        expect(statusOf("Lead 1")).toHaveText("Lead 1: completed activity pending sync.");
        expect(queryOne(`${statusOf("Lead 1")} > div`)).not.toBe(firstNode);
        await advanceTime(1000);

        // Another lead's queued create and its systray discard are announced on that lead's card
        // only: the count the queued create raises, never the drop its discard explains.
        const lead1Node = queryOne(`${statusOf("Lead 1")} > div`);
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_log_call`).click();
        expect(statusOf("Lead 2")).toHaveText("Lead 2: new activity pending sync, 2 activities.");
        const lead2Create = queued().find(
            ({ value }) =>
                value.model === "mail.activity" &&
                value.method === "web_save" &&
                value.args[1].res_id === 2
        );
        getService(OfflinePlugin).removeScheduledORM(lead2Create.key);
        await animationFrame();
        expect(statusOf("Lead 2")).toHaveText("Lead 2: new activity no longer pending sync.");
        await advanceTime(1000);

        // A queued mark done of another lead's activity is announced on that lead's card only.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        await markDone(qualifyId);
        expect(statusOf("Lead 2")).toHaveText("Lead 2: completed activity pending sync.");
        expect(queryOne(`${statusOf("Lead 1")} > div`)).toBe(lead1Node);
        expect(queued()).toHaveLength(4);

        // Reconnect: each replayed call is announced as no longer pending sync on its card,
        // before the reconciliation reload. The replayed create announces no count: a call
        // leaving the queue is no change the user made on the card, nor are the re-reads that
        // follow it (test "after offline Log calls are replayed, …").
        hold.promise = new Promise(() => {});
        await setOffline(false);
        // the first call replays at once, each next one a second later
        await waitUntil(() => queued().length === 3);
        await animationFrame();
        expect(statusOf("Lead 1")).toHaveText("Lead 1: new activity no longer pending sync.");
        await letQueueReplay(1);
        expect(queued()).toHaveLength(2);
        expect(statusOf("Lead 1")).toHaveText("Lead 1: completed activity no longer pending sync.");
        await letQueueReplay(2);
        expect(queued()).toHaveLength(0);
        expect(statusOf("Lead 1")).toHaveText("Lead 1: completed activity no longer pending sync.");
        expect(statusOf("Lead 2")).toHaveText("Lead 2: completed activity no longer pending sync.");
        expect(".o_crm_mobile_pending_badge").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: card status region announces the activity count an online create and an online mark done change", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "action_done", ({ args }) => {
            MockServer.env["mail.activity"].action_feedback(args[0]);
            return true;
        });
        watchRpcs(["mail.activity/web_save", "mail.activity/action_done"]);
        await mountPipeline();
        expect(queryOne(statusOf("Lead 2")).textContent).toBe("");

        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_log_call`).click();
        await animationFrame();
        expect.verifySteps(["mail.activity/web_save"]);
        expect(queued()).toHaveLength(0);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_card_activities .badge`).toHaveText("1");
        expect(statusOf("Lead 2")).toHaveText("Lead 2: 1 activity.");
        expect(queryOne(statusOf("Lead 1")).textContent).toBe("");

        // The re-read after an online mark done changes the persisted rows: the count is
        // announced.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        await contains(
            `${cardOf("Lead 2")} .o_crm_mobile_activity_row .o_crm_mobile_activity_done`
        ).click();
        await animationFrame();
        expect.verifySteps(["mail.activity/action_done"]);
        expect(queued()).toHaveLength(0);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_activity_row`).toHaveCount(0);
        expect(statusOf("Lead 2")).toHaveText("Lead 2: no activities.");
        expect(queryOne(statusOf("Lead 1")).textContent).toBe("");
    });

    /**
     * Records, in order, the text of every message the card status regions render (each
     * announcement is a new node), those of cards mounted later included, until the test ends.
     *
     * @returns {string[]}
     */
    function recordAnnouncements() {
        const selector = ".o_crm_mobile_lead_card_status > div";
        const messages = [];
        const observer = new MutationObserver((mutations) => {
            for (const { addedNodes } of mutations) {
                for (const node of addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) {
                        continue;
                    }
                    const added = node.matches(selector) ? [node] : node.querySelectorAll(selector);
                    messages.push(...[...added].map((message) => message.textContent));
                }
            }
        });
        observer.observe(getFixture(), { childList: true, subtree: true });
        after(() => observer.disconnect());
        return messages;
    }

    /**
     * Network latency the test releases (never a hold for the rest of it): while
     * `latency.activities[<lead id>]` is set, the activity reads of that lead answer once it is
     * resolved; while `latency.groups` is set, so do the lead group reads (the reconciliation
     * reload). The answers are the server's at that time.
     *
     * @returns {{ activities: Object, groups: Object | null }} `Promise.withResolvers()` values
     */
    function delayReads() {
        const latency = { activities: {}, groups: null };
        onRpc("/web/dataset/call_kw/mail.activity/web_search_read", async (request) => {
            const { params } = await request.clone().json();
            const resId = params.kwargs.domain.find(([field]) => field === "res_id")?.[2];
            await latency.activities[resId]?.promise;
        });
        onRpc("crm.lead", "web_read_group", async () => {
            await latency.groups?.promise;
        });
        return latency;
    }

    /**
     * @param {string} name the lead name
     * @returns {string} selector of the Activities count badge of the mobile card of that lead
     */
    function activityBadgeOf(name) {
        return `${cardOf(name)} .o_crm_mobile_card_activities .badge`;
    }

    /**
     * Resolves once the mobile card of a lead was mounted again (another element than `card`).
     *
     * @param {string} name the lead name
     * @param {Element} card the card element mounted before
     */
    async function waitForRemountedCard(name, card) {
        await waitUntil(() => {
            const current = queryFirst(cardOf(name));
            return Boolean(current) && current !== card;
        });
        await animationFrame();
    }

    test.tags("mobile");
    test("mobile: after offline Log calls are replayed, the activity re-reads and the reconciliation reload announce no count", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // Lead 1's activity read issued on reconnect answers after its create was replayed, the
        // reconciliation reload lands after the replayed cards rendered their announcements, and
        // Lead 2's activity read issued after that reload answers once its card was mounted again.
        const latency = delayReads();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const announcements = recordAnnouncements();
        for (const name of ["Lead 1", "Lead 2"]) {
            expect(activityBadgeOf(name)).toHaveText("0");
            expect(queryOne(statusOf(name)).textContent).toBe("");
        }

        // Offline Log call on both leads, which have no activity: each raises the count.
        await setOffline(true);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).click();
        await advanceTime(1000);
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_log_call`).click();
        expect(statusOf("Lead 1")).toHaveText("Lead 1: new activity pending sync, 1 activity.");
        expect(statusOf("Lead 2")).toHaveText("Lead 2: new activity pending sync, 1 activity.");
        expect(queued()).toHaveLength(2);

        // Reconnect: the activities are read again at once (Lead 2's answers before its create
        // is replayed), and Lead 1's create is replayed at once.
        latency.activities[1] = Promise.withResolvers();
        latency.groups = Promise.withResolvers();
        await setOffline(false);
        await waitUntil(() => queued().length === 1);
        await animationFrame();
        const [lead1Activity] = MockServer.env["mail.activity"].search_read([["res_id", "=", 1]]);
        expect(lead1Activity).not.toBe(undefined);
        expect(statusOf("Lead 1")).toHaveText("Lead 1: new activity no longer pending sync.");
        expect(activityBadgeOf("Lead 1")).toHaveText("0");

        // Lead 1's re-read brings the replayed server row to the same mounted card, whose
        // displayed count rises: no count is announced.
        const lead1Card = queryOne(cardOf("Lead 1"));
        latency.activities[1].resolve();
        await waitUntil(() => queryFirst(activityBadgeOf("Lead 1"))?.textContent === "1");
        await animationFrame();
        expect(queryOne(cardOf("Lead 1"))).toBe(lead1Card);
        expect(statusOf("Lead 1")).toHaveText("Lead 1: new activity no longer pending sync.");

        // Lead 2's create is replayed a second later, which ends the sync window.
        await letQueueReplay(1);
        expect(queued()).toHaveLength(0);
        expect(statusOf("Lead 2")).toHaveText("Lead 2: new activity no longer pending sync.");
        expect(activityBadgeOf("Lead 2")).toHaveText("0");

        // The reconciliation reload rebuilds the groups, so the cards are mounted again (silent,
        // with the activities displayed so far), and their activities are read again: Lead 2's
        // replayed server row reaches its new card, whose displayed count rises: no count is
        // announced either.
        const lead2Card = queryOne(cardOf("Lead 2"));
        latency.activities[2] = Promise.withResolvers();
        latency.groups.resolve();
        await waitForRemountedCard("Lead 2", lead2Card);
        expect(activityBadgeOf("Lead 2")).toHaveText("0");
        latency.activities[2].resolve();
        await waitUntil(() => queryFirst(activityBadgeOf("Lead 2"))?.textContent === "1");
        await animationFrame();
        expect(activityBadgeOf("Lead 1")).toHaveText("1");
        const [lead2Activity] = MockServer.env["mail.activity"].search_read([["res_id", "=", 2]]);
        for (const [name, activity] of [
            ["Lead 1", lead1Activity],
            ["Lead 2", lead2Activity],
        ]) {
            await contains(`${cardOf(name)} .o_crm_mobile_card_activities`).click();
            expect(
                `${cardOf(name)} .o_crm_mobile_activity_row[data-activity-id='${activity.id}']`
            ).toHaveCount(1);
            expect(`${cardOf(name)} .o_crm_mobile_activity_pending`).toHaveCount(0);
            // a card mounted by the reload starts silent
            expect(queryOne(statusOf(name)).textContent).toBe("");
        }

        // Each card's last announcement is its sync confirmation: no re-read announced a count.
        expect(announcements).toEqual([
            "Lead 1: new activity pending sync, 1 activity.",
            "Lead 2: new activity pending sync, 1 activity.",
            "Lead 1: new activity no longer pending sync.",
            "Lead 2: new activity no longer pending sync.",
        ]);
    });

    test.tags("mobile");
    test("mobile: after offline mark dones are replayed, the activity re-reads and the reconciliation reload announce no count", async () => {
        const [sendOfferId, qualifyId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Qualify" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // Lead 1's activity read issued on reconnect answers after its mark done was replayed,
        // the reconciliation reload lands after the replayed cards rendered their announcements,
        // and Lead 2's activity reads answer once its card was mounted again by that reload.
        const latency = delayReads();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const announcements = recordAnnouncements();

        // Offline Mark done on both leads: each row stays, shown pending, and the count with it.
        await setOffline(true);
        for (const [name, activityId] of [
            ["Lead 1", sendOfferId],
            ["Lead 2", qualifyId],
        ]) {
            expect(activityBadgeOf(name)).toHaveText("1");
            await contains(`${cardOf(name)} .o_crm_mobile_card_activities`).click();
            // (activity ids are unique on the page: the row selector needs no card)
            await contains(
                `.o_crm_mobile_activity_row[data-activity-id='${activityId}'] .o_crm_mobile_activity_done`
            ).click();
            expect(statusOf(name)).toHaveText(`${name}: completed activity pending sync.`);
            expect(activityBadgeOf(name)).toHaveText("1");
            await advanceTime(1000);
        }
        expect(queued()).toHaveLength(2);

        // Reconnect: Lead 1's mark done is replayed at once.
        latency.activities[1] = Promise.withResolvers();
        latency.activities[2] = Promise.withResolvers();
        latency.groups = Promise.withResolvers();
        await setOffline(false);
        await waitUntil(() => queued().length === 1);
        await animationFrame();
        expect(statusOf("Lead 1")).toHaveText("Lead 1: completed activity no longer pending sync.");
        expect(activityBadgeOf("Lead 1")).toHaveText("1");

        // Lead 1's re-read drops the archived row from the same mounted card, whose displayed
        // count falls: no count is announced.
        const lead1Card = queryOne(cardOf("Lead 1"));
        latency.activities[1].resolve();
        await waitUntil(() => queryFirst(activityBadgeOf("Lead 1"))?.textContent === "0");
        await animationFrame();
        expect(queryOne(cardOf("Lead 1"))).toBe(lead1Card);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_row`).toHaveCount(0);
        expect(statusOf("Lead 1")).toHaveText("Lead 1: completed activity no longer pending sync.");

        // Lead 2's mark done is replayed a second later, which ends the sync window.
        await letQueueReplay(1);
        expect(queued()).toHaveLength(0);
        expect(statusOf("Lead 2")).toHaveText("Lead 2: completed activity no longer pending sync.");
        expect(activityBadgeOf("Lead 2")).toHaveText("1");

        // The reconciliation reload mounts the cards again (silent, with the archived row still
        // displayed), then Lead 2's re-read drops that row from its new card: no count either.
        const lead2Card = queryOne(cardOf("Lead 2"));
        latency.groups.resolve();
        await waitForRemountedCard("Lead 2", lead2Card);
        expect(activityBadgeOf("Lead 2")).toHaveText("1");
        latency.activities[2].resolve();
        await waitUntil(() => queryFirst(activityBadgeOf("Lead 2"))?.textContent === "0");
        await animationFrame();
        for (const name of ["Lead 1", "Lead 2"]) {
            expect(activityBadgeOf(name)).toHaveText("0");
            // a card mounted by the reload starts silent
            expect(queryOne(statusOf(name)).textContent).toBe("");
        }

        // Each card's last announcement is its sync confirmation: no re-read announced a count.
        expect(announcements).toEqual([
            "Lead 1: completed activity pending sync.",
            "Lead 2: completed activity pending sync.",
            "Lead 1: completed activity no longer pending sync.",
            "Lead 2: completed activity no longer pending sync.",
        ]);
    });

    test.tags("mobile");
    test("mobile: card status region announces the lead's own pending sync and its end, after a systray discard and after a replay", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const hold = holdGroupReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;

        // An offline save of Lead 2 that keeps it in its stage queues its write.
        await setOffline(true);
        await recordOf(renderer, 2).update({ contact_name: "Monica Geller" });
        await animationFrame();
        expect(`${cardOf("Lead 2")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(statusOf("Lead 2")).toHaveText("Lead 2: changes pending sync.");
        expect(queryOne(statusOf("Lead 1")).textContent).toBe("");

        // The systray discard removes the entry: the lead is no longer pending sync.
        const [entry] = queued();
        getService(OfflinePlugin).removeScheduledORM(entry.key);
        await animationFrame();
        expect(`${cardOf("Lead 2")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(statusOf("Lead 2")).toHaveText("Lead 2: changes no longer pending sync.");

        await advanceTime(1000);
        await recordOf(renderer, 2).update({ contact_name: "Phoebe Buffay" });
        await animationFrame();
        expect(statusOf("Lead 2")).toHaveText("Lead 2: changes pending sync.");
        hold.promise = new Promise(() => {});
        await setOffline(false);
        await letQueueReplay(1);
        expect(queued()).toHaveLength(0);
        expect(MockServer.env["crm.lead"].browse(2)[0].contact_name).toBe("Phoebe Buffay");
        expect(`${cardOf("Lead 2")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(statusOf("Lead 2")).toHaveText("Lead 2: changes no longer pending sync.");
        expect(queryOne(statusOf("Lead 1")).textContent).toBe("");
    });

    test.tags("mobile");
    test("mobile: every pending-sync badge kind spaces its icon and label with Bootstrap gap-1", async () => {
        const [activityId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const card = cardOf("Lead 1");
        const activityRow = `${card} .o_crm_mobile_activity_row[data-activity-id='${activityId}']`;

        // Offline: a lead write, an activity create and a mark done, one badge kind each.
        await setOffline(true);
        await recordOf(renderers[0], 1).update({ contact_name: "Monica Geller" });
        await advanceTime(1000);
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        await advanceTime(1000);
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        await contains(`${activityRow} .o_crm_mobile_activity_done`).click();
        expect(queued()).toHaveLength(3);

        for (const badge of [
            `${card} .o_crm_mobile_lead_card_body .o_crm_mobile_pending_badge`,
            `${card} .o_crm_mobile_activity_pending .o_crm_mobile_pending_badge`,
            `${activityRow} .o_crm_mobile_pending_badge`,
        ]) {
            expect(badge).toHaveCount(1);
            expect(badge).toHaveClass("gap-1");
            expect(badge).toHaveText("Pending sync");
            expect(`${badge} .oi[data-icon=cloud_upload]`).toHaveCount(1);
            // Bootstrap gap-1 is $spacer * 0.25 (4px with a 16px spacer). Its inline-flex display
            // computes to flex, as every item of a flex row (blockified).
            const style = getComputedStyle(queryOne(badge));
            expect(style.display).toBe("flex");
            expect(style.alignItems).toBe("center");
            expect(style.whiteSpace).toBe("nowrap");
            expect(style.columnGap).toBe("4px");
            expect(style.rowGap).toBe("4px");
        }
    });
});

// -----------------------------------------------------------------------------
// Mobile lead card guards
// -----------------------------------------------------------------------------

/**
 * @param {CrmMobileLeadCard[]} cards captured card instances
 * @param {number} resId
 * @returns {CrmMobileLeadCard | undefined} the mounted card of a lead record
 */
function mountedCardOf(cards, resId) {
    return cards.find(
        (instance) => instance.props.record?.resId === resId && status(instance) === "mounted"
    );
}

/**
 * @param {CrmMobileLeadCard[]} cards captured card instances
 * @param {string | number} key the queue key of a pending lead create
 * @returns {CrmMobileLeadCard | undefined} the mounted card of that pending create
 */
function mountedPendingCardOf(cards, key) {
    return cards.find(
        (instance) =>
            String(instance.props.pendingCall?.key) === String(key) &&
            status(instance) === "mounted"
    );
}

/**
 * @param {string | number} key the queue key of a pending lead create
 * @returns {string} selector of the card of that pending create
 */
function pendingCardOf(key) {
    return `.o_crm_mobile_lead_card[data-pending-key='${key}']`;
}

/**
 * Schedules a call in the framework offline queue as another writer of the queue does (a lead
 * form saved offline sends its values only, without the card's display values), with the extras
 * the offline systray reads.
 *
 * @param {string} model
 * @param {"web_save" | "action_archive"} method
 * @param {any[]} args
 * @param {Object} [extras] merged over the default extras
 * @returns {string} the queue key
 */
function scheduleCall(model, method, args, extras = {}) {
    const kwargs = method === "web_save" ? { context: {}, specification: {} } : {};
    return getService(OfflinePlugin).scheduleORM(model, method, args, kwargs, {
        extras: {
            actionId: PIPELINE_ACTION_ID,
            viewType: "kanban",
            timeStamp: Date.now(),
            displayName: "",
            changes: {},
            ...extras,
        },
    });
}

/** @returns {string} the framework offline queue, serialized (to assert it did not change) */
function queueSnapshot() {
    return JSON.stringify(getService(OfflinePlugin)._ormToSync());
}

/** @returns {Object} the local state of a card that nothing has changed */
function untouchedCardState() {
    return {
        stageListOpen: false,
        // the stage list's roving tab stop, before any keyboard move
        activeStageValue: null,
        followUpOpen: false,
        activitiesOpen: false,
        typeId: null,
        summary: "",
        date: serializeDate(today()),
        busy: false,
        // the status region, which announced nothing
        announcement: { message: "", sequence: 0 },
    };
}

/**
 * Mounts a lead card on its own, with every prop the pipeline can give a record card, so that a
 * guard is the only thing that can stop a handler. Its callbacks are steps.
 *
 * @param {Object} props overrides (`record`, `pendingCall`, ...)
 * @returns {Promise<CrmMobileLeadCard>}
 */
function mountStandaloneCard(props) {
    const stages = [
        { id: "stage_1", serverValue: 1, displayName: "New", list: { records: [] } },
        { id: "stage_2", serverValue: 2, displayName: "Qualified", list: { records: [] } },
    ];
    return mountWithCleanup(CrmMobileLeadCard, {
        props: {
            group: stages[0],
            stages,
            activities: [
                {
                    id: 7,
                    activity_type_id: { id: 1, display_name: "Email" },
                    summary: "Send offer",
                },
                { id: 8, activity_type_id: { id: 2, display_name: "Call" }, summary: "Call back" },
            ],
            activityTypes: ACTIVITY_TYPES.slice(0, 2),
            displayedStageValue: 1,
            frameworkStageValue: 1,
            onOpen: (record) => expect.step(`onOpen ${record.id}`),
            onMove: async (record, group) =>
                expect.step(`onMove ${record.id} ${group.serverValue}`),
            onActivitiesChanged: (resId) => expect.step(`onActivitiesChanged ${resId}`),
            ...props,
        },
    });
}

describe("Mobile lead card guards", () => {
    test.tags("mobile");
    test("mobile: an activity create queued without display values takes its type label from the cached types, and typeLabel answers known, unknown and uncached types", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        // Two creates queued with their values only: one of a cached type, one of a type the
        // cache does not hold.
        const values = (activityTypeId, summary) => ({
            res_model: "crm.lead",
            res_id: 1,
            activity_type_id: activityTypeId,
            summary,
            date_deadline: "2030-03-01",
            user_id: serverState.userId,
        });
        const knownKey = scheduleCall("mail.activity", "web_save", [[], values(1, "Known type")]);
        const unknownKey = scheduleCall("mail.activity", "web_save", [
            [],
            values(999, "Unknown type"),
        ]);
        await animationFrame();
        const card = cardOf("Lead 1");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_pending_badge`).toHaveCount(2);
        const rows = queryAll(`${card} .o_crm_mobile_activity_pending`).map((row) => [
            row.querySelector(".o_crm_mobile_activity_summary").textContent,
            row.querySelector(".o_crm_mobile_activity_type").textContent,
        ]);
        expect(rows.sort()).toEqual([
            ["Known type", "Email"],
            ["Unknown type", ""],
        ]);
        const lead1Card = mountedCardOf(cards, 1);
        const entryOf = (key) =>
            lead1Card.pendingActivityCreates.find((entry) => entry.key === key);
        expect(lead1Card.pendingCreateTypeLabel(entryOf(knownKey))).toBe("Email");
        expect(lead1Card.pendingCreateTypeLabel(entryOf(unknownKey))).toBe("");
        // typeLabel: the name of a cached type; meeting and upload types are never cached for
        // the card, and an unknown or missing id has no name.
        expect(lead1Card.typeLabel(1)).toBe("Email");
        expect(lead1Card.typeLabel(2)).toBe("Call");
        expect(lead1Card.typeLabel(31)).toBe("");
        expect(lead1Card.typeLabel(999)).toBe("");
        expect(lead1Card.typeLabel(undefined)).toBe("");

        // A card without cached types (a pending lead create is given none) names no type.
        const pendingKey = scheduleCall(
            "crm.lead",
            "web_save",
            [[], { name: "Pending lead", stage_id: 1 }],
            { displayName: "Pending lead" }
        );
        await animationFrame();
        const pendingCard = mountedPendingCardOf(cards, pendingKey);
        expect(pendingCard.props.activityTypes).toBe(null);
        expect(pendingCard.typeLabel(1)).toBe("");
        expect(pendingCard.pendingCreateTypeLabel(entryOf(knownKey))).toBe("");
        expect(queued()).toHaveLength(3);
    });

    test.tags("mobile");
    test("mobile: a pending lead card of the pipeline ignores every direct handler call and reads no activity marker", async () => {
        const [activityId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const rpcs = collectRpcs();
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            moveRecords() {
                expect.step("moveRecords");
                return super.moveRecords(...arguments);
            },
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({ selectRecord: (resId) => expect.step(`open ${resId}`) });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        await setOffline(true);
        // Offline: a quick create, and a mark done of Lead 1's activity, both queued.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Pending lead", expected_revenue: "10" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        const [{ key }] = queued();
        await advanceTime(1000);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_activity_done`).click();
        expect(queued()).toHaveLength(2);
        const lead1Card = mountedCardOf(cards, 1);
        expect(lead1Card.pendingArchivedIds.has(activityId)).toBe(true);

        const pendingCard = mountedPendingCardOf(cards, key);
        expect(`${pendingCardOf(key)} .o_crm_mobile_lead_card_controls`).toHaveCount(0);
        expect(pendingCard.isPending).toBe(true);
        expect(pendingCard.isPersisted).toBe(false);
        expect(pendingCard.canLogCall).toBe(false);
        expect(pendingCard.canFollowUp).toBe(false);
        // Every queued mark done is a candidate activity marker: the pending lead reads none.
        expect(pendingCard.pendingActivityEntries).toEqual([]);
        expect(pendingCard.pendingActivityCreates).toEqual([]);
        expect(pendingCard.pendingArchivedIds.size).toBe(0);
        expect(pendingCard.activityCount).toBe(0);

        const before = queueSnapshot();
        const rpcCount = rpcs.length;
        pendingCard.onOpenCard();
        pendingCard.onOpenCard({
            target: queryOne(`${pendingCardOf(key)} .o_crm_mobile_lead_card_name`),
        });
        pendingCard.toggleStageList();
        await pendingCard.onChooseStage(groupOf(renderer, 2));
        await pendingCard.onLogCall();
        pendingCard.toggleFollowUp();
        await pendingCard.onSaveFollowUp();
        await pendingCard.onMarkDone({ id: activityId });
        pendingCard.toggleActivities();
        await animationFrame();
        // No open, no move, no RPC, no queue change and no panel.
        expect.verifySteps([]);
        expect(rpcs.slice(rpcCount)).toEqual([]);
        expect(queueSnapshot()).toBe(before);
        expect({ ...pendingCard.state }).toEqual(untouchedCardState());
        expect(`${pendingCardOf(key)} .o_crm_mobile_lead_card_controls`).toHaveCount(0);
        expect(`${pendingCardOf(key)} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
    });

    test.tags("mobile");
    test("mobile: a card whose lead has no server id offers no activity action, and its direct Log call, Follow-up and Mark done write nothing", async () => {
        const setOffline = mockOffline();
        // The reference: a persisted lead, whose callbacks and writes are all reachable.
        const persisted = await mountStandaloneCard({
            record: {
                id: "lead_1",
                resId: 1,
                resModel: "crm.lead",
                data: {
                    display_name: "Lead 1",
                    expected_revenue: 100,
                    company_currency: { id: CURRENCY_ID },
                },
            },
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        persisted.onOpenCard();
        await persisted.onChooseStage(persisted.props.stages[1]);
        expect.verifySteps(["onOpen lead_1", "onMove lead_1 2"]);
        expect(persisted.canLogCall).toBe(true);
        await persisted.onLogCall();
        await persisted.onMarkDone(persisted.props.activities[0]);
        expect(queuedCalls("mail.activity", "web_save").map(({ args }) => args)).toEqual([
            [
                [],
                {
                    res_model: "crm.lead",
                    res_id: 1,
                    activity_type_id: 2,
                    summary: "Call",
                    date_deadline: serializeDate(today()),
                    user_id: serverState.userId,
                },
            ],
        ]);
        expect(queuedCalls("mail.activity", "action_archive").map(({ args }) => args)).toEqual([
            [[7]],
        ]);
        expect(queued()).toHaveLength(2);
        expect.verifySteps([]);
        // Mark done needs a server id: a pending activity create (a queue entry) or a missing
        // activity marks nothing done.
        const [pendingActivity] = persisted.pendingActivityCreates;
        expect(pendingActivity.value.args[1].res_id).toBe(1);
        const afterReference = queueSnapshot();
        await persisted.onMarkDone(pendingActivity);
        await persisted.onMarkDone({});
        await persisted.onMarkDone(undefined);
        expect(queueSnapshot()).toBe(afterReference);
        expect(persisted.state.busy).toBe(false);
        expect.verifySteps([]);

        // A lead record without a server id (a new record not saved yet).
        const draft = ".o_crm_mobile_lead_card[data-id='draft']";
        const idless = await mountStandaloneCard({
            record: {
                id: "draft",
                resId: false,
                resModel: "crm.lead",
                data: {
                    display_name: false,
                    name: "Draft lead",
                    partner_id: false,
                    contact_name: false,
                    expected_revenue: false,
                    company_currency: { id: CURRENCY_ID },
                },
            },
        });
        expect(idless.isPending).toBe(false);
        expect(idless.isPersisted).toBe(false);
        expect(idless.isPendingSync).toBe(false);
        expect(idless.leadLabel).toBe("Draft lead");
        expect(idless.partnerName).toBe("");
        expect(idless.revenue).toBe("");
        expect(`${draft} .o_crm_mobile_lead_card_revenue`).toHaveCount(0);
        // Its activity actions are disabled although a phonecall type is cached ...
        expect(idless.phonecallType.id).toBe(2);
        expect(idless.canLogCall).toBe(false);
        expect(idless.canFollowUp).toBe(false);
        expect(`${draft} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");
        expect(`${draft} .o_crm_mobile_card_follow_up`).toHaveAttribute("disabled");
        // ... and it reads no activity marker, not even the queued mark done of activity 7.
        expect(idless.pendingActivityEntries).toEqual([]);
        expect(idless.pendingArchivedIds.size).toBe(0);

        const before = queueSnapshot();
        await idless.onLogCall();
        idless.toggleFollowUp();
        idless.onFollowUpType({ target: { value: "1" } });
        await idless.onSaveFollowUp();
        await idless.onMarkDone(idless.props.activities[1]);
        await animationFrame();
        expect.verifySteps([]);
        expect(queueSnapshot()).toBe(before);
        expect({ ...idless.state }).toEqual({ ...untouchedCardState(), typeId: 1 });
        expect(`${draft} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a card for a pending lead create, or without any lead, calls none of its callbacks and writes nothing, whatever it is given", async () => {
        const setOffline = mockOffline();
        // A card without a record nor a pending create (the pipeline never renders one).
        const empty = await mountStandaloneCard({});
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        expect(empty.isPending).toBe(false);
        expect(empty.isPersisted).toBe(false);
        expect(empty.isPendingSync).toBe(false);
        expect(empty.leadLabel).toBe("");
        expect(empty.partnerName).toBe("");
        expect(empty.revenue).toBe("");
        expect(empty.canLogCall).toBe(false);
        expect(empty.canFollowUp).toBe(false);
        empty.onOpenCard();
        empty.toggleStageList();
        await empty.onChooseStage(empty.props.stages[1]);
        await empty.onLogCall();
        await empty.onMarkDone(empty.props.activities[0]);
        await animationFrame();
        expect.verifySteps([]);
        expect(queued()).toHaveLength(0);
        expect({ ...empty.state }).toEqual(untouchedCardState());

        // A pending lead create given a phonecall type, activities and every callback.
        const key = scheduleCall(
            "crm.lead",
            "web_save",
            [[], { name: "Pending lead", contact_name: "Monica Geller", stage_id: 1 }],
            { displayName: "Pending lead" }
        );
        const pending = await mountStandaloneCard({
            pendingCall: queued().find((entry) => entry.key === key),
        });
        expect(`${pendingCardOf(key)} .o_crm_mobile_lead_card_name`).toHaveText("Pending lead");
        expect(`${pendingCardOf(key)} .o_crm_mobile_lead_card_partner`).toHaveText("Monica Geller");
        expect(`${pendingCardOf(key)} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(`${pendingCardOf(key)} .o_crm_mobile_lead_card_controls`).toHaveCount(0);
        expect(pending.phonecallType.id).toBe(2);
        expect(pending.canLogCall).toBe(false);
        expect(pending.canFollowUp).toBe(false);
        expect(pending.pendingActivityEntries).toEqual([]);

        const before = queueSnapshot();
        pending.onOpenCard();
        pending.onOpenCard({
            target: queryOne(`${pendingCardOf(key)} .o_crm_mobile_lead_card_name`),
        });
        pending.toggleStageList();
        await pending.onChooseStage(pending.props.stages[1]);
        await pending.onLogCall();
        pending.toggleFollowUp();
        pending.onFollowUpType({ target: { value: "1" } });
        await pending.onSaveFollowUp();
        await pending.onMarkDone(pending.props.activities[0]);
        pending.toggleActivities();
        await animationFrame();
        expect.verifySteps([]);
        expect(queueSnapshot()).toBe(before);
        expect({ ...pending.state }).toEqual({ ...untouchedCardState(), typeId: 1 });
        expect(`${pendingCardOf(key)} .o_crm_mobile_lead_card_controls`).toHaveCount(0);

        // A pending create whose entry carries no values, under a key not in the queue: an empty
        // name, and no partner, revenue or badge.
        const bare = await mountStandaloneCard({
            pendingCall: { key: "bare", value: { model: "crm.lead", method: "web_save" } },
        });
        expect(bare.pendingValues).toEqual({});
        expect(bare.leadLabel).toBe("");
        expect(bare.partnerName).toBe("");
        expect(bare.revenue).toBe("");
        expect(bare.isPendingSync).toBe(false);
        expect(`${pendingCardOf("bare")} .o_crm_mobile_lead_card_name`).toHaveText("");
        expect(`${pendingCardOf("bare")} .o_crm_mobile_lead_card_partner`).toHaveCount(0);
        expect(`${pendingCardOf("bare")} .o_crm_mobile_lead_card_revenue`).toHaveCount(0);
        expect(`${pendingCardOf("bare")} .o_crm_mobile_pending_badge`).toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: while an online activity write is in flight, the card refuses every other write, follow-up and move, and offers no stage", async () => {
        const [activityId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const save = Promise.withResolvers();
        onRpc("mail.activity", "web_save", async () => {
            await save.promise;
        });
        watchRpcs(["mail.activity/web_save", "mail.activity/action_done", "crm.lead/web_save"]);
        watchActivityReads();
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            moveRecords() {
                expect.step("moveRecords");
                return super.moveRecords(...arguments);
            },
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        expect.verifySteps(["activities:1", "activities:2"]);
        const [renderer] = renderers;
        const card = cardOf("Lead 1");
        const lead1Card = mountedCardOf(cards, 1);
        const [activity] = lead1Card.props.activities;
        expect(activity.id).toBe(activityId);

        // A follow-up is being entered when Log call starts its online write.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Send the proposal", {
            confirm: false,
        });
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        await expect.waitForSteps(["mail.activity/web_save"]);
        expect(lead1Card.state.busy).toBe(true);
        expect(lead1Card.canLogCall).toBe(false);
        expect(lead1Card.canFollowUp).toBe(false);
        expect(`${card} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");
        expect(`${card} .o_crm_mobile_card_follow_up`).toHaveAttribute("disabled");
        expect(`${card} .o_crm_mobile_follow_up_save`).toHaveAttribute("disabled");

        // Direct calls: a second log call, the follow-up save, a mark done and a stage move are
        // all refused, and the follow-up form is not toggled off.
        await lead1Card.onLogCall();
        await lead1Card.onSaveFollowUp();
        lead1Card.toggleFollowUp();
        await lead1Card.onMarkDone(activity);
        await lead1Card.onChooseStage(groupOf(renderer, 2));
        await animationFrame();
        expect.verifySteps([]);
        expect(lead1Card.state.followUpOpen).toBe(true);
        expect(lead1Card.state.summary).toBe("Send the proposal");
        expect(queued()).toHaveLength(0);
        // The read-only panels still open; Mark done and every stage option are disabled.
        lead1Card.toggleActivities();
        await animationFrame();
        expect(`${card} .o_crm_mobile_activity_done`).toHaveAttribute("disabled");
        lead1Card.toggleStageList();
        await animationFrame();
        expect(lead1Card.stageOptions.map(({ disabled }) => disabled)).toEqual([
            true,
            true,
            true,
            true,
        ]);
        expect(`${card} .o_crm_mobile_stage_option`).toHaveCount(4);
        expect(`${card} .o_crm_mobile_stage_option:not(:disabled)`).toHaveCount(0);

        // The write returns: one create on the server, the lead's activities read again, and
        // the card usable again, its displayed stage alone disabled.
        save.resolve();
        await animationFrame();
        expect.verifySteps(["activities:1"]);
        expect(lead1Card.state.busy).toBe(false);
        expect(
            MockServer.env["mail.activity"].search_read(
                [
                    ["res_id", "=", 1],
                    ["activity_type_id", "=", 2],
                ],
                ["summary"]
            )
        ).toHaveLength(1);
        expect(
            queryAll(`${card} .o_crm_mobile_stage_option:disabled`).map((el) =>
                Number(el.dataset.stageValue)
            )
        ).toEqual([1]);
        expect(`${card} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
    });

    test.tags("mobile");
    test("mobile: choosing no stage, the displayed stage or the framework group a queued write displaced the card from moves nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["crm.lead/web_save"]);
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            moveRecords() {
                expect.step("moveRecords");
                return super.moveRecords(...arguments);
            },
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        // A stage write of Lead 1 whose replay the server rejected stays parked in the queue: it
        // places the card in Qualified while the framework group holding the record is New.
        scheduleCall("crm.lead", "web_save", [[1], { stage_id: 2 }], {
            displayName: "Lead 1",
            error: "ValidationError - The stage is locked",
        });
        await animationFrame();
        await goToStage("Qualified");
        expect(cardNames()).toEqual(["Lead 3", "Lead 1"]);
        expectHeader("Qualified", 2, 130);
        const lead1Card = mountedCardOf(cards, 1);
        expect(lead1Card.props.displayedStageValue).toBe(2);
        expect(lead1Card.props.frameworkStageValue).toBe(1);
        expect(lead1Card.disabledStageValues).toEqual([2, 1]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).click();
        expect(
            queryAll(`${cardOf("Lead 1")} .o_crm_mobile_stage_option:disabled`).map((el) =>
                Number(el.dataset.stageValue)
            )
        ).toEqual([1, 2]);

        const before = queueSnapshot();
        await lead1Card.onChooseStage(null);
        await lead1Card.onChooseStage(undefined);
        await lead1Card.onChooseStage(groupOf(renderer, 2));
        await lead1Card.onChooseStage(groupOf(renderer, 1));
        await animationFrame();
        // No move and no write; the stage list stays open, the card not busy.
        expect.verifySteps([]);
        expect(queueSnapshot()).toBe(before);
        expect(lead1Card.state.stageListOpen).toBe(true);
        expect(lead1Card.state.busy).toBe(false);
        expect(recordOf(renderer, 1).group.serverValue).toBe(1);
        expect(cardNames()).toEqual(["Lead 3", "Lead 1"]);
        expectHeader("Qualified", 2, 130);
    });

    test.tags("mobile");
    test("mobile: a stage move the server rejects propagates its error, leaves the lead in its stage and the card usable", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", () => {
            expect.step("crm.lead/web_save");
            throw makeServerError({ message: "The stage is locked" });
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const lead1Card = mountedCardOf(cards, 1);

        expect.errors(1);
        await chooseStage("Lead 1", 2);
        expect.verifySteps(["crm.lead/web_save"]);
        expect.verifyErrors(["The stage is locked"]);
        await contains(".modal .modal-footer .btn-primary").click();
        // The framework put the record back; the displayed stage and its totals are unchanged.
        expect(recordOf(renderer, 1).group.serverValue).toBe(1);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(queued()).toHaveLength(0);
        expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(1);
        // The rejection came back before the move was rendered: the card that chose the stage is
        // still the mounted one, and it is not left busy, its controls and options usable again.
        expect(status(lead1Card)).toBe("mounted");
        expect(mountedCardOf(cards, 1)).toBe(lead1Card);
        expect(lead1Card.state.busy).toBe(false);
        expect(lead1Card.state.stageListOpen).toBe(false);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).click();
        expect(
            queryAll(`${cardOf("Lead 1")} .o_crm_mobile_stage_option:disabled`).map((el) =>
                Number(el.dataset.stageValue)
            )
        ).toEqual([1]);
    });

    test.tags("mobile");
    test("mobile: a follow-up whose selected type stopped being creatable saves nothing, toggling the form off closes it and reopening it selects the first creatable type", async () => {
        const types = mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["mail.activity/web_save"]);
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const card = cardOf("Lead 1");
        const lead1Card = mountedCardOf(cards, 1);

        // Opened, the form selects the first creatable type; a selection still offered is kept
        // when the form is closed and reopened, the summary is not.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(lead1Card.state.typeId).toBe(1);
        await contains(`${card} .o_crm_mobile_follow_up_type`).select("2");
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Call back", {
            confirm: false,
        });
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(lead1Card.state.typeId).toBe(2);
        expect(`${card} .o_crm_mobile_follow_up_type`).toHaveValue("2");
        expect(`${card} .o_crm_mobile_follow_up_summary`).toHaveValue("");

        // The server stops offering Call: the refreshed types reach the open form.
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Call back", {
            confirm: false,
        });
        types.records = ACTIVITY_TYPES.filter((type) => type.id !== 2);
        await renderer._loadActivityTypes();
        await animationFrame();
        expect(mountedCardOf(cards, 1)).toBe(lead1Card);
        expect(queryAllTexts(`${card} .o_crm_mobile_follow_up_type option`)).toEqual(["Email"]);
        expect(lead1Card.state.typeId).toBe(2);
        // Saving the stale selection writes nothing and leaves the form as entered.
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        await animationFrame();
        expect.verifySteps([]);
        expect(queued()).toHaveLength(0);
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(1);
        expect(lead1Card.state.summary).toBe("Call back");
        expect(lead1Card.state.busy).toBe(false);

        // Follow-up toggles the form off; reopened, it selects the first creatable type again,
        // with an empty summary and today, and saves with it.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        expect(lead1Card.state.followUpOpen).toBe(false);
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(lead1Card.state.typeId).toBe(1);
        expect(`${card} .o_crm_mobile_follow_up_type`).toHaveValue("1");
        expect(`${card} .o_crm_mobile_follow_up_summary`).toHaveValue("");
        expect(queryOne(`${card} .o_crm_mobile_follow_up_date`).value).toBe(serializeDate(today()));
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Send the offer", {
            confirm: false,
        });
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        await animationFrame();
        expect.verifySteps(["mail.activity/web_save"]);
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        expect(
            MockServer.env["mail.activity"]
                .search_read([["res_id", "=", 1]], ["summary"])
                .map(({ summary }) => summary)
        ).toEqual(["Send the offer"]);
    });

    test.tags("mobile");
    test("mobile: a log call whose connection drops during the call is queued with its full values, frees the card and reads nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const connection = mockConnectionDrop();
        watchRpcs(["mail.activity/web_save"]);
        watchActivityReads();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["activities:1", "activities:2"]);
        const card = cardOf("Lead 1");
        const lead1Card = mountedCardOf(cards, 1);
        const todayString = serializeDate(today());

        connection.offline = true;
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        await animationFrame();
        // Attempted online, then queued with exactly the values of the attempt.
        expect.verifySteps(["mail.activity/web_save"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        const creates = queuedCalls("mail.activity", "web_save");
        expect(creates).toHaveLength(1);
        expect(creates[0].args).toEqual([
            [],
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: 2,
                summary: "Call",
                date_deadline: todayString,
                user_id: serverState.userId,
            },
        ]);
        expect(creates[0].kwargs).toEqual({ context: {}, specification: {} });
        expect(creates[0].extras).toMatchObject({
            actionId: PIPELINE_ACTION_ID,
            displayName: "Call: Lead 1",
            changes: { activity_type_id: "Call", summary: "Call", date_deadline: todayString },
        });
        // Not busy any more, and no refresh requested: the write did not reach the server.
        expect(status(lead1Card)).toBe("mounted");
        expect(lead1Card.state.busy).toBe(false);
        expect(`${card} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_activity_type`).toHaveText(
            "Call"
        );
        expect(`${card} .o_crm_mobile_activity_pending .o_crm_mobile_pending_badge`).toHaveText(
            "Pending sync"
        );
        expect.verifySteps([]);
        expect(MockServer.env["mail.activity"].search_read([["res_id", "=", 1]], ["id"])).toEqual(
            []
        );
    });

    test.tags("mobile");
    test("mobile: a mark done the server rejects propagates its error and frees the card; one whose connection drops during the call queues action_archive", async () => {
        const [activityId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "action_done", () => {
            throw makeServerError({ message: "This activity is locked" });
        });
        const connection = mockConnectionDrop();
        watchRpcs(["mail.activity/action_done", "mail.activity/action_archive"]);
        watchActivityReads();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["activities:1", "activities:2"]);
        const card = cardOf("Lead 1");
        const row = `${card} .o_crm_mobile_activity_row[data-activity-id='${activityId}']`;
        const lead1Card = mountedCardOf(cards, 1);
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        const typeName = queryOne(`${row} .o_crm_mobile_activity_type`).textContent;

        // Online, the server rejects the call: its error surfaces, nothing is queued or read,
        // and the card is usable again.
        expect.errors(1);
        await contains(`${row} .o_crm_mobile_activity_done`).click();
        await animationFrame();
        expect.verifySteps(["mail.activity/action_done"]);
        expect.verifyErrors(["This activity is locked"]);
        await contains(".modal .modal-footer .btn-primary").click();
        expect(queued()).toHaveLength(0);
        expect(lead1Card.state.busy).toBe(false);
        expect(`${row} .o_crm_mobile_activity_done`).not.toHaveAttribute("disabled");
        expect(
            MockServer.env["mail.activity"].search_read([["id", "=", activityId]], ["id"])
        ).toHaveLength(1);

        // The connection drops during the call: the mark done is queued as a state change.
        connection.offline = true;
        await contains(`${row} .o_crm_mobile_activity_done`).click();
        await animationFrame();
        expect.verifySteps(["mail.activity/action_done"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        const archives = queuedCalls("mail.activity", "action_archive");
        expect(archives.map(({ args, kwargs }) => [args, kwargs])).toEqual([[[[activityId]], {}]]);
        expect(archives[0].extras).toMatchObject({
            actionId: PIPELINE_ACTION_ID,
            displayName: `${typeName}: Lead 1`,
            changes: {},
        });
        expect(queued()).toHaveLength(1);
        expect(lead1Card.state.busy).toBe(false);
        expect(`${row} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(`${row} .o_crm_mobile_activity_done`).toHaveCount(0);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a tap inside the card controls never opens the lead, while a tap elsewhere or a direct call does", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline({ selectRecord: (resId) => expect.step(`open ${resId}`) });
        const card = cardOf("Lead 1");
        const lead1Card = mountedCardOf(cards, 1);
        await contains(`${card} .o_crm_mobile_card_stage`).click();
        expect(`${card} .o_crm_mobile_lead_card_stage_list`).toHaveCount(1);
        expect.verifySteps([]);

        // The controls stop their clicks in the DOM; a direct call with an event coming from
        // them is refused too.
        for (const selector of [
            ".o_crm_mobile_lead_card_controls",
            ".o_crm_mobile_lead_card_actions",
            ".o_crm_mobile_card_stage",
            ".o_crm_mobile_card_stage i",
            ".o_crm_mobile_stage_option",
        ]) {
            lead1Card.onOpenCard({ target: queryFirst(`${card} ${selector}`) });
        }
        await animationFrame();
        expect.verifySteps([]);
        // From the card body, without a target element or without an event, the lead opens.
        lead1Card.onOpenCard({ target: queryOne(`${card} .o_crm_mobile_lead_card_partner`) });
        expect.verifySteps(["open 1"]);
        lead1Card.onOpenCard({});
        expect.verifySteps(["open 1"]);
        lead1Card.onOpenCard();
        expect.verifySteps(["open 1"]);
    });

    test.tags("mobile");
    test("mobile: an empty or invalid deadline is not displayed, and an invalid follow-up date is queued as today", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);
        const card = cardOf("Lead 1");
        const lead1Card = mountedCardOf(cards, 1);
        const todayString = serializeDate(today());

        for (const value of [
            false,
            undefined,
            null,
            "",
            "not a date",
            "2030-02-30",
            "2030-13-01",
        ]) {
            expect(lead1Card.formatDeadline(value)).toBe("", {
                message: `${JSON.stringify(value)} is not displayed`,
            });
        }
        expect(lead1Card.formatDeadline("2030-01-10")).toBe(
            formatDate(deserializeDate("2030-01-10"))
        );
        expect(lead1Card.formatDeadline("2030-01-10")).not.toBe("");

        // A date input holds a valid date or nothing, but a browser without a date picker lets
        // any text through, and the input handler copies it as typed.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Check in", {
            confirm: false,
        });
        lead1Card.onFollowUpDate({ target: { value: "2030-02-30" } });
        expect(lead1Card.state.date).toBe("2030-02-30");
        expect(lead1Card._followUpDeadline()).toBe(todayString);
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        const creates = queuedCalls("mail.activity", "web_save");
        expect(creates).toHaveLength(1);
        expect(creates[0].args[1]).toEqual({
            res_model: "crm.lead",
            res_id: 1,
            activity_type_id: 1,
            summary: "Check in",
            date_deadline: todayString,
            user_id: serverState.userId,
        });
        expect(creates[0].extras.changes.date_deadline).toBe(todayString);
        await advanceTime(1000);

        // A queued create carrying an invalid deadline lists no date.
        scheduleCall("mail.activity", "web_save", [
            [],
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: 1,
                summary: "Bad date",
                date_deadline: "2030-02-30",
                user_id: serverState.userId,
            },
        ]);
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        const deadlines = Object.fromEntries(
            queryAll(`${card} .o_crm_mobile_activity_pending`).map((row) => [
                row.querySelector(".o_crm_mobile_activity_summary").textContent,
                row.querySelector(".o_crm_mobile_activity_deadline").textContent,
            ])
        );
        expect(deadlines).toEqual({
            "Check in": formatDate(deserializeDate(todayString)),
            "Bad date": "",
        });
    });

    test.tags("mobile");
    test("mobile: a pending lead create shows no revenue without a numeric amount, and formats it in the company currency in a stage holding no loaded lead", async () => {
        // offline, Won (folded, so not loaded) is displayed through Qualified and Proposition:
        // the types are read from the cache each time (no activity of their leads is cached)
        const errors = cachedReadErrors([TYPES, TYPES, TYPES]);
        expect.errors(errors.length);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        await setOffline(true);

        // Creates queued without an amount (a form saved offline sends only the fields it
        // changed) or with an empty one: no revenue line. With an amount, the currency of the
        // stage's first lead.
        const noAmount = scheduleCall("crm.lead", "web_save", [
            [],
            { name: "No amount", stage_id: 1 },
        ]);
        const falseAmount = scheduleCall("crm.lead", "web_save", [
            [],
            { name: "False amount", expected_revenue: false, stage_id: 1 },
        ]);
        const withAmount = scheduleCall("crm.lead", "web_save", [
            [],
            { name: "With amount", expected_revenue: 10, stage_id: 1 },
        ]);
        await animationFrame();
        for (const key of [noAmount, falseAmount]) {
            expect(mountedPendingCardOf(cards, key).revenue).toBe("");
            expect(`${pendingCardOf(key)} .o_crm_mobile_lead_card_revenue`).toHaveCount(0);
        }
        expect(`${pendingCardOf(withAmount)} .o_crm_mobile_lead_card_revenue`).toHaveText(
            formatCardRevenue(10)
        );

        // Won is folded: displayed offline it loads nothing, so no lead of its own carries a
        // currency, and the amount is formatted in the user's company currency.
        const wonCreate = scheduleCall("crm.lead", "web_save", [
            [],
            { name: "Won lead", expected_revenue: 25, stage_id: 4 },
        ]);
        await goToStage("Won");
        const won = groupOf(renderer, 4);
        expect(won.isFolded).toBe(true);
        expect(won.list.records).toHaveLength(0);
        expect(cardNames()).toEqual(["Won lead"]);
        expect(`${pendingCardOf(wonCreate)} .o_crm_mobile_lead_card_revenue`).toHaveText(
            formatCardRevenue(25)
        );
        expect(serverState.companies[0].currency_id).toBe(CURRENCY_ID);
        expect.verifyErrors(errors);
    });
});

// -----------------------------------------------------------------------------
// Remaining card branches
// -----------------------------------------------------------------------------

/**
 * The lead card's guards and fallbacks that its template never reaches: handlers called directly
 * on a card that cannot act (a queued create, no record, a call in flight, the displayed stage, a
 * type no longer cached), calls that fail or lose the connection, and display fallbacks (missing
 * values, currencies, type labels and dates).
 */
describe("Remaining card branches", () => {
    /**
     * Queues a call in the framework offline queue as a framework view queues it (the card queues
     * its own calls through `runOrQueue`).
     *
     * @param {string} model
     * @param {string} method
     * @param {any[]} args
     * @param {Object} extras display extras of the offline systray (`displayName`, `changes`)
     * @returns {string | number} the queue key
     */
    const queueCall = (model, method, args, extras) =>
        getService(OfflinePlugin).scheduleORM(
            model,
            method,
            args,
            { context: {}, specification: {} },
            {
                extras: {
                    actionId: PIPELINE_ACTION_ID,
                    viewType: "form",
                    timeStamp: Date.now(),
                    ...extras,
                },
            }
        );

    /**
     * @param {CrmMobileLeadCard[]} cards captured card instances
     * @param {number} resId
     * @returns {CrmMobileLeadCard} the mounted card of a lead record
     */
    const mountedCard = (cards, resId) =>
        cards.find((card) => card.props.record?.resId === resId && status(card) === "mounted");

    /** @returns {string} the snapshot of the framework offline queue */
    const storedQueue = () => JSON.stringify(getService(OfflinePlugin)._ormToSync());

    test.tags("mobile");
    test("mobile: a queued lead create without name or revenue shows only its contact, and every handler called on its card does nothing", async () => {
        const [activityId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs([
            "crm.lead/web_save",
            "mail.activity/web_save",
            "mail.activity/action_done",
            "mail.activity/action_archive",
        ]);
        patchWithCleanup(CrmMobilePipeline.prototype, {
            onCardOpen() {
                expect.step("onCardOpen");
                return super.onCardOpen(...arguments);
            },
            onCardMove() {
                expect.step("onCardMove");
                return super.onCardMove(...arguments);
            },
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;

        // The server computes a lead's name from its contact: a create queued by a form showing
        // neither the name nor the expected revenue carries neither value.
        queueCall("crm.lead", "web_save", [[], { contact_name: "Monica Geller", stage_id: 1 }], {
            displayName: "Monica Geller",
            changes: { contact_name: "Monica Geller" },
        });
        await animationFrame();
        const pendingCard = ".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card_pending";
        expect(pendingCard).toHaveCount(1);
        expect(`${pendingCard} .o_crm_mobile_lead_card_name`).toHaveText("");
        expect(`${pendingCard} .o_crm_mobile_lead_card_partner`).toHaveText("Monica Geller");
        expect(`${pendingCard} .o_crm_mobile_lead_card_revenue`).toHaveCount(0);
        expect(`${pendingCard} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(`${pendingCard} .o_crm_mobile_lead_card_controls`).toHaveCount(0);
        expect(cardNames()).toEqual(["", "Lead 1", "Lead 2"]);
        expectHeader("New", 3, 120);
        const pending = cards.find((card) => card.props.pendingCall && status(card) === "mounted");
        expect(pending.leadLabel).toBe("");
        expect(pending.revenue).toBe("");
        // No server id, hence no activity and no activity action; and no framework group, hence
        // only the displayed stage is excluded from its stage list.
        expect(pending.isPersisted).toBe(false);
        expect(pending.canLogCall).toBe(false);
        expect(pending.canFollowUp).toBe(false);
        expect(pending.pendingActivityEntries).toEqual([]);
        expect(pending.disabledStageValues).toEqual([1]);
        // A record card, by contrast, carries no queued values.
        expect(mountedCard(cards, 1).pendingValues).toEqual({});

        const stored = storedQueue();
        pending.onOpenCard(NO_EVENT);
        pending.toggleStageList();
        await pending.onChooseStage(groupOf(renderer, 2));
        await pending.onLogCall();
        pending.toggleFollowUp();
        await pending.onSaveFollowUp();
        await pending.onMarkDone({ id: activityId });
        pending.toggleActivities();
        await animationFrame();
        expect([
            pending.state.stageListOpen,
            pending.state.followUpOpen,
            pending.state.activitiesOpen,
            pending.state.busy,
        ]).toEqual([false, false, false, false]);
        expect(`${pendingCard} .o_crm_mobile_lead_card_controls`).toHaveCount(0);
        expect(storedQueue()).toBe(stored);
        expect(recordOf(renderer, 1).group).toBe(groupOf(renderer, 1));
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a card given neither a lead record nor a queued create shows no lead data, and its handlers do nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs([
            "crm.lead/web_save",
            "mail.activity/web_save",
            "mail.activity/action_done",
            "mail.activity/action_archive",
        ]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        // Both `record` and `pendingCall` are optional props: the card mounted with neither, in
        // the pipeline's own stage groups.
        const card = await mountWithCleanup(CrmMobileLeadCard, {
            props: {
                group: groupOf(renderer, 1),
                stages: renderer.stageGroups,
                activityTypes: renderer.mobileState.activityTypes,
                displayedStageValue: 1,
                onOpen: () => expect.step("onOpen"),
                onMove: () => expect.step("onMove"),
                onActivitiesChanged: () => expect.step("onActivitiesChanged"),
            },
        });
        const recordless =
            ".o_crm_mobile_lead_card:not([data-id]):not(.o_crm_mobile_lead_card_pending)";
        expect(recordless).toHaveCount(1);
        expect(`${recordless} .o_crm_mobile_lead_card_name`).toHaveText("");
        expect(`${recordless} .o_crm_mobile_lead_card_partner`).toHaveCount(0);
        expect(`${recordless} .o_crm_mobile_lead_card_revenue`).toHaveCount(0);
        expect(`${recordless} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(`${recordless} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");
        expect(`${recordless} .o_crm_mobile_card_follow_up`).toHaveAttribute("disabled");
        expect(card.leadLabel).toBe("");
        expect(card.revenue).toBe("");
        expect(card.isPersisted).toBe(false);
        expect(card.isPendingSync).toBe(false);

        // A tap on the card opens nothing, and Stage opens no stage list.
        await contains(`${recordless} .o_crm_mobile_lead_card_body`).click();
        await contains(`${recordless} .o_crm_mobile_card_stage`).click();
        expect(`${recordless} [role=listbox]`).toHaveCount(0);
        expect(card.state.stageListOpen).toBe(false);
        // Direct calls start nothing.
        await card.onChooseStage(groupOf(renderer, 2));
        await card.onLogCall();
        card.toggleFollowUp();
        await card.onSaveFollowUp();
        await card.onMarkDone({ id: 1 });
        await animationFrame();
        expect(card.state.followUpOpen).toBe(false);
        expect(card.state.busy).toBe(false);
        expect(queued()).toHaveLength(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: cards of a pipeline that does not load expected_revenue show no revenue line", async () => {
        // Neither the card template nor the progress bar (whose sum field the kanban view loads)
        // names the field.
        const arch = PIPELINE_ARCH.replace(/<field name="expected_revenue"[^>]*\/>/, "").replace(
            ' sum_field="expected_revenue"',
            ""
        );
        expect(arch).not.toMatch(/expected_revenue/);
        mockActivityTypes(ACTIVITY_TYPES);
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({ arch });
        const [renderer] = renderers;

        expect(recordOf(renderer, 1).data.expected_revenue).toBe(undefined);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card_revenue").toHaveCount(0);
        expect(mountedCard(cards, 1).revenue).toBe("");
        expect(mountedCard(cards, 2).revenue).toBe("");
        // The rest of each card is shown as usual.
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_partner`).toHaveText(
            serverState.partnerName
        );
        expect(".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_count").toHaveText("2");
    });

    test.tags("mobile");
    test("mobile: a queued create in a stage with no loaded lead shows its revenue in the currency of the user's company", async () => {
        // The user's company works in EUR, while every lead is in USD (its company currency).
        serverState.companies = [{ id: 1, name: "Hermit", currency_id: 2 }];
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["crm.lead/web_save"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;

        // Proposition's only lead moves out online: the stage stays, with no loaded lead.
        await goToStage("Proposition");
        await chooseStage("Lead 4", 2);
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save"]);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("Qualified");
        await goToStage("Proposition");
        expect(cardNames()).toEqual([]);
        expect(groupOf(renderer, 3).list.records).toHaveLength(0);

        queueCall(
            "crm.lead",
            "web_save",
            [[], { name: "Queued in Proposition", expected_revenue: 75, stage_id: 3 }],
            { displayName: "Queued in Proposition", changes: { expected_revenue: 75 } }
        );
        queueCall(
            "crm.lead",
            "web_save",
            [[], { name: "Queued in New", expected_revenue: 15, stage_id: 1 }],
            { displayName: "Queued in New", changes: { expected_revenue: 15 } }
        );
        await animationFrame();
        const inEuros = formatMonetary(75, { currencyId: 2 }).replace(/\s+/g, " ");
        expect(inEuros).not.toBe(formatCardRevenue(75));
        expect(".o_crm_mobile_pipeline_count").toHaveText("1");
        expect(`${cardOf("Queued in Proposition")} .o_crm_mobile_lead_card_revenue`).toHaveText(
            inEuros
        );
        // In a stage with loaded leads, the currency of those leads is used.
        await goToStage("New");
        expect(`${cardOf("Queued in New")} .o_crm_mobile_lead_card_revenue`).toHaveText(
            formatCardRevenue(15)
        );
    });

    test.tags("mobile");
    test("mobile: queued activity creates without a type label show the cached type's name, or none for an uncached type or before the types are read; an empty or invalid deadline shows no date", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["mail.activity/action_done", "mail.activity/action_archive"]);
        // The pipeline's activity-type read is withheld: its cards get no type list (`null`).
        const restoreTypeRead = patchWithCleanup(CrmMobilePipeline.prototype, {
            _loadActivityTypes() {},
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(renderer.mobileState.activityTypes).toBe(null);

        // Activity creates queued by another view, whose display values carry no type label.
        const activityValues = (typeId, summary, dateDeadline) => ({
            res_model: "crm.lead",
            res_id: 1,
            activity_type_id: typeId,
            summary,
            date_deadline: dateDeadline,
            user_id: serverState.userId,
        });
        const offer = activityValues(1, "Send the offer", "2030-02-30"); // no such day
        const visit = activityValues(99, "Visit the site", "2030-03-01"); // a type not cached
        queueCall("mail.activity", "web_save", [[], offer], {
            displayName: "Send the offer",
            changes: { summary: "Send the offer" },
        });
        queueCall("mail.activity", "web_save", [[], visit], { displayName: "Visit the site" });
        await animationFrame();
        const card = cardOf("Lead 1");
        const row = (summary) =>
            `${card} .o_crm_mobile_activity_pending:has(.o_crm_mobile_activity_summary:text(${summary}))`;
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_card_activities .badge`).toHaveText("2");
        expect(`${card} .o_crm_mobile_activity_pending`).toHaveCount(2);
        expect(`${row("Send the offer")} .o_crm_mobile_activity_type`).toHaveText("");
        expect(`${row("Visit the site")} .o_crm_mobile_activity_type`).toHaveText("");
        // The invalid deadline shows no date, the valid one is formatted.
        expect(`${row("Send the offer")} .o_crm_mobile_activity_deadline`).toHaveText("");
        expect(`${row("Visit the site")} .o_crm_mobile_activity_deadline`).toHaveText("03/01/2030");

        // Once the types are read, the cached type's name is shown; the uncached one has none.
        restoreTypeRead();
        await renderer._loadActivityTypes();
        await animationFrame();
        expect(renderer.mobileState.activityTypes.map(({ id }) => id)).toEqual([1, 2]);
        expect(`${row("Send the offer")} .o_crm_mobile_activity_type`).toHaveText("Email");
        expect(`${row("Visit the site")} .o_crm_mobile_activity_type`).toHaveText("");
        const lead1Card = mountedCard(cards, 1);
        expect(lead1Card.typeLabel(2)).toBe("Call");
        expect(lead1Card.typeLabel(99)).toBe("");
        expect(
            [false, "", undefined, "2030-02-30"].map((v) => lead1Card.formatDeadline(v))
        ).toEqual(["", "", "", ""]);

        // A queued create has no server id: marking it done does nothing.
        const stored = storedQueue();
        await lead1Card.onMarkDone(offer);
        await lead1Card.onMarkDone(undefined);
        await animationFrame();
        expect(lead1Card.state.busy).toBe(false);
        expect(storedQueue()).toBe(stored);
        expect(`${card} .o_crm_mobile_activity_pending`).toHaveCount(2);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: while a card call is in flight, its stage options are disabled and no other call of the card starts; a second Follow-up tap closes the form", async () => {
        const [activityId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const inFlight = [];
        onRpc("mail.activity", "web_save", async () => {
            const deferred = Promise.withResolvers();
            inFlight.push(deferred);
            await deferred.promise;
        });
        watchRpcs(["mail.activity/web_save", "mail.activity/action_done", "crm.lead/web_save"]);
        patchWithCleanup(CrmMobilePipeline.prototype, {
            onActivitiesChanged(resId) {
                expect.step(`activities changed ${resId}`);
                return super.onActivitiesChanged(...arguments);
            },
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const card = cardOf("Lead 1");
        const lead1Card = mountedCard(cards, 1);

        // Follow-up toggles: the second tap closes the form, and nothing is sent.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(1);
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        expect(lead1Card.state.followUpOpen).toBe(false);
        expect.verifySteps([]);

        // A Log call in flight: every control that would start a call is disabled.
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        await expect.waitForSteps(["mail.activity/web_save"]);
        expect(lead1Card.state.busy).toBe(true);
        expect(`${card} .o_crm_mobile_card_log_call`).toHaveAttribute("disabled");
        expect(`${card} .o_crm_mobile_card_follow_up`).toHaveAttribute("disabled");
        expect(`${card} .o_crm_mobile_activity_done`).toHaveAttribute("disabled");
        // The stage list opens with every stage disabled.
        await contains(`${card} .o_crm_mobile_card_stage`).click();
        expect(`${card} .o_crm_mobile_stage_option`).toHaveCount(4);
        expect(`${card} .o_crm_mobile_stage_option:disabled`).toHaveCount(4);
        // Called directly, the card's handlers start nothing.
        await lead1Card.onLogCall();
        lead1Card.toggleFollowUp();
        await lead1Card.onSaveFollowUp();
        await lead1Card.onMarkDone(lead1Card.activityRows.find(({ id }) => id === activityId));
        await lead1Card.onChooseStage(groupOf(renderer, 2));
        await animationFrame();
        expect.verifySteps([]);
        expect(inFlight).toHaveLength(1);
        expect(lead1Card.state.followUpOpen).toBe(false);
        expect(`${card} [role=listbox]`).toHaveCount(1);
        expect(recordOf(renderer, 1).group).toBe(groupOf(renderer, 1));
        expect(queued()).toHaveLength(0);

        // The call completes: the card is usable again, and only the displayed stage stays
        // disabled.
        inFlight[0].resolve();
        await expect.waitForSteps(["activities changed 1"]);
        await animationFrame();
        expect(lead1Card.state.busy).toBe(false);
        expect(`${card} .o_crm_mobile_card_log_call`).not.toHaveAttribute("disabled");
        expect(`${card} .o_crm_mobile_stage_option:disabled`).toHaveCount(1);
        expect(`${card} .o_crm_mobile_stage_option[data-stage-value='1']`).toHaveAttribute(
            "disabled"
        );
        expect(
            MockServer.env["mail.activity"].search_read(
                [
                    ["res_model", "=", "crm.lead"],
                    ["res_id", "=", 1],
                ],
                ["summary"]
            )
        ).toHaveLength(2);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: a card activity call the server rejects propagates its error, queues nothing and leaves the card usable", async () => {
        const [activityId] = await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "web_save", ({ args }) => {
            expect.step(`web_save ${args[1].summary}`);
            if (args[1].summary === "Rejected follow-up") {
                throw makeServerError({ message: "This activity type is archived" });
            }
        });
        onRpc("mail.activity", "action_done", ({ args }) => {
            expect.step(`action_done ${JSON.stringify(args)}`);
            throw makeServerError({ message: "This activity is locked" });
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            onActivitiesChanged(resId) {
                expect.step(`activities changed ${resId}`);
                return super.onActivitiesChanged(...arguments);
            },
        });
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        const card = cardOf("Lead 1");
        const lead1Card = mountedCard(cards, 1);

        // A follow-up the server rejects: the form stays open with what was entered.
        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Rejected follow-up", {
            confirm: false,
        });
        await expect(lead1Card.onSaveFollowUp()).rejects.toThrow(/This activity type is archived/);
        await animationFrame();
        expect.verifySteps(["web_save Rejected follow-up"]);
        expect(lead1Card.state.busy).toBe(false);
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(1);
        expect(`${card} .o_crm_mobile_follow_up_summary`).toHaveValue("Rejected follow-up");
        expect(`${card} .o_crm_mobile_follow_up_save`).not.toHaveAttribute("disabled");

        // A mark done the server rejects: the activity stays listed, with its Mark done enabled.
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        const activity = lead1Card.activityRows.find(({ id }) => id === activityId);
        await expect(lead1Card.onMarkDone(activity)).rejects.toThrow(/This activity is locked/);
        await animationFrame();
        expect.verifySteps([`action_done [[${activityId}]]`]);
        expect(lead1Card.state.busy).toBe(false);
        expect(
            `${card} .o_crm_mobile_activity_row[data-activity-id='${activityId}'] .o_crm_mobile_activity_done`
        ).not.toHaveAttribute("disabled");
        expect(queued()).toHaveLength(0);

        // The card is usable again: Log call goes through and refreshes the activities.
        await contains(`${card} .o_crm_mobile_card_log_call`).click();
        await expect.waitForSteps(["web_save Call", "activities changed 1"]);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: card activity calls whose connection drops while in flight are queued with their exact arguments", async () => {
        const [activityId] = await createActivities([
            { res_id: 2, activity_type_id: 1, activity_category: "default", summary: "Call back" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        // Each call is held, then its connection drops (a 502 answer).
        const held = { create: Promise.withResolvers(), done: Promise.withResolvers() };
        onRpc("/web/dataset/call_kw/mail.activity/web_save", async () => {
            expect.step("web_save sent");
            await held.create.promise;
            return new Response("", { status: 502 });
        });
        onRpc("/web/dataset/call_kw/mail.activity/action_done", async () => {
            expect.step("action_done sent");
            await held.done.promise;
            return new Response("", { status: 502 });
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            onActivitiesChanged(resId) {
                expect.step(`activities changed ${resId}`);
                return super.onActivitiesChanged(...arguments);
            },
        });
        const cards = captureInstances(CrmMobileLeadCard);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const lead1Card = mountedCard(cards, 1);
        const lead2Card = mountedCard(cards, 2);

        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_log_call`).click();
        await expect.waitForSteps(["web_save sent"]);
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_activity_done`).click();
        await expect.waitForSteps(["action_done sent"]);
        expect([lead1Card.state.busy, lead2Card.state.busy]).toEqual([true, true]);
        expect(queued()).toHaveLength(0);

        held.create.resolve();
        held.done.resolve();
        await animationFrame();
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect([lead1Card.state.busy, lead2Card.state.busy]).toEqual([false, false]);
        const todayString = serializeDate(today());
        const creates = queuedCalls("mail.activity", "web_save");
        expect(creates.map(({ args, kwargs }) => [args, kwargs])).toEqual([
            [
                [
                    [],
                    {
                        res_model: "crm.lead",
                        res_id: 1,
                        activity_type_id: 2,
                        summary: "Call",
                        date_deadline: todayString,
                        user_id: serverState.userId,
                    },
                ],
                { context: {}, specification: {} },
            ],
        ]);
        expect(creates[0].extras).toMatchObject({
            displayName: "Call: Lead 1",
            changes: { activity_type_id: "Call", summary: "Call", date_deadline: todayString },
        });
        const archives = queuedCalls("mail.activity", "action_archive");
        expect(archives.map(({ args, kwargs }) => [args, kwargs])).toEqual([[[[activityId]], {}]]);
        expect(archives[0].extras).toMatchObject({ displayName: "Email: Lead 2", changes: {} });
        expect(queued()).toHaveLength(2);
        // Queued, not done online: the activities are not read again.
        expect.verifySteps([]);
        // Each card shows its queued call as pending.
        expect(
            `${cardOf(
                "Lead 2"
            )} .o_crm_mobile_activity_row[data-activity-id='${activityId}'] .o_crm_mobile_pending_badge`
        ).toHaveText("Pending sync");
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(
            `${cardOf("Lead 1")} .o_crm_mobile_activity_pending .o_crm_mobile_activity_type`
        ).toHaveText("Call");
    });

    test.tags("mobile");
    test("mobile: Follow-up saves nothing with a selected type no longer cached, and an invalid typed date falls back to today", async () => {
        const types = mockActivityTypes(ACTIVITY_TYPES);
        onRpc("mail.activity", "web_save", ({ args }) => {
            expect.step(args[1]);
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const card = cardOf("Lead 1");
        const lead1Card = mountedCard(cards, 1);

        await contains(`${card} .o_crm_mobile_card_follow_up`).click();
        expect(lead1Card.state.typeId).toBe(1);
        await contains(`${card} .o_crm_mobile_follow_up_summary`).edit("Send the brochure", {
            confirm: false,
        });
        // The types are read again while the form is open: Email is no longer offered.
        types.records = ACTIVITY_TYPES.filter(({ id }) => id !== 1);
        await renderer._loadActivityTypes();
        await animationFrame();
        expect(queryAllTexts(`${card} .o_crm_mobile_follow_up_type option`)).toEqual(["Call"]);
        expect(lead1Card.state.typeId).toBe(1);
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        expect.verifySteps([]);
        expect(queued()).toHaveLength(0);
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(1);

        // An offered type saves. A date input never holds an invalid date: the handler is given
        // one directly, and the deadline falls back to today.
        await contains(`${card} .o_crm_mobile_follow_up_type`).select("2");
        lead1Card.onFollowUpDate({ target: { value: "2030-02-30" } });
        await contains(`${card} .o_crm_mobile_follow_up_save`).click();
        await animationFrame();
        expect.verifySteps([
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: 2,
                summary: "Send the brochure",
                date_deadline: serializeDate(today()),
                user_id: serverState.userId,
            },
        ]);
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: card handlers called directly ignore a tap inside the controls, the displayed stage and a missing stage", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["crm.lead/web_save"]);
        patchWithCleanup(CrmMobilePipeline.prototype, {
            // Only records the call: opening the form is not under test.
            onCardOpen(record) {
                expect.step(`open ${record.resId}`);
            },
            onCardMove(record) {
                expect.step(`move ${record.resId}`);
                return super.onCardMove(...arguments);
            },
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const card = cardOf("Lead 1");
        const lead1Card = mountedCard(cards, 1);

        // A tap event whose target is inside the controls does not open the lead; one on its
        // name does.
        for (const selector of [
            ".o_crm_mobile_lead_card_actions",
            ".o_crm_mobile_card_stage",
            ".o_crm_mobile_card_activities",
        ]) {
            lead1Card.onOpenCard({ target: queryOne(`${card} ${selector}`) });
        }
        expect.verifySteps([]);
        lead1Card.onOpenCard({ target: queryOne(`${card} .o_crm_mobile_lead_card_name`) });
        expect.verifySteps(["open 1"]);

        // Neither the displayed stage nor a missing stage is a move.
        await contains(`${card} .o_crm_mobile_card_stage`).click();
        await lead1Card.onChooseStage(groupOf(renderer, 1));
        await lead1Card.onChooseStage(null);
        await lead1Card.onChooseStage(undefined);
        await animationFrame();
        expect.verifySteps([]);
        expect(lead1Card.state.busy).toBe(false);
        expect(`${card} [role=listbox]`).toHaveCount(1);
        expect(recordOf(renderer, 1).group).toBe(groupOf(renderer, 1));
        expect(queued()).toHaveLength(0);
        // Another stage is a move.
        await contains(`${card} .o_crm_mobile_stage_option[data-stage-value='2']`).click();
        await animationFrame();
        expect.verifySteps(["move 1", "crm.lead/web_save"]);
        expect(recordOf(renderer, 1).group).toBe(groupOf(renderer, 2));
    });

    test.tags("mobile");
    test("mobile: a card stage move the server rejects puts the card back, propagates the error and leaves the card usable", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`web_save ${JSON.stringify(args)}`);
            throw makeServerError({ message: "This stage is locked" });
        });
        const cards = captureInstances(CrmMobileLeadCard);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const lead1Card = mountedCard(cards, 1);

        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).click();
        await expect(lead1Card.onChooseStage(groupOf(renderer, 2))).rejects.toThrow(
            /This stage is locked/
        );
        await animationFrame();
        expect.verifySteps([`web_save [[1],{"stage_id":2}]`]);
        // The framework put the card back: same stage, same totals, nothing queued.
        expect(lead1Card.state.busy).toBe(false);
        expect(recordOf(renderer, 1).group).toBe(groupOf(renderer, 1));
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expectHeader("New", 2, 120);
        expect(queued()).toHaveLength(0);
        // The card shown for Lead 1 is idle with its stage list closed, and every other stage can
        // be chosen again.
        expect(mountedCard(cards, 1).state.busy).toBe(false);
        expect(`${cardOf("Lead 1")} [role=listbox]`).toHaveCount(0);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_stage`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_stage_option`).toHaveCount(4);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_stage_option:disabled`).toHaveCount(1);
    });
});

// -----------------------------------------------------------------------------
// Remaining branches
// -----------------------------------------------------------------------------

describe("Remaining branches", () => {
    test.tags("mobile");
    test("mobile: a lead datapoint a reload replaced is placed by the rules of the loaded ones: in the stage of its queued stage write, else in its loaded stage", async () => {
        // the queued write places Lead 3 in New: Lead 1's and Lead 2's activities (Lead 3's were
        // never read, so they are not cached and raise nothing) and the types
        const errors = cachedReadErrors([ACTIVITIES, ACTIVITIES, TYPES]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        // Datapoints of the first load: Lead 3 in Qualified, Lead 2 in New.
        const replacedLead3 = recordOf(renderers.at(-1), 3);
        const replacedLead2 = recordOf(renderers.at(-1), 2);
        expect([replacedLead3.serverStageId, replacedLead2.serverStageId]).toEqual([2, 1]);
        await renderers.at(-1).props.list.load();
        await animationFrame();
        const renderer = renderers.at(-1);
        // The reload rebuilt every record: the list holds neither datapoint any more.
        const loaded = renderer.allLoadedRecords();
        expect(loaded.map((record) => record.resId).sort()).toEqual([1, 2, 3, 4, 5]);
        expect(loaded.includes(replacedLead3)).toBe(false);
        expect(loaded.includes(replacedLead2)).toBe(false);

        // Offline, a queued stage write moves Lead 3 from Qualified to New.
        await setOffline(true);
        getService(OfflinePlugin).scheduleORM(
            "crm.lead",
            "web_save",
            [[3], { stage_id: 1 }],
            { context: {}, specification: {} },
            { extras: { timeStamp: Date.now(), viewType: "kanban", displayName: "Lead 3" } }
        );
        await animationFrame();
        expectHeader("New", 3, 150);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Lead 3"]);
        expect(renderer.displayStage(recordOf(renderer, 3))).toBe(1);

        // The replaced Lead 3 is placed where the write displays the loaded one, as displaced...
        expect(renderer.displayStage(replacedLead3)).toBe(1);
        expect(renderer.isDisplaced(replacedLead3)).toBe(true);
        // ...and the replaced Lead 2, which no write moves, in its loaded stage.
        expect(renderer.displayStage(replacedLead2)).toBe(1);
        expect(renderer.isDisplaced(replacedLead2)).toBe(false);
        // Placing them changes nothing displayed.
        await animationFrame();
        expectHeader("New", 3, 150);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Lead 3"]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a stage the server answers in two groups shows, in each of them, the lead a queued write places in the stage, and not the lead it moves out", async () => {
        // the queued writes change the lead Proposition displays (Lead 1 for Lead 4): Lead 1's
        // activities, read online in New, and the types are answered by the cache
        const errors = cachedReadErrors([ACTIVITIES, TYPES]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        // The server answers Proposition, then a second, empty group of the same stage.
        onRpc("crm.lead", "web_read_group", async ({ kwargs, parent }) => {
            const result = await parent();
            const index = result.groups.findIndex((group) => group.stage_id?.[0] === 3);
            const emptyGroup = { ...result.groups[index], __count: 0, __records: [] };
            for (const aggregate of kwargs.aggregates) {
                emptyGroup[aggregate] = aggregate.endsWith(":array_agg_distinct") ? [] : 0;
            }
            result.groups.splice(index + 1, 0, emptyGroup);
            result.length++;
            return result;
        });
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const [proposition, twin] = renderer.props.list.groups.filter(
            (group) => group.serverValue === 3
        );
        expect(twin.id).not.toBe(proposition.id);
        expect([proposition.count, twin.count]).toEqual([1, 0]);
        expect(renderer.stageGroups.map((group) => group.displayName)).toEqual([
            "New",
            "Qualified",
            "Proposition",
            "Proposition",
            "Won",
        ]);
        await goToStage("Proposition");
        expect(renderer.currentGroup).toBe(proposition);
        expectHeader("Proposition", 1, 40);
        expect(cardNames()).toEqual(["Lead 4"]);

        // Offline, queued stage writes move Lead 4 to Qualified and Lead 1 from New to
        // Proposition.
        await setOffline(true);
        const offline = getService(OfflinePlugin);
        const timeStamp = Date.now();
        for (const [resId, stageId, index] of [
            [4, 2, 0],
            [1, 3, 1],
        ]) {
            offline.scheduleORM(
                "crm.lead",
                "web_save",
                [[resId], { stage_id: stageId }],
                { context: {}, specification: {} },
                {
                    extras: {
                        timeStamp: timeStamp + index,
                        viewType: "kanban",
                        displayName: `Lead ${resId}`,
                    },
                }
            );
        }
        await animationFrame();
        // The displayed group shows Lead 1 only, with its count and revenue (40 - 40 + 100)...
        expectHeader("Proposition", 1, 100);
        expect(cardNames()).toEqual(["Lead 1"]);
        // ...and so does the other group of the stage: Lead 1 is placed in both, Lead 4 in
        // neither.
        const namesIn = (group) => renderer.cardsFor(group).map((record) => record.data.name);
        expect(namesIn(proposition)).toEqual(["Lead 1"]);
        expect(namesIn(twin)).toEqual(["Lead 1"]);
        expect(renderer.stageCount(twin)).toBe(1);
        // Lead 4 is counted in Qualified, and Lead 1 is out of New.
        const totals = (stageId) => {
            const group = groupOf(renderer, stageId);
            return [namesIn(group), renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };
        expect(totals(2)).toEqual([["Lead 3", "Lead 4"], 2, 70]);
        expect(totals(1)).toEqual([["Lead 2"], 1, 20]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: Show all called for a lead whose page is complete, or whose activities were never read, reads nothing and changes nothing", async () => {
        await createLeadActivities(2, 3);
        mockActivityTypes(ACTIVITY_TYPES);
        watchActivityReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps(["activities:1", "activities:2"]);
        const [renderer] = renderers;
        const { mobileState } = renderer;
        const pageIds = (resId) => mobileState.activitiesByLead[resId].map(({ id }) => id);
        // Lead 1 has no activity and Lead 2 its 3 activities on one page; Lead 3 (Qualified)
        // was never displayed, so its activities were never read.
        expect(mobileState.activityTotalsByLead).toEqual({ 1: 0, 2: 3 });
        const lead2Page = pageIds(2);
        expect(lead2Page).toHaveLength(3);
        expect(pageIds(1)).toEqual([]);
        // No card offers Show all: no page misses an activity.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 2")} .o_crm_mobile_activity_row`).toHaveCount(3);
        expect(".o_crm_mobile_activities_show_all").toHaveCount(0);

        // Called directly online, for each of them, it reads nothing and expands nothing.
        for (const resId of [2, 1, 3]) {
            await renderer.onShowAllActivities(resId);
        }
        await animationFrame();
        expect.verifySteps([]);
        expect(mobileState.activityLimitsByLead).toEqual({});
        expect(mobileState.activityTotalsByLead).toEqual({ 1: 0, 2: 3 });
        expect(pageIds(2)).toEqual(lead2Page);
        expect(pageIds(1)).toEqual([]);
        expect(3 in mobileState.activitiesByLead).toBe(false);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_activity_row`).toHaveCount(3);
        expect(activityBadgeOf("Lead 2")).toHaveText("3");
        expect(".o_crm_mobile_activities_show_all").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: online, displaying a folded stage loads and unfolds it through the inherited toggleGroup; a connection lost meanwhile leaves it folded and shown offline", async () => {
        // Won is displayed once the connection dropped: the cache answers its type read
        const errors = cachedReadErrors([TYPES]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([3, 4], { fold: true });
        const connection = mockConnectionDrop();
        watchRpcs(["crm.lead/web_search_read"]);
        patchWithCleanup(CrmMobilePipeline.prototype, {
            toggleGroup(group) {
                expect.step(`toggleGroup ${group.serverValue}`);
                return super.toggleGroup(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(groupOf(renderer, 3).isFolded).toBe(true);
        expect(groupOf(renderer, 3).list.records).toHaveLength(0);

        // An unfolded stage is displayed without any load.
        await goToStage("Qualified");
        expect.verifySteps([]);
        // Online, the folded Proposition is loaded and unfolded by the inherited toggleGroup.
        await contains(".o_crm_mobile_pipeline_next").click();
        await animationFrame();
        expect.verifySteps(["toggleGroup 3", "crm.lead/web_search_read"]);
        expect(groupOf(renderer, 3).isFolded).toBe(false);
        expect(".o_crm_mobile_pipeline_folded").toHaveCount(0);
        expectHeader("Proposition", 1, 40);
        expect(cardNames()).toEqual(["Lead 4"]);

        // The connection drops while the folded Won is loaded: the loss is not raised, Won is
        // displayed folded and, offline, its lead (never loaded) is reported missing.
        connection.offline = true;
        await contains(".o_crm_mobile_pipeline_next").click();
        await animationFrame();
        expect.verifySteps(["toggleGroup 4", "crm.lead/web_search_read"]);
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(groupOf(renderer, 4).isFolded).toBe(true);
        expect(".o_crm_mobile_pipeline_folded").toHaveCount(1);
        expectHeader("Won", 1, 50);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a server error while a folded stage is loaded for display is raised, and the stage stays folded", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.stage"].write([4], { fold: true });
        onRpc("crm.lead", "web_search_read", () => {
            expect.step("load Won");
            throw makeServerError({ message: "This stage cannot be read" });
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        await goToStage("Proposition");
        expect.verifySteps([]);

        expect.errors(1);
        await contains(".o_crm_mobile_pipeline_next").click();
        await animationFrame();
        expect.verifySteps(["load Won"]);
        expect.verifyErrors(["This stage cannot be read"]);
        expect(groupOf(renderer, 4).isFolded).toBe(true);
        expect(".o_crm_mobile_pipeline_folded").toHaveCount(1);
        expectHeader("Won", 1, 50);
        await contains(".modal .modal-footer .btn-primary").click();
        expect(".modal").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a mostly vertical gesture, a touch without a start point and a swipe past the last stage do not navigate; a touch end without coordinates swipes from the last move", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();
        /**
         * Dispatches a touch event on the stage body.
         *
         * @param {string} type
         * @param {Array<[number, number]>} points the touch positions, none for `[]`
         */
        const touch = async (type, points) => {
            const target = queryOne(".o_crm_mobile_pipeline_body");
            const touches = points.map(
                ([clientX, clientY], identifier) =>
                    new Touch({ identifier, target, clientX, clientY })
            );
            target.dispatchEvent(
                new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: type === "touchend" ? [] : touches,
                    changedTouches: touches,
                })
            );
            await animationFrame();
        };
        expectHeader("New", 2, 120);

        // Mostly vertical (|dx| = 70 is over the threshold, but |dy| = 200): not a navigation.
        await touch("touchstart", [[200, 100]]);
        await touch("touchmove", [[130, 300]]);
        await touch("touchend", [[130, 300]]);
        expectHeader("New", 2, 120);

        // A touch end with no gesture in progress: its start carried no touch point.
        await touch("touchstart", []);
        await touch("touchend", [[50, 100]]);
        expectHeader("New", 2, 120);

        // A touch end without coordinates ends the swipe where the last move left it.
        await touch("touchstart", [[200, 100]]);
        await touch("touchmove", [[100, 105]]);
        await touch("touchend", []);
        expectHeader("Qualified", 1, 30);

        // On the last stage, a swipe to the left (the next stage) changes nothing.
        await goToStage("Won");
        expect(".o_crm_mobile_pipeline_next").toHaveCount(0);
        await swipeLeft(".o_crm_mobile_pipeline_body");
        expectHeader("Won", 1, 50);
        expect(cardNames()).toEqual(["Lead 5"]);
    });

    test.tags("mobile");
    test("mobile: the pipeline handlers ignore an absent record, target stage or lead id, and Add without an event opens the bottom sheet on the displayed stage", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const calls = collectRpcs();
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            moveRecords() {
                expect.step("moveRecords");
                return super.moveRecords(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({ selectRecord: (resId) => expect.step(`open ${resId}`) });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        await goToStage("Qualified");
        await animationFrame();
        const qualified = groupOf(renderer, 2);
        const lead3 = recordOf(renderer, 3);
        calls.splice(0);

        await renderer.onCardOpen(undefined);
        await renderer.onCardMove(undefined, groupOf(renderer, 1));
        await renderer.onCardMove(lead3, undefined);
        await renderer.onActivitiesChanged(0);
        await renderer.goToGroup(undefined);
        await animationFrame();
        expect.verifySteps([]);
        expect(calls).toEqual([]);
        expect(renderer.currentGroup).toBe(qualified);
        expect(lead3.group).toBe(qualified);
        expect(renderer.mobileState.unavailableLeadId).toBe(null);
        expectHeader("Qualified", 1, 30);
        expect(cardNames()).toEqual(["Lead 3"]);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);

        // Add called without an event (no tapped button) anchors the bottom sheet on the
        // pipeline, with the displayed stage selected.
        renderer.onAddClick();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(".o_crm_mobile_quick_create select[name=stage_id]").toHaveValue(qualified.id);
    });

    test.tags("mobile");
    test("mobile: with the group-by cleared there is no displayed stage, and the stage readers and navigation handlers do nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const calls = collectRpcs();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        // This action groups by stage through a search facet only (no default grouping).
        await getService("action").doAction(UNGROUPABLE_PIPELINE_ACTION_ID);
        await animationFrame();
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        await removeFacet("Stage");
        await animationFrame();
        const [renderer] = renderers;
        expect(renderer.props.list.config.groupBy).toEqual([]);
        expect(renderer.isMobilePipeline).toBe(false);
        const displayedStage = renderer.stageState.serverValue;
        calls.splice(0);

        const group = renderer.currentGroup;
        expect(group).toBe(undefined);
        expect(renderer.currentIndex).toBe(-1);
        expect(renderer.hasPrevStage).toBe(false);
        expect(renderer.hasNextStage).toBe(false);
        expect(renderer.cardsFor(group)).toEqual([]);
        expect(renderer.pendingCreatesFor(group)).toEqual([]);
        expect(renderer.stageCount(group)).toBe(0);
        expect(renderer.stageRevenueValue(group)).toBe(0);
        expect(renderer.isStageDataMissing(group)).toBe(false);
        expect(renderer.unavailableMoreCount(group)).toBe(0);
        await renderer.onNext();
        await renderer.onPrev();
        // Outside the stage pipeline, an activity refresh request reads nothing.
        await renderer.onActivitiesChanged(1);
        await animationFrame();
        expect(renderer.stageState.serverValue).toBe(displayedStage);
        expect(calls).toEqual([]);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer.o_kanban_ungrouped").toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: activities and activity types answered after regrouping by salesperson are dropped, and read again once grouped by stage", async () => {
        await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        mockActivityTypes(ACTIVITY_TYPES);
        const answers = Promise.withResolvers();
        onRpc("mail.activity", "web_search_read", async () => {
            await answers.promise;
        });
        onRpc("mail.activity.type", "web_search_read", async () => {
            await answers.promise;
        });
        watchActivityReads();
        watchTypeReads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect.verifySteps(["types", "activities:1", "activities:2"]);

        // The reads are still unanswered when the pipeline is regrouped by salesperson.
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        expect(renderer.isMobilePipeline).toBe(false);
        answers.resolve();
        await animationFrame();
        await animationFrame();
        // Their answers arrive outside the stage pipeline: nothing is stored, nothing read.
        expect(renderer.mobileState.activitiesByLead).toEqual({});
        expect(renderer.mobileState.activityTypes).toBe(null);
        expect.verifySteps([]);

        // Grouped by stage again, the reads are issued again and their answers applied.
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        await animationFrame();
        expect.verifySteps(["types", "activities:1", "activities:2"]);
        expect(renderer.mobileState.activityTypes.map(({ id }) => id)).toEqual([1, 2]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_summary`).toHaveText("Send offer");
    });

    test.tags("mobile");
    test("mobile: answers landing after the pipeline was left change nothing: refreshed activities and activity types, and the stage a card move would display", async () => {
        const typeAnswer = mockActivityTypes(ACTIVITY_TYPES);
        // Once held, the server answers of the activity and type reads wait for the release.
        let holdReads = false;
        const readsReleased = Promise.withResolvers();
        const holdRead = async ({ model }) => {
            if (holdReads) {
                await readsReleased.promise;
                expect.step(`${model} answered`);
            }
        };
        onRpc("mail.activity", "web_search_read", holdRead);
        onRpc("mail.activity.type", "web_search_read", holdRead);
        // The framework move is made at once; its answer reaches the pipeline on release. The
        // scoped ORM of a destroyed pipeline never answers, so only a held answer can land late.
        const moveReleased = Promise.withResolvers();
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            async moveRecords() {
                const result = await super.moveRecords(...arguments);
                expect.step("moved");
                await moveReleased.promise;
                return result;
            },
        });
        const typeNames = (types) => types.map(({ display_name }) => display_name);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const [renderer] = renderers;
        expect(renderer.stageState.serverValue).toBe(null);
        expect(renderer.mobileState.activitiesByLead[1]).toEqual([]);
        expect(typeNames(renderer.mobileState.activityTypes)).toEqual(["Email", "Call"]);

        // The server now holds an activity on Lead 1 and one more activity type.
        await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
        ]);
        typeAnswer.records = [
            ...ACTIVITY_TYPES,
            { id: 40, display_name: "Visit", category: "default" },
        ];
        // Online, Lead 1 moves to Qualified: Qualified is displayed with it and Lead 3 as soon as
        // the framework has moved it, so their activities and the types are read again. The cache
        // answers at once (Lead 3's were never read), the server's answers wait.
        holdReads = true;
        await chooseStage("Lead 1", 2);
        await expect.waitForSteps(["moved"]);
        expect(recordOf(renderer, 1).group.serverValue).toBe(2);
        expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(2);
        expect(renderer.stageState.serverValue).toBe(null);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);
        // Lead 1's form is opened, which destroys the pipeline...
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        await animationFrame();
        expect(".o_form_view").toHaveCount(1);
        expect(status(renderer)).toBe("destroyed");

        // ...then the changed server answers and the move land: the destroyed pipeline keeps the
        // activities and types it had, and its stored stage stays unset.
        readsReleased.resolve();
        moveReleased.resolve();
        await expect.waitForSteps([
            "mail.activity answered",
            "mail.activity answered",
            "mail.activity.type answered",
        ]);
        await animationFrame();
        expect(renderer.mobileState.activitiesByLead[1]).toEqual([]);
        expect(renderer.mobileState.activitiesByLead[3]).toBe(undefined);
        expect(typeNames(renderer.mobileState.activityTypes)).toEqual(["Email", "Call"]);
        expect(recordOf(renderer, 1).group.serverValue).toBe(2);
        expect(renderer.stageState.serverValue).toBe(null);

        // Back: a new pipeline, on the stage it was left on, with the moved lead in Qualified and
        // the answers the cache now holds.
        holdReads = false;
        await contains(".o_back_button").click();
        await animationFrame();
        expect(renderers).toHaveLength(2);
        expectHeader("New", 1, 20);
        expect(cardNames()).toEqual(["Lead 2"]);
        expect(renderers[1].stageCount(groupOf(renderers[1], 2))).toBe(2);
        expect(typeNames(renderers[1].mobileState.activityTypes)).toEqual([
            "Email",
            "Call",
            "Visit",
        ]);
        await goToStage("Qualified");
        await animationFrame();
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);
        expect(renderers[1].mobileState.activitiesByLead[1].map(({ summary }) => summary)).toEqual([
            "Send offer",
        ]);
    });

    test.tags("mobile");
    test("mobile: a reconnection while regrouped by salesperson reloads nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        expect(renderer.isMobilePipeline).toBe(false);

        // Offline and back online with nothing queued: in the stage pipeline this reloads at
        // once; regrouped by salesperson, nothing is reloaded.
        await setOffline(true);
        await setOffline(false);
        await runAllTimers();
        expect(queued()).toHaveLength(0);
        expect.verifySteps([]);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_group").toHaveCount(2);
    });

    test.tags("mobile");
    test("mobile: with sample data, no activity is read or refreshed; a reconnection whose reload loses the connection keeps the sample data, and the next one reloads once and leaves sample mode", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        // A pipeline without any lead: the server still returns every stage, empty (stage
        // `group_expand`), and the kanban fills them with sample data.
        onRpc("crm.lead", "web_read_group", ({ parent }) => {
            const result = parent();
            for (const group of result.groups) {
                group.__count = 0;
                group.__records = [];
            }
            return result;
        });
        const setOffline = mockOffline();
        let dropNextReload = false;
        onRpc("/*", (request) => {
            const match = new URL(request.url).pathname.match(R_CALL_KW);
            if (dropNextReload && match?.groups.model === "crm.lead") {
                // The connection drops again as the pipeline reloads: its first request (the
                // progress bar read) loses it, so its grouped read does too.
                dropNextReload = false;
                setOffline(true);
                return new Response("", { status: 502 });
            }
        });
        watchRpcs([LEAD_GROUPS, ACTIVITIES, TYPES]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" sample="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(renderer.props.list.model.useSampleModel).toBe(true);
        expect(".o_view_sample_data").toHaveCount(1);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expect.verifySteps([LEAD_GROUPS]);
        const [sampleLead] = renderer.cardsFor(renderer.currentGroup);
        expect(sampleLead.resId).toBeGreaterThan(0);

        // A refresh request for a sample lead reads nothing.
        await renderer.onActivitiesChanged(sampleLead.resId);
        expect.verifySteps([]);
        // Offline and back online with nothing queued: the pipeline reloads at once, and the
        // reload loses the connection. The sample data stay, and nothing is read for them.
        await setOffline(true);
        dropNextReload = true;
        await setOffline(false);
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(renderer.props.list.model.useSampleModel).toBe(true);
        expect(".o_view_sample_data").toHaveCount(1);
        expect(renderer.mobileState.syncEntries).toBe(null);
        // Back online with nothing queued: the pipeline is reloaded once, at once, and leaves
        // sample mode on the server's empty stages; the reloaded stage revalidates the activity
        // types, and no activity is read (no lead is displayed).
        await setOffline(false);
        await runAllTimers();
        expect.verifySteps([LEAD_GROUPS, TYPES]);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(renderer.mobileState.activitiesByLead).toEqual({});
        expect(renderer.props.list.model.useSampleModel).toBe(false);
        expect(".o_view_sample_data").toHaveCount(0);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expect(".o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_count").toHaveText("0");
    });

    test.tags("mobile");
    test("mobile: a reconciliation reload that loses the connection keeps the sync copy, so the replayed move keeps its placement until the next reconnection reloads", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
            // the connection lost during the reload: Qualified's two leads, read online on
            // reconnecting, and the types, answered by the cache
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // the offline reload, then the activities revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        let dropNextReload = false;
        onRpc("/web/dataset/call_kw/crm.lead/web_read_group", () => {
            if (dropNextReload) {
                // The connection drops again while the pipeline reloads.
                dropNextReload = false;
                setOffline(true);
                return new Response("", { status: 502 });
            }
        });
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${JSON.stringify(args)}`);
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        const offline = getService(OfflinePlugin);
        const totals = (stageId) => {
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };

        // Offline move of Lead 1 (100) from New to Qualified.
        await setOffline(true);
        await chooseStage("Lead 1", 2);
        const [entry] = queued();
        expectHeader("Qualified", 2, 130);

        // Reconnect: the move is replayed, then the reconciliation reload loses the connection.
        dropNextReload = true;
        await setOffline(false);
        await expect.waitForSteps(['replayed [[1],{"stage_id":2}]', LEAD_GROUPS]);
        await animationFrame();
        expect(offline.isOffline()).toBe(true);
        expect(queued()).toHaveLength(0);
        // The copy of the sync window is kept.
        expect(renderer.mobileState.syncEntries.map(({ key }) => String(key))).toEqual([
            String(entry.key),
        ]);

        // An offline reload rebuilds Lead 1 from cached data that predate the move: the kept
        // copy still places it in Qualified, with the corrected totals.
        await renderer.props.list.load();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        const lead1 = recordOf(renderer, 1);
        expect(lead1.group.serverValue).toBe(1);
        expect(lead1.serverStageId).toBe(1);
        expectHeader("Qualified", 2, 130);
        expect(cardNames().sort()).toEqual(["Lead 1", "Lead 3"]);
        expect(totals(1)).toEqual([1, 20]);

        // The next reconnection (nothing queued) reloads at once: the copy ends, the server data
        // place the lead.
        await setOffline(false);
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(recordOf(renderer, 1).serverStageId).toBe(2);
        expect(renderer.allLoadedRecords().some((record) => renderer.isDisplaced(record))).toBe(
            false
        );
        expectHeader("Qualified", 2, 130);
        expect(totals(1)).toEqual([1, 20]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a reconciliation reload rejected by the server is raised", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        let rejectReload = false;
        onRpc("crm.lead", "web_read_group", () => {
            if (rejectReload) {
                throw makeServerError({ message: "The pipeline cannot be reloaded" });
            }
        });
        watchRpcs([LEAD_GROUPS]);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);

        await setOffline(true);
        rejectReload = true;
        expect.errors(1);
        // Back online with nothing queued: the reconciliation reload runs at once and fails.
        await setOffline(false);
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect.verifyErrors(["The pipeline cannot be reloaded"]);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("New", 2, 120);
        await contains(".modal .modal-footer .btn-primary").click();
        expect(".modal").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a reconciliation reload landing after the pipeline was left leaves its sync copy alone", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // Once held, the framework reload is made at once and its answer reaches the pipeline on
        // release. The scoped ORM of a destroyed pipeline never answers, and leaving the view
        // waits for a reload in progress, so only a held answer can land after the pipeline left.
        let holdReload = false;
        const reloadReleased = Promise.withResolvers();
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            async load() {
                const result = await super.load(...arguments);
                if (holdReload) {
                    holdReload = false;
                    expect.step("reloaded");
                    await reloadReleased.promise;
                }
                return result;
            },
        });
        const keysOf = (entries) => entries.map(({ key }) => String(key));
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const [renderer] = renderers;

        // Offline move of Lead 1 to Qualified, then the connection returns: the move is replayed
        // and the reconciliation reload is made, its answer held.
        await setOffline(true);
        await chooseStage("Lead 1", 2);
        const [entry] = queued();
        holdReload = true;
        await setOffline(false);
        await letQueueReplay(1);
        await expect.waitForSteps(["reloaded"]);
        expect(queued()).toHaveLength(0);
        expect(keysOf(renderer.mobileState.syncEntries)).toEqual([String(entry.key)]);

        // Lead 1's form is opened, which destroys the pipeline, then the reload answer lands: the
        // destroyed pipeline's copy is not ended.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        await animationFrame();
        expect(".o_form_view").toHaveCount(1);
        expect(status(renderer)).toBe("destroyed");
        reloadReleased.resolve();
        await animationFrame();
        expect(keysOf(renderer.mobileState.syncEntries)).toEqual([String(entry.key)]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a connection lost during the replay keeps the sync copy, and the next sync window starts from it united with the entries still queued", async () => {
        const errors = cachedReadErrors([
            // the first move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
            // the second move displays Proposition (Lead 3's activities were never cached: the
            // types)
            TYPES,
            // the offline reload, then the activities revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        let dropOnLead3 = false;
        let holdLead3 = false;
        const lead3Replay = Promise.withResolvers();
        // Registered before mockOffline, whose offline answer therefore comes first: only the
        // calls that reach the server are seen here, the replays.
        onRpc("/web/dataset/call_kw/crm.lead/web_save", async (request) => {
            const { params } = await request.clone().json();
            expect.step(`replay ${JSON.stringify(params.args)}`);
            if (params.args[0][0] !== 3) {
                return;
            }
            if (dropOnLead3) {
                // The connection drops again during this replay.
                dropOnLead3 = false;
                setOffline(true);
                return new Response("", { status: 502 });
            }
            if (holdLead3) {
                await lead3Replay.promise;
            }
        });
        const setOffline = mockOffline();
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        const offline = getService(OfflinePlugin);
        const keysOf = (entries) => entries.map(({ key }) => String(key));
        const keyOf = (resId) =>
            String(queued().find(({ value }) => value.args[0][0] === resId).key);
        const totals = (stageId) => {
            const group = groupOf(renderer, stageId);
            return [renderer.stageCount(group), renderer.stageRevenueValue(group)];
        };

        // Offline: Lead 1 (100) to Qualified, then Lead 3 (30) to Proposition.
        await setOffline(true);
        await chooseStage("Lead 1", 2);
        await advanceTime(1000);
        await chooseStage("Lead 3", 3);
        const keyA = keyOf(1);
        const keyB = keyOf(3);
        expectHeader("Proposition", 2, 70);

        // Reconnect: Lead 1's move is replayed, then the connection drops during Lead 3's.
        dropOnLead3 = true;
        await setOffline(false);
        await letQueueReplay(1);
        expect.verifySteps(['replay [[1],{"stage_id":2}]', 'replay [[3],{"stage_id":3}]']);
        expect(offline.isOffline()).toBe(true);
        expect(offline.syncingORM()).toBe(false);
        expect(keysOf(queued())).toEqual([keyB]);
        // The interrupted window reloaded nothing and kept its copy.
        expect(keysOf(renderer.mobileState.syncEntries).sort()).toEqual([keyA, keyB].sort());

        // An offline reload rebuilds both leads from cached data that predate both moves: the
        // queued move places Lead 3, the kept copy places Lead 1.
        await renderer.props.list.load();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(recordOf(renderer, 1).group.serverValue).toBe(1);
        expect(recordOf(renderer, 3).group.serverValue).toBe(2);
        expectHeader("Proposition", 2, 70);
        expect(totals(1)).toEqual([1, 20]);
        expect(totals(2)).toEqual([1, 100]);

        // Reconnect: the new window starts from the entries still queued united with the kept
        // copy, so Lead 1 keeps its placement while Lead 3's move is replayed...
        holdLead3 = true;
        await setOffline(false);
        await expect.waitForSteps(['replay [[3],{"stage_id":3}]']);
        expect(offline.syncingORM()).toBe(true);
        expect(keysOf(renderer.mobileState.syncEntries)).toEqual([keyB, keyA]);
        expect(keysOf(queued())).toEqual([keyB]);
        expect(totals(2)).toEqual([1, 100]);
        expectHeader("Proposition", 2, 70);
        // ...and once it is replayed, the reconciliation reload lands: no correction remains.
        lead3Replay.resolve();
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(offline.syncingORM()).toBe(false);
        expect(queued()).toHaveLength(0);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(recordOf(renderer, 1).serverStageId).toBe(2);
        expect(recordOf(renderer, 3).serverStageId).toBe(3);
        expect(renderer.allLoadedRecords().some((record) => renderer.isDisplaced(record))).toBe(
            false
        );
        expectHeader("Proposition", 2, 70);
        expect(totals(1)).toEqual([1, 20]);
        expect(totals(2)).toEqual([1, 100]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: without a sum field the header shows the lead count only, and without create rights no Add is offered", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace(' sum_field="expected_revenue"', "").replace(
                'archivable="false"',
                'archivable="false" create="0"'
            ),
        });
        const [renderer] = renderers;
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expect(renderer.hasRevenue).toBe(false);
        expect(renderer.canAdd).toBe(false);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("New");
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
        expect(".o_crm_mobile_pipeline_revenue").toHaveCount(0);
        expect(renderer.stageRevenueValue(renderer.currentGroup)).toBe(0);
        expect(".o_crm_mobile_pipeline_add").toHaveCount(0);
        renderer.onAddClick();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a non-monetary sum field is summed as an integer, online and from the offline cache, a zero sum included", async () => {
        const errors = cachedReadErrors([
            // the offline reload, then New's leads and the types revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // Qualified displayed (Lead 3's activities were never read): the types
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.lead"].write([1], { color: 3 });
        MockServer.env["crm.lead"].write([2], { color: 4 });
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('sum_field="expected_revenue"', 'sum_field="color"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
        expect(".o_crm_mobile_pipeline_revenue").toHaveText("7");

        // Offline, the pipeline reloaded from the cache has no progress bar data: the cached
        // group aggregates are summed, with no currency.
        await setOffline(true);
        await renderer.props.list.load();
        await animationFrame();
        expect(renderer._stageAggregate(groupOf(renderer, 1))).toEqual({ value: 7 });
        expect(renderer._stageAggregate(groupOf(renderer, 2))).toEqual({ value: 0 });
        expect(".o_crm_mobile_pipeline_revenue").toHaveText("7");
        await goToStage("Qualified");
        expect(".o_crm_mobile_pipeline_count").toHaveText("1");
        expect(".o_crm_mobile_pipeline_revenue").toHaveText("0");
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a stage holding several currencies sums in the company currency, and a stage emptied on the server shows 0 without currency, online and from the offline cache", async () => {
        const errors = cachedReadErrors([
            // the offline reload, then Qualified's lead and the types revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            TYPES,
            // back on New: its two leads and the types
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // on to Proposition through Qualified (its lead and the types), then Proposition,
            // which holds no lead (the types)
            ACTIVITIES,
            TYPES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        // New holds dollars (Lead 1) and euros (Lead 2), Qualified euros only (Lead 3).
        MockServer.env["crm.lead"].write([2, 3], { company_currency: 2 });
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const euros = (value) =>
            formatMonetary(value, {
                currencyId: 2,
                humanReadable: true,
                digits: [null, 0],
                minDigits: 3,
            }).replace(/\s+/g, " ");
        expect(renderer._stageAggregate(groupOf(renderer, 1)).currencies).toEqual([1, 2]);
        expectHeader("New", 2, 120);
        await goToStage("Qualified");
        expect(".o_crm_mobile_pipeline_revenue").toHaveText(euros(30));

        // Proposition's only lead moves to Won on the server: reloaded, Proposition is kept
        // (default grouping) with no lead.
        MockServer.env["crm.lead"].write([4], { stage_id: 4 });
        await renderer.props.list.load();
        await animationFrame();
        expect(groupOf(renderer, 3).count).toBe(0);

        // Offline, the pipeline reloaded from the cache has no progress bar data: the cached
        // group aggregates give the same sums and currencies.
        await setOffline(true);
        await renderer.props.list.load();
        await animationFrame();
        expect(renderer._stageAggregate(groupOf(renderer, 1))).toEqual({
            value: 120,
            currencies: [1, 2],
        });
        expect(renderer._stageAggregate(groupOf(renderer, 2))).toEqual({
            value: 30,
            currencies: [2],
        });
        expect(renderer._stageAggregate(groupOf(renderer, 3))).toEqual({ value: 0 });
        expect(".o_crm_mobile_pipeline_revenue").toHaveText(euros(30));
        await goToStage("New");
        expectHeader("New", 2, 120);
        await goToStage("Proposition");
        expect(".o_crm_mobile_pipeline_count").toHaveText("0");
        expect(".o_crm_mobile_pipeline_revenue").toHaveText("0");
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: once the progress bar data are lost, a stage filtered on a progress bar value keeps the filter's totals, the others use their loaded aggregates", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.lead"].write([1], { activity_state: "planned" });
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const progressBarState = renderer.props.progressBarState;
        const totals = (group) => {
            const { value, currencies } = renderer._stageAggregate(group);
            return [value, currencies];
        };

        // Online, New is filtered on its planned leads, as a click on its progress bar does on
        // desktop (the mobile pipeline shows no progress bar): only Lead 1 is planned.
        await progressBarState.selectBar(groupOf(renderer, 1).id, { value: "planned" });
        await runAllTimers();
        await animationFrame();
        expect(progressBarState.activeBars[1].value).toBe("planned");
        expect(groupOf(renderer, 1).aggregates.expected_revenue).toBe(120);
        expect(totals(groupOf(renderer, 1))).toEqual([100, [CURRENCY_ID]]);

        // The connection drops and a reload fails: the progress bar data are gone. New keeps the
        // filter's own sum, not its loaded aggregate; Qualified, unfiltered, uses its own.
        await setOffline(true);
        await renderer.props.list.load().catch((error) => expect.step(error.message));
        await animationFrame();
        expect.verifySteps([
            `Connection to "/web/dataset/call_kw/${LEAD_GROUPS}" couldn't be established or was interrupted`,
        ]);
        const newStage = groupOf(renderer, 1);
        expect(progressBarState.getGroupInfo(newStage).isReady).toBe(false);
        expect(totals(newStage)).toEqual([100, [CURRENCY_ID]]);
        expect(".o_crm_mobile_pipeline_revenue").toHaveText(formatRevenue(100));
        expect(totals(groupOf(renderer, 2))).toEqual([30, [CURRENCY_ID]]);
    });

    test.tags("mobile");
    test("mobile: a monetary sum field the server does not aggregate totals 0 without currency, online and from the offline cache", async () => {
        const errors = cachedReadErrors([
            // the offline reload, then New's leads and the types revalidated after it
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        // The server defines the sum field without aggregator: neither its sum nor its currencies
        // are read with the groups.
        onRpc("crm.lead", "get_views", ({ parent }) => {
            const result = parent();
            delete result.models["crm.lead"].fields.expected_revenue.aggregator;
            return result;
        });
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expect(groupOf(renderer, 1).aggregates.expected_revenue).toBe(undefined);
        expect(groupOf(renderer, 1).aggregates.company_currency).toBe(undefined);
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
        expect(".o_crm_mobile_pipeline_revenue").toHaveText("0");

        // Offline, the pipeline reloaded from the cache has no progress bar data: the cached
        // group aggregates hold neither, so the stage sums 0, with no currency.
        await setOffline(true);
        await renderer.props.list.load();
        await animationFrame();
        expect(renderer._stageAggregate(groupOf(renderer, 1))).toEqual({ value: 0 });
        expect(".o_crm_mobile_pipeline_count").toHaveText("2");
        expect(".o_crm_mobile_pipeline_revenue").toHaveText("0");
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: an offline move of a lead without revenue changes the stage counts only", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 2's activities, the types)
            ACTIVITIES,
            TYPES,
            // back on New: Lead 1's activities and the types
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.lead"].write([2], { expected_revenue: 0 });
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expectHeader("New", 2, 100);

        await setOffline(true);
        await chooseStage("Lead 2", 2);
        expect(renderer.isDisplaced(recordOf(renderer, 2))).toBe(true);
        expectHeader("Qualified", 2, 30);
        await goToStage("New");
        expectHeader("New", 1, 100);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: when the arch does not load stage_id, every card is placed by its framework group only", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline({ arch: PIPELINE_ARCH.replace('<field name="stage_id"/>', "") });
        const [renderer] = renderers;
        const lead1 = recordOf(renderer, 1);
        expect(lead1.activeFields.stage_id).toBe(undefined);
        expect(renderer._tracksStage(lead1)).toBe(false);
        expect(renderer.displayStage(lead1)).toBe(1);
        expect(renderer.isDisplaced(lead1)).toBe(false);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        await goToStage("Qualified");
        expectHeader("Qualified", 1, 30);
        expect(cardNames()).toEqual(["Lead 3"]);
    });

    test.tags("mobile");
    test("mobile: a parked move to a stage deleted on the server leaves the card in its server stage, still pending", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", () => {
            expect.step("replay rejected");
            throw makeServerError({ message: "The stage no longer exists" });
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        // Grouped by stage through a search facet: a stage that disappears is not kept.
        await getService("action").doAction(UNGROUPABLE_PIPELINE_ACTION_ID);
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;

        await setOffline(true);
        await chooseStage("Lead 1", 2);
        expectHeader("Qualified", 2, 130);
        // Meanwhile, Qualified is emptied and deleted on the server.
        MockServer.env["crm.lead"].write([3], { stage_id: 3 });
        MockServer.env["crm.stage"].unlink([2]);

        // Reconnect: the move is rejected and parked, then the pipeline is reloaded without
        // Qualified.
        await setOffline(false);
        await expect.waitForSteps(["replay rejected", LEAD_GROUPS]);
        await animationFrame();
        const [parked] = queued();
        expect(parked.value.args[1]).toEqual({ stage_id: 2 });
        expect(parked.value.extras.error).toMatch(/The stage no longer exists/);
        expect(renderer.props.list.groups.map((group) => group.serverValue)).toEqual([1, 3, 4]);
        // The parked write targets no stage of the pipeline: Lead 1 stays in its server stage,
        // with its pending badge, and no total is corrected.
        const lead1 = recordOf(renderer, 1);
        expect(lead1.serverStageId).toBe(1);
        expect(renderer.displayStage(lead1)).toBe(1);
        expect(renderer.isDisplaced(lead1)).toBe(false);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a card move the server rejects online is raised, and the card and the displayed stage stay", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", () => {
            expect.step("move rejected");
            throw makeServerError({ message: "This stage is locked" });
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;

        expect.errors(1);
        await chooseStage("Lead 1", 2);
        await animationFrame();
        expect.verifySteps(["move rejected"]);
        expect.verifyErrors(["This stage is locked"]);
        expect(recordOf(renderer, 1).group.serverValue).toBe(1);
        expect(renderer.stageState.serverValue).toBe(null);
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(queued()).toHaveLength(0);
        await contains(".modal .modal-footer .btn-primary").click();
        expect(".modal").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: the renderer used without the controller adapter keeps its own displayed stage", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        registry.category("views").add("crm_mobile_pipeline_renderer_only", {
            ...crmKanbanView,
            Renderer: CrmMobilePipeline,
        });
        const renderers = captureInstances(CrmMobilePipeline);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace(
                'js_class="crm_mobile_pipeline"',
                'js_class="crm_mobile_pipeline_renderer_only"'
            ),
        });
        const [renderer] = renderers;
        expect(controllers).toHaveLength(0);
        expect(renderer.env.crmMobileStage).toBe(undefined);
        expect(renderer.stageState.serverValue).toBe(null);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("New", 2, 120);
        await contains(".o_crm_mobile_pipeline_next").click();
        expect(renderer.stageState.serverValue).toBe(2);
        expectHeader("Qualified", 1, 30);

        // A quick create into another stage: no displayed stage is shared with the sheet, so the
        // renderer's own stays.
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Proposition lead", stage_id: "Proposition" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(renderer.stageState.serverValue).toBe(2);
        expectHeader("Qualified", 1, 30);
    });

    test.tags("mobile");
    test("mobile: New on a pipeline without the framework quick create uses the base creation", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const controllers = captureInstances(CrmMobilePipelineController);
        await mountPipeline({
            arch: PIPELINE_ARCH.replace(
                'archivable="false"',
                'archivable="false" quick_create="false"'
            ),
            createRecord: () => expect.step("createRecord"),
        });
        expect(controllers[0].isMobilePipeline).toBe(true);
        expect(controllers[0].canQuickCreate).toBe(false);
        await contains(".o-kanban-button-new").click();
        await animationFrame();
        expect.verifySteps(["createRecord"]);
        expect(".o_kanban_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: leads without a stage are displayed first, in a stage of their own", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.lead"].create({
            name: "Stageless lead",
            stage_id: false,
            expected_revenue: 5,
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect(renderer.stageGroups.map((group) => group.serverValue)).toEqual([false, 1, 2, 3, 4]);
        while (queryAll(".o_crm_mobile_pipeline_prev").length) {
            await contains(".o_crm_mobile_pipeline_prev").click();
        }
        // The no-stage group is stored as the `false` stage, which designates it.
        expect(renderer.stageState.serverValue).toBe(false);
        expect(renderer.currentIndex).toBe(0);
        expect(".o_crm_mobile_pipeline_count").toHaveText("1");
        expect(cardNames()).toEqual(["Stageless lead"]);
        const stageless = renderer.cardsFor(renderer.currentGroup)[0];
        expect(stageless.serverStageId).toBe(false);
        expect(renderer.displayStage(stageless)).toBe(false);
        await contains(".o_crm_mobile_pipeline_next").click();
        expectHeader("New", 2, 120);
    });

    test.tags("mobile");
    test("mobile: placement tolerates records the CRM model does not track and records without id, and activity answers in the records shape are applied", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // let the activity and type reads of the mount settle
        await animationFrame();
        const [renderer] = renderers;
        const qualified = groupOf(renderer, 2);

        // A record the CRM kanban model did not build carries no serverStageId: it is placed by
        // its framework group and never displaced.
        const untracked = {
            group: qualified,
            resId: 3,
            activeFields: { stage_id: {} },
            data: { stage_id: { id: 1 } },
        };
        expect(renderer._tracksStage(untracked)).toBe(false);
        expect(renderer.displayStage(untracked)).toBe(2);
        expect(renderer.isDisplaced(untracked)).toBe(false);
        // A record without id has no queued write to follow: its framework group.
        const idless = { ...untracked, resId: false, serverStageId: 1 };
        expect(renderer.displayStage(idless)).toBe(2);

        // Answers in the `{ records }` shape are applied; `null` keeps what is displayed.
        renderer._applyActivityTypes({ records: [{ id: 1, display_name: "Email" }] });
        renderer._applyActivities(1, {
            records: [
                {
                    id: 99,
                    activity_type_id: { id: 1, display_name: "Email" },
                    activity_category: "default",
                    summary: "Shaped answer",
                    date_deadline: "2030-01-10",
                    state: "planned",
                    user_id: { id: serverState.userId, display_name: "Mitchell Admin" },
                },
            ],
        });
        renderer._applyActivities(1, null);
        await animationFrame();
        expect(renderer.mobileState.activityTypes).toEqual([{ id: 1, display_name: "Email" }]);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_card_activities`).click();
        expect(`${cardOf("Lead 1")} .o_crm_mobile_activity_summary`).toHaveText("Shaped answer");
    });

    test.tags("mobile");
    test("mobile: reconnecting with nothing queued reloads the pipeline at once, before the sync window opens, and only once", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        watchRpcs([LEAD_GROUPS]);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);

        // A browser opens the framework sync window only once it grants the cross-tab "db-sync"
        // lock: in a later task, or once another tab has released it. Here the window opens only
        // when the test lets it.
        const offline = getService(OfflinePlugin);
        const heldSyncs = [];
        patchWithCleanup(offline, {
            _syncORM() {
                return new Promise((resolve) => {
                    heldSyncs.push(() => {
                        const run = super._syncORM();
                        resolve(run);
                        return run;
                    });
                });
            },
        });

        await setOffline(true);
        expect(queued()).toHaveLength(0);
        // Meanwhile, Lead 2 is renamed on the server.
        MockServer.env["crm.lead"].write([2], { name: "Lead 2 (renamed)" });

        // Back online with nothing queued: the pipeline reloads at once, while the sync window
        // has not opened yet.
        await setOffline(false);
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(heldSyncs).toHaveLength(1);
        expect(offline.syncingORM()).toBe(false);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2 (renamed)"]);

        // The empty sync window that follows opens and closes without reloading again.
        const sync = heldSyncs[0]();
        expect(offline.syncingORM()).toBe(true);
        await animationFrame();
        await sync;
        await animationFrame();
        expect(offline.syncingORM()).toBe(false);
        expect.verifySteps([]);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2 (renamed)"]);
    });

    test.tags("mobile");
    test("mobile: a Load more the server rejects is raised, and the stage is idle again: its button enabled and not busy, and a second activation loads the next page", async () => {
        await makeMockServer();
        MockServer.env["crm.lead"].create({
            name: "Lead 6",
            stage_id: 1,
            team_id: 1,
            expected_revenue: 60,
        });
        mockActivityTypes(ACTIVITY_TYPES);
        let rejectLoad = true;
        onRpc("crm.lead", "web_search_read", () => {
            expect.step("next page read");
            if (rejectLoad) {
                throw makeServerError({ message: "The next page cannot be read" });
            }
        });
        patchWithCleanup(CrmMobilePipeline.prototype, {
            loadMore() {
                expect.step("loadMore");
                return super.loadMore(...arguments);
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        // One lead per stage page: New holds three leads, two of them left to load.
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" limit="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const newStage = groupOf(renderer, 1);
        const loadMore = ".o_crm_mobile_pipeline_load_more button";
        expect(cardNames()).toEqual(["Lead 1"]);
        expect(loadMore).toHaveText("Load more... (2 remaining)");

        // The server rejects the next page: the error is raised, unlike a lost connection...
        expect.errors(1);
        await contains(loadMore).click();
        await animationFrame();
        expect.verifySteps(["loadMore", "next page read"]);
        expect.verifyErrors(["The next page cannot be read"]);
        // ...and the stage is idle again: no spinner, not busy, enabled, nothing more shown.
        expect(renderer.isLoadingMore(newStage)).toBe(false);
        expect(loadMore).toHaveAttribute("aria-busy", "false");
        expect(loadMore).not.toHaveAttribute("disabled");
        expect(`${loadMore} .oi-spin`).toHaveCount(0);
        expect(loadMore).toHaveText("Load more... (2 remaining)");
        expect(cardNames()).toEqual(["Lead 1"]);
        expectHeader("New", 3, 180);
        await contains(".modal .modal-footer .btn-primary").click();
        expect(".modal").toHaveCount(0);

        // A second activation loads the next page.
        rejectLoad = false;
        await contains(loadMore).click();
        await animationFrame();
        expect.verifySteps(["loadMore", "next page read"]);
        expect(renderer.isLoadingMore(newStage)).toBe(false);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(loadMore).toHaveText("Load more... (1 remaining)");
        expect(loadMore).toHaveAttribute("aria-busy", "false");
        expect(loadMore).not.toHaveAttribute("disabled");
    });

    test.tags("mobile");
    test("mobile: the uncached lead helper requested outside the stage pipeline waits for it: a patch that does not render the helper keeps the focus request, the one that renders it focuses Back", async () => {
        const errors = cachedReadErrors([
            // the offline reload while regrouped by salesperson
            LEAD_GROUPS,
            // the stage pipeline restored offline: its groups, New's two leads and the types
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // Qualified displayed (Lead 3's activities were never read, so they are not cached
            // and raise nothing): the types
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // Lead 1's form was visited online, Lead 2's was not.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline(actionId, viewType, resId) {
                if (viewType === "form") {
                    return resId === 1;
                }
                return actionId === PIPELINE_ACTION_ID;
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        // Online, regrouped by salesperson: the standard kanban renderer, which has no helper.
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        expect(renderer.isMobilePipeline).toBe(false);
        await setOffline(true);

        // Offline, the uncached Lead 2 is opened through the card handler (only the stage
        // pipeline renders its card), then a reload patches the standard renderer: no helper,
        // no focus move, and the focus request is kept for the patch that renders the helper.
        const focused = document.activeElement;
        renderer.onCardOpen(recordOf(renderer, 2));
        expect(renderer.helperFocus).toEqual({ resId: 2, focus: "back" });
        await renderer.props.list.load();
        await animationFrame();
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_back").toHaveCount(0);
        expect(renderer.mobileState.unavailableLeadId).toBe(2);
        expect(renderer.helperFocus).toEqual({ resId: 2, focus: "back" });
        expect(document.activeElement).toBe(focused);

        // Back to the stage pipeline through the offline search bar (the search visited first):
        // the patch that renders the helper focuses Back and consumes the request.
        await contains(".o_offline_search_bar .o_searchview_facet [data-icon='close']").click();
        await animationFrame();
        expect(renderers).toHaveLength(1);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("New", 2, 120);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(1);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_back").toBeFocused();
        expect(renderer.helperFocus).toEqual({ resId: 2, focus: null });

        // Next, holding the focus while the helper shows, leaves the helper: the request ends and
        // the focus stays on Next.
        queryOne(".o_crm_mobile_pipeline_next").focus();
        await contains(".o_crm_mobile_pipeline_next").click();
        await animationFrame();
        expectHeader("Qualified", 1, 30);
        expect(".o_crm_mobile_pipeline_back").toHaveCount(0);
        expect(renderer.helperFocus).toBe(null);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: the uncached lead helper left outside the stage pipeline moves no focus", async () => {
        // the offline reload while regrouped by salesperson
        const errors = cachedReadErrors([LEAD_GROUPS]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // No lead form was visited online.
        patchWithCleanup(OfflinePlugin.prototype, {
            isAvailableOffline(actionId, viewType) {
                return viewType !== "form" && actionId === PIPELINE_ACTION_ID;
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        await toggleSearchBarMenu();
        await toggleMenuItem("Salesperson");
        await toggleSearchBarMenu();
        expect(renderer.isMobilePipeline).toBe(false);
        await setOffline(true);
        const searchInput = queryOne(".o_offline_search_bar input");
        searchInput.focus();

        // The helper of the uncached Lead 2 is requested then left through the card and Back
        // handlers, which only the stage pipeline renders.
        renderer.onCardOpen(recordOf(renderer, 2));
        renderer.onBackFromHelper();
        expect(renderer.mobileState.unavailableLeadId).toBe(null);
        expect(renderer.helperFocus).toEqual({ resId: 2, focus: "return" });
        // The next patch (an offline reload) ends the request and focuses no kanban control.
        await renderer.props.list.load();
        await animationFrame();
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(renderer.helperFocus).toBe(null);
        expect(searchInput).toBeFocused();
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: after the helper, a pipeline whose header has no control focuses its first control, and a destroyed pipeline focuses nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        // A single stage (New, through the domain) and no create right: no previous, next or Add.
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" create="0"'),
            domain: [["stage_id", "=", 1]],
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(".o_crm_mobile_pipeline_header button").toHaveCount(0);

        // The focus that follows the helper, called directly (a tapped lead stays displayed in a
        // single stage while its helper shows), goes to the lead's card when it is displayed (its
        // open button)...
        renderer._focusAfterHelper(2);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_open`).toBeFocused();
        // ...else, the header having no control, to the first control of the pipeline: the open
        // button of its first card, never the document body.
        renderer._focusAfterHelper(3);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_open`).toBeFocused();

        // A destroyed pipeline has no root any more: nothing is focused.
        destroyApp();
        expect(status(renderer)).toBe("destroyed");
        expect(renderer.rootRef()).toBe(null);
        const focused = document.activeElement;
        renderer._focusAfterHelper(1);
        expect(document.activeElement).toBe(focused);
    });

    test.tags("mobile");
    test("mobile: the Load more handlers ignore an absent stage, and the Back handler without a displayed helper requests no focus", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        watchRpcs(["crm.lead/web_search_read"]);
        const renderers = captureInstances(CrmMobilePipeline);
        // One lead per stage page: New has a Load more.
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" limit="1"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const loadMore = ".o_crm_mobile_pipeline_load_more button";
        expect(cardNames()).toEqual(["Lead 1"]);

        // Without a stage, nothing is loading and nothing is loaded.
        expect(renderer.isLoadingMore(undefined)).toBe(false);
        await renderer.onLoadMoreClick(undefined);
        await animationFrame();
        expect.verifySteps([]);
        expect(renderer.loadingMoreGroups).toEqual({});
        expect(cardNames()).toEqual(["Lead 1"]);
        expect(loadMore).toHaveText("Load more... (1 remaining)");
        expect(loadMore).toHaveAttribute("aria-busy", "false");

        // The Back handler without a displayed helper requests no focus move: the next patch (a
        // stage navigation by Next, which holds the focus) leaves the focus on Next.
        queryOne(".o_crm_mobile_pipeline_next").focus();
        renderer.onBackFromHelper();
        expect(renderer.mobileState.unavailableLeadId).toBe(null);
        expect(renderer.helperFocus).toBe(null);
        await contains(".o_crm_mobile_pipeline_next").click();
        await animationFrame();
        expectHeader("Qualified", 1, 30);
        expect(renderer.helperFocus).toBe(null);
        expect(".o_crm_mobile_pipeline_next").toBeFocused();
    });

    test.tags("mobile");
    test("mobile: a focused navigation button removed because the screen is no longer small moves no focus into the standard renderer", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expectHeader("New", 2, 120);
        queryOne(".o_crm_mobile_pipeline_next").focus();
        expect(".o_crm_mobile_pipeline_next").toBeFocused();

        // The screen widens past the small-screen breakpoint (a tablet turned to landscape) while
        // Next holds the focus: the standard renderer replaces the stage pipeline, Next included.
        await resize({ width: 1024 });
        await animationFrame();
        expect(renderer.isMobilePipeline).toBe(false);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        expect(".o_kanban_renderer .o_kanban_group").toHaveCount(4);
        expect(".o_kanban_renderer .o_kanban_record").toHaveCount(5);
        // The root is the standard renderer's, which holds controls that can take the focus: none
        // is focused, and the focus stays where the browser left it, on the document body.
        expect(renderer.rootRef()).toBe(queryOne(".o_kanban_renderer"));
        expect(getTabableElements(renderer.rootRef()).length).toBeGreaterThan(0);
        expect(document.activeElement).toBe(document.body);

        // Small again: the stage pipeline is back on the same stage, and no focus is moved.
        await resize({ width: 375 });
        await animationFrame();
        expect(renderer.isMobilePipeline).toBe(true);
        expectHeader("New", 2, 120);
        expect(document.activeElement).toBe(document.body);
    });

    test.tags("mobile");
    test("mobile: a focused navigation button removed by a reload that leaves a header without control hands the focus to the first control of the pipeline", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        // No create right: no Add, so the header controls are the navigation buttons only.
        await mountPipeline({
            arch: PIPELINE_ARCH.replace('archivable="false"', 'archivable="false" create="0"'),
        });
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        expectHeader("New", 2, 120);
        expect(".o_crm_mobile_pipeline_header button").toHaveCount(1);
        queryOne(".o_crm_mobile_pipeline_next").focus();

        // The "Lead One" filter is applied through the search model while Next holds the focus:
        // the reload with its domain leaves New as the only stage (a reload with the same domain
        // would keep the emptied stages), so the header loses its last control.
        const { searchModel } = renderer.env;
        const leadOne = Object.values(searchModel.searchItems).find(
            ({ name }) => name === "lead_one"
        );
        searchModel.toggleSearchItem(leadOne.id);
        await animationFrame();
        await animationFrame();
        expect(renderer.props.list.groups).toHaveLength(1);
        expectHeader("New", 1, 100);
        expect(cardNames()).toEqual(["Lead 1"]);
        expect(".o_crm_mobile_pipeline_header button").toHaveCount(0);
        // The focus goes to the first control of the pipeline, the open button of its first card,
        // never to the document body.
        expect(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_open`).toBeFocused();
    });

    /**
     * Holds the answer of every `crm.lead` `web_save` until `release()`. Each call steps
     * `"web_save <name>"`, then goes on to the mock server once released.
     *
     * @returns {{ release: () => void }}
     */
    function holdLeadCreates() {
        let held = Promise.withResolvers();
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`web_save ${args[1].name}`);
            await held.promise;
        });
        return {
            release() {
                held.resolve();
                held = Promise.withResolvers();
            },
        };
    }

    /**
     * Saves a lead (revenue 5) through the mobile quick create of the displayed stage, then
     * dismisses the sheet (Escape: Discard is disabled while the save runs) while its `web_save`
     * is held (see `holdLeadCreates`).
     *
     * @param {string} name
     * @param {string} [stageName] the stage chosen in the sheet (the displayed one by default)
     */
    async function saveThenDismiss(name, stageName) {
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({
            name,
            expected_revenue: "5",
            ...(stageName ? { stage_id: stageName } : {}),
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        await expect.waitForSteps([`web_save ${name}`]);
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
    }

    /** Steps `"validateQuickCreate <id>"` for every lead the pipeline adds to a stage. */
    function watchAddedLeads() {
        patchWithCleanup(CrmMobilePipeline.prototype, {
            validateQuickCreate(recordId) {
                expect.step(`validateQuickCreate ${recordId}`);
                return super.validateQuickCreate(...arguments);
            },
        });
    }

    test.tags("mobile");
    test("mobile: the reload that replaces adding a lead created online whose stage is no longer listed raises a server rejection, and the sheet stays closed", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadCreates();
        let rejectReload = false;
        onRpc("crm.lead", "web_read_group", () => {
            if (rejectReload) {
                throw makeServerError({ message: "The pipeline cannot be reloaded" });
            }
        });
        watchRpcs([LEAD_GROUPS]);
        watchAddedLeads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const stageValues = () => renderer.props.list.groups.map((group) => group.serverValue);
        expect.verifySteps([LEAD_GROUPS]);

        await saveThenDismiss("Unlisted lead", "Qualified");
        // While the call runs, a reload with a domain that leaves Qualified empty drops its group.
        await renderer.props.list.load({ domain: [["name", "!=", "Lead 3"]] });
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(stageValues()).toEqual([1, 3, 4]);

        // The lead is created in a stage no live group holds: the pipeline is reloaded instead,
        // and the server rejects that reload. The rejection is raised, nothing is added.
        rejectReload = true;
        expect.errors(1);
        saves.release();
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect.verifyErrors(["The pipeline cannot be reloaded"]);
        expect(serverLeads("Unlisted lead")).toHaveLength(1);
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(stageValues()).toEqual([1, 3, 4]);
        expectHeader("New", 2, 120);
        await contains(".modal .modal-footer .btn-primary").click();
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: the reload that replaces adding a lead created online whose stage is no longer listed, when it loses the connection, leaves the pipeline as it is, tells the user the lead was saved, and the next load shows the lead", async () => {
        // the connection lost during the reload: New's two leads and the types, read again
        // offline and answered by the cache
        const errors = cachedReadErrors([ACTIVITIES, ACTIVITIES, TYPES]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const saves = holdLeadCreates();
        let dropReload = false;
        onRpc("/web/dataset/call_kw/crm.lead/web_read_group", () => {
            if (dropReload) {
                // The connection drops while the pipeline reloads.
                dropReload = false;
                setOffline(true);
                return new Response("", { status: 502 });
            }
        });
        watchRpcs([LEAD_GROUPS]);
        watchAddedLeads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const stageValues = () => renderer.props.list.groups.map((group) => group.serverValue);
        expect.verifySteps([LEAD_GROUPS]);

        await saveThenDismiss("Unlisted lead", "Qualified");
        await renderer.props.list.load({ domain: [["name", "!=", "Lead 3"]] });
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(stageValues()).toEqual([1, 3, 4]);

        // The lead is created; the reload made instead of adding it loses the connection: no
        // error, nothing added or queued, the pipeline as it was.
        dropReload = true;
        saves.release();
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(getService(OfflinePlugin).isOffline()).toBe(true);
        expect(serverLeads("Unlisted lead")).toHaveLength(1);
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(stageValues()).toEqual([1, 3, 4]);
        expectHeader("New", 2, 120);
        // The lead it could not show is not silently lost: the user is told it was saved, also
        // though the sheet was dismissed during the call.
        expect(".o_notification").toHaveCount(1);
        expect(".o_notification .o_notification_content").toHaveText(
            '"Unlisted lead" was saved. It will show in the pipeline once the connection is back.'
        );

        // Back online with nothing queued: the reconciliation reload lists Qualified again, with
        // the lead created.
        await setOffline(false);
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(stageValues()).toEqual([1, 2, 3, 4]);
        await goToStage("Qualified");
        expect(cardNames()).toEqual(["Unlisted lead"]);
        expectHeader("Qualified", 1, 5);
        expect.verifySteps([]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a queued lead create saved again under its key with another name is not announced, its end is announced with that name, and a destroyed pipeline announces nothing", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const offline = getService(OfflinePlugin);
        const pipelineStatus = ".o_crm_mobile_pipeline > .o_crm_mobile_pipeline_status";
        const announcementNode = () => queryFirst(`${pipelineStatus} > div`);
        expect(queryOne(pipelineStatus).textContent).toBe("");

        // A lead create is queued in New: its pending card shows, the pipeline announces it.
        const key = queueLeadSave([], { name: "First name", stage_id: 1, expected_revenue: 10 });
        await animationFrame();
        expect(pendingCardNames()).toEqual(["First name"]);
        expect(pipelineStatus).toHaveText("First name: new lead pending sync.");
        const createNode = announcementNode();
        const createAnnouncement = { ...renderer.mobileState.announcement };

        // The same create saved again under its key with another name, as the framework coalesces
        // the offline saves of one record into its entry: no create appeared or left, so nothing
        // is announced, and the card shows the new name.
        const [entry] = queued();
        offline.scheduleORM(
            "crm.lead",
            "web_save",
            [[], { ...entry.value.args[1], name: "Second name" }],
            entry.value.kwargs,
            { id: key, extras: entry.value.extras }
        );
        await animationFrame();
        expect(queued().map((queuedEntry) => queuedEntry.key)).toEqual([key]);
        expect(pendingCardNames()).toEqual(["Second name"]);
        expect(renderer.mobileState.announcement).toEqual(createAnnouncement);
        expect(announcementNode()).toBe(createNode);
        expect(pipelineStatus).toHaveText("First name: new lead pending sync.");

        // The systray's discard ends it: announced with the name it was last compared with.
        offline.removeScheduledORM(key);
        await animationFrame();
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(pipelineStatus).toHaveText("Second name: new lead no longer pending sync.");
        expect(renderer.mobileState.announcement.sequence).toBe(createAnnouncement.sequence + 1);

        // A destroyed pipeline announces nothing (a direct call: no flow announces once it is
        // destroyed).
        const lastAnnouncement = { ...renderer.mobileState.announcement };
        destroyApp();
        expect(status(renderer)).toBe("destroyed");
        renderer._announce(["Lead 1: changes pending sync."]);
        expect(renderer.mobileState.announcement).toEqual(lastAnnouncement);
    });

    test.tags("mobile");
    test("mobile: the Stage focus a keyboard stage move requests is dropped when a reload removed the card, when the standard renderer replaced the pipeline, and once the pipeline is destroyed", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        // Once held, the framework move is made at once and its answer reaches the pipeline on
        // release.
        let holdMove = false;
        let moveReleased = Promise.withResolvers();
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            async moveRecords() {
                const result = await super.moveRecords(...arguments);
                if (holdMove) {
                    holdMove = false;
                    expect.step("moved");
                    await moveReleased.promise;
                }
                return result;
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const stageOption = (name, stageId) =>
            `${cardOf(name)} .o_crm_mobile_stage_option[data-stage-value='${stageId}']`;

        /**
         * Opens the lead's stage list from its focused Stage button, moves to the stage's option
         * with ArrowDown and chooses it with Enter: the move starts with the focus in the card,
         * and is held.
         */
        const chooseStageByKeyboard = async (name, stageId) => {
            queryOne(`${cardOf(name)} .o_crm_mobile_card_stage`).focus();
            await press("Enter");
            await animationFrame();
            const option = () => queryOne(stageOption(name, stageId));
            for (let guard = 0; guard < 4 && document.activeElement !== option(); guard++) {
                await press("ArrowDown");
            }
            expect(stageOption(name, stageId)).toBeFocused();
            holdMove = true;
            moveReleased = Promise.withResolvers();
            await press("Enter");
            await expect.waitForSteps(["moved"]);
        };

        // Lead 1 is moved from New to Qualified; while its answer is pending, a reload with a
        // domain that excludes Lead 1 rebuilds the groups.
        expectHeader("New", 2, 120);
        await chooseStageByKeyboard("Lead 1", 2);
        await renderer.props.list.load({ domain: [["name", "!=", "Lead 1"]] });
        await animationFrame();
        const focusedAfterReload = document.activeElement;
        // The move lands: Qualified is displayed, but no card of Lead 1 is rendered there, so the
        // requested focus is dropped and the focus stays where it is.
        moveReleased.resolve();
        await animationFrame();
        expect(renderer.stageState.serverValue).toBe(2);
        expectHeader("Qualified", 1, 30);
        expect(cardNames()).toEqual(["Lead 3"]);
        expect(renderer.pendingFocus).toBe(null);
        expect(document.activeElement).toBe(focusedAfterReload);

        // Lead 3 is moved from Qualified to Proposition; while its answer is pending, the screen
        // widens past the small-screen breakpoint: the standard renderer replaces the pipeline.
        await chooseStageByKeyboard("Lead 3", 3);
        await resize({ width: 1024 });
        await animationFrame();
        expect(renderer.isMobilePipeline).toBe(false);
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
        moveReleased.resolve();
        await animationFrame();
        // The focus request outlives the move; the next patch of the standard renderer (a
        // reload) drops it, and the focus stays where it is.
        const focusedWhileWide = document.activeElement;
        await renderer.props.list.load();
        await animationFrame();
        expect(".o_kanban_renderer .o_kanban_group").toHaveCount(4);
        expect(renderer.pendingFocus).toBe(null);
        expect(document.activeElement).toBe(focusedWhileWide);
        // Small again: Proposition is displayed with the moved lead, and no focus is moved.
        await resize({ width: 375 });
        await animationFrame();
        expect(renderer.isMobilePipeline).toBe(true);
        expectHeader("Proposition", 2, 70);
        expect(`${cardOf("Lead 3")} .o_crm_mobile_card_stage`).not.toBeFocused();
        expect(document.activeElement).toBe(focusedWhileWide);

        // A destroyed pipeline has no root: a request is dropped and nothing is focused (a direct
        // call: no move requests a focus once the pipeline is destroyed).
        destroyApp();
        expect(renderer.rootRef()).toBe(null);
        const focused = document.activeElement;
        renderer.pendingFocus = { leadId: 3, control: "stage" };
        renderer._applyPendingFocus();
        expect(renderer.pendingFocus).toBe(null);
        expect(document.activeElement).toBe(focused);
    });

    test.tags("mobile");
    test("mobile: a lead created online once the pipeline is regrouped by salesperson, or destroyed, is not added and nothing is reloaded for it; grouped by stage again, the load shows it", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadCreates();
        watchRpcs([LEAD_GROUPS]);
        watchAddedLeads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);

        // Regrouped by salesperson while the call runs: the standard renderer is displayed when
        // the lead is created, so nothing is added and nothing is reloaded.
        await saveThenDismiss("Regrouped lead");
        await toggleSalespersonGrouping();
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.isMobilePipeline).toBe(false);
        saves.release();
        await animationFrame();
        expect(serverLeads("Regrouped lead")).toHaveLength(1);
        expect.verifySteps([]);
        // Grouped by stage again: the load shows the lead in New.
        await toggleSalespersonGrouping();
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.isMobilePipeline).toBe(true);
        expectHeader("New", 3, 125);
        expect(cardOf("Regrouped lead")).toHaveCount(1);

        // Destroyed while the call runs: nothing is added, reloaded or raised.
        await saveThenDismiss("Destroyed lead");
        destroyApp();
        expect(status(renderer)).toBe("destroyed");
        saves.release();
        await animationFrame();
        expect(serverLeads("Destroyed lead")).toHaveLength(1);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a lead created online while a pipeline reload holds the model is not added when the pipeline is regrouped by salesperson, or destroyed, before that reload ends", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const saves = holdLeadCreates();
        // Once held, a pipeline reload keeps the model mutex locked after its answer, until it
        // is released.
        let holdReload = false;
        let reloadReleased = Promise.withResolvers();
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            async _load() {
                const result = await super._load(...arguments);
                if (holdReload) {
                    holdReload = false;
                    expect.step("reloaded");
                    await reloadReleased.promise;
                }
                return result;
            },
        });
        watchRpcs([LEAD_GROUPS]);
        watchAddedLeads();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);

        /** Creates a lead while a reload of the pipeline is held: the pipeline waits for it. */
        const createDuringReload = async (name) => {
            await saveThenDismiss(name);
            holdReload = true;
            reloadReleased = Promise.withResolvers();
            renderer.props.list.load();
            await expect.waitForSteps([LEAD_GROUPS, "reloaded"]);
            saves.release();
            await animationFrame();
            expect(serverLeads(name)).toHaveLength(1);
            expect.verifySteps([]);
        };

        // Regrouped by salesperson before the reload ends: nothing is added.
        await createDuringReload("Regrouped lead");
        await toggleSalespersonGrouping();
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.isMobilePipeline).toBe(false);
        reloadReleased.resolve();
        await animationFrame();
        expect.verifySteps([]);
        // Grouped by stage again: the load shows the lead in New.
        await toggleSalespersonGrouping();
        expect.verifySteps([LEAD_GROUPS]);
        expectHeader("New", 3, 125);
        expect(cardOf("Regrouped lead")).toHaveCount(1);

        // Destroyed before the reload ends: nothing is added, reloaded or raised.
        await createDuringReload("Destroyed lead");
        destroyApp();
        expect(status(renderer)).toBe("destroyed");
        reloadReleased.resolve();
        await animationFrame();
        expect(serverLeads("Destroyed lead")).toHaveLength(1);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: a pipeline regrouped by salesperson, or destroyed, while the lead created online is being added to its stage reloads nothing more", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`web_save ${args[1].name}`);
        });
        watchRpcs([LEAD_GROUPS]);
        // Adding the created lead completes at once; its end reaches the pipeline on release.
        let addReleased = Promise.withResolvers();
        patchWithCleanup(CrmMobilePipeline.prototype, {
            async validateQuickCreate(recordId, mode, group) {
                await super.validateQuickCreate(...arguments);
                expect.step(`added to ${group.serverValue}`);
                await addReleased.promise;
            },
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        expect.verifySteps([LEAD_GROUPS]);

        /** Creates a lead online in New and closes its sheet while the lead is being added. */
        const createWhileAdding = async (name) => {
            addReleased = Promise.withResolvers();
            await contains(".o_crm_mobile_pipeline_add").click();
            await fillQuickCreate({ name, expected_revenue: "5" });
            await contains(".o_crm_mobile_quick_create_save").click();
            await expect.waitForSteps([`web_save ${name}`, "added to 1"]);
            expect(serverLeads(name)).toHaveLength(1);
            await press("Escape");
            await animationFrame();
            expect(".o_crm_mobile_quick_create").toHaveCount(0);
        };

        // Regrouped by salesperson before the addition ends: the stage pipeline is no longer
        // displayed, so nothing is reloaded.
        await createWhileAdding("Regrouped lead");
        expect(cardOf("Regrouped lead")).toHaveCount(1);
        await toggleSalespersonGrouping();
        expect.verifySteps([LEAD_GROUPS]);
        expect(renderer.isMobilePipeline).toBe(false);
        addReleased.resolve();
        await animationFrame();
        expect.verifySteps([]);
        await toggleSalespersonGrouping();
        expect.verifySteps([LEAD_GROUPS]);
        expectHeader("New", 3, 125);
        expect(cardOf("Regrouped lead")).toHaveCount(1);

        // Destroyed before the addition ends: nothing is reloaded or raised.
        await createWhileAdding("Destroyed lead");
        destroyApp();
        expect(status(renderer)).toBe("destroyed");
        addReleased.resolve();
        await animationFrame();
        expect(serverLeads("Destroyed lead")).toHaveLength(1);
        expect.verifySteps([]);
    });
});

// -----------------------------------------------------------------------------
// Mobile pipeline status region
// -----------------------------------------------------------------------------

describe("Mobile pipeline status region", () => {
    /** The pipeline's status region: a direct child of the mobile root. */
    const PIPELINE_STATUS = ".o_crm_mobile_pipeline > .o_crm_mobile_pipeline_status";

    /** @returns {HTMLElement | null} the node of the pipeline's current announcement */
    function announcementNode() {
        return queryFirst(`${PIPELINE_STATUS} > div`);
    }

    /**
     * @param {string} name the lead name
     * @returns {string} selector of the status region of the mobile card showing that lead
     */
    function cardStatusOf(name) {
        return `${cardOf(name)} .o_crm_mobile_lead_card_status`;
    }

    /**
     * Queues a lead create through the open mobile quick create, offline.
     *
     * @param {string} name
     * @param {string} [stageName] the stage chosen in the sheet (the displayed one by default)
     * @returns {Promise<string | number>} the queue key of the create
     */
    async function queueQuickCreate(name, stageName) {
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({
            name,
            expected_revenue: "10",
            ...(stageName ? { stage_id: stageName } : {}),
        });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        return queued().find(({ value }) => value.args[1].name === name).key;
    }

    test.tags("mobile");
    test("mobile: pipeline status region is one stable polite region, silent at mount and after a remount with writes already queued", async () => {
        const errors = cachedReadErrors([
            // Lead 1's form offline, then the pipeline rebuilt from the cache with New's leads
            // (both visited online) and the types
            "crm.lead/web_read",
            LEAD_GROUPS,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        // Online: the pipeline and Lead 1's form are visited, hence available offline.
        await getService("action").doAction(PIPELINE_ACTION_ID);
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_back_button").click();

        /** One polite, atomic, visually hidden region on the mobile root, outside every control. */
        const expectSilentRegion = () => {
            const regions = queryAll(".o_crm_mobile_pipeline_status");
            expect(regions).toHaveLength(1);
            const [region] = regions;
            expect(region.parentElement).toHaveClass("o_crm_mobile_pipeline");
            expect(region).toHaveAttribute("role", "status");
            expect(region).toHaveAttribute("aria-live", "polite");
            expect(region).toHaveAttribute("aria-atomic", "true");
            expect(region).toHaveClass("visually-hidden");
            expect(
                region.closest(
                    "button, .o_crm_mobile_pipeline_header, .o_kanban_group, .o_kanban_record"
                )
            ).toBe(null);
            expect(region.textContent).toBe("");
            // The pipeline itself and its stage body are no live regions.
            const root = queryOne(".o_crm_mobile_pipeline");
            expect(root).not.toHaveAttribute("aria-live");
            expect(root).not.toHaveAttribute("role");
            expect(".o_crm_mobile_pipeline_body[aria-live]").toHaveCount(0);
        };
        expectSilentRegion();

        // Offline: a lead create and an in-place write of Lead 2 are queued. The create is
        // announced by the pipeline; the write of a card that stays mounted by that card only.
        await setOffline(true);
        await visitedReady();
        await queueQuickCreate("Queued lead");
        expect(PIPELINE_STATUS).toHaveText("Queued lead: new lead pending sync.");
        // The hidden message never matches the card selectors of the main flow.
        expect(".o_kanban_group .o_kanban_record span:contains(Queued lead)").toHaveCount(1);
        const createNode = announcementNode();
        await advanceTime(1000);
        await recordOf(renderers.at(-1), 2).update({ contact_name: "Monica Geller" });
        await animationFrame();
        expect(cardStatusOf("Lead 2")).toHaveText("Lead 2: changes pending sync.");
        expect(announcementNode()).toBe(createNode);
        expect(queued()).toHaveLength(2);

        // Lead form, then back: a new pipeline mounts with both writes already queued, and
        // announces neither; nor do its cards.
        await contains(`${cardOf("Lead 1")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_back_button").click();
        await animationFrame();
        // three pipelines: the first visit, the online back, and this offline back
        expect(renderers).toHaveLength(3);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expectSilentRegion();
        for (const region of queryAll(".o_crm_mobile_lead_card_status")) {
            expect(region.textContent).toBe("");
        }
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: pipeline status region announces a card stage move that leaves the lead pending sync, mark-won included; an online move or a move of a lead already pending announces nothing", async () => {
        const errors = cachedReadErrors([
            // mark-won of Lead 2 displays Won (Lead 2's activities, the types; Lead 5's were
            // never read)
            ACTIVITIES,
            TYPES,
            // Lead 2's move displays Qualified (Lead 2's activities, the types; Lead 3's were
            // never read)
            ACTIVITIES,
            TYPES,
            // Lead 3's move displays Proposition (Lead 4's activities, the types)
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect(PIPELINE_STATUS).toHaveCount(1);
        expect(queryOne(PIPELINE_STATUS).textContent).toBe("");

        // Online: the move is saved at once, nothing is pending; the stage title tells the stage.
        await chooseStage("Lead 2", 3);
        expectHeader("Proposition", 2, 60);
        expect(queued()).toHaveLength(0);
        expect(queryOne(PIPELINE_STATUS).textContent).toBe("");

        // Offline mark-won: the moved card is a new card in Won, showing its badge, whose own
        // region stays silent; the pipeline announces the pending write.
        await setOffline(true);
        await chooseStage("Lead 2", 4);
        expectHeader("Won", 2, 70);
        expect(queuedCalls("crm.lead", "web_save").map(({ args }) => args)).toEqual([
            [[2], { stage_id: 4 }],
        ]);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(queryOne(cardStatusOf("Lead 2")).textContent).toBe("");
        expect(PIPELINE_STATUS).toHaveText("Lead 2: changes pending sync.");
        const markWonNode = announcementNode();

        // The same lead, already pending, moved again: nothing new to announce.
        await chooseStage("Lead 2", 2);
        expectHeader("Qualified", 2, 50);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(announcementNode()).toBe(markWonNode);

        // Another lead's offline move, from the keyboard (Stage, then the stage list's next
        // enabled option, then Enter): announced in a new node.
        const lead3Option = (stageId) =>
            `${cardOf("Lead 3")} .o_crm_mobile_stage_option[data-stage-value='${stageId}']`;
        queryOne(`${cardOf("Lead 3")} .o_crm_mobile_card_stage`).focus();
        await press("Enter");
        await animationFrame();
        expect(lead3Option(1)).toBeFocused();
        await press("ArrowDown");
        expect(lead3Option(3)).toBeFocused();
        await press("Enter");
        await animationFrame();
        expectHeader("Proposition", 2, 70);
        expect(`${cardOf("Lead 3")} .o_crm_mobile_card_stage`).toBeFocused();
        expect(`${cardOf("Lead 3")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(queryOne(cardStatusOf("Lead 3")).textContent).toBe("");
        expect(PIPELINE_STATUS).toHaveText("Lead 3: changes pending sync.");
        expect(announcementNode()).not.toBe(markWonNode);
        expect(queued()).toHaveLength(2);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: pipeline status region announces a queued lead create, and its end after a systray discard and as its replay happens", async () => {
        // offline, Qualified is displayed: the types are cached (Lead 3's activities are not)
        const errors = cachedReadErrors([TYPES]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const replays = [];
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`replay ${args[1].name}`);
            const deferred = Promise.withResolvers();
            replays.push(deferred);
            await deferred.promise;
        });
        watchRpcs([LEAD_GROUPS]);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        await setOffline(true);

        // A create in another stage than the displayed one: that stage is displayed with the
        // pending card, which stays silent; the pipeline announces the create.
        const firstKey = await queueQuickCreate("Mobile lead", "Qualified");
        expectHeader("Qualified", 2, 40);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expect(
            queryOne(
                `.o_crm_mobile_lead_card[data-pending-key='${firstKey}'] .o_crm_mobile_lead_card_status`
            ).textContent
        ).toBe("");
        expect(PIPELINE_STATUS).toHaveText("Mobile lead: new lead pending sync.");
        const firstNode = announcementNode();
        await advanceTime(1000);

        // A create in the displayed stage: its pending card appears, silent; the pipeline
        // announces it in a new node.
        const secondKey = await queueQuickCreate("Second lead");
        expect(`.o_crm_mobile_lead_card[data-pending-key='${secondKey}']`).toHaveCount(1);
        expect(
            queryOne(
                `.o_crm_mobile_lead_card[data-pending-key='${secondKey}'] .o_crm_mobile_lead_card_status`
            ).textContent
        ).toBe("");
        expect(PIPELINE_STATUS).toHaveText("Second lead: new lead pending sync.");
        expect(announcementNode()).not.toBe(firstNode);

        // The systray's discard removes the entry: its card leaves, the pipeline tells it.
        getService(OfflinePlugin).removeScheduledORM(secondKey);
        await animationFrame();
        expect(`.o_crm_mobile_lead_card[data-pending-key='${secondKey}']`).toHaveCount(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expect(PIPELINE_STATUS).toHaveText("Second lead: new lead no longer pending sync.");
        const discardNode = announcementNode();
        expect(queued()).toHaveLength(1);

        // Reconnect: the sync re-reads the queue from its storage (new entries, same keys), which
        // announces nothing while the replay is in flight.
        await setOffline(false);
        await expect.waitForSteps(["replay Mobile lead"]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(queued()).toHaveLength(1);
        expect(announcementNode()).toBe(discardNode);
        // The replay succeeds: the entry leaves the live queue and is announced at once.
        replays.shift().resolve();
        await waitUntil(() => queued().length === 0);
        await animationFrame();
        expect(PIPELINE_STATUS).toHaveText("Mobile lead: new lead no longer pending sync.");
        const replayNode = announcementNode();
        // The reconciliation reload lands; the server card replaces the pending one, with no
        // other announcement.
        await expect.waitForSteps([LEAD_GROUPS]);
        await animationFrame();
        expect(announcementNode()).toBe(replayNode);
        expect(".o_crm_mobile_pipeline_stage_name").toHaveText("Qualified");
        expect(cardNames()).toEqual(["Lead 3", "Mobile lead"]);
        expect(`${cardOf("Mobile lead")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(announcementNode()).toBe(replayNode);
        const created = MockServer.env["crm.lead"].search_read([["name", "=", "Mobile lead"]]);
        expect(created).toHaveLength(1);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a pending lead create in the displayed stage stays silent on its own card while the sync window keeps it after its replay; the pipeline alone tells it", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const replay = Promise.withResolvers();
        onRpc("crm.lead", "web_save", async ({ args }) => {
            expect.step(`replay ${args[1].name}`);
            await replay.promise;
        });
        // Armed on reconnection: holds the reconciliation reload, so the sync window keeps the
        // replayed create's pending card on screen until the test releases it.
        let heldReload = null;
        onRpc("crm.lead", "web_read_group", async () => {
            if (heldReload) {
                expect.step("reconciliation reload");
                await heldReload.promise;
            }
        });
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await setOffline(true);

        // Offline, a create in the displayed stage: its pending card shows the badge, its own
        // region stays silent, and the pipeline announces the create.
        const key = await queueQuickCreate("Displayed lead");
        const pendingCard = `.o_crm_mobile_lead_card_pending[data-pending-key='${key}']`;
        const pendingStatus = `${pendingCard} .o_crm_mobile_lead_card_status`;
        expectHeader("New", 3, 130);
        expect(pendingCard).toHaveCount(1);
        expect(`${pendingCard} .o_crm_mobile_pending_badge`).toHaveText("Pending sync");
        expect(queryOne(pendingStatus).textContent).toBe("");
        expect(PIPELINE_STATUS).toHaveText("Displayed lead: new lead pending sync.");
        const createNode = announcementNode();

        // Reconnect: the replay is in flight, the card and both regions are unchanged.
        heldReload = Promise.withResolvers();
        await setOffline(false);
        await expect.waitForSteps(["replay Displayed lead"]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(`${pendingCard} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(queryOne(pendingStatus).textContent).toBe("");
        expect(announcementNode()).toBe(createNode);

        // The replay succeeds: the entry leaves the live queue. The sync window keeps the pending
        // card, without its badge; its own region stays silent and the pipeline tells the end.
        replay.resolve();
        await waitUntil(() => queued().length === 0);
        await animationFrame();
        expect(pendingCard).toHaveCount(1);
        expect(`${pendingCard} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(queryOne(pendingStatus).textContent).toBe("");
        expect(PIPELINE_STATUS).toHaveText("Displayed lead: new lead no longer pending sync.");
        const replayNode = announcementNode();
        await expect.waitForSteps(["reconciliation reload"]);
        await animationFrame();
        expect(pendingCard).toHaveCount(1);
        expect(queryOne(pendingStatus).textContent).toBe("");
        expect(announcementNode()).toBe(replayNode);

        // The reconciliation reload lands: the server card replaces the pending one, its region
        // silent, with no other announcement.
        heldReload.resolve();
        await animationFrame();
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Displayed lead"]);
        expect(`${cardOf("Displayed lead")} .o_crm_mobile_pending_badge`).toHaveCount(0);
        expect(queryOne(cardStatusOf("Displayed lead")).textContent).toBe("");
        expect(announcementNode()).toBe(replayNode);
        expect(PIPELINE_STATUS).toHaveText("Displayed lead: new lead no longer pending sync.");
        const created = MockServer.env["crm.lead"].search_read([["name", "=", "Displayed lead"]]);
        expect(created).toHaveLength(1);
    });
});

// -----------------------------------------------------------------------------
// Replayed lead creates inside a sync window
// -----------------------------------------------------------------------------

describe("Replayed lead creates", () => {
    /** Creates a lead in the displayed stage through the mobile quick create. */
    async function quickCreate(name, revenue) {
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name, expected_revenue: revenue });
        await contains(".o_crm_mobile_quick_create_save").click();
    }

    /** @returns {string} the queue key of the queued create of a lead name */
    function createKeyOf(name) {
        return String(queued().find(({ value }) => value.args[1].name === name).key);
    }

    test.tags("mobile");
    test("mobile: a pipeline mounted while a lead create is replayed shows that lead once, by its server card, until the reconciliation reload", async () => {
        const errors = cachedReadErrors([
            // Lead 2's form, from the cache
            "crm.lead/web_read",
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        // While `heldAnswer` is set, the next lead save is made on the server at once, but
        // answered only once released.
        let heldAnswer = null;
        onRpc("crm.lead", "web_save", async ({ args, parent }) => {
            expect.step(`replayed ${args[1].name}`);
            const held = heldAnswer;
            if (held) {
                heldAnswer = null;
                const result = await parent();
                await held.promise;
                return result;
            }
        });
        onRpc("crm.lead", "web_read_group", () => {
            expect.step(LEAD_GROUPS);
        });
        const renderers = captureInstances(CrmMobilePipeline);
        await mountWithCleanup(WebClient);
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        await getService("action").doAction(PIPELINE_ACTION_ID);
        const plugin = getService(OfflinePlugin);
        // Lead 2's form is visited online, so it opens offline.
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_back_button").click();
        expect.verifySteps([LEAD_GROUPS, LEAD_GROUPS]);
        expectHeader("New", 2, 120);

        // Offline: Final 1 and Final 2 are created in New, one second apart (the replay order).
        await setOffline(true);
        await visitedReady();
        await quickCreate("Final 1", "7");
        await advanceTime(1000);
        await quickCreate("Final 2", "9");
        expect(queued()).toHaveLength(2);
        const [key1, key2] = ["Final 1", "Final 2"].map(createKeyOf);
        expectHeader("New", 4, 136);

        // The connection returns in Lead 2's form: Final 1's replay creates the lead on the
        // server, and its answer is held.
        const answer = Promise.withResolvers();
        heldAnswer = answer;
        await contains(`${cardOf("Lead 2")} .o_crm_mobile_lead_card_name`).click();
        expect(".o_form_view").toHaveCount(1);
        await setOffline(false);
        await expect.waitForSteps(["replayed Final 1"]);
        expect(MockServer.env["crm.lead"].search([["name", "=", "Final 1"]])).toHaveLength(1);

        // Back to the pipeline while that call is in flight: its load has the created lead, and
        // its copy holds both creates, still queued.
        await contains(".o_back_button").click();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        const renderer = renderers.at(-1);
        const heldKeys = () =>
            (renderer.mobileState.syncEntries ?? []).map(({ key }) => String(key)).sort();
        expect(plugin.syncingORM()).toBe(true);
        expect(heldKeys()).toEqual([key1, key2].sort());
        expect(renderer.allLoadedRecords().map((record) => record.data.name)).toInclude("Final 1");

        // The answer lands: Final 1 leaves the queue and the copy holds it, yet the lead shows
        // once, by its server card, and counts once; Final 2 stays pending.
        answer.resolve();
        await animationFrame();
        expect(queued().map(({ key }) => String(key))).toEqual([key2]);
        expect(plugin.syncingORM()).toBe(true);
        expect(heldKeys()).toEqual([key1, key2].sort());
        expect(cardNames().sort()).toEqual(["Final 1", "Final 2", "Lead 1", "Lead 2"]);
        expect(cardOf("Final 1")).toHaveCount(1);
        expect(cardOf("Final 1")).toHaveAttribute("data-id");
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expect(`.o_crm_mobile_lead_card_pending[data-pending-key='${key2}']`).toHaveCount(1);
        expectHeader("New", 4, 136);

        // Final 2 is replayed, then the reconciliation reload ends the window: every lead is a
        // server card, with the same totals.
        await letQueueReplay(1);
        expect.verifySteps(["replayed Final 2", LEAD_GROUPS]);
        await animationFrame();
        expect(plugin.syncingORM()).toBe(false);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames().sort()).toEqual(["Final 1", "Final 2", "Lead 1", "Lead 2"]);
        expect(cardOf("Final 1")).toHaveAttribute("data-id");
        expect(cardOf("Final 2")).toHaveAttribute("data-id");
        expectHeader("New", 4, 136);
        await runAllTimers();
        expect.verifySteps([]);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a replayed lead create that a load inside the sync window brings in is shown once", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step(`replayed ${args[1].name}`);
        });
        watchRpcs([LEAD_GROUPS]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        expect.verifySteps([LEAD_GROUPS]);
        const [renderer] = renderers;
        const plugin = getService(OfflinePlugin);
        const heldKeys = () =>
            (renderer.mobileState.syncEntries ?? []).map(({ key }) => String(key)).sort();

        // Offline: X and Y are created in New, one second apart (the replay order).
        await setOffline(true);
        await quickCreate("Lead X", "50");
        await advanceTime(1000);
        await quickCreate("Lead Y", "60");
        const [keyX, keyY] = ["Lead X", "Lead Y"].map(createKeyOf);
        expectHeader("New", 4, 230);

        // Reconnect: X is replayed and its pending card stays, the loaded data predating it; the
        // sync waits a second before Y's call.
        await setOffline(false);
        await expect.waitForSteps(["replayed Lead X"]);
        await animationFrame();
        expect(plugin.syncingORM()).toBe(true);
        expect(queued().map(({ key }) => String(key))).toEqual([keyY]);
        expect(heldKeys()).toEqual([keyX, keyY].sort());
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(2);
        expect(`.o_crm_mobile_lead_card_pending[data-pending-key='${keyX}']`).toHaveCount(1);
        expectHeader("New", 4, 230);

        // A load inside the window brings X in as a server record: X shows once, by its server
        // card, and counts once, while the window keeps its copy and Y stays pending.
        await renderer.props.list.load();
        await animationFrame();
        expect.verifySteps([LEAD_GROUPS]);
        expect(plugin.syncingORM()).toBe(true);
        expect(heldKeys()).toEqual([keyX, keyY].sort());
        expect(cardNames().sort()).toEqual(["Lead 1", "Lead 2", "Lead X", "Lead Y"]);
        expect(cardOf("Lead X")).toHaveCount(1);
        expect(cardOf("Lead X")).toHaveAttribute("data-id");
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(1);
        expect(`.o_crm_mobile_lead_card_pending[data-pending-key='${keyY}']`).toHaveCount(1);
        expectHeader("New", 4, 230);

        // Y is replayed, then the reconciliation reload ends the window with the same totals.
        await letQueueReplay(1);
        expect.verifySteps(["replayed Lead Y", LEAD_GROUPS]);
        await animationFrame();
        expect(plugin.syncingORM()).toBe(false);
        expect(renderer.mobileState.syncEntries).toBe(null);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames().sort()).toEqual(["Lead 1", "Lead 2", "Lead X", "Lead Y"]);
        expect(cardOf("Lead Y")).toHaveAttribute("data-id");
        expectHeader("New", 4, 230);
        await runAllTimers();
        expect.verifySteps([]);
    });
});

// -----------------------------------------------------------------------------
// Header totals
// -----------------------------------------------------------------------------

/**
 * The header totals as the desktop column header would show them for the same data: the
 * aggregates a refresh brings are kept for every stage, folded ones included, and a pending-aware
 * revenue carries the currency the synced header shows.
 */
describe("Header totals", () => {
    test.tags("mobile");
    test("mobile: aggregates refreshed online are kept for stages never displayed: a folded stage displayed after the refresh, and an online mark-won into the folded won stage, Load more included", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        // Proposition and Won are folded: neither is loaded nor displayed until the steps below.
        MockServer.env["crm.stage"].write([3, 4], { fold: true });
        watchRpcs(["crm.lead/web_save", "crm.lead/formatted_read_group"]);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const proposition = groupOf(renderer, 3);
        const won = groupOf(renderer, 4);
        expect([proposition.isFolded, won.isFolded]).toEqual([true, true]);
        expectHeader("New", 2, 120);

        // Lead 4 (Proposition) is raised to 45 on the server, then an online move of Lead 2 saves
        // and refreshes the aggregates of every stage.
        MockServer.env["crm.lead"].write([4], { expected_revenue: 45 });
        await chooseStage("Lead 2", 2);
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save", "crm.lead/formatted_read_group"]);
        expectHeader("Qualified", 2, 50);

        // Proposition, displayed for the first time after that refresh, shows the refreshed sum.
        await goToStage("Proposition");
        expect(proposition.isFolded).toBe(false);
        expectHeader("Proposition", 1, 45);

        // Online mark-won of Lead 4 into the folded won stage, never displayed: the save refreshes
        // the aggregates, and the won header shows them, the moved lead included.
        await chooseStage("Lead 4", 4);
        await animationFrame();
        expect.verifySteps(["crm.lead/web_save", "crm.lead/formatted_read_group"]);
        expect(won.isFolded).toBe(true);
        expectHeader("Won", 2, 95);
        expect(cardNames()).toEqual(["Lead 4"]);

        // Load more loads the folded stage: the same totals, which its cards now add up to.
        await contains(".o_crm_mobile_pipeline_load_more button").click();
        await animationFrame();
        expect(won.isFolded).toBe(false);
        expectHeader("Won", 2, 95);
        expect(cardNames().sort()).toEqual(["Lead 4", "Lead 5"]);
        expect.verifySteps([]);
    });

    test.tags("mobile");
    test("mobile: offline moves into stages the server reports empty show the moved revenue in its currency, a zero revenue included; a stage left without a lead it counts, and an empty stage with nothing pending, show 0 without currency", async () => {
        const errors = cachedReadErrors([
            // Lead 3's move displays Qualified (Lead 3, the types)
            ACTIVITIES,
            TYPES,
            // back on New: Leads 1, 2 and 4, the types
            ACTIVITIES,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // Lead 2's move displays Proposition (Lead 2, the types)
            ACTIVITIES,
            TYPES,
            // on to Won, whose Lead 5 was never displayed online (the types); Lead 5's move
            // displays Qualified (Lead 3, the types)
            TYPES,
            ACTIVITIES,
            TYPES,
            // on to Won through Proposition (Lead 2, the types), then Won (the types)
            ACTIVITIES,
            TYPES,
            TYPES,
            // back to New through Proposition (Lead 2, the types), Qualified (Lead 3, the types)
            // and New (Leads 1 and 4, the types)
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        await makeMockServer();
        MockServer.env["crm.lead"].write([2], { expected_revenue: 0 });
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        // The leads of Qualified and Proposition move to New on the server: reloaded, both stages
        // are kept, empty, as the server keeps every stage of the pipeline.
        MockServer.env["crm.lead"].write([3, 4], { stage_id: 1 });
        await renderer.props.list.load();
        await animationFrame();
        expect([2, 3].map((stageId) => groupOf(renderer, stageId).count)).toEqual([0, 0]);
        const expectEmptyHeader = (stageName) => {
            expect(".o_crm_mobile_pipeline_stage_name").toHaveText(stageName);
            expect(".o_crm_mobile_pipeline_count").toHaveText("0");
            expect(".o_crm_mobile_pipeline_revenue").toHaveText("0");
        };
        expectHeader("New", 4, 170);

        // A stage empty with nothing pending: 0 without currency, as on the desktop header.
        await goToStage("Proposition");
        expectEmptyHeader("Proposition");
        expect(renderer._stageAggregate(groupOf(renderer, 3)).currencies).toBe(undefined);
        await goToStage("New");

        // Offline, Lead 3 (30) moves to Qualified, which the server reports empty: its revenue in
        // the lead's currency, as the card shows it and as the synced header will.
        await setOffline(true);
        await chooseStage("Lead 3", 2);
        expectHeader("Qualified", 1, 30);
        expect(`${cardOf("Lead 3")} .o_crm_mobile_lead_card_revenue`).toHaveText(
            formatCardRevenue(30)
        );

        // Lead 2, without revenue, moves to Proposition: a zero revenue in that currency.
        await goToStage("New");
        await chooseStage("Lead 2", 3);
        expectHeader("Proposition", 1, 0);

        // Won's only lead moves to Qualified: Won, left without a lead its aggregate counts, shows
        // 0 without currency, and Qualified sums both moved leads in their currency.
        await goToStage("Won");
        await chooseStage("Lead 5", 2);
        expectHeader("Qualified", 2, 80);
        await goToStage("Won");
        expectEmptyHeader("Won");

        // New keeps its currency with the leads it still counts.
        await goToStage("New");
        expectHeader("New", 2, 140);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: an offline quick create in a stage the server reports empty shows its revenue in the currency the synced header shows", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        // Proposition's lead moves to New on the server: reloaded, the stage is kept, empty.
        MockServer.env["crm.lead"].write([4], { stage_id: 1 });
        await renderer.props.list.load();
        await animationFrame();
        expect(groupOf(renderer, 3).count).toBe(0);
        await goToStage("Proposition");
        expect(".o_crm_mobile_pipeline_count").toHaveText("0");
        expect(".o_crm_mobile_pipeline_revenue").toHaveText("0");

        // Offline, a lead of 50 is created in Proposition: queued, and counted in its currency.
        await setOffline(true);
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Offline lead", expected_revenue: "50" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect(queuedCalls("crm.lead", "web_save")).toHaveLength(1);
        expect(cardNames()).toEqual(["Offline lead"]);
        expectHeader("Proposition", 1, 50);

        // Replayed and reconciled, the server's aggregate gives the same header.
        await setOffline(false);
        await letQueueReplay(1);
        expect(queued()).toHaveLength(0);
        expect(MockServer.env["crm.lead"].search([["name", "=", "Offline lead"]])).toHaveLength(1);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames()).toEqual(["Offline lead"]);
        expectHeader("Proposition", 1, 50);
    });

    /**
     * Holds the next framework save of a card move: the framework has then moved the card in
     * memory, and the save waits until released with `"saved"` (made as usual) or `"refused"`
     * (refused as an invalid record is, which undoes the move). Also records what every patch of
     * the pipeline shows: the displayed stage name and its card names.
     *
     * @returns {{ hold: () => PromiseWithResolvers<string>, patches: Array<[string, string[]]> }}
     */
    function holdCardMoveSaves() {
        let held = null;
        patchWithCleanup(CrmKanbanDynamicGroupList.prototype, {
            async _saveRecords() {
                const hold = held;
                if (!hold) {
                    return super._saveRecords(...arguments);
                }
                held = null;
                expect.step("save held");
                const outcome = await hold.promise;
                return outcome === "refused" ? false : super._saveRecords(...arguments);
            },
        });
        const patches = [];
        patchWithCleanup(CrmMobilePipeline.prototype, {
            _applyPendingFocus() {
                patches.push([queryAllTexts(".o_crm_mobile_pipeline_stage_name")[0], cardNames()]);
                return super._applyPendingFocus(...arguments);
            },
        });
        return {
            hold() {
                held = Promise.withResolvers();
                return held;
            },
            patches,
        };
    }

    test.tags("mobile");
    test("mobile: an online card move displays the target stage with the moved card as soon as the framework has moved it, before its save returns; a move the framework undoes displays the source stage again", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const { hold, patches } = holdCardMoveSaves();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        const displayedStage = renderer.env.crmMobileStage;
        expectHeader("New", 2, 120);

        // Lead 1 moves to Qualified, its save held: the framework has moved the card, and
        // Qualified is displayed with it, its totals included, while the stored stage is unset.
        const firstSave = hold();
        const firstMove = renderer.onCardMove(recordOf(renderer, 1), groupOf(renderer, 2));
        await expect.waitForSteps(["save held"]);
        await animationFrame();
        expect(displayedStage.serverValue).toBe(null);
        expectHeader("Qualified", 2, 130);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);

        // The save returns: Qualified is now the stored stage, with the server totals.
        firstSave.resolve("saved");
        await firstMove;
        await animationFrame();
        expect(displayedStage.serverValue).toBe(2);
        expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(2);
        expectHeader("Qualified", 2, 130);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);

        // Lead 3 moves to Proposition, its save held, then refused: Proposition is displayed with
        // the card while the save is held, then Qualified again, with the card back in place.
        const secondSave = hold();
        const secondMove = renderer.onCardMove(recordOf(renderer, 3), groupOf(renderer, 3));
        await expect.waitForSteps(["save held"]);
        await animationFrame();
        expect(displayedStage.serverValue).toBe(2);
        expectHeader("Proposition", 2, 70);
        expect(cardNames()).toEqual(["Lead 3", "Lead 4"]);
        secondSave.resolve("refused");
        await secondMove;
        await animationFrame();
        expect(displayedStage.serverValue).toBe(2);
        expect(MockServer.env["crm.lead"].browse(3)[0].stage_id).toBe(2);
        expectHeader("Qualified", 2, 130);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);

        // No patch ever showed the source stage of a move in flight without its card.
        expect(patches).toInclude(["Qualified", ["Lead 1", "Lead 3"]]);
        expect(patches).toInclude(["Proposition", ["Lead 3", "Lead 4"]]);
        expect(
            patches.filter(
                ([stage, names]) =>
                    (stage === "New" && !names.includes("Lead 1")) ||
                    (stage === "Qualified" && !names.includes("Lead 3"))
            )
        ).toEqual([]);
    });

    test.tags("mobile");
    test("mobile: an offline card move displays the target stage with the moved card as soon as the framework has moved it, before its save is queued, then with its pending badge", async () => {
        const errors = cachedReadErrors([
            // the move displays Qualified (Lead 1's activities, the types; Lead 3's were never
            // cached), once only
            ACTIVITIES,
            TYPES,
        ]);
        expect.errors(errors.length);
        mockActivityTypes(ACTIVITY_TYPES);
        const { hold, patches } = holdCardMoveSaves();
        const setOffline = mockOffline();
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        await runAllTimers(); // flush the start-up synchronisation of the offline plugin
        const [renderer] = renderers;
        const displayedStage = renderer.env.crmMobileStage;
        expectHeader("New", 2, 120);

        // Offline, Lead 1 moves to Qualified, its save held: Qualified is displayed with the card
        // before anything is queued.
        await setOffline(true);
        const save = hold();
        const move = renderer.onCardMove(recordOf(renderer, 1), groupOf(renderer, 2));
        await expect.waitForSteps(["save held"]);
        await animationFrame();
        expect(displayedStage.serverValue).toBe(null);
        expect(queued()).toHaveLength(0);
        expectHeader("Qualified", 2, 130);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);

        // The save is queued: the same stage, now stored, with the card's pending badge.
        save.resolve("saved");
        await move;
        await animationFrame();
        expect(queuedCalls("crm.lead", "web_save").map(({ args }) => args)).toEqual([
            [[1], { stage_id: 2 }],
        ]);
        expect(displayedStage.serverValue).toBe(2);
        expectHeader("Qualified", 2, 130);
        expect(cardNames()).toEqual(["Lead 1", "Lead 3"]);
        expect(`${cardOf("Lead 1")} .o_crm_mobile_pending_badge`).toHaveCount(1);
        expect(patches).toInclude(["Qualified", ["Lead 1", "Lead 3"]]);
        expect(
            patches.filter(([stage, names]) => stage === "New" && !names.includes("Lead 1"))
        ).toEqual([]);
        expect.verifyErrors(errors);
    });
});

// -----------------------------------------------------------------------------
// Quick create sheet layout and focus
// -----------------------------------------------------------------------------

/** Id of the quick-create title, which names the sheet and its content. */
const QUICK_CREATE_TITLE_ID = "o_crm_mobile_quick_create_title";

/**
 * Opens the quick create from the pipeline header, and waits until its bottom sheet takes user
 * interactions (`o_bottom_sheet_snapping`), its resting position.
 */
async function openQuickCreateSheet() {
    await contains(".o_crm_mobile_pipeline_add").click();
    await waitUntil(() => queryFirst(".o_bottom_sheet.o_bottom_sheet_snapping"));
}

/**
 * Asserts that Save and Discard lie entirely on the screen of the open bottom sheet (the box the
 * framework sheet is positioned in, which spans the viewport) and inside the sheet itself.
 *
 * @param {string} when the state checked, for the assertion messages
 */
function expectQuickCreateActionsOnScreen(when) {
    const screen = queryOne(".o_bottom_sheet").getBoundingClientRect();
    const sheet = queryOne(".o_bottom_sheet_sheet").getBoundingClientRect();
    for (const selector of [
        ".o_crm_mobile_quick_create_save",
        ".o_crm_mobile_quick_create_discard",
    ]) {
        const rect = queryOne(selector).getBoundingClientRect();
        expect(rect.top >= Math.max(screen.top, sheet.top)).toBe(true, {
            message: `${selector} starts on screen ${when}`,
        });
        expect(rect.bottom <= Math.min(screen.bottom, sheet.bottom)).toBe(true, {
            message: `${selector} ends on screen ${when}`,
        });
    }
}

describe("Quick create sheet layout and focus", () => {
    test.tags("mobile");
    test("mobile: the quick-create sheet is a modal dialog named by its New Lead title, and its content a group named by the same title", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();

        await openQuickCreateSheet();
        expect(`#${QUICK_CREATE_TITLE_ID}`).toHaveCount(1);
        expect(`.o_crm_mobile_quick_create h4#${QUICK_CREATE_TITLE_ID}`).toHaveText("New Lead");
        expect(".o_crm_mobile_quick_create").toHaveAttribute("role", "group");
        expect(".o_crm_mobile_quick_create").toHaveAttribute(
            "aria-labelledby",
            QUICK_CREATE_TITLE_ID
        );
        const dialog = queryOne(".o_crm_mobile_quick_create").closest("[role=dialog]");
        expect(dialog).toHaveClass("o_bottom_sheet_sheet");
        expect(dialog).toHaveAttribute("aria-labelledby", QUICK_CREATE_TITLE_ID);
        expect(dialog).toHaveAttribute("aria-modal", "true");
    });

    test.tags("mobile");
    test("mobile: the open quick-create sheet holds the keyboard focus: Tab wraps from Discard to the lead name, Shift+Tab from the lead name to Discard, and Escape still closes it back to Add", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();

        await openQuickCreateSheet();
        const root = queryOne(".o_crm_mobile_quick_create");
        expect(getService(UIPlugin).activeElement()).toBe(root);
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();

        // Tab walks the six controls and the two buttons in order, then wraps to the lead name.
        for (const name of QUICK_CREATE_FIELDS.slice(1)) {
            await press("Tab");
            expect(`.o_crm_mobile_quick_create [name=${name}]`).toBeFocused();
        }
        await press("Tab");
        expect(".o_crm_mobile_quick_create_save").toBeFocused();
        await press("Tab");
        expect(".o_crm_mobile_quick_create_discard").toBeFocused();
        await press("Tab");
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();

        // Shift+Tab wraps from the lead name back to Discard.
        await press(["Shift", "Tab"]);
        expect(".o_crm_mobile_quick_create_discard").toBeFocused();
        expect(root.contains(document.activeElement)).toBe(true);

        // Escape, from Discard, still closes the sheet, and the focus goes back to Add.
        await press("Escape");
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();
        expect(getService(UIPlugin).activeElement()).not.toBe(root);
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: while the quick-create sheet is open, the pipeline's New access key stays inactive behind it, and works again once the sheet is closed", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();

        await openQuickCreateSheet();
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();
        // Alt+C, the access key of the kanban New button behind the sheet, does nothing (the
        // framework clicks an access-key target in a timeout, hence the timers run).
        await press(["Alt", "c"]);
        await runAllTimers();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        expect(".o_kanban_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_quick_create [name=name]").toBeFocused();

        // Once the sheet is closed, the same key opens the framework quick create again.
        await contains(".o_crm_mobile_quick_create_discard").click();
        await animationFrame();
        expect(".o_crm_mobile_quick_create").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_add").toBeFocused();
        await press(["Alt", "c"]);
        await runAllTimers();
        await animationFrame();
        expect(".o_crm_mobile_pipeline_body .o_kanban_quick_create").toHaveCount(1);
    });

    test.tags("mobile");
    test("mobile: the quick-create sheet keeps to its resting height and pins Save and Discard on screen as it opens, after an inline error and while its fields scroll", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        await mountPipeline();

        await openQuickCreateSheet();
        const screen = queryOne(".o_bottom_sheet").getBoundingClientRect();
        const sheet = queryOne(".o_bottom_sheet_sheet").getBoundingClientRect();
        const rail = queryOne(".o_bottom_sheet_rail");
        const body = queryOne(".o_bottom_sheet_body");
        // On a 375x667 screen the fields and the actions are taller than the sheet's resting
        // height: the sheet keeps to it (90% of the screen), ends at the bottom of the screen,
        // and its body scrolls the fields instead.
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
        expect(sheet.height).toBeCloseTo(0.9 * screen.height, { margin: 1 });
        expect(sheet.bottom).toBeCloseTo(screen.bottom, { margin: 1 });
        // The sheet rests at the end of the rail, which therefore has no more content to show.
        expect(rail.scrollTop).toBeCloseTo(rail.scrollHeight - rail.clientHeight, { margin: 1 });
        expect(".o_crm_mobile_quick_create_actions").toHaveStyle({
            position: "sticky",
            bottom: "0px",
        });
        expectQuickCreateActionsOnScreen("as the sheet opens");

        // An inline error lengthens the content, and the actions stay where they are.
        const { top } = queryOne(".o_crm_mobile_quick_create_save").getBoundingClientRect();
        await contains(".o_crm_mobile_quick_create_save").click();
        expect(".o_crm_mobile_quick_create [role=alert]").toHaveText("The lead name is required.");
        expectQuickCreateActionsOnScreen("after an inline error");
        expect(queryOne(".o_crm_mobile_quick_create_save").getBoundingClientRect().top).toBe(top);

        // Scrolling the fields under the pinned row leaves the actions on screen.
        body.scrollTop = 40;
        await animationFrame();
        expect(body.scrollTop).toBe(40);
        expectQuickCreateActionsOnScreen("while the fields scroll");
        expect(queued()).toHaveLength(0);
    });

    test.tags("mobile");
    test("mobile: a quick create rendered outside a dialog names only its own group and leaves other dialogs untouched", async () => {
        mockActivityTypes(ACTIVITY_TYPES);
        const renderers = captureInstances(CrmMobilePipeline);
        await mountPipeline();
        const [renderer] = renderers;
        // A dialog of something else, beside the content rather than around it.
        const otherDialog = document.createElement("div");
        otherDialog.setAttribute("role", "dialog");
        otherDialog.className = "o_unrelated_dialog";
        getFixture().append(otherDialog);

        // The content mounted on its own, not in the bottom sheet, so no dialog encloses it: the
        // mount raises nothing, closes nothing and creates nothing.
        const sheet = await mountWithCleanup(CrmMobileQuickCreate, {
            props: {
                list: renderer.props.list,
                group: groupOf(renderer, 1),
                close: () => expect.step("close"),
                onCreated: async () => expect.step("onCreated"),
            },
        });
        expect(status(sheet)).toBe("mounted");
        expect(".o_crm_mobile_quick_create").toHaveCount(1);
        const root = queryOne(".o_crm_mobile_quick_create");
        expect(root.closest("[role=dialog]")).toBe(null);
        expect(root).toHaveAttribute("role", "group");
        expect(root).toHaveAttribute("aria-labelledby", QUICK_CREATE_TITLE_ID);
        expect(`.o_crm_mobile_quick_create h4#${QUICK_CREATE_TITLE_ID}`).toHaveText("New Lead");

        // Nothing but the content is named after its title, and nothing is declared modal.
        expect(".o_unrelated_dialog").not.toHaveAttribute("aria-labelledby");
        expect(".o_unrelated_dialog").not.toHaveAttribute("aria-modal");
        expect("[aria-modal]").toHaveCount(0);
        const named = [
            ...document.querySelectorAll(`[aria-labelledby="${QUICK_CREATE_TITLE_ID}"]`),
        ];
        expect(named).toHaveLength(1);
        expect(named[0]).toBe(root);
        expect.verifySteps([]);
        expect(queued()).toHaveLength(0);
    });
});
