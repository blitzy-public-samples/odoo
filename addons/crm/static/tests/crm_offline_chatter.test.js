import {
    defineMailModels,
    insertText,
    onRpcBefore,
    openFormView,
    start,
    startServer,
    triggerHotkey,
} from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-dom";
import { contains, defineModels, fields, mockOffline, models } from "@web/../tests/web_test_helpers";

/**
 * Defect 8 (architecture.md §3.2 item 8 / offline_inventory.md row B14):
 * the chatter's primary actions (`Send message`, `Log note`, `Activity`,
 * `Attach files`, the followers toggler) are all plain `<button>`s with no
 * `data-available-offline` (`@mail/chatter/web/chatter.xml`), so the
 * framework's `SELECTORS_TO_DISABLE` already disables them offline on its
 * own (sets `disabled`) -- that part needs a reachability test, not a crm
 * code change. The companion `o_disabled_offline` class it also adds is
 * cosmetic only and gets wiped by the chatter's own next re-render (OWL
 * recomputes the whole `class` attribute from the template, overwriting
 * any class added to the DOM node from outside); only the `disabled`
 * attribute -- the one that actually blocks the button -- is asserted on.
 *
 * The one real gap: inside a chatter, `Composer.onKeydown`
 * (`@mail/core/common/composer.js`) sends on Ctrl+Enter/Cmd+Enter (plain
 * Enter only inserts a newline there; `this.env.inChatter` picks the
 * modifier-key branch) by calling `this.sendMessage()` directly, bypassing
 * the disabled Send-message button's DOM state entirely. A composer opened
 * while online and left open stays mounted (with its text) when the
 * connection drops, so Ctrl+Enter while offline could still fire
 * `message_post`. `core/common/composer_patch.js` closes that path for
 * `crm.lead` threads by making `sendMessage()` a no-op and forcing
 * `isSendButtonDisabled` while offline (VAL-FIX-012, VAL-DIS-004).
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    activity_ids = fields.One2many({ relation: "mail.activity" });
    message_ids = fields.One2many({ relation: "mail.message" });
    message_follower_ids = fields.Many2many({ relation: "mail.followers" });

    _records = [{ id: 1, name: "First lead" }];

    _views = {
        form: /* xml */ `
            <form>
                <sheet>
                    <field name="name"/>
                </sheet>
                <chatter/>
            </form>`,
    };
}

defineModels([Lead]);
defineMailModels();

// ---------------------------------------------------------------------------
// VAL-DIS-004: offline, the chatter's own buttons are disabled by the
// framework (reachability proof, not a crm code path).
// ---------------------------------------------------------------------------

test("offline, the chatter's primary action buttons are disabled", async () => {
    await startServer();
    await start();
    await openFormView("crm.lead", 1);
    await waitFor(".o-mail-Chatter-sendMessage");

    const setOffline = mockOffline();
    await setOffline(true);

    for (const selector of [
        ".o-mail-Chatter-sendMessage",
        ".o-mail-Chatter-logNote",
        ".o-mail-Chatter-attachFiles",
        ".o-mail-Followers-button",
    ]) {
        expect(selector).toHaveAttribute("disabled");
    }
});

// ---------------------------------------------------------------------------
// VAL-FIX-012 / VAL-DIS-004: the Ctrl+Enter bypass is closed for a
// crm.lead thread; re-enabled once back online (VAL-FIX-013).
// ---------------------------------------------------------------------------

test("offline, Ctrl+Enter in an already-open composer posts nothing and raises no error; online again it works", async () => {
    await startServer();
    onRpcBefore("/mail/message/post", () => expect.step("message_post"));
    await start();
    await openFormView("crm.lead", 1);
    await contains(".o-mail-Chatter-sendMessage").click();
    await insertText(".o-mail-Composer-input", "Hello while online");

    const setOffline = mockOffline();
    await setOffline(true);

    // The composer was already open and mounted before the connection
    // dropped: its DOM is untouched by `_offlineUI()` (it is not a
    // `<button>`), so without the patch Ctrl+Enter would still reach
    // `sendMessage()` directly -- which, since `mockOffline()` also fails
    // every actual RPC while offline, would surface as an uncaught
    // `ConnectionLostError` instead of silently succeeding (see the
    // non-crm.lead test below, where that is exactly what happens).
    await triggerHotkey("control+Enter");
    expect.verifySteps([]); // no message_post RPC was even attempted
    expect(".o-mail-Message").toHaveCount(0);
    // The text is still there: the no-op left the draft untouched instead
    // of silently discarding it.
    expect(".o-mail-Composer-input").toHaveValue("Hello while online");

    await setOffline(false);
    await triggerHotkey("control+Enter");
    expect.verifySteps(["message_post"]);
    await waitFor(".o-mail-Message-body:contains('Hello while online')");
});

// ---------------------------------------------------------------------------
// VAL-FIX-012 online guard: sending by Ctrl+Enter is unaffected online.
// ---------------------------------------------------------------------------

test("online, Ctrl+Enter in the composer still posts the message", async () => {
    await startServer();
    onRpcBefore("/mail/message/post", () => expect.step("message_post"));
    await start();
    await openFormView("crm.lead", 1);
    await contains(".o-mail-Chatter-sendMessage").click();
    await insertText(".o-mail-Composer-input", "Hello");
    await triggerHotkey("control+Enter");

    expect.verifySteps(["message_post"]);
    await waitFor(".o-mail-Message-body:contains('Hello')");
});

// ---------------------------------------------------------------------------
// Scope check: the patch only engages for a crm.lead thread. For every
// other model, the pre-existing Ctrl+Enter bypass still *attempts*
// `message_post` while offline, which now throws an uncaught
// `ConnectionLostError` instead of silently doing nothing -- a real,
// pre-existing gap in `@mail/core/common/composer.js` (not touched here,
// since this feature's scope is the crm.lead chatter; see discoveredIssues
// in the handoff).
// ---------------------------------------------------------------------------

test("offline, a non-crm.lead chatter's Ctrl+Enter still attempts message_post and throws an uncaught error (pre-existing @mail gap, out of scope)", async () => {
    const pyEnv = await startServer();
    const partnerId = pyEnv["res.partner"].create({ name: "A partner" });
    await start();
    await openFormView("res.partner", partnerId);
    await contains(".o-mail-Chatter-sendMessage").click();
    await insertText(".o-mail-Composer-input", "Hi");

    const setOffline = mockOffline();
    await setOffline(true);

    expect.errors(1);
    await triggerHotkey("control+Enter");
    // The RPC rejection (and the uncaught-error report it produces) lands
    // a tick after the hotkey's own handler returns.
    await animationFrame();

    expect.verifyErrors([
        `Connection to "/mail/message/post" couldn't be established or was interrupted`,
    ]);
    expect(".o-mail-Message").toHaveCount(0); // never actually posted
});
