import {
    defineMailModels,
    inputFiles,
    insertText,
    onRpcBefore,
    openFormView,
    start,
    startServer,
    triggerHotkey,
} from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    mockService,
    models,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { LeadGenerationDropdown } from "@crm/components/lead_generation_dropdown/lead_generation_dropdown";
import { TeamSwitcher } from "@crm/components/team_switcher/team_switcher";
import { CrmColumnProgress } from "@crm/views/crm_kanban/crm_column_progress";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * VAL-FIX-013: a single offline → online cycle re-enables every M2-disabled
 * control together, not just each in isolation. Each control already has
 * its own dedicated test (crm_offline_team_switcher.test.js,
 * crm_offline_lead_generation.test.js, crm_offline_pls_tooltip.test.js,
 * crm_offline_chatter.test.js, crm_offline_activity_menu.test.js); this
 * file drives one shared connection drop/restore across all of them, plus
 * the one thing none of those cover: the MRR aggregate (VAL-FIX-009)
 * reappearing on the *next* online load, since
 * `CrmColumnProgress.onWillStart` only evaluates `showRecurringRevenue`
 * once per mount, not reactively.
 */

class Stage extends models.Model {
    _name = "crm.stage";
    name = fields.Char();
    _records = [{ id: 1, name: "New" }];
}

class Team extends models.Model {
    _name = "crm.team";
    name = fields.Char();
    use_opportunities = fields.Boolean({ default: true });
    _records = [
        { id: 1, name: "Mushroom Kingdom" },
        { id: 2, name: "Hyrule" },
    ];
    get_team_switcher_data() {
        const teams = this._filter([["use_opportunities", "=", true]]);
        return {
            available: teams.length > 1,
            teams: teams.map((team) => ({
                id: team.id,
                name: team.name,
                switcher_domain: ["|", ["team_id", "=", team.id], ["team_id", "=", false]],
            })),
        };
    }
}

class Users extends models.Model {
    name = fields.Char();
    has_group() {
        return true;
    }
    _records = [{ id: 1, name: "Mitchell Admin" }];
}

class IrModuleModule extends models.Model {
    _name = "ir.module.module";
    name = fields.Char();
    shortdesc = fields.Char();
    _records = [
        { id: 1, name: "crm_iap_mine", shortdesc: "Lead Mining" },
        { id: 2, name: "website", shortdesc: "Website" },
        { id: 3, name: "mass_mailing", shortdesc: "Email Marketing" },
        { id: 4, name: "survey", shortdesc: "Survey" },
    ];
}

class Lead extends models.Model {
    _name = "crm.lead";

    // mail's own `has_activities` wiring (base.js's `ServerModel.prototype`
    // patch to `get_views()`) only fires for models extending
    // `models.ServerModel`, not the plain `models.Model` every crm offline
    // mock uses, so it is never in this class's prototype chain. Without
    // this override the chatter's "Activity" button (chatter.xml:25,
    // `t-if="this.webChatterProps.has_activities"`) never renders, so the
    // VAL-FIX-013 "Schedule Activity works online again" assertion below
    // would have nothing to click.
    get_views(...args) {
        const result = super.get_views(...args);
        for (const modelName of Object.keys(result.models)) {
            result.models[modelName].has_activities = true;
        }
        return result;
    }

    name = fields.Char();
    probability = fields.Float();
    won_status = fields.Char();
    is_automated_probability = fields.Boolean();
    activity_ids = fields.One2many({ relation: "mail.activity" });
    message_ids = fields.One2many({ relation: "mail.message" });
    message_follower_ids = fields.Many2many({ relation: "mail.followers" });

    _records = [
        {
            id: 1,
            name: "First lead",
            probability: 20,
            won_status: "pending",
            is_automated_probability: true,
        },
    ];

    prepare_pls_tooltip_data() {
        return { probability: 42, low_3_data: {}, top_3_data: {}, team_name: "Team 1" };
    }

    _views = {
        form: /* xml */ `
            <form js_class="crm_form">
                <field name="won_status" invisible="1"/>
                <field name="is_automated_probability" invisible="1"/>
                <sheet>
                    <field name="name"/>
                    <field name="probability"/>
                    <widget name="pls_tooltip_button"/>
                </sheet>
                <chatter/>
            </form>`,
    };
}

defineModels([Stage, Team, Users, IrModuleModule, Lead]);
defineMailModels();
patchWithCleanup(AnimatedNumber, { enableAnimations: false });
defineActions([
    {
        id: "crm.crm_lead_action_my_activities",
        name: "My Pipeline Activities",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [[false, "list"]],
    },
]);

