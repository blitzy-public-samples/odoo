import { Component, status, t, useProps } from "@odoo/owl";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { localization } from "@web/core/l10n/localization";
import { registry } from '@web/core/registry';
import { usePopover } from "@web/core/popover/popover_hook";
import { useService } from "@web/core/utils/hooks";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";


export class CrmPlsTooltip extends Component {
    static template = "crm.PlsTooltip";

    props = useProps({
        close: t.function().optional(),
        dashArrayVals: t.string(),
        low3Data: t.object().optional(),
        probability: t.number(),
        teamName: t.string().optional(),
        top3Data: t.object().optional(),
    });
}


export class CrmPlsTooltipButton extends Component {
    static template = "crm.PlsTooltipButton";

    props = useProps(standardWidgetProps);

    setup() {
        super.setup();
        this.orm = useService("orm");
        this.ui = useService("ui");
        this.popover = usePopover(CrmPlsTooltip, {
            popoverClass: 'mt-2 me-2',
            position: "bottom-start",
            useBottomSheet: this.ui.isSmall
        });
        // Offline state, read only through the shared CRM offline hooks.
        this.crmOffline = useCrmOffline();
    }

    /**
     * Opens the predictive lead scoring tooltip: saves the record, asks the server for the tooltip
     * data (which also recomputes the probability), reloads the record and shows the popover.
     *
     * Offline, this control is DISABLE: the save and the server lookup cannot be separated, and
     * the lookup needs the server. The button itself is disabled by the framework's offline
     * selector (it carries no `data-available-offline`); this handler is also inert offline, so a
     * hotkey, a keyboard activation or a direct call neither saves, nor looks up, nor reloads.
     * Closing an already open popover stays allowed. Online behaviour is unchanged.
     *
     * @param {MouseEvent} ev
     */
    async onClickPlsTooltipButton(ev) {
        if (this.popover.isOpen) {
            this.popover.close();
        } else {
            if (this.crmOffline.isOffline()) {
                return;
            }
            // Read after the offline guard, so an offline call without an event stays inert, and
            // before the first await, while the event is still being dispatched.
            const tooltipButtonEl = ev.currentTarget;
            // Apply pending changes. They may change probability
            await this.props.record.save();
            // A save that lost the connection was queued and turned the client offline: the
            // lookup would fail, so it is skipped along with the reload.
            if (
                status(this) === "destroyed" ||
                !this.props.record.resId ||
                this.crmOffline.isOffline()
            ) {
                return;
            }

            // This recomputes probability, and returns all tooltip data
            const tooltipData = await this.orm.call(
                "crm.lead",
                "prepare_pls_tooltip_data",
                [this.props.record.resId]
            );
            // Update the form
            await this.props.record.load();

            // Hard set wheel dimensions, see o_crm_pls_tooltip_wheel in scss and xml
            const progressWheelPerimeter = 2 * Math.PI * 25;
            const progressBarDashLength = progressWheelPerimeter * tooltipData.probability / 100.0;
            const progressBarDashGap = progressWheelPerimeter - progressBarDashLength;
            let dashArrayVals = progressBarDashLength + ' ' + progressBarDashGap;
            if (localization.direction === "rtl") {
                dashArrayVals = 0 + ' ' + 0.5 * progressWheelPerimeter + ' ' + dashArrayVals;
            }
            this.popover.open(tooltipButtonEl, {
                'dashArrayVals': dashArrayVals,
                'low3Data': tooltipData.low_3_data,
                'probability': tooltipData.probability,
                'teamName': tooltipData.team_name,
                'top3Data': tooltipData.top_3_data,
            });
        }
    }
}

registry.category("view_widgets").add("pls_tooltip_button", {
    component: CrmPlsTooltipButton
});
