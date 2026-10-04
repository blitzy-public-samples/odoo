import {
    click,
    defineMailModels,
    dragenterFiles,
    dropFiles,
    insertText,
    onRpcBefore,
    openFormView,
    pasteFiles,
    start,
    startServer,
    triggerHotkey,
} from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor, waitForNone } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-dom";
import {
    contains,
    defineModels,
    fields,
    getService,
    mockService,
    models,
    serverState,
} from "@web/../tests/web_test_helpers";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

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
 *
 * Scrutiny round-1 (confusingly, these are numbered independently of the
 * "Defect 8" above, which is this file's own pre-existing architecture.md
 * item number -- the three below are the *scrutiny* findings 8, 9 and 10):
 *
 * - Finding 8 (VAL-FIX-012, VAL-DIS-004): the followers dropdown's
 *   Follow/Unfollow/"Add Followers" (`FollowerList`, `mail/core/web/
 *   follower_list.js`) and each follower's own "Remove"
 *   (`Follower.onClickRemove`, `mail/core/web/follower.js`) are not
 *   `<button>`s either, so a dropdown opened online and left open across
 *   the connection drop stays fully clickable the same way the composer
 *   does above. `core/web/follower_list_patch.js` guards all four for a
 *   `crm.lead` thread.
 * - Finding 9 (VAL-DIS-004): editing an already-posted message
 *   (`Composer.editMessage()`, reached by Ctrl+Enter or the "save" text
 *   link in edit mode, not by `sendMessage()`) had no offline guard at
 *   all. `composer_patch.js` now guards `editMessage()` too, scoped by
 *   the *edited message's* own thread.
 * - Finding 10 (VAL-FIX-012, VAL-DIS-004): pasting or dropping a file
 *   into an already-open composer started an attachment upload with no
 *   offline check. `composer_patch.js` guards this via the `allowUpload`
 *   getter (covers paste, since mail's own `onPaste` already gates on it)
 *   and a dedicated `onDropFile()` guard (drop has no such internal
 *   check).
 *
 * Test stability (m2-test-stability-partner-link / m2-fix-lists-queue-tests):
 * mounting the chatter (and typing into its composer) can leave one of
 * @mail's own debounced fetchStoreData() calls still pending
 * (Store.FETCH_DATA_DEBOUNCE_DELAY, @mail/core/common/store_service.js --
 * a 1ms debounce around the /mail/store RPC). waitFor(".o-mail-Chatter-
 * sendMessage") and insertText() only wait for the DOM they touch, not
 * for that unrelated timer; if it is still pending when the connection
 * flips, the debounced RPC fires straight into the simulated outage and
 * surfaces as an uncaught ConnectionLostError moments later -- unrelated
 * to anything this file asserts, but enough to fail whichever test
 * happened to be running at the time (observed on tests all over this
 * file, and even in unrelated files elsewhere in the suite once the
 * rejection resolves a tick late). mockCrmOffline()
 * (crm_test_helpers.js), used throughout this file instead of the raw
 * web_test_helpers mockOffline(), waits for the store's own
 * isReadyPromise plus one more animationFrame() before every
 * setOffline(true), so that fetch settles successfully while still
 * online instead of racing the drop. The remaining standalone
 * animationFrame() calls below are for an unrelated tick (the
 * *reported* error's own settling, each noted at its call site).
 */

class Lead extends models.Model {
    _name = "crm.lead";

    // mail's own `has_activities` wiring (base.js's `ServerModel.prototype`
    // patch to `get_views()`) only fires for models extending
    // `models.ServerModel`; this file's `Lead` extends plain `models.Model`,
    // like every other crm offline mock, so the patch's `get_views` is never
    // in its prototype chain. Without this override `webChatterProps.
    // has_activities` stays false, the "Activity" button (chatter.xml:25)
    // never renders, and VAL-DIS-004's "no uncaught error" would otherwise
    // vacuously substitute for a real disabled-button check on it.
    get_views(...args) {
        const result = super.get_views(...args);
        for (const modelName of Object.keys(result.models)) {
            result.models[modelName].has_activities = true;
        }
        return result;
    }

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

/**
 * Test stability (m2-fix-chatter-paste-drop-flake): clicking "Send message"
 * toggles `composerType` (`chatter.js`'s `toggleComposer`), but the button
 * carries `t-att-disabled="!this.state.thread.canPostMessage and
 * this.thread().id"` (`chatter.xml`). `canPostMessage` is derived from
 * `hasReadAccess`/`hasWriteAccess`, which start `undefined` and are only
 * set once the chatter's own mount-time `fetchThreadData()`
 * (`thread_model_patch.js`) round-trips through the same debounced
 * `/mail/store` fetch `mockCrmOffline()` above guards before going offline
 * -- here the fetch races the click itself, not the offline switch.
 * `openFormView()` does not wait for that fetch, and hoot's `click()`
 * checks `target.disabled` and silently skips dispatching any event on a
 * disabled target (`hoot-dom/helpers/events.js`): an unlucky timing makes
 * the click a complete no-op, with no error, and the composer never
 * mounts -- surfacing moments later as a `waitFor(".o-mail-Composer-
 * input")` timeout instead of a clear cause (the intermittent mobile-
 * preset failure this closes). Waiting for the button to actually be
 * enabled first makes the click deterministic regardless of system load.
 */
async function clickSendMessage() {
    await waitFor(".o-mail-Chatter-sendMessage:enabled");
    await contains(".o-mail-Chatter-sendMessage").click();
}

// ---------------------------------------------------------------------------
// VAL-DIS-004: offline, the chatter's own buttons are disabled by the
// framework (reachability proof, not a crm code path).
// ---------------------------------------------------------------------------

test("offline, the chatter's primary action buttons are disabled", async () => {
    await startServer();
    await start();
    await openFormView("crm.lead", 1);
    await waitFor(".o-mail-Chatter-sendMessage");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    for (const selector of [
        ".o-mail-Chatter-sendMessage",
        ".o-mail-Chatter-logNote",
        ".o-mail-Chatter-activity",
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
    await clickSendMessage();
    await insertText(".o-mail-Composer-input", "Hello while online");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    // The composer was already open and mounted before the connection
    // dropped: its DOM is untouched by `_offlineUI()` (it is not a
    // `<button>`), so without the patch Ctrl+Enter would still reach
    // `sendMessage()` directly -- which, since `mockCrmOffline()` also fails
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
    await clickSendMessage();
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
    await clickSendMessage();
    await insertText(".o-mail-Composer-input", "Hi");
    const setOffline = mockCrmOffline();
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

// ---------------------------------------------------------------------------
// Scrutiny finding 8 (VAL-FIX-012, VAL-DIS-004): the followers dropdown's
// Follow/Unfollow/"Add Followers" and each follower's own "Remove" are not
// `<button>`s, so a dropdown opened online and left open across the
// connection drop stays fully clickable without the patch.
//
// Scrutiny round 2: a handler guard alone leaves the dropdown's items
// visibly enabled offline, which VAL-FIX-012 forbids. `follower_list_patch.js`
// now closes the whole dropdown the moment the connection drops (for a
// `crm.lead` thread); these three tests assert that visible closed state
// -- the items are gone, not just inert -- in addition to the handler
// guard still proven by the "no RPC" assertion.
// ---------------------------------------------------------------------------

test("offline, an already-open followers dropdown closes (taking Follow with it); online it still works", async () => {
    await startServer();
    onRpcBefore("/mail/thread/subscribe", () => expect.step("subscribe"));
    await start();
    await openFormView("crm.lead", 1);
    await click(".o-mail-Followers-button");
    await waitFor(".o-dropdown-item:text('Follow')");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Without the patch, "Follow" (a `DropdownItem`/`<a>`, not a
    // `<button>`) would stay visibly enabled and clickable here, the same
    // open-before-offline gap as the composer's Ctrl+Enter above. The
    // patch instead closes the whole dropdown as soon as `isOffline()`
    // flips, so the item is gone, not merely inert, and the toggler
    // itself is disabled like any other offline `<button>` (first test of
    // this file), leaving no way to reopen it.
    await waitForNone(".o-dropdown-item:text('Follow')");
    expect(".o-mail-Followers-button").toHaveAttribute("disabled");
    expect.verifySteps([]);
    expect(".o-mail-Followers-counter").toHaveText("0");

    await setOffline(false);
    await click(".o-mail-Followers-button");
    await click(".o-dropdown-item:text('Follow')");
    // DropdownItem's onClick fires `onSelected` without awaiting it, so the
    // subscribe RPC can still be in flight when `click()` resolves; wait
    // for the step instead of asserting it immediately.
    await expect.waitForSteps(["subscribe"]);
    await waitFor(".o-mail-Followers-counter:text('1')");
});

test("offline, an already-open followers dropdown closes (taking Add Followers with it); online it still works", async () => {
    await startServer();
    mockService("action", {
        doAction(action, options) {
            if (action?.res_model !== "mail.followers.edit") {
                return super.doAction(...arguments);
            }
            expect.step("add_followers_action");
            options.onClose?.();
        },
    });
    await start();
    await openFormView("crm.lead", 1);
    await click(".o-mail-Followers-button");
    await waitFor("a:text('Add Followers')");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    await waitForNone("a:text('Add Followers')");
    expect(".o-mail-Followers-button").toHaveAttribute("disabled");
    expect.verifySteps([]);

    await setOffline(false);
    await click(".o-mail-Followers-button");
    await click("a:text('Add Followers')");
    expect.verifySteps(["add_followers_action"]);
});

test("offline, an already-open followers dropdown closes (taking a follower's Remove with it); online it still works", async () => {
    const pyEnv = await startServer();
    const partnerId = pyEnv["res.partner"].create({ name: "A follower" });
    pyEnv["mail.followers"].create({
        partner_id: partnerId,
        is_active: true,
        res_id: 1,
        res_model: "crm.lead",
    });
    onRpcBefore("/mail/thread/unsubscribe", () => expect.step("unsubscribe"));
    await start();
    await openFormView("crm.lead", 1);
    await click(".o-mail-Followers-button");
    await waitFor(".o-mail-Follower");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    // "Remove this follower" is a plain `<span>` (`@mail/core/web/
    // follower.xml`), inside the same dropdown content as `FollowerList`
    // -- closing the dropdown unmounts it along with everything else.
    await waitForNone(".o-mail-Follower");
    expect(".o-mail-Followers-button").toHaveAttribute("disabled");
    expect.verifySteps([]);

    await setOffline(false);
    await click(".o-mail-Followers-button");
    await click("[title='Remove this follower']");
    // Same fire-and-forget `onSelected` timing as the Follow test above.
    await expect.waitForSteps(["unsubscribe"]);
    await waitForNone(".o-mail-Follower");
});

// `onClickUnfollow` (self removing their own followership through
// `FollowerList`) is a separate code path from both `onClickFollow` above
// and `Follower.onClickRemove` (a *different* follower's own "Remove",
// just above) -- it only renders once the current user already follows
// the thread (`follower_list.xml`'s `t-if="thread.selfFollower"`), so it
// needs becoming a follower first instead of a seeded `mail.followers`
// record for someone else.
test("offline, an already-open followers dropdown closes (taking Unfollow with it); online it still works", async () => {
    await startServer();
    onRpcBefore("/mail/thread/unsubscribe", () => expect.step("unsubscribe"));
    await start();
    await openFormView("crm.lead", 1);
    await click(".o-mail-Followers-button");
    await click(".o-dropdown-item:text('Follow')");
    await waitFor(".o-mail-Followers-counter:text('1')");

    await click(".o-mail-Followers-button");
    await waitFor(".o-dropdown-item:text('Unfollow')");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    await waitForNone(".o-dropdown-item:text('Unfollow')");
    expect(".o-mail-Followers-button").toHaveAttribute("disabled");
    expect.verifySteps([]);
    expect(".o-mail-Followers-counter").toHaveText("1"); // still following: nothing was sent

    await setOffline(false);
    await click(".o-mail-Followers-button");
    await click(".o-dropdown-item:text('Unfollow')");
    await expect.waitForSteps(["unsubscribe"]);
    await waitFor(".o-mail-Followers-counter:text('0')");
});

// ---------------------------------------------------------------------------
// Scope check: the follower-action patch only engages for a crm.lead
// thread. For every other model, Follow still *attempts* `subscribe`
// while offline, same pre-existing @mail gap as above.
// ---------------------------------------------------------------------------

test("offline, a non-crm.lead chatter's Follow still attempts subscribe and throws an uncaught error (pre-existing @mail gap, out of scope)", async () => {
    const pyEnv = await startServer();
    const partnerId = pyEnv["res.partner"].create({ name: "A partner" });
    await start();
    await openFormView("res.partner", partnerId);
    await click(".o-mail-Followers-button");
    await waitFor(".o-dropdown-item:text('Follow')");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect.errors(1);
    await click(".o-dropdown-item:text('Follow')");
    await animationFrame();

    expect.verifyErrors([
        `Connection to "/mail/thread/subscribe" couldn't be established or was interrupted`,
    ]);
    expect(".o-mail-Followers-counter").toHaveText("0"); // never actually followed
});

// `Follower.onClickRemove` is a separate override, in a separate class,
// scoped independently of `FollowerList`'s -- worth its own scope check.
test("offline, a non-crm.lead chatter's remove-follower still attempts unsubscribe and throws an uncaught error (pre-existing @mail gap, out of scope)", async () => {
    const pyEnv = await startServer();
    const [partnerId_1, partnerId_2] = pyEnv["res.partner"].create([
        { name: "Partner1" },
        { name: "Partner2" },
    ]);
    pyEnv["mail.followers"].create({
        partner_id: partnerId_2,
        is_active: true,
        res_id: partnerId_1,
        res_model: "res.partner",
    });
    await start();
    await openFormView("res.partner", partnerId_1);
    await click(".o-mail-Followers-button");
    await waitFor(".o-mail-Follower");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect.errors(1);
    await click("[title='Remove this follower']");
    await animationFrame();

    expect.verifyErrors([
        `Connection to "/mail/thread/unsubscribe" couldn't be established or was interrupted`,
    ]);
    await waitFor(".o-mail-Follower"); // never actually removed
});

// ---------------------------------------------------------------------------
// Scrutiny finding 9 (VAL-DIS-004): editing an already-posted message
// reaches `Composer.editMessage()` by Ctrl+Enter or the "save" text link,
// neither of which goes through `sendMessage()` -- the guard above never
// ran for an edit, and edit mode's "save" is a plain, never-disabled span.
// ---------------------------------------------------------------------------

test("offline, saving an already-open message edit does nothing by Ctrl+Enter or the save link; online it still works", async () => {
    const pyEnv = await startServer();
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "original message",
        message_type: "comment",
        model: "crm.lead",
        res_id: 1,
    });
    onRpcBefore("/mail/message/update_content", () => expect.step("update_content"));
    await start();
    await openFormView("crm.lead", 1);
    // Unlike a real mail.thread model (e.g. res.partner below), this mock
    // Lead has no reaction feature, so "Edit" (the lowest-sequence action
    // for a self-authored message) is the sole quick action -- its own
    // `title="Edit"` button, not inside the "..." overflow dropdown.
    await click(".o-mail-Message [title='Edit']");
    await waitFor(".o-mail-Message .o-mail-Composer.o-focused");
    await insertText(".o-mail-Message .o-mail-Composer-input", "edited while online", {
        replace: true,
    });
    const setOffline = mockCrmOffline();
    await setOffline(true);

    // The edit composer was already open before the connection dropped:
    // without the patch, either path below would still reach
    // `editMessage()` and attempt `update_content`.
    await triggerHotkey("control+Enter");
    expect.verifySteps([]);
    expect(".o-mail-Message .o-mail-Composer-input").toHaveValue("edited while online");
    // The "save" text link only renders `!this.ui.isSmall`
    // (`composer.xml`); on a small screen, Ctrl+Enter above is the only
    // way to reach `editMessage()` at all, so there is nothing extra to
    // click here under the mobile preset.
    const ui = getService("ui");
    if (!ui.isSmall) {
        await click(".o-mail-Message button:text('save')");
        expect.verifySteps([]);
        expect(".o-mail-Message .o-mail-Composer-input").toHaveValue("edited while online");
    }
    expect(".o-mail-Message-body:contains('(edited)')").toHaveCount(0);

    await setOffline(false);
    if (!ui.isSmall) {
        await click(".o-mail-Message button:text('save')");
    } else {
        await triggerHotkey("control+Enter");
    }
    // Same fire-and-forget `onClickCancelOrSaveEditText` timing as the
    // follower RPCs above (it calls `editMessage()` without awaiting it).
    await expect.waitForSteps(["update_content"]);
    await waitFor(".o-mail-Message-body:contains('edited while online (edited)')");
});

// ---------------------------------------------------------------------------
// Scope check: the edit-message patch only engages for a crm.lead thread.
// ---------------------------------------------------------------------------

test("offline, a non-crm.lead chatter's message edit still attempts update_content and throws an uncaught error (pre-existing @mail gap, out of scope)", async () => {
    const pyEnv = await startServer();
    const partnerId = pyEnv["res.partner"].create({ name: "A partner" });
    pyEnv["mail.message"].create({
        author_id: serverState.partnerId,
        body: "original message",
        message_type: "comment",
        model: "res.partner",
        res_id: partnerId,
    });
    await start();
    await openFormView("res.partner", partnerId);
    await click(".o-mail-Message [title='Expand']");
    await click(".o-dropdown-item:text('Edit')");
    await insertText(".o-mail-Message .o-mail-Composer-input", " edited", { replace: true });
    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect.errors(1);
    // The "save" text link only renders `!this.ui.isSmall`
    // (`composer.xml`); Ctrl+Enter reaches the same `editMessage()` call
    // either way.
    if (getService("ui").isSmall) {
        await triggerHotkey("control+Enter");
    } else {
        await click(".o-mail-Message button:text('save')");
    }
    await animationFrame();

    expect.verifyErrors([
        `Connection to "/mail/message/update_content" couldn't be established or was interrupted`,
    ]);
});

// ---------------------------------------------------------------------------
// Scrutiny finding 10 (VAL-FIX-012, VAL-DIS-004): pasting or dropping a
// file into an already-open composer started an attachment upload with
// no offline check at all.
// ---------------------------------------------------------------------------

test("offline, pasting or dropping a file into an already-open composer does nothing; online it still works", async () => {
    await startServer();
    // The DOM-only assertions below (no `.o-mail-AttachmentContainer`)
    // would also pass if the upload were attempted but merely never
    // finished rendering; recording the actual HTTP route proves the
    // request itself was never sent, not just that its result never
    // appeared.
    onRpcBefore("/mail/attachment/upload", () => expect.step("attachment_upload"));
    await start();
    await openFormView("crm.lead", 1);
    await clickSendMessage();
    // Unlike the Ctrl+Enter/follower tests above, nothing here types into
    // the composer afterwards, so there is no implicit wait for it to
    // actually be in the DOM; wait for it explicitly before going offline
    // below (the click above is already deterministic -- see
    // `clickSendMessage()` -- but OWL's own render of the newly-toggled
    // composer still lands a tick later).
    await waitFor(".o-mail-Composer-input");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    const file = new File(["hello, world"], "text.txt", { type: "text/plain" });
    // Paste: mail's own `onPaste` already gates on the `allowUpload`
    // getter this feature overrides, so this proves that override closes
    // the path on its own.
    await pasteFiles(".o-mail-Composer-input", [file]);
    expect(".o-mail-AttachmentContainer").toHaveCount(0);
    // Drop: the dropzone's own enablement predicate reads the raw
    // `allowUpload` *prop* (always true from the chatter), not the
    // getter, so it still renders -- `onDropFile` needs its own guard,
    // which this proves. The chatter itself also registers its own
    // dropzone (`chatter_patch.js`) that reacts to the same drag event, so
    // two `.o-Dropzone` elements coexist; target the composer's own
    // (`extraClass: "o-mail-Composer-dropzone"` in `composer.js`).
    await dragenterFiles(".o-mail-Composer-input", [file]);
    await waitFor(".o-Dropzone.o-mail-Composer-dropzone");
    await dropFiles(".o-Dropzone.o-mail-Composer-dropzone", [file]);
    expect(".o-mail-AttachmentContainer").toHaveCount(0);
    expect.verifySteps([]); // neither the paste nor the drop ever reached the upload route

    await setOffline(false);
    await pasteFiles(".o-mail-Composer-input", [file]);
    await waitFor(".o-mail-AttachmentContainer:not(.o-isUploading):contains('text.txt')");
    expect.verifySteps(["attachment_upload"]); // back online, the same paste genuinely uploads
});

// ---------------------------------------------------------------------------
// Scope check: the paste/drop patch only engages for a crm.lead thread.
// ---------------------------------------------------------------------------

test("offline, a non-crm.lead chatter's paste still attempts the upload (pre-existing @mail gap, out of scope)", async () => {
    const pyEnv = await startServer();
    const partnerId = pyEnv["res.partner"].create({ name: "A partner" });
    await start();
    await openFormView("res.partner", partnerId);
    await clickSendMessage();
    // Nothing types into the composer before going offline, so there is
    // no implicit wait for it to actually be in the DOM; wait for it
    // explicitly (the click above is already deterministic -- see
    // `clickSendMessage()` -- but OWL's own render of the newly-toggled
    // composer still lands a tick later).
    await waitFor(".o-mail-Composer-input");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    getService("file_upload").bus.addEventListener("FILE_UPLOAD_ADDED", () =>
        expect.step("upload_added")
    );
    const file = new File(["hello, world"], "text.txt", { type: "text/plain" });
    await pasteFiles(".o-mail-Composer-input", [file]);
    // Unlike the message-post/edit/follower RPCs above, the file upload
    // goes through the raw `XMLHttpRequest` the `file_upload` service
    // builds (`file_upload_service.js`), not `orm`/`rpc`; unguarded here
    // (this is the non-crm.lead scope check), the paste still reaches
    // that service and fires the upload (`FILE_UPLOAD_ADDED`), instead of
    // crm.lead's silent no-op above which never gets this far. The
    // request itself then fails once it reaches the network -- hoot's
    // `MockXMLHttpRequest.send()` relays through `fetch()`, so
    // `mockCrmOffline()`'s catch-all still 502s it -- but that is the same
    // outcome any model gets while actually offline; it is not the gap
    // this scope check is about.
    await expect.waitForSteps(["upload_added"]);
});

// ---------------------------------------------------------------------------
// Scrutiny round 2 (VAL-FIX-012, VAL-DIS-004): with the composer closed
// (the chatter's default state), a *second*, independent dropzone --
// registered by the chatter itself (`@mail/chatter/web/chatter_patch.js`'s
// own `useCustomDropzone`, enabled whenever the thread `canPostMessage`,
// regardless of `composerType`) -- still called `uploadFile()`
// unconditionally. `chatter/web_portal_project/chatter_patch.js` closes
// that gap by swapping in a guarded `attachmentUploader` for a `crm.lead`
// thread while offline.
// ---------------------------------------------------------------------------

test("offline, dropping a file onto the chatter's own dropzone (composer closed) does nothing; online it still works", async () => {
    await startServer();
    onRpcBefore("/mail/attachment/upload", () => expect.step("attachment_upload"));
    await start();
    await openFormView("crm.lead", 1);
    // The composer is closed by default (`clickSendMessage()` is not
    // called here, unlike the composer-dropzone test above) -- this is
    // exactly the state in which the chatter-level dropzone, not the
    // composer's own, is the one a drop reaches.
    await waitFor(".o-mail-Chatter");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    const file = new File(["hello, world"], "text.txt", { type: "text/plain" });
    await dragenterFiles(".o-mail-Chatter", [file]);
    await waitFor(".o-Dropzone.o-mail-Chatter-dropzone");
    await dropFiles(".o-Dropzone.o-mail-Chatter-dropzone", [file]);
    expect(".o-mail-AttachmentContainer").toHaveCount(0);
    expect.verifySteps([]); // the drop never reached the upload route

    await setOffline(false);
    await dragenterFiles(".o-mail-Chatter", [file]);
    await waitFor(".o-Dropzone.o-mail-Chatter-dropzone");
    await dropFiles(".o-Dropzone.o-mail-Chatter-dropzone", [file]);
    await waitFor(".o-mail-AttachmentContainer:not(.o-isUploading):contains('text.txt')");
    expect.verifySteps(["attachment_upload"]); // back online, the same drop genuinely uploads
});

// ---------------------------------------------------------------------------
// Scope check: the chatter-level dropzone guard only engages for a
// crm.lead thread.
// ---------------------------------------------------------------------------

test("offline, a non-crm.lead chatter's own dropzone (composer closed) still attempts the upload (pre-existing @mail gap, out of scope)", async () => {
    const pyEnv = await startServer();
    const partnerId = pyEnv["res.partner"].create({ name: "A partner" });
    await start();
    await openFormView("res.partner", partnerId);
    await waitFor(".o-mail-Chatter");
    const setOffline = mockCrmOffline();
    await setOffline(true);

    getService("file_upload").bus.addEventListener("FILE_UPLOAD_ADDED", () =>
        expect.step("upload_added")
    );
    const file = new File(["hello, world"], "text.txt", { type: "text/plain" });
    await dragenterFiles(".o-mail-Chatter", [file]);
    await waitFor(".o-Dropzone.o-mail-Chatter-dropzone");
    await dropFiles(".o-Dropzone.o-mail-Chatter-dropzone", [file]);
    // Unguarded here (this is the non-crm.lead scope check): the drop
    // still reaches the `file_upload` service and fires the upload, same
    // as the composer-dropzone scope check above.
    await expect.waitForSteps(["upload_added"]);
});
