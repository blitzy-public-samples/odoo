import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-dom";
import { advanceTime } from "@odoo/hoot-mock";
import { contains, defineModels, fields, mockOffline, models, mountView, onRpc } from "@web/../tests/web_test_helpers";

/**
 * VAL-DIS-026 (B32-B39, B76, B77, C19, C21): the team dashboard kanban's own
 * menu links, card body click and card menu toggler, all inert offline.
 *
 * `crm.team`'s dashboard kanban has no dedicated `js_class` (it is the
 * plain "kanban" view, same as `utm.campaign`'s -- see
 * `crm_offline_utm_campaign.test.js`), so the two guards this feature adds
 * are patches on the shared `KanbanController`/`KanbanRecord`
 * (`views/view_components/kanban_action_button_patch.js`,
 * `kanban_record_offline_patch.js`), not a crm subclass:
 *
 * - B32-B39: `<a type="object"|"action">` links (B32:
 *   `action_open_unassigned_opportunities`, which also reaches C19, the
 *   same method; B33-39: the various report/new-record navigations) are
 *   compiled into `ViewButton`s. Every `ViewButton` click runs
 *   `KanbanController.beforeExecuteActionButton` first
 *   (`view_button_hook.js`); returning `false` cancels the click before any
 *   `call_kw`/`doAction`. B33-39's `type="action"` targets are left
 *   undefined on purpose below (no matching `defineActions` entry): if the
 *   guard ever let one of these through offline, the unmocked
 *   `/web/action/load` call would surface as an uncaught "action not
 *   found" error, failing the test -- the absence of any such error below
 *   is itself part of the proof, on top of the explicit `verifySteps([])`.
 * - C21: the kanban root's own `action="action_primary_channel_button"
 *   type="object"` (inherited unchanged from
 *   `sales_team.crm_team_view_kanban_dashboard`) is not a `ViewButton` --
 *   clicking the card body reaches `KanbanRecord.onGlobalClick`'s
 *   `openAction` branch directly, guarded separately.
 * - B76/B77: the card-menu toggler is a plain `<button>` with no
 *   `data-available-offline` (`kanban_record.xml`), so the framework's own
 *   `SELECTORS_TO_DISABLE` already disables it -- same mechanism
 *   `crm_offline_uncached_lead.test.js` already proves for the lead
 *   kanban's card menu. With the menu unreachable, both the color picker
 *   (B76) and the "Configuration" link (B77) inside it are unreachable too.
 *
 * Online, B32 (`type="object"`) and C21 (the card body, also
 * `type="object"`) are proven to genuinely still call their crm.team
 * method. B33-39 share the identical `beforeExecuteActionButton` gate with
 * no per-button distinction -- the same "same reasoning as B33" grouping
 * `offline_inventory.md` itself uses for B34/B36/B37/B38/B39 -- so this
 * mechanism-level proof covers them too, without needing a `defineActions`
 * round trip for each of the seven `type="action"` targets.
 */

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();

    _records = [{ id: 1, name: "Sales Team" }];

    _views = {
        kanban: `
            <kanban action="action_primary_channel_button" type="object">
                <templates>
                    <t t-name="menu">
                        <a role="menuitem" type="open" class="dropdown-item">Configuration</a>
                    </t>
                    <t t-name="card">
                        <field name="name"/>
                        <a name="action_open_unassigned_opportunities" type="object" class="o_b32_link">Unassigned Leads</a>
                        <a name="1" type="action" class="o_b33_link">Leads</a>
                        <a name="2" type="action" class="o_b34_link">Opportunities</a>
                        <a name="3" type="action" class="o_b35_link">New Lead</a>
                        <a name="4" type="action" class="o_b36_link">New Opportunity</a>
                        <a name="5" type="action" class="o_b37_link">Leads Report</a>
                        <a name="6" type="action" class="o_b38_link">Opportunities Report</a>
                        <a name="7" type="action" class="o_b39_link">Activities Report</a>
                    </t>
                </templates>
            </kanban>`,
    };
}

defineModels([Team]);
defineMailModels();

const ACTION_LINKS = [
    ".o_b33_link",
    ".o_b34_link",
    ".o_b35_link",
    ".o_b36_link",
    ".o_b37_link",
    ".o_b38_link",
    ".o_b39_link",
];

