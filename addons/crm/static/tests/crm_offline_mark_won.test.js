import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { animationFrame, expect, runAllTimers, test } from "@odoo/hoot";
import { press } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    MockServer,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { user } from "@web/core/user";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * m3-mark-won (architecture.md §3.3, offline_inventory.md rows B1/C6,
 * VAL-DATA-005/006/007): the form's "Won" button is bound to
 * `action_set_won_rainbowman` (C8, DISABLE as a method -- it runs a heavy
 * SQL read and returns an effect action needing a live round trip). The
 * offline producer in `crm_form.js`'s `CrmFormController` bypasses that
 * wrapper entirely and queues the plain `action_set_won` (C6, QUEUE)
 * directly, exactly like the existing Restore producer
 * (`crm_offline_systray_restore.test.js`) bypasses nothing but queues its
 * own bare `[[id]]` call -- same `record.save()`-first ordering, same
 * `record.data`-only optimistic UI technique, now shared through
 * `CrmFormController._queueLeadCallOffline`.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    type = fields.Selection({ selection: [["lead", "Lead"], ["opportunity", "Opportunity"]] });
    active = fields.Boolean({ default: true });
    won_status = fields.Selection({
        selection: [
            ["won", "Won"],
            ["pending", "In Progress"],
            ["lost", "Lost"],
        ],
    });

    _records = [
        { id: 1, name: "Open Opportunity", type: "opportunity", active: true, won_status: "pending" },
    ];

    _views = {
        form: `
            <form js_class="crm_form">
                <header>
                    <button name="action_set_won_rainbowman" string="Won"
                        type="object" class="oe_highlight" data-hotkey="w"
                        data-available-offline=""
                        invisible="won_status == 'won' or type == 'lead' or not active"/>
                    <field name="type" invisible="1"/>
                    <field name="active" invisible="1"/>
                    <field name="won_status" invisible="1"/>
                </header>
                <widget name="web_ribbon" title="Won" invisible="won_status != 'won'"/>
                <field name="name" required="1"/>
            </form>`,
        search: `<search/>`,
    };
}

defineModels([Lead]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Open Opportunity",
        res_model: "crm.lead",
        res_id: 1,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    },
]);

test.tags("desktop");
test("offline, Won queues action_set_won (not action_set_won_rainbowman), shows the won ribbon at once, and replays on reconnect (desktop)", async () => {
    const replayedKwargs = [];
    onRpc("crm.lead", "action_set_won_rainbowman", () => expect.step("action_set_won_rainbowman"));
    onRpc("crm.lead", "get_rainbowman_message", () => expect.step("get_rainbowman_message"));
    onRpc("crm.lead", "action_set_won", function ({ args, kwargs }) {
        expect.step("action_set_won");
        replayedKwargs.push(kwargs);
        this.env["crm.lead"].write(args[0], { won_status: "won" });
        return true;
    });
    await mountWithCleanup(WebClient);
    // Visit the form online first so it is in the RPC disk cache
    // (visited): irrelevant to this fix (Won queues regardless), but
    // matches how a user would actually reach this screen.
    await getService("action").doAction(1);
    expect("button[name='action_set_won_rainbowman']").toHaveCount(1);
    expect(".ribbon span").toHaveCount(0); // not won yet

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains("button[name='action_set_won_rainbowman']").click();
    expect.verifySteps([]); // no RPC: queued, not sent -- no rainbowman lookup either

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("action_set_won");
    expect(value.args).toEqual([[1]]);
    expect(typeof value.extras.timeStamp).toBe("number");
    // "the context in kwargs" (VAL-DATA-005): the record's own eval
    // context, carrying the current user, not an empty kwargs object.
    expect(Object.keys(value.kwargs)).toEqual(["context"]);
    expect(value.kwargs.context.uid).toBe(user.userId);

    // Optimistic UI: won_status flips locally, so the button's own
    // `invisible="won_status == 'won' or ..."` hides it without a round trip,
    // and the real Won ribbon ("the form shows the won state immediately")
    // appears at once, before any replay.
    expect("button[name='action_set_won_rainbowman']").toHaveCount(0);
    expect(".ribbon span").toHaveCount(1);
    expect(".ribbon span").toHaveText(/^won$/i);
    expect(".o_notification").toHaveCount(0);
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0); // no rainbowman effect offline

    // The systray already shows the queued call as "Won"
    // (offline_systray_patch.js).
    await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
    expect(".o-dropdown--menu .o-dropdown-item div.ms-auto").toHaveText("Won");

    await setOffline(false);
    expect.verifySteps(["action_set_won"]); // replayed verbatim; still no rainbowman call
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).won_status).toBe("won");
    expect(".ribbon span").toHaveText(/^won$/i); // still won after replay
    // "context in kwargs" survives the replay unchanged (replayed
    // verbatim). Compared on `.context` alone, not the whole kwargs
    // object: the mock server's own call wrapper tags the kwargs object it
    // hands to `onRpc` with an internal `is_kwargs` marker Symbol that the
    // queue's own copy never had.
    expect(replayedKwargs.length).toBe(1);
    expect(replayedKwargs[0].context).toEqual(value.kwargs.context);
});

