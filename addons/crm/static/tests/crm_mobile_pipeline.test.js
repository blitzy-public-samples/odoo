/**
 * Small-screen CRM pipeline: lane 2 (Hoot) of the offline/mobile work.
 *
 * These tests prove, under the desktop and mobile presets, that:
 * - the `crm_mobile_pipeline` view is the CRM kanban view with its renderer and controller swapped,
 *   and that on desktop it renders exactly the standard kanban DOM with the same RPCs;
 * - on small screens, while grouped by stage, the pipeline shows one stage at a time behind a
 *   fixed header (stage name, lead count, revenue sum) with button and swipe navigation (a focused
 *   navigation button that disappears hands the focus to the other one), keeps the displayed stage
 *   and its scroll across breadcrumbs, opens New in the displayed stage, and falls back to the
 *   standard renderer for any other grouping;
 * - pending stage placement and pending-aware totals are derived from framework state only, survive
 *   remounts and reloads, and end once the write is replayed (or discarded) and reloaded;
 * - activity reads are bounded pages that carry the lead's total, so the card shows the total and
 *   says what the page misses ("Show all" online, a muted count offline);
 * - the lead card (44x44 touch targets, pending-sync badge, stage list, activities), the six-field
 *   bottom-sheet quick create and the activity controls queue their writes offline through the
 *   shared framework queue, and are disabled when their data is missing.
 *
 * Conventions:
 * - Every mock model is local to this file; no existing test helper is modified.
 * - Offline state is driven only through the offline plugin (`mockOffline()` and
 *   `getService(OfflinePlugin)`); "the connection drops during the call" is a 502 answer.
 * - Hoot fails a test on any undeclared error, which is how "no error" is asserted. The only
 *   errors declared are the ones the framework itself produces offline: a read served from the
 *   framework RPC cache while offline still tries the server in the background, and that refresh
 *   rejects with a `ConnectionLostError` nobody awaits.
 */

import {
    advanceTime,
    animationFrame,
    beforeEach,
    describe,
    expect,
    press,
    queryAll,
    queryAllTexts,
    queryFirst,
    queryOne,
    runAllTimers,
    test,
} from "@odoo/hoot";
import { status } from "@odoo/owl";
import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineActions,
    defineModels,
    destroyApp,
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
} from "@web/../tests/web_test_helpers";

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
import { deserializeDate, formatDate, serializeDate, today } from "@web/core/l10n/dates";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
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
        "list,false": /* xml */ `<list><field name="name"/><field name="stage_id"/></list>`,
        "search,false": LEAD_SEARCH_ARCH,
    };

    /** Mark-won returns no message here: only the lookup itself is asserted. */
    get_rainbowman_message() {
        return false;
    }
}

defineModels([CrmStage, CrmTeam, CrmLead]);
defineMailModels();