test("offline, every M2-disabled control is inert together; online again, each works and the MRR aggregate reappears", async () => {
    const pyEnv = await startServer();
    pyEnv["mail.activity"].create({ res_id: 1, res_model: "crm.lead" });

    onRpc("res.users", "has_group", ({ args, parent }) => {
        const result = parent();
        if (args[1] === "sales_team.group_sale_manager") {
            expect.step("has_group_team_switcher");
        } else if (args[1] === "crm.group_use_recurring_revenues") {
            expect.step("has_group_mrr");
        }
        return result;
    });
    onRpc("ir.module.module", "search_read", ({ parent }) => {
        expect.step("search_read");
        return parent();
    });
    onRpc("crm.lead", "prepare_pls_tooltip_data", ({ parent }) => {
        expect.step("prepare_pls_tooltip_data");
        return parent();
    });
    onRpcBefore("/mail/message/post", () => expect.step("message_post"));
    onRpc("/web/action/load", () => expect.step("load_action"));
    onRpcBefore("/mail/attachment/upload", () => expect.step("attachment_upload"));
    // "Schedule Activity" (chatter.xml's `.o-mail-Chatter-activity`) opens
    // the `mail.activity.schedule` wizard through the action service
    // (store_service_patch.js's `scheduleActivity`), not an RPC of its
    // own; record that it was asked for and close it immediately so the
    // test does not hang on an unresolved dialog.
    mockService("action", {
        doAction(action, options) {
            if (action?.res_model !== "mail.activity.schedule") {
                return super.doAction(...arguments);
            }
            expect.step("schedule_activity_action");
            options.onClose?.();
        },
    });

    await start();
    await openFormView("crm.lead", 1);
    // f297e5e5 / m2-fix-chatter-paste-drop-flake: "Send message" carries
    // t-att-disabled driven by hasReadAccess/hasWriteAccess, set only once
    // the chatter's own mount-time fetchThreadData() round-trips through
    // the debounced /mail/store fetch; waiting for plain
    // ".o-mail-Chatter-sendMessage" can still race that fetch and click a
    // disabled button, which hoot's click() silently no-ops. Wait for
    // :enabled first, same fix as crm_offline_chatter.test.js's
    // clickSendMessage() helper.
    await waitFor(".o-mail-Chatter-sendMessage:enabled");
    // Open the composer and leave it open with a draft, same setup as
    // crm_offline_chatter.test.js's Ctrl+Enter-bypass test.
    await contains(".o-mail-Chatter-sendMessage").click();
    await insertText(".o-mail-Composer-input", "Hello while online");

    await mountWithCleanup(TeamSwitcher, {
        componentEnv: {
            searchModel: {
                state: {
                    switcherTeamId: null,
                    switcherTeams: [
                        { id: 1, name: "Mushroom Kingdom" },
                        { id: 2, name: "Hyrule" },
                    ],
                },
                isTeamSwitcherEnabled: true,
                _updateSwitcherSelection: () => {},
            },
        },
    });
    await mountWithCleanup(LeadGenerationDropdown);
    expect.verifySteps(["has_group_team_switcher"]); // TeamSwitcher's own mount-time probe

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Every control is disabled or inert together, from one connection drop.
    expect(".o_cp_team_switcher").toHaveAttribute("disabled");
    expect(".o-dropdown-caret.btn-secondary").toHaveAttribute("disabled");
    expect(".o_crm_pls_tooltip_button").toHaveAttribute("disabled");
    for (const selector of [
        ".o-mail-Chatter-sendMessage",
        ".o-mail-Chatter-logNote",
        ".o-mail-Chatter-attachFiles",
        ".o-mail-Followers-button",
    ]) {
        expect(selector).toHaveAttribute("disabled");
    }

    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item").toHaveCount(0); // disabled button: no click ever registers

    await contains(".o-dropdown-caret.btn-secondary").click();
    expect(".o_lead_mining_menu_choices").toHaveCount(0);

    await contains(".o_crm_pls_tooltip_button").click();
    expect(".o_crm_pls_tooltip").toHaveCount(0);

    // Refocus the composer: the clicks above moved focus to other buttons,
    // and Ctrl+Enter is handled by the composer textarea's own keydown
    // listener, not a global hotkey.
    await contains(".o-mail-Composer-input").click();
    await triggerHotkey("control+Enter"); // the already-open composer's Ctrl+Enter bypass
    expect(".o-mail-Message").toHaveCount(0);
    expect(".o-mail-Composer-input").toHaveValue("Hello while online"); // draft untouched

    // Opening the Activities dropdown always issues its own
    // `fetchStoreData("systray_get_activities")` (`ActivityMenu.onBeforeOpen`,
    // @mail/core/web/activity_menu.js) -- unlike the controls above, this is
    // not the mail store's one-time startup fetch that `mockCrmOffline()`
    // already settled, but a fresh RPC triggered by this very click, which
    // can only fail now that the connection is down (crm_offline_activity_menu
    // .test.js's two offline tests declare the same error for the same reason).
    expect.errors(1);
    await contains(".o_menu_systray i[aria-label='Activities']").click();
    expect(".o-mail-ActivityGroup[data-model_name='crm.lead']").toHaveCount(1);
    await contains(".o-mail-ActivityGroup[data-model_name='crm.lead']").click();
    expect(".o_last_breadcrumb_item:contains('My Pipeline Activities')").toHaveCount(0);
    expect.verifyErrors([
        `Connection to "/mail/store" couldn't be established or was interrupted`,
    ]);

    expect.verifySteps([]); // no probe, RPC or navigation was ever attempted while offline

    await setOffline(false);

    // Chatter: the Ctrl+Enter bypass works again (refocus the composer:
    // the activity-menu click above moved focus to the systray toggler).
    await contains(".o-mail-Composer-input").click();
    await triggerHotkey("control+Enter");
    expect.verifySteps(["message_post"]);
    await waitFor(".o-mail-Message-body:contains('Hello while online')");

    // Chatter's other two write controls, both still untouched above
    // (VAL-FIX-013 names them individually, not just "re-enabled"):
    // Log Note switches the composer into note mode...
    expect(".o-mail-Chatter-logNote").not.toHaveAttribute("disabled");
    await contains(".o-mail-Chatter-logNote").click();
    expect(".o-mail-Chatter-logNote").toHaveClass("active");
    // ...Schedule Activity opens the "Schedule Activity" wizard action...
    expect(".o-mail-Chatter-activity").not.toHaveAttribute("disabled");
    await contains(".o-mail-Chatter-activity").click();
    expect.verifySteps(["schedule_activity_action"]);
    // ...and Attach Files opens the hidden file input, through which a
    // selected file genuinely uploads.
    expect(".o-mail-Chatter-attachFiles").not.toHaveAttribute("disabled");
    await contains(".o-mail-Chatter-attachFiles").click();
    // Not plain ".o_input_file": the open Log Note composer above has its
    // own (unrelated) hidden file input too; only the chatter-level
    // `FileUploader` carries this class (chatter.xml's `fileUploadClass`).
    await inputFiles(".o_input_file.o-mail-Chatter-fileUploader", [
        new File(["hello"], "reenabled.txt"),
    ]);
    // Not just "the card appeared": it shows optimistically while
    // `.o-isUploading` is still set, before the RPC resolves.
    await waitFor(".o-mail-AttachmentCard:not(.o-isUploading)", { text: "reenabled.txt" });
    expect.verifySteps(["attachment_upload"]);

    // PLS tooltip: the button re-opens the popover and re-issues the RPC.
    expect(".o_crm_pls_tooltip_button").not.toHaveAttribute("disabled");
    await contains(".o_crm_pls_tooltip_button").click();
    expect.verifySteps(["prepare_pls_tooltip_data"]);
    expect(".o_crm_pls_tooltip").toHaveCount(1);

    // Team switcher: the toggler re-opens the dropdown with "Manage Teams"
    // and the other team, reachable again.
    expect(".o_cp_team_switcher").not.toHaveAttribute("disabled");
    await contains(".o_cp_team_switcher").click();
    expect(".dropdown-item:contains('Manage Teams')").toHaveCount(1);
    expect(".dropdown-item:contains('Hyrule')").toHaveCount(1);

    // Lead generation: the toggler re-opens the dropdown and re-issues the
    // module search_read.
    expect(".o-dropdown-caret.btn-secondary").not.toHaveAttribute("disabled");
    await contains(".o-dropdown-caret.btn-secondary").click();
    expect.verifySteps(["search_read"]);
    expect(".o_lead_mining_menu_choices").toHaveCount(1);

    // Activity menu: clicking anything else above (composer, team switcher,
    // lead generation) closed the activity dropdown as an outside click;
    // reopen it, then the crm.lead group entry navigates.
    await contains(".o_menu_systray i[aria-label='Activities']").click();
    await waitFor(".o-mail-ActivityGroup[data-model_name='crm.lead']");
    await contains(".o-mail-ActivityGroup[data-model_name='crm.lead']").click();
    expect.verifySteps(["load_action"]);
    await waitFor(".o_last_breadcrumb_item:contains('My Pipeline Activities')");

    // MRR aggregate: a fresh kanban-column mount on this next online load
    // shows it again and re-issues the probe.
    await mountWithCleanup(CrmColumnProgress, {
        props: {
            aggregate: { value: 14, title: "Revenue", currencies: [false] },
            group: { count: 1, _config: { fields: {} } },
            progressBar: { bars: [], isReady: true },
            progressBarState: {
                progressAttributes: { recurring_revenue_sum_field: "recurring_revenue_monthly" },
                getAggregateValue: () => ({ value: 5, title: "Recurring Revenue", currency: false }),
            },
            onRotIconClicked: () => {},
        },
    });
    expect.verifySteps(["has_group_mrr"]);
    expect(".o_animated_number[data-tooltip='Recurring Revenue']").toHaveCount(1);
});
