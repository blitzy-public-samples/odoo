import { expect, test } from "@odoo/hoot";
import { Component, xml } from "@odoo/owl";
import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    getService,
    mockOffline,
    mountWithCleanup,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

defineMailModels();

class IsOfflineComponent extends Component {
    static template = xml`<span class="o_is_offline" t-esc="this.crmOffline.isOffline()"/>`;
    setup() {
        this.crmOffline = useCrmOffline();
    }
}

class AvailabilityComponent extends Component {
    static template = xml`
        <div>
            <span class="o_available_cached" t-esc="this.crmOffline.isRecordAvailableOffline(1, 42)"/>
            <span class="o_available_uncached" t-esc="this.crmOffline.isRecordAvailableOffline(1, 99)"/>
        </div>`;
    setup() {
        this.crmOffline = useCrmOffline();
    }
}

class QueueComponent extends Component {
    static template = xml`<button class="o_queue_call" t-on-click="() => this.onQueueCall()">Queue</button>`;
    setup() {
        this.crmOffline = useCrmOffline();
    }
    onQueueCall() {
        this.crmOffline.queueCall("crm.lead", "action_set_won", [[1]], { context: { a: 1 } }, {
            actionName: "Won",
        });
    }
}

test("useCrmOffline.isOffline() mirrors OfflinePlugin.isOffline()", async () => {
    const setOffline = mockOffline();
    await mountWithCleanup(IsOfflineComponent);
    expect(".o_is_offline").toHaveText("false");

    await setOffline(true);
    expect(".o_is_offline").toHaveText("true");

    await setOffline(false);
    expect(".o_is_offline").toHaveText("false");
});

test("useCrmOffline.isRecordAvailableOffline is gated on isOffline() and mirrors the plugin's cache", async () => {
    // Only record 42 of action 1 is "visited" (cached); isAvailableOffline
    // is only meaningful while offline (architecture.md §2), so the guard
    // must short-circuit to true while online regardless of the cache.
    patchWithCleanup(OfflinePlugin.prototype, {
        isAvailableOffline(actionId, viewType, resId) {
            return actionId === 1 && viewType === "form" && resId === 42;
        },
    });
    const setOffline = mockOffline();
    await mountWithCleanup(AvailabilityComponent);
    expect(".o_available_cached").toHaveText("true");
    expect(".o_available_uncached").toHaveText("true");

    await setOffline(true);
    expect(".o_available_cached").toHaveText("true");
    expect(".o_available_uncached").toHaveText("false");
});

test("useCrmOffline.queueCall schedules a verbatim ORM call tagged with a timeStamp", async () => {
    await mountWithCleanup(QueueComponent);
    await contains(".o_queue_call").click();

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("action_set_won");
    expect(value.args).toEqual([[1]]);
    expect(value.kwargs).toEqual({ context: { a: 1 } });
    expect(value.extras.actionName).toBe("Won");
    expect(typeof value.extras.timeStamp).toBe("number");
});
