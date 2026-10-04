import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-mock";
import {
    contains,
    defineModels,
    fields,
    getService,
    models,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * A25 (VAL-DIS-014). `CrmShareTargetItem.updateTeams()`
 * (`webclient/share_target/crm_share_target_item.js`) guards the
 * `crm.team` `web_search_read` lookup its `onWillStart` issues as soon as
 * the dialog's "Lead" item renders: offline it leaves `teams`/
 * `selected_team` at their defaults instead of calling the server, which
 * would otherwise throw an uncaught `ConnectionLostError`. The dialog's
 * "Create" button is a plain `<button>` with no `data-available-offline`,
 * already disabled by the framework (`OfflinePlugin.SELECTORS_TO_DISABLE`)
 * -- these tests only prove the lookup itself is skipped and that the
 * button ends up disabled as a consequence, not a new guard on Create.
 *
 * The dialog is opened directly through the `"share_target"` service's
 * `display()` (not `_getShareTargetFiles`'s `WEB_CLIENT_READY` wiring,
 * and not a real `doAction()`): the former only fires once, right after
 * `WebClient` mounts, before this test gets a chance to go offline first;
 * the latter can't survive a cold start offline at all (`window_action.
 * test.js`'s "[Offline] execute unavailable action"), which isn't what's
 * under test here anyway -- the dialog is a plain `Dialog` mounted
 * through the generic `"dialog"` service, not an action/view.
 */
class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    company_id = fields.Many2one({ relation: "res.company" });

    _records = [
        { id: 1, name: "Sales Team", company_id: false },
        { id: 2, name: "Online Sales", company_id: false },
    ];
}

// VAL-DIS-014 (user-testing round 2 evidence): a minimal `crm.lead`
// stand-in, so the online Create tests below can let `ShareTargetItem.
// process()` run for real -- `name_create` through to the opened form --
// instead of stubbing it out, the way the generic web test
// (`share_target.test.js`) does for its own assertions.
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();

    _views = {
        form: `<form><field name="name"/></form>`,
    };
}

// `defineMailModels()` already provides its own `ir.attachment` mock
// model (used by the `ir.attachment` `write` the create flow issues
// below); adding another one here would double-register it.
defineModels([Team, Lead]);
defineMailModels();

const pngFile = new File([new Uint8Array(1)], "shared.png", { type: "image/png" });

test.tags("desktop");
test("online, opening the share-target dialog on the Lead item issues the crm.team lookup and leaves Create enabled", async () => {
    onRpc("crm.team", "web_search_read", ({ parent }) => {
        expect.step("web_search_read");
        return parent();
    });
    await mountWithCleanup(WebClient);
    getService("share_target").display([pngFile]);
    await animationFrame();
    expect(".o_dialog").toHaveCount(1);

    await contains(".modal-body button:contains('Lead')").click();
    expect.verifySteps(["web_search_read"]);
    expect(".modal-footer .btn-primary").not.toHaveAttribute("disabled");
});

test.tags("mobile");
test("online, opening the share-target dialog on the Lead item issues the crm.team lookup and leaves Create enabled (mobile)", async () => {
    onRpc("crm.team", "web_search_read", ({ parent }) => {
        expect.step("web_search_read");
        return parent();
    });
    await mountWithCleanup(WebClient);
    getService("share_target").display([pngFile]);
    await animationFrame();
    expect(".o_dialog").toHaveCount(1);

    await contains(".modal-body button:contains('Lead')").click();
    expect.verifySteps(["web_search_read"]);
    expect(".modal-footer .btn-primary").not.toHaveAttribute("disabled");
});

