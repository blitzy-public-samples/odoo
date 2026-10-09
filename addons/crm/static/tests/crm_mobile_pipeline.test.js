/**
 * Small-screen CRM pipeline: lane 2 (Hoot) of the offline/mobile work.
 *
 * These tests prove, under the desktop and mobile presets, that:
 * - the `crm_mobile_pipeline` view is the CRM kanban view with its renderer and controller swapped,
 *   and that on desktop it renders exactly the standard kanban DOM with the same RPCs;
 * - on small screens, while grouped by stage, the pipeline shows one stage at a time behind a
 *   fixed header (stage name, lead count, revenue sum) with button and swipe navigation, keeps the
 *   displayed stage and its scroll across breadcrumbs, opens New in the displayed stage, and falls
 *   back to the standard renderer for any other grouping;
 * - pending stage placement and pending-aware totals are derived from framework state only, survive
 *   remounts and reloads, and end once the write is replayed (or discarded) and reloaded;
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
    queryAll,
    queryAllTexts,
    queryFirst,
    queryOne,
    runAllTimers,
    test,
} from "@odoo/hoot";
import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineActions,
    defineModels,
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
import { serializeDate, today } from "@web/core/l10n/dates";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { formatMonetary } from "@web/views/fields/formatters";
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

/** @returns {Object[]} the framework offline queue entries, as stored */
function queued() {
    return Object.values(getService(OfflinePlugin)._ormToSync());
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
        // The adapter saved the displayed stage with the local state, then restored it.
        expect(controllers[1].props.state.crmMobileStage).toBe(2);
        expect(controllers[1].props.state.scrollPositions.columnScrollTops).toEqual([[2, 200]]);
        expect(".o_crm_mobile_pipeline").toHaveCount(1);
        expectHeader("Qualified", 13, 150);
        expect(queryOne(".o_crm_mobile_pipeline_body").scrollTop).toBe(scrollTop);
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
});