test.tags("mobile");
test("offline, Won queues action_set_won (not action_set_won_rainbowman), shows the won ribbon at once, and replays on reconnect (mobile)", async () => {
    const replayedKwargs = [];
    onRpc("crm.lead", "action_set_won_rainbowman", () => expect.step("action_set_won_rainbowman"));
    onRpc("crm.lead", "get_rainbowman_message", () => expect.step("get_rainbowman_message"));
    onRpc("crm.lead", "action_set_won", function ({ args, kwargs }) {
        expect.step("action_set_won");
        replayedKwargs.push(kwargs);
        this.env["crm.lead"].write(args[0], { won_status: "won" });
        return true;
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect("button[name='action_set_won_rainbowman']").toHaveCount(1);
    expect(".ribbon span").toHaveCount(0); // not won yet

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains("button[name='action_set_won_rainbowman']").click();
    expect.verifySteps([]);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("action_set_won");
    expect(value.args).toEqual([[1]]);
    // "the context in kwargs" (VAL-DATA-005), same as the desktop case.
    expect(Object.keys(value.kwargs)).toEqual(["context"]);
    expect(value.kwargs.context.uid).toBe(user.userId);

    expect("button[name='action_set_won_rainbowman']").toHaveCount(0);
    // "The form shows the won state (Won ribbon/status) immediately."
    expect(".ribbon span").toHaveCount(1);
    expect(".ribbon span").toHaveText(/^won$/i);
    expect(".o_notification").toHaveCount(0);
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0);

    // Mobile's systray toggler is a bare div, not the Dropdown's own
    // button (same extra frame `crm_offline_systray_restore.test.js`'s
    // mobile systray test needs).
    await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
    await animationFrame();
    expect(".o-dropdown--menu .o-dropdown-item div.ms-auto").toHaveText("Won");

    await setOffline(false);
    expect.verifySteps(["action_set_won"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).won_status).toBe("won");
    expect(".ribbon span").toHaveText(/^won$/i); // still won after replay
    // "context in kwargs" survives the replay unchanged (replayed
    // verbatim), compared on `.context` alone for the same reason as the
    // desktop case above.
    expect(replayedKwargs.length).toBe(1);
    expect(replayedKwargs[0].context).toEqual(value.kwargs.context);
});

test.tags("desktop");
test("online, Won still calls action_set_won_rainbowman and shows the rainbowman effect; nothing is queued (desktop)", async () => {
    onRpc("crm.lead", "action_set_won_rainbowman", function ({ args }) {
        expect.step("action_set_won_rainbowman");
        this.env["crm.lead"].write(args[0], { won_status: "won" });
        // The real `/web/dataset/call_button` controller fills in a
        // missing `type` with `ir.actions.act_window_close`
        // (`clean_action`, addons/web/controllers/utils.py) before the
        // client ever sees it; `onRpc` bypasses that controller, so the
        // mock must reproduce it, or `doAction` rejects an action with no
        // `type` of its own.
        return {
            type: "ir.actions.act_window_close",
            effect: { type: "rainbow_man", message: "Yeah!" },
        };
    });
    onRpc("crm.lead", "action_set_won", () => expect.step("action_set_won"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    await contains("button[name='action_set_won_rainbowman']").click();
    expect.verifySteps(["action_set_won_rainbowman"]); // online: the real wrapper is still called
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(1);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect("button[name='action_set_won_rainbowman']").toHaveCount(0);
});

// ---------------------------------------------------------------------------
// m5-fix-online-guards (VAL-REPO-013 clause (b)): CrmFormController's
// onPatched/effect handler used to recompute the Won button's `disabled` on
// every patch *and* on every `isOffline()` change, unconditionally
// (`el.disabled = offline && !resId`), which is always `false` once online.
// web's own `executeButtonCallback`
// (addons/web/static/src/views/view_button/view_button_hook.js) disables
// every enabled button in the view *before* calling the button's action, to
// close exactly this double-submit window, and only re-enables them once the
// action settles. Anything that re-runs CRM's own sync logic while that
// action is still in flight (here, a brief connectivity blip -- `effect()`
// re-runs on every `isOffline()` change "independently of whether anything
// else causes this controller to re-render", per the comment above) must not
// clear that in-flight disable. The fix marks the button with a dataset flag
// only when CRM itself disabled it (offline, unsaved lead); the sync logic
// then only ever touches `disabled` when that flag is present, so a stray
// run during a pending action leaves web's own disable alone.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("online, Won stays disabled by a brief offline blip while action_set_won_rainbowman is pending (desktop)", async () => {
    const wonDeferred = Promise.withResolvers();
    onRpc("crm.lead", "action_set_won_rainbowman", function ({ args }) {
        expect.step("action_set_won_rainbowman");
        return wonDeferred.promise.then(() => {
            this.env["crm.lead"].write(args[0], { won_status: "won" });
            return {
                type: "ir.actions.act_window_close",
                effect: { type: "rainbow_man", message: "Yeah!" },
            };
        });
    });
    onRpc("crm.lead", "action_set_won", () => expect.step("action_set_won"));
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const wonButton = "button[name='action_set_won_rainbowman']";
    const nameInput = ".o_field_widget[name='name'] input";

    // "on a dirty lead form": the Won click's own save-first step
    // (FormController.beforeExecuteActionButton) must save this edit.
    await contains(nameInput).edit("Dirty lead");
    expect(wonButton).not.toHaveAttribute("disabled");

    await contains(wonButton).click();
    // web's executeButtonCallback disabled every enabled button in the
    // view before awaiting the (still-pending) action_set_won_rainbowman
    // call -- this is the in-flight disable the fix must not clobber.
    expect(wonButton).toHaveAttribute("disabled");

    // A brief connectivity blip while action_set_won_rainbowman is still
    // pending: this lead is already saved (has a server id), so CRM's own
    // sync logic would -- correctly -- leave the button enabled were it
    // actually offline; what matters here is that going back online runs
    // that same shared logic again (`effect(syncAiSwitchOfflineState)`)
    // while the Won action is still in flight.
    await setOffline(true);
    await setOffline(false);
    expect(wonButton).toHaveAttribute("disabled"); // must still be disabled: not cleared by CRM's own sync logic

    wonDeferred.resolve();
    await animationFrame();
    expect.verifySteps(["action_set_won_rainbowman"]); // called exactly once: no double submit
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(1);
    expect(wonButton).toHaveCount(0); // won now: the button's own invisible condition hides it
});

// ---------------------------------------------------------------------------
// Same save-first ordering VAL-QUEUE-005 established for Restore applies to
// Won: a dirty edit made before clicking "Won" must not be lost, and an
// invalid form must queue nothing, not even Won.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, Won on a dirty valid form queues web_save then action_set_won, in that order (desktop)", async () => {
    onRpc("crm.lead", "action_set_won", function ({ args }) {
        expect.step("action_set_won");
        this.env["crm.lead"].write(args[0], { won_status: "won" });
        return true;
    });
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless "sync shortly after startup" pass now,
    // while the queue is empty, so it can't fire a second time
    // concurrently with the explicit replay below once `runAllTimers` is
    // in play.
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_field_widget[name='name'] input").edit("Renamed before Won");
    await contains("button[name='action_set_won_rainbowman']").click();
    expect.verifySteps([]); // both calls queued, neither sent yet

    const queued = Object.values(getService(OfflinePlugin)._ormToSync()).sort(
        (a, b) => a.value.extras.timeStamp - b.value.extras.timeStamp
    );
    expect(queued.length).toBe(2);
    expect(queued[0].value.model).toBe("crm.lead");
    expect(queued[0].value.method).toBe("web_save");
    expect(queued[0].value.args[1].name).toBe("Renamed before Won");
    expect(queued[1].value.method).toBe("action_set_won");
    expect(queued[1].value.args).toEqual([[1]]);
    expect(queued[0].value.extras.timeStamp < queued[1].value.extras.timeStamp).toBe(true);

    // Optimistic UI still applies: the record is no longer dirty (it was
    // just saved) and shows as won. The ribbon appears at once too, before
    // either queued call has replayed.
    expect("button[name='action_set_won_rainbowman']").toHaveCount(0);
    expect(".ribbon span").toHaveCount(1);
    expect(".ribbon span").toHaveText(/^won$/i);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);
    await runAllTimers(); // flush _syncORM's 1s pause between the two replays
    expect.verifySteps(["web_save", "action_set_won"]); // replayed in that order
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
});

