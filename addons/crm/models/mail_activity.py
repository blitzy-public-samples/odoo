# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import api, models


class MailActivity(models.Model):
    _inherit = "mail.activity"

    # ------------------------------------------------------
    # ORM overrides
    # ------------------------------------------------------

    @api.model_create_multi
    def create(self, vals_list):
        """ Resolve ``res_model_id`` for activities created on ``crm.lead`` with only
        ``res_model`` given, as ``res_model`` is a readonly related field computed
        from ``res_model_id``: a ``res_model`` value alone is discarded and the
        activity would fail the "res_id set if model" constraint.

        This is the shape of the activity creations queued offline by the CRM
        mobile lead card and replayed on reconnect, e.g.
        ``web_save([], {'res_model': 'crm.lead', 'res_id': lead.id, ...})``,
        the client only knowing the model name, never the ``ir.model`` id.
        An explicit ``res_model_id`` is never overwritten and other models are
        left untouched. No sudo: access checks apply exactly as online. """
        for vals in vals_list:
            if vals.get('res_model') == 'crm.lead' and not vals.get('res_model_id'):
                vals['res_model_id'] = self.env['ir.model']._get_id('crm.lead')
        return super().create(vals_list)

    def action_create_calendar_event(self):
        """ Small override of the action that creates a calendar.

        If the activity is linked to a crm.lead through the "opportunity_id" field, we include in
        the action context the default values used when scheduling a meeting from the crm.lead form
        view.
        e.g: It will set the partner_id of the crm.lead as default attendee of the meeting. """

        action = super(MailActivity, self).action_create_calendar_event()
        opportunity = self.calendar_event_id.opportunity_id
        if opportunity:
            opportunity_action_context = opportunity.action_schedule_meeting(smart_calendar=False).get('context', {})
            opportunity_action_context['initial_date'] = self.calendar_event_id.start

            action['context'].update(opportunity_action_context)

        return action
