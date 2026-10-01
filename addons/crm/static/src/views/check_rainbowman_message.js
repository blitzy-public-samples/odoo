import { ConnectionLostError } from "@web/core/network/rpc";

/**
 * @param {import("@web/core/orm_service").ORM} orm
 * @param {import("@web/core/effects/effect_service").EffectService} effect
 * @param {number} recordId
 * @param {{ isOffline: () => boolean }} [offlinePlugin] the model's
 *  `OfflinePlugin` (defect 1, architecture.md §3.2): offline there is no
 *  server to ask, so the lookup must be skipped outright -- not just left to
 *  reject, since an uncached `orm.call` would otherwise throw and abort the
 *  save/drag that triggered it.
 */
export async function checkRainbowmanMessage(orm, effect, recordId, offlinePlugin) {
    if (offlinePlugin?.isOffline()) {
        return;
    }
    let message;
    try {
        message = await orm.call("crm.lead", "get_rainbowman_message", [[recordId]]);
    } catch (error) {
        if (error instanceof ConnectionLostError) {
            // The connection dropped mid-lookup: the save/drag that triggered
            // this already went through, so treat the lost lookup as a skip
            // rather than an error surfaced on top of a successful save.
            return;
        }
        throw error;
    }
    if (message) {
        effect.add({
            message,
            type: "rainbow_man",
        });
    }
}
