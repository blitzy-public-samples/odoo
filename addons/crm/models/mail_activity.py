# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from collections.abc import Mapping

import psycopg2

from odoo import api, models
from odoo.exceptions import ValidationError
from odoo.http.dispatcher import conceal_debug_traceback


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
        left untouched. No sudo: access checks apply exactly as online.

        RPC callers choose these values freely, so they are checked before being
        read. ``vals_list`` must be a list of mappings. Values targeting
        ``crm.lead``, through ``res_model``, ``res_model_id`` or, without a
        ``res_model_id`` key, the context's ``default_res_model`` or
        ``default_res_model_id``, must give a ``res_model_id``, if any, as an
        integer or an ``ir.model`` record, and a ``res_id`` the standard create
        converts to a positive id (an integer, a numeric string or number, a
        record; never a boolean), in the values or, without a ``res_id`` key, as
        the context's ``default_res_id``. These checks raise a
        ``ValidationError`` that does not repeat the input.

        When the batch holds values targeting ``crm.lead``, every error it
        raises, the standard create's own (access rights, missing records,
        invalid values) included, keeps its type and message but has its
        traceback concealed from the HTTP response; the server log still
        records it. When the batch also holds values in the replayed shape
        above, whose ``res_model_id`` is resolved here, the create runs in a
        savepoint: the HTTP layer turns a database integrity error into a new
        error outside this method, out of reach of that concealment, so such an
        error is rolled back to the savepoint here and raised as the same
        standard ``ValidationError``. Pending ORM writes are flushed before the
        savepoint, so that its rollback only drops this create. Lead batches
        whose values all give their model otherwise, through ``res_model_id``
        (as ``activity_schedule`` does) or the context defaults, are created
        with neither flush nor savepoint, so pending ORM writes stay batched
        and integrity errors are handled as with the standard create. Batches
        on other models are created as standard. """
        if not isinstance(vals_list, (list, tuple)) or not all(isinstance(vals, Mapping) for vals in vals_list):
            with conceal_debug_traceback():
                raise ValidationError(self.env._("Invalid activity values: a list of field values is expected."))
        lead_model_id = self.env['ir.model']._get_id('crm.lead')
        res_id_field = self._fields['res_id']
        context = self.env.context
        on_lead = False
        model_id_resolved = False
        for vals in vals_list:
            res_model_id = vals.get('res_model_id')
            # a model id is an integer or a single ``ir.model`` record: the ORM stores a string as empty
            if type(res_model_id) is int:
                model_id = res_model_id
            elif isinstance(res_model_id, models.BaseModel) and res_model_id._name == 'ir.model' and len(res_model_id) == 1:
                model_id = res_model_id.id
            else:
                model_id = None
            if not (
                vals.get('res_model') == 'crm.lead'
                or model_id == lead_model_id
                or ('res_model_id' not in vals and (
                    context.get('default_res_model') == 'crm.lead'
                    or context.get('default_res_model_id') == lead_model_id
                ))
            ):
                continue
            on_lead = True
            if res_model_id and model_id is None:
                with conceal_debug_traceback():
                    raise ValidationError(self.env._("Invalid activity values: the document model of an activity on a lead must be given by its id."))
            res_id = vals['res_id'] if 'res_id' in vals else context.get('default_res_id')
            # the id the standard create would store, converted as it converts it: a context
            # default through the field's cache format first (default_get), then as a column
            # value (a record gives its id); a boolean is never taken as an id
            lead_id = 0
            if not isinstance(res_id, bool):
                try:
                    if 'res_id' not in vals:
                        res_id = res_id_field.convert_to_cache(res_id, self)
                    lead_id = res_id_field.convert_to_column(res_id, self)
                except (TypeError, ValueError, OverflowError):
                    lead_id = 0
            if lead_id <= 0:
                with conceal_debug_traceback():
                    raise ValidationError(self.env._("Invalid activity values: an activity on a lead requires the id of that lead."))
            if vals.get('res_model') == 'crm.lead' and not res_model_id:
                vals['res_model_id'] = lead_model_id
                model_id_resolved = True
        if not on_lead:
            return super().create(vals_list)
        with conceal_debug_traceback():
            if not model_id_resolved:
                # values that already give their model, such as activity_schedule's: neither flush
                # nor savepoint, so pending ORM writes stay batched as with the standard create
                return super().create(vals_list)
            # pending ORM writes reach the database before the savepoint, so that its rollback
            # drops nothing else; precommit hooks, mail tracking included, still run at commit
            self.env.flush_all()
            try:
                with self.env.cr.savepoint(flush=False):
                    return super().create(vals_list)
            except psycopg2.IntegrityError as error:
                # the savepoint is rolled back: drop what the failed create left in the caches
                self.env.transaction.clear()
                # the error the HTTP layer would raise (odoo.http.retrying), concealed here
                model = self.env['base']
                for model_class in self.env.registry.values():
                    if model_class._table == error.diag.table_name:
                        model = self.env[model_class._name]
                        break
                raise ValidationError(self.env._(
                    "The operation cannot be completed: %s",
                    model._sql_error_to_message(error),
                )) from None
            except Exception:
                # the savepoint is rolled back: drop what the failed create left in the caches
                self.env.transaction.clear()
                raise

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
