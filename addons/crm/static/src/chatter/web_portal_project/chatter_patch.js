import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * Scrutiny round 2 (VAL-FIX-012, VAL-DIS-004): besides the composer's own
 * dropzone (guarded for `crm.lead` in `core/common/composer_patch.js`),
 * the chatter registers a second, independent drop target that is active
 * whenever the composer is closed -- `useCustomDropzone` in
 * `@mail/chatter/web/chatter_patch.js`, enabled while the thread
 * `canPostMessage` regardless of `composerType`. Its `onDrop` reads
 * `this.attachmentUploader` fresh on every drop and calls `uploadFile()`
 * unconditionally, with no connectivity check of its own.
 *
 * That `onDrop` is a closure captured once in `@mail`'s `setup()`, so it
 * cannot be patched directly; it always re-reads `this.attachmentUploader`
 * at drop time though, so intercepting that property on the prototype --
 * rather than reassigning the instance value once from our own `setup()`
 * -- is what actually works here: `@mail`'s own `setup()` runs
 * `this.attachmentUploader = useAttachmentUploader(this.thread)` itself,
 * and whether that statement executes before or after our patch's own
 * `setup()` body depends on patch-registration order (which extension
 * ends up "outer" in `@web/core/utils/patch`'s skeleton chain) -- not on
 * import order, since neither module imports the other. A one-shot
 * post-`super.setup()` reassignment is liable to run *before* `@mail`
 * makes its own assignment and then get silently overwritten by it
 * (observed in practice: the drop still uploaded). A getter/setter pair
 * on the prototype has no such ordering dependency: every assignment to
 * `this.attachmentUploader`, from any layer, in any order, is captured by
 * the setter below into a private field, and every read -- including the
 * dropzone's `onDrop` and the toolbar `FileUploader`'s `onUploaded` --
 * goes through the getter, which returns a guarded wrapper derived from
 * that field. This blocks `uploadFile`/`uploadData` for a `crm.lead`
 * thread while offline, without touching the shared `AttachmentUploader`
 * class used by every other model's chatter and by the `Composer`'s own
 * uploader. `unlink` (deleting an already-uploaded attachment) is passed
 * through unchanged: it has no offline-safe alternative to block to, and
 * is out of this feature's scope.
 */
patch(Chatter.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    get attachmentUploader() {
        return this._crmAttachmentUploader;
    },

    set attachmentUploader(uploader) {
        const isCrmLeadOffline = () =>
            this.crmOffline.isOffline() && this.thread()?.model === "crm.lead";
        this._crmAttachmentUploader = {
            uploadFile(file, options) {
                if (isCrmLeadOffline()) {
                    return;
                }
                return uploader.uploadFile(file, options);
            },
            uploadData(data, options) {
                if (isCrmLeadOffline()) {
                    return;
                }
                return uploader.uploadData(data, options);
            },
            unlink(attachments, options) {
                return uploader.unlink(attachments, options);
            },
        };
    },
});