// VAL-DIS-014 (user-testing round 2 evidence): the two tests above only
// check that Create stays enabled online; they never click it. These two
// click it for real and let `ShareTargetItem.process()` run its whole
// chain (upload the file, `crm.lead.name_create`, link the attachment,
// open the created lead's form) to prove the create flow genuinely
// completes online, not just that the button isn't disabled.
test.tags("desktop");
test("online, clicking Create on the share-target dialog's Lead item uploads the file, creates the lead and opens it", async () => {
    onRpc("crm.team", "web_search_read", ({ parent }) => parent());
    onRpc("/web/binary/upload_attachment", () => {
        expect.step("upload_attachment");
        return [{ id: 666, filename: pngFile.name }];
    });
    onRpc("crm.lead", "name_create", ({ parent }) => {
        expect.step("name_create");
        return parent();
    });
    // The mocked upload above never actually creates attachment id 666 in
    // the `ir.attachment` mock model's own records, so the real `write`
    // implementation (which looks the record up by id) can't run; only
    // record that the write happened, the same way the generic web test
    // (`share_target.test.js`) checks `write`'s params without a real
    // backing record either.
    onRpc("ir.attachment", "write", () => {
        expect.step("attachment_write");
        return true;
    });
    await mountWithCleanup(WebClient);
    getService("share_target").display([pngFile]);
    await animationFrame();
    expect(".o_dialog").toHaveCount(1);

    await contains(".modal-body button:contains('Lead')").click();
    await contains(".modal-footer .btn-primary").click();
    await animationFrame();
    await animationFrame();

    expect.verifySteps(["upload_attachment", "name_create", "attachment_write"]);
    expect(".o_dialog").toHaveCount(0); // the share-target dialog closed after Create
    expect(".o_form_view").toHaveCount(1); // the created lead's own form opened
});

test.tags("mobile");
test("online, clicking Create on the share-target dialog's Lead item uploads the file, creates the lead and opens it (mobile)", async () => {
    onRpc("crm.team", "web_search_read", ({ parent }) => parent());
    onRpc("/web/binary/upload_attachment", () => {
        expect.step("upload_attachment");
        return [{ id: 666, filename: pngFile.name }];
    });
    onRpc("crm.lead", "name_create", ({ parent }) => {
        expect.step("name_create");
        return parent();
    });
    onRpc("ir.attachment", "write", () => {
        expect.step("attachment_write");
        return true;
    });
    await mountWithCleanup(WebClient);
    getService("share_target").display([pngFile]);
    await animationFrame();
    expect(".o_dialog").toHaveCount(1);

    await contains(".modal-body button:contains('Lead')").click();
    await contains(".modal-footer .btn-primary").click();
    await animationFrame();
    await animationFrame();

    expect.verifySteps(["upload_attachment", "name_create", "attachment_write"]);
    expect(".o_dialog").toHaveCount(0);
    expect(".o_form_view").toHaveCount(1);
});

test.tags("desktop");
test("offline, opening the share-target dialog on the Lead item issues no crm.team lookup and disables Create", async () => {
    onRpc("crm.team", "web_search_read", () => expect.step("web_search_read"));
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await setOffline(true);

    getService("share_target").display([pngFile]);
    await animationFrame();
    expect(".o_dialog").toHaveCount(1);

    await contains(".modal-body button:contains('Lead')").click();
    expect.verifySteps([]); // the crm.team lookup never fired
    expect(".modal-footer .btn-primary").toHaveAttribute("disabled");
    expect(".modal-footer .btn-primary").toHaveClass("o_disabled_offline");
    expect(".o_notification").toHaveCount(0); // no uncaught ConnectionLostError surfaced
    // The dialog's own Cancel button is a plain `<button>` too, with no
    // `data-available-offline`: offline it is just as disabled as Create,
    // so there's no click-driven way to close this dialog here -- expected,
    // not a gap this feature needs to plug (same blanket framework rule).
    expect(".modal-footer .btn-secondary").toHaveAttribute("disabled");
});

test.tags("mobile");
test("offline, opening the share-target dialog on the Lead item issues no crm.team lookup and disables Create (mobile)", async () => {
    onRpc("crm.team", "web_search_read", () => expect.step("web_search_read"));
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await setOffline(true);

    getService("share_target").display([pngFile]);
    await animationFrame();
    expect(".o_dialog").toHaveCount(1);

    await contains(".modal-body button:contains('Lead')").click();
    expect.verifySteps([]);
    expect(".modal-footer .btn-primary").toHaveAttribute("disabled");
    expect(".modal-footer .btn-primary").toHaveClass("o_disabled_offline");
    expect(".o_notification").toHaveCount(0);
});