test("offline, every team dashboard link, the card click and the card menu are inert; online B32 and the card click still work (desktop)", async () => {
    onRpc("crm.team", "action_open_unassigned_opportunities", () => {
        expect.step("B32/C19");
        return false;
    });
    onRpc("crm.team", "action_primary_channel_button", () => {
        expect.step("C21");
        return false;
    });
    await mountView({ resModel: "crm.team", type: "kanban", arch: Team._views.kanban });

    await animationFrame(); // let any pending fetchStoreData() debounce settle first
    const setOffline = mockOffline();
    await setOffline(true);

    // B32/C19 and B33-B39: every `<a>` link issues no call_kw/doAction.
    await contains(".o_b32_link").click();
    for (const selector of ACTION_LINKS) {
        await contains(selector).click();
    }
    expect.verifySteps([]);

    // C21: clicking the card body (the bare "name" field renders as a
    // plain `<span>`, not an `<a>`, so `CANCEL_GLOBAL_CLICK` does not
    // exclude it) does not reach `action_primary_channel_button`.
    await contains(".o_kanban_record span").click();
    expect.verifySteps([]);

    // B76/B77: the menu toggler is disabled, so it cannot even be opened.
    expect(".o_kanban_record .o_dropdown_kanban button").toHaveAttribute("disabled");
    expect(".o_kanban_record .o_dropdown_kanban button").toHaveClass("o_disabled_offline");
    await contains(".o_kanban_record .o_dropdown_kanban button").click();
    expect(".o-dropdown--menu").toHaveCount(0); // unreachable: "Configuration" never shows
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);
    // `<a type="object">` kanban action buttons are compiled with a 300ms
    // debounce (card_compiler.js's `compileButton`) to guard against
    // double-submission; the offline click above already started that
    // window on this same button, so re-clicking it immediately would be
    // silently swallowed regardless of the gate -- let it elapse first.
    await advanceTime(300);

    // Online: the gate lets B32/C19 and C21 through again.
    await contains(".o_b32_link").click();
    expect.verifySteps(["B32/C19"]);
    await contains(".o_kanban_record span").click();
    expect.verifySteps(["C21"]);
});

// ---------------------------------------------------------------------------
// B77 (scrutiny finding 24): "Configuration" is a `type="open"` link, not a
// `ViewButton` -- it compiles to `KanbanRecord.triggerAction({type:'open'})`
// directly, bypassing both the `beforeExecuteActionButton` gate above and
// the card-root `onGlobalClick` guard. A menu opened online and left open
// when the connection drops bypasses the toggler's own disable pass too
// (`DropdownItem`s are never `<button>`s), so only a handler-level guard on
// `triggerAction` itself (`kanban_record_offline_patch.js`) can stop it.
// ---------------------------------------------------------------------------

test("offline, a team card menu opened online can't open Configuration afterward; online it still can", async () => {
    let selectRecordCalls = 0;
    await mountView({
        resModel: "crm.team",
        type: "kanban",
        arch: Team._views.kanban,
        selectRecord: () => selectRecordCalls++,
    });

    await contains(".o_kanban_record .o_dropdown_kanban button").click();
    expect(".dropdown-item:contains('Configuration')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".dropdown-item:contains('Configuration')").click();
    expect(selectRecordCalls).toBe(0); // unreachable: no navigation at all
    expect(".o-dropdown--menu").toHaveCount(0); // the item click still closes the dropdown itself

    await setOffline(false);
    await contains(".o_kanban_record .o_dropdown_kanban button").click();
    await contains(".dropdown-item:contains('Configuration')").click();
    expect(selectRecordCalls).toBe(1);
});

test.tags("mobile");
test("offline, every team dashboard link, the card click and the card menu are inert; online B32 and the card click still work (mobile)", async () => {
    onRpc("crm.team", "action_open_unassigned_opportunities", () => {
        expect.step("B32/C19");
        return false;
    });
    onRpc("crm.team", "action_primary_channel_button", () => {
        expect.step("C21");
        return false;
    });
    await mountView({ resModel: "crm.team", type: "kanban", arch: Team._views.kanban });

    await animationFrame(); // let any pending fetchStoreData() debounce settle first
    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_b32_link").click();
    for (const selector of ACTION_LINKS) {
        await contains(selector).click();
    }
    await contains(".o_kanban_record span").click();
    expect.verifySteps([]);

    expect(".o_kanban_record .o_dropdown_kanban button").toHaveAttribute("disabled");
    expect(".o_kanban_record .o_dropdown_kanban button").toHaveClass("o_disabled_offline");

    await setOffline(false);
    await advanceTime(300); // let B32's 300ms action-button debounce elapse

    await contains(".o_b32_link").click();
    expect.verifySteps(["B32/C19"]);
    await contains(".o_kanban_record span").click();
    expect.verifySteps(["C21"]);
});