const PIPELINE_ACTION_ID = 1;
const UNGROUPABLE_PIPELINE_ACTION_ID = 2;

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

        // Same DOM, same requests, and none for activities or activity types.
        expect(".o_crm_mobile_pipeline").toHaveCount(0);
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
        expect(".o_crm_mobile_pipeline_body").toHaveCount(1);
        expect(".o_kanban_group").toHaveCount(1);
        expect(getComputedStyle(queryOne(".o_crm_mobile_pipeline_header")).position).toBe("sticky");
        expectHeader("New", 2, 120);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(".o_crm_mobile_pipeline_prev").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_next").toHaveCount(1);

        // Header buttons move one stage at a time.
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
        // Nothing in the stage body is live-announced, and the helper overlay stays positioned
        // against the stage body.
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

        // Back hands the focus to the tapped lead's card (its first control), never to the body.
        await contains(".o_crm_mobile_pipeline_back").click();
        expect(".o_crm_mobile_pipeline_back").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2"]);
        expect(`${cardOf("Lead 2")} .o_crm_mobile_card_stage`).toBeFocused();

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
            // the move first takes Lead 1 out of New: Lead 2's activities and the types
            ACTIVITIES,
            TYPES,
            // then displays Qualified: Lead 1's activities (cached) and the types; Lead 3's
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
            // the first move takes Lead 1 out of New (Lead 2's activities, the types), then
            // displays Qualified (Lead 1's activities, the types; Lead 3's were never cached)
            ACTIVITIES,
            TYPES,
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
            // the second move takes Lead 1 out of Qualified (the types), then displays
            // Proposition (Lead 1's activities, the types)
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
            // the move takes Lead 1 out of New (Lead 2's activities, the types), then displays
            // Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
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

        // A discard (the systray's removal of the entry) takes its card away at once.
        getService(OfflinePlugin).removeScheduledORM(keyC);
        await animationFrame();
        expect(`.o_crm_mobile_lead_card[data-pending-key='${keyC}']`).toHaveCount(0);
        expect(pendingCard(keyA)).toBe(cardA);
        expect(pendingCard(keyB)).toBe(cardB);
        expectHeader("New", 4, 140);

        // Reconnect: the sync re-reads the queue from its storage (new entry objects, same keys)
        // while the first replay is in flight; the cards keep their node.
        await setOffline(false);
        await expect.waitForSteps(["replay Pending A"]);
        expect(getService(OfflinePlugin).syncingORM()).toBe(true);
        expect(pendingCard(keyA)).toBe(cardA);
        expect(pendingCard(keyB)).toBe(cardB);
        replays.shift().resolve();
        await letQueueReplay(1);
        expect.verifySteps(["replay Pending B"]);
        replays.shift().resolve();
        await letQueueReplay(1);
        // Both entries left the queue and the reload landed: the server cards replace them.
        expect(queued()).toHaveLength(0);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Pending A", "Pending B"]);
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
            // a card move takes Lead 1 out of New (Lead 2's activities, the types), then
            // displays Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
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
        // once (5 leads) and each stage's queued creates once (4 stages).
        const onePass = { queuedEntries: 1, latestStageWrite: 5, pendingLeadCreates: 4 };

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
        expect({ passes, visits }).toEqual({ passes: 1, visits: entryCount + 3 + 2 });
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
        expect({ passes, visits }).toEqual({ passes: 1, visits: entryCount + 3 + 2 });

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
        // Filtering (a new root load).
        await toggleSearchBarMenu();
        await toggleMenuItem("With Revenue");
        await toggleSearchBarMenu();
        expect(cardNames()).toEqual(["Lead 1"]);
        expect.verifySteps(["activities:1"]);
        // Load more.
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
    test("mobile: activity reads are bounded: 40 activities per lead and 80 activity types, in a fixed order", async () => {
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
        expect(typeReads[0].order).toBe("sequence ASC, id ASC");
        expect(typeReads[0].limit).toBe(80);
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
            // the move takes Lead 1 out of New (Lead 2's activities, the types), then displays
            // Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
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
                // the move takes Lead 1 out of New (Lead 2's activities, the types), then
                // displays Qualified (Lead 1's activities, the types)
                ACTIVITIES,
                TYPES,
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
    test("mobile: outside the stage grouping, the reconciliation drops the sync snapshot and reloads nothing", async () => {
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

        // Grouped by stage again, the created lead is a server card, and no pending card of the
        // ended window is left.
        await toggleSalespersonGrouping();
        expect.verifySteps([LEAD_GROUPS]);
        expectHeader("New", 3, 145);
        expect(cardNames()).toEqual(["Lead 1", "Lead 2", "Queued lead"]);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
    });

    test.tags("mobile");
    test("mobile: a reconciliation reload landing after the pipeline is destroyed leaves its sync snapshot alone", async () => {
        const errors = cachedReadErrors([
            // the move takes Lead 1 out of New (Lead 2's activities, the types), then displays
            // Qualified (Lead 1's activities, the types)
            ACTIVITIES,
            TYPES,
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
    test("mobile: with sample data, no activity is read and reconnecting reloads nothing", async () => {
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

        // Reconnecting does not reload the sample pipeline.
        await setOffline(true);
        await setOffline(false);
        await runAllTimers();
        expect.verifySteps([]);
        expect(renderer.props.list.model.useSampleModel).toBe(true);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
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
            // Qualified loses Lead 3 (the types), then Proposition is displayed (Lead 3's
            // activities, the types; Lead 4's were never read, so they are not cached)
            TYPES,
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
        expectHeader("Qualified", 0, 0);
        expect(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card").toHaveCount(0);
        expect(".o_crm_mobile_pipeline_body .o_view_nocontent").toHaveCount(0);
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: a card move failing for another reason than the connection propagates, and a move ending after the pipeline is destroyed changes nothing", async () => {
        const errors = cachedReadErrors([
            // offline, New loses its only loaded lead: the types
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
 * @param {number} value
 * @returns {string} an amount as the card shows it (lead currency, whitespace-normalized)
 */
function formatCardRevenue(value) {
    return formatMonetary(value, { currencyId: CURRENCY_ID }).replace(/\s+/g, " ");
}

describe("Mobile lead card", () => {
    test.tags("mobile");
    test("mobile: card shows name, partner, revenue; touch targets >= 44x44", async () => {
        await createActivities([
            { res_id: 1, activity_type_id: 1, activity_category: "default", summary: "Send offer" },
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
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_lead_card_follow_up`).toHaveCount(0);
        expect(`${card} .o_crm_mobile_activity_row`).toHaveCount(1);
        expectTouchTarget(queryOne(`${card} .o_crm_mobile_activity_done`), "mark done");
        await contains(`${card} .o_crm_mobile_card_activities`).click();
        expect(`${card} .o_crm_mobile_lead_card_activities`).toHaveCount(0);
        // The pipeline controls.
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
    test("mobile: offline stage move via card queues web_save and shows pending-sync indicator", async () => {
        const errors = cachedReadErrors([
            // the move takes Lead 1 out of New, which then shows no loaded lead (the types),
            // then displays Qualified (Lead 1's activities, the types)
            TYPES,
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
        expect.verifyErrors(errors);
    });

    test.tags("mobile");
    test("mobile: pending indicator clears after successful replay and after a systray discard", async () => {
        const errors = cachedReadErrors([
            // first move: New loses Lead 1 (Lead 2, types), then Qualified is displayed (Lead 1
            // and Lead 3, both visited online, and the types)
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            ACTIVITIES,
            TYPES,
            // second move: Qualified loses Lead 3 (Lead 1, types), then Proposition is displayed
            // (Lead 3, the types; Lead 4's activities were never cached)
            ACTIVITIES,
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
            // New loses Lead 1 (Lead 2, types), then Won is displayed (Lead 1, types)
            ACTIVITIES,
            TYPES,
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
            // New loses Lead 1 (Lead 2, types), then Won is displayed (Lead 1, types)
            ACTIVITIES,
            TYPES,
            ACTIVITIES,
            TYPES,
            // the card leaves Won (the types), then Qualified is displayed (Lead 1, types)
            TYPES,
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
        expect(queryAllTexts(".o_crm_mobile_quick_create label")).toEqual([
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
        // The displayed stage is unchanged; the pending card is in Qualified.
        expectHeader("New", 2, 120);
        expect(".o_crm_mobile_lead_card_pending").toHaveCount(0);
        await goToStage("Qualified");
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

        // Discard closes the sheet without queuing anything.
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

        // A server error leaves the sheet open with its values, ready for another try.
        expect.errors(1);
        await contains(".o_crm_mobile_pipeline_add").click();
        await fillQuickCreate({ name: "Rejected lead" });
        await contains(".o_crm_mobile_quick_create_save").click();
        await animationFrame();
        expect.verifySteps([
            `web_save [[],{"name":"Rejected lead","contact_name":false,"phone":false,"email_from":false,"expected_revenue":0,"stage_id":1}]`,
        ]);
        expect.verifyErrors(["This lead name is reserved"]);
        await contains(".modal .modal-footer .btn-primary").click();
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
        followUpOpen: false,
        activitiesOpen: false,
        typeId: null,
        summary: "",
        date: serializeDate(today()),
        busy: false,
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