test.tags("mobile");
test("offline, Won on a dirty valid form queues web_save then action_set_won, in that order (mobile)", async () => {
    onRpc("crm.lead", "action_set_won", function ({ args }) {
        expect.step("action_set_won");
        this.env["crm.lead"].write(args[0], { won_status: "won" });
        return true;
    });
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_field_widget[name='name'] input").edit("Renamed before Won");
    await contains("button[name='action_set_won_rainbowman']").click();
    expect.verifySteps([]);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync()).sort(
        (a, b) => a.value.extras.timeStamp - b.value.extras.timeStamp
    );
    expect(queued.length).toBe(2);
    expect(queued[0].value.model).toBe("crm.lead");
    expect(queued[0].value.method).toBe("web_save");
    expect(queued[0].value.args[1].name).toBe("Renamed before Won");
    expect(queued[1].value.method).toBe("action_set_won");
    expect(queued[1].value.args).toEqual([[1]]);
    // "in this order of extras.timeStamp" (VAL-DATA-005): strict, not
    // merely equal, ordering between the two queued calls.
    expect(queued[0].value.extras.timeStamp < queued[1].value.extras.timeStamp).toBe(true);

    // The ribbon appears at once here too, before either queued call has
    // replayed.
    expect(".ribbon span").toHaveCount(1);
    expect(".ribbon span").toHaveText(/^won$/i);

    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["web_save", "action_set_won"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
});

test.tags("desktop");
test("offline, the Won hotkey queues action_set_won too (desktop)", async () => {
    onRpc("crm.lead", "action_set_won", function ({ args }) {
        expect.step("action_set_won");
        this.env["crm.lead"].write(args[0], { won_status: "won" });
        return true;
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await press(["alt", "w"]);
    await animationFrame();
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1);
    expect.verifySteps([]);
});

test.tags("desktop");
test("offline, Won on an invalid form queues nothing (desktop)", async () => {
    onRpc("crm.lead", "action_set_won", () => expect.step("action_set_won"));
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_field_widget[name='name'] input").edit("");
    await contains("button[name='action_set_won_rainbowman']").click();
    expect.verifySteps([]); // neither call issued

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    // Not won: the button is still there, the lead is still pending.
    expect("button[name='action_set_won_rainbowman']").toHaveCount(1);
});
