# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import fields
from odoo.exceptions import AccessError, UserError

from odoo.addons.crm.tests.common import TestCrmCommon


class TestCrmOffline(TestCrmCommon):
    """ Server-side proof of the offline-fixes milestone's central invariant
    (architecture.md §2, AGENTS.md §2): the queue stores and replays each
    offline write verbatim -- same model, method, args and kwargs, no
    onchange, no id remapping, no field merge. So applying a queued call on
    reconnect must leave the record in exactly the state an online write of
    the same values would.
    """

    def test_web_save_force_saved_email_phone_matches_online_write(self):
        """ crm_form.js's CrmFormRecord._save() override force-copies the
        lead's current email_from/phone into the record's changes whenever
        the partner still needs to be synced (partner_email_update /
        partner_phone_update), even though the user only touched another
        field (architecture.md §3.2 defect 2). That force-copy runs
        unconditionally, online and offline alike: offline, the resulting
        web_save call -- forced values included -- is simply queued instead
        of being sent immediately, then replayed verbatim on reconnect.

        This test proves that equivalence: replaying such a queued
        `web_save` (vals included) leaves the lead, and the partner it
        propagates to, in exactly the same state as an online write of the
        identical vals.
        """
        partner_online = self.env['res.partner'].create({'name': 'Force Save Partner (online)'})
        partner_offline = self.env['res.partner'].create({'name': 'Force Save Partner (offline)'})
        lead_values = {
            'name': 'Force Save Lead',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'email_from': 'fresh.lead.email@test.example.com',
            'phone': '+1 202 555 0002',
        }
        online_lead = self.env['crm.lead'].create({**lead_values, 'partner_id': partner_online.id})
        offline_lead = self.env['crm.lead'].create({**lead_values, 'partner_id': partner_offline.id})

        # Creating the lead with partner_id and email_from/phone together
        # already syncs the (blank) partner via the inverse methods. Void
        # the partner again to reproduce the "partner needs sync" state
        # crm_form.js checks before it force-copies email_from/phone --
        # test_crm_ui.py's tour test uses the same setup (create, then void
        # the partner) for the same reason.
        partner_online.write({'email': False, 'phone': False})
        partner_offline.write({'email': False, 'phone': False})

        # Sanity: both leads start identically, and the partner still needs
        # the sync crm_form.js checks before it force-copies email_from/phone
        # into the save it is about to issue (online) or queue (offline).
        self.assertTrue(online_lead.partner_email_update)
        self.assertTrue(online_lead.partner_phone_update)
        self.assertTrue(offline_lead.partner_email_update)
        self.assertTrue(offline_lead.partner_phone_update)
        self.assertEqual(online_lead.email_from, offline_lead.email_from)
        self.assertEqual(online_lead.phone, offline_lead.phone)

        # The vals crm_form.js actually sends: the field the user touched
        # (description) plus the unchanged, force-copied email_from/phone.
        online_changes = {
            'description': 'Edited while connected',
            'email_from': online_lead.email_from,
            'phone': online_lead.phone,
        }
        offline_changes = {
            'description': 'Edited while connected',
            'email_from': offline_lead.email_from,
            'phone': offline_lead.phone,
        }

        # Online: the client issues the web_save RPC immediately -- modeled
        # here as the plain write() web_save delegates to (see
        # addons/web/models/models.py BaseModel.web_save).
        online_lead.write(online_changes)
        # Offline: the identical call (same model, method, same args and
        # kwargs) is instead queued and replayed verbatim on reconnect.
        offline_lead.web_save(offline_changes, {})

        self.assertEqual(online_lead.description, offline_lead.description)
        self.assertEqual(online_lead.email_from, offline_lead.email_from)
        self.assertEqual(online_lead.phone, offline_lead.phone)
        self.assertEqual(
            online_lead.partner_id.email, offline_lead.partner_id.email,
            'Replaying the queued web_save must propagate the email to the '
            'partner exactly as an online write of the same vals would'
        )
        self.assertEqual(
            online_lead.partner_id.phone, offline_lead.partner_id.phone,
            'Replaying the queued web_save must propagate the phone to the '
            'partner exactly as an online write of the same vals would'
        )
        self.assertEqual(online_lead.partner_id.email, online_lead.email_from,
                          'Partner email should have moved away from its stale value')
        self.assertEqual(online_lead.partner_id.phone, online_lead.phone,
                          'Partner phone should have moved away from its stale value')

    def test_web_save_queued_lead_edit_equals_online_write(self):
        """ VAL-DATA-018 (architecture.md §3.3 "Leads/stages/teams reads,
        edits, creates, stage moves: framework already covers them -- prove
        with tests, don't reimplement"): the JS-side proof
        (crm_offline_data_queue_replay.test.js's "offline, editing several
        fields of a lead ... queues one web_save") already shows an
        ordinary offline edit of several lead fields -- not the
        email/phone force-save defect's special case covered above -- gets
        queued as a plain `web_save`. This is the server-side half: that
        replaying such a queued call verbatim, with no sudo (as the
        salesperson assigned to the lead, the access an offline user
        actually has), leaves the lead -- and the partner it still
        propagates email/phone to -- in exactly the same state an online
        write of the identical vals would.
        """
        partner_online = self.env['res.partner'].create({'name': 'Queued Edit Partner (online)'})
        partner_offline = self.env['res.partner'].create({'name': 'Queued Edit Partner (offline)'})
        lead_values = {
            'name': 'Queued Edit Lead',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        }
        online_lead = self.env['crm.lead'].create({**lead_values, 'partner_id': partner_online.id})
        offline_lead = self.env['crm.lead'].create({**lead_values, 'partner_id': partner_offline.id})

        # An ordinary user-initiated edit (not the force-copy path): the
        # user directly changes description, expected_revenue and the
        # lead's own email_from/phone.
        changes = {
            'description': 'Edited through the offline queue',
            'expected_revenue': 4242.0,
            'email_from': 'queued.edit@test.example.com',
            'phone': '+1 202 555 0099',
        }

        salesman_online = self.env['crm.lead'].with_user(self.user_sales_salesman).browse(online_lead.id)
        salesman_offline = self.env['crm.lead'].with_user(self.user_sales_salesman).browse(offline_lead.id)

        # Online: the client issues web_save immediately.
        salesman_online.web_save(changes, {})
        # Offline: the identical call -- same model, method, same args and
        # kwargs, no onchange, no field merge (architecture.md §2) -- is
        # instead queued and replayed verbatim on reconnect.
        salesman_offline.web_save(changes, {})

        self.assertEqual(online_lead.description, offline_lead.description)
        self.assertEqual(online_lead.expected_revenue, offline_lead.expected_revenue)
        self.assertEqual(online_lead.email_from, offline_lead.email_from)
        self.assertEqual(online_lead.phone, offline_lead.phone)
        self.assertEqual(
            online_lead.partner_id.email, offline_lead.partner_id.email,
            'Replaying the queued web_save must propagate the email to the '
            'partner exactly as an online write of the same vals would'
        )
        self.assertEqual(
            online_lead.partner_id.phone, offline_lead.partner_id.phone,
            'Replaying the queued web_save must propagate the phone to the '
            'partner exactly as an online write of the same vals would'
        )
        self.assertEqual(online_lead.partner_id.email, online_lead.email_from)
        self.assertEqual(online_lead.partner_id.phone, online_lead.phone)

    def test_action_restore_replay_restores_lead_like_online(self):
        """ B3/C4 (architecture.md §3.7, offline_inventory.md rows B3/C4,
        VAL-QUEUE-006): the offline "Restore" button
        (crm_form.js's `CrmFormController._queueRestoreOffline`) queues a
        bare `crm.lead.action_restore([[id]])` -- no onchange, no id
        remapping, nothing else. Replaying that queued call verbatim, with
        no sudo (as the salesman who owns the lead, same access rights an
        offline user would have), must leave the lead exactly as restoring
        it online would: active again, and its probability reset to its
        (freshly recomputed) automated probability -- not merely
        unarchived, which `action_unarchive` alone would already do.
        """
        lead = self.env['crm.lead'].create({
            'name': 'Lost Lead For Restore',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        })
        lead.action_set_lost()
        self.assertFalse(lead.active)
        self.assertEqual(lead.probability, 0)

        # Replay exactly as `_syncORM` replays the queued `[[id]]` call:
        # same model, method, args -- no sudo.
        self.env['crm.lead'].with_user(self.user_sales_salesman).browse(lead.ids).action_restore()
        lead.invalidate_recordset()

        self.assertTrue(lead.active)
        self.assertEqual(
            lead.probability, lead.automated_probability,
            'Restoring a lead must reset its probability to the (recomputed) '
            'automated probability, the same result an online Restore gives'
        )

    def test_action_set_won_replay_leaves_lead_won(self):
        """ VAL-DATA-006 (architecture.md §3.3, offline_inventory.md rows
        B1/C6): the offline "Won" button
        (`crm_form.js`'s `CrmFormController._queueWonOffline`) queues a
        bare `crm.lead.action_set_won([[id]])` -- not the
        `action_set_won_rainbowman` the button itself names, since that
        wrapper's `get_rainbowman_message` lookup needs a live round trip
        (C8, DISABLE as a method). Replaying that queued call verbatim,
        with no sudo (as the salesman who owns the lead, the same access
        an offline user would have), must leave the lead exactly as
        clicking "Won" online would: `won_status == 'won'`, probability
        100 and moved to a won stage -- the same outcome
        `test_crm_rainbowman.py`'s online test gets from
        `action_set_won_rainbowman` itself (that method only adds the
        rainbowman lookup on top of this same `action_set_won`).
        """
        lead = self.env['crm.lead'].create({
            'name': 'Opportunity For Won',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        })
        self.assertEqual(lead.won_status, 'pending')
        self.assertNotEqual(lead.probability, 100)

        # Replay exactly as `_syncORM` replays the queued `[[id]]` call:
        # same model, method, args -- no sudo.
        self.env['crm.lead'].with_user(self.user_sales_salesman).browse(lead.ids).action_set_won()
        lead.invalidate_recordset()

        self.assertTrue(lead.stage_id.is_won)
        self.assertEqual(lead.probability, 100)
        self.assertEqual(
            lead.won_status, 'won',
            'Replaying the queued action_set_won must leave the lead won, '
            'the same result an online "Won" click gives'
        )

    def test_mail_activity_create_maps_res_model_to_res_model_id_for_crm_lead(self):
        """ VAL-DATA-019 (architecture.md §3.3 "Schedule"): the offline
        activity panel's Schedule control queues `mail.activity.create`
        with `res_model` resolved to the literal string 'crm.lead' on the
        client (no onchange, no extra round trip to look up the matching
        `ir.model` id -- architecture.md §2). `res_model` is itself a
        field related to `res_model_id`, so leaving `res_model_id` unset
        would make the two inconsistent; `models/mail_activity.py`'s
        `create()` override maps `res_model` -> `res_model_id` for
        crm.lead when `res_model_id` is absent. Replaying that queued call
        verbatim, with no sudo (as the salesman who owns the lead -- the
        access an offline user actually has), must set `res_model_id`,
        keep `res_model` consistent, and link the new activity into the
        lead's `activity_ids`, exactly as an online create that already
        passes `res_model_id` explicitly does.
        """
        lead = self.env['crm.lead'].create({
            'name': 'Lead For Queued Activity Create',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        })
        call_type = self.env.ref('mail.mail_activity_data_call')
        salesman_activities = self.env['mail.activity'].with_user(self.user_sales_salesman)

        # Replay exactly as `_syncORM` replays the queued Schedule
        # activity's `create` call: `res_model` resolved client-side, no
        # `res_model_id` -- no sudo.
        activity = salesman_activities.create({
            'res_model': 'crm.lead',
            'res_id': lead.id,
            'activity_type_id': call_type.id,
            'summary': 'Call back next week',
            'user_id': self.user_sales_salesman.id,
            'date_deadline': fields.Date.context_today(lead),
        })

        self.assertEqual(
            activity.res_model_id, self.env['ir.model']._get('crm.lead'),
            'create() must map res_model to res_model_id for crm.lead when res_model_id is absent'
        )
        self.assertEqual(activity.res_model, 'crm.lead')
        self.assertIn(
            activity, lead.activity_ids,
            'The activity created from the queued res_model-only vals must be linked to the lead'
        )

        # Unchanged baseline case: an explicit res_model_id still works --
        # the path every other caller already uses (e.g.
        # activity_schedule, test_crm_activity.py's existing tests, which
        # keep passing unmodified since the override only touches vals
        # whose res_model equals 'crm.lead' and whose res_model_id is
        # absent; a vals dict that already carries res_model_id is passed
        # through untouched).
        explicit_activity = salesman_activities.create({
            'res_model_id': self.env['ir.model']._get_id('crm.lead'),
            'res_id': lead.id,
            'activity_type_id': call_type.id,
            'summary': 'Explicit res_model_id',
            'user_id': self.user_sales_salesman.id,
            'date_deadline': fields.Date.context_today(lead),
        })
        self.assertEqual(explicit_activity.res_model, 'crm.lead')

    def test_mail_activity_create_without_res_id_behaves_as_on_eval_base(self):
        """ m5-fix-online-guards (VAL-REPO-013 clause (b)): the override
        above must only step in for the one input shape that actually
        raised on `eval/base` -- a queued Schedule create with both
        `res_model` and `res_id` set but no `res_model_id`. Without a
        `res_id`, the override must leave `create()` exactly as it is on
        `eval/base` (no crm override at all).

        Verified directly in an `odoo shell` savepoint probe against this
        same database: calling `mail.activity`'s own `create()` (resolved
        from the MRO past crm's override class, i.e. literally what
        `eval/base` runs, since that branch never had
        `addons/crm/models/mail_activity.py`) with
        `{'res_model': 'crm.lead', ...}` and no `res_id`/`res_model_id`
        succeeds and returns `res_model=False, res_model_id=False,
        res_id=0` -- an orphan activity, not a `CheckViolation`. Reasoned
        from the field definitions: `res_model` is declared
        `precompute=True, readonly=True`
        (`addons/mail/models/mail_activity.py`), so
        `BaseModel._prepare_create_values` discards whatever value a
        caller puts in `vals['res_model']` before `create()` ever sees it
        (it only keeps precomputed *readonly* fields out of vals "to force
        their computation"), and `_add_precomputed_values` recomputes it
        from `res_model_id` on the new record. With no `res_model_id`
        given, the recomputed `res_model` is False, which is consistent
        with mail's SQL constraint `_check_res_id_is_set_if_model` (both
        res_model and res_id empty) -- so the create succeeds as an
        orphan. The current (buggy, pre-fix) crm override instead sets
        `res_model_id` from the bare `res_model` check alone, so
        `res_model` gets recomputed to 'crm.lead' while `res_id` stays
        unset -- violating that same constraint and raising a
        `CheckViolation` that never happens on eval/base. The fix adds
        `vals.get('res_id')` to the override's guard so it only maps
        `res_model_id` for the one shape that needs it (an explicit
        `res_id`, VAL-DATA-019's Schedule-queue shape, still covered by
        the test right above this one).
        """
        lead = self.env['crm.lead'].create({
            'name': 'Lead Never Referenced By The Create Below',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        })
        call_type = self.env.ref('mail.mail_activity_data_call')
        salesman_activities = self.env['mail.activity'].with_user(self.user_sales_salesman)

        activity = salesman_activities.create({
            'res_model': 'crm.lead',
            'activity_type_id': call_type.id,
            'summary': 'No res_id supplied',
            'user_id': self.user_sales_salesman.id,
            'date_deadline': fields.Date.context_today(lead),
        })
        # Force the DB write (and its CHECK constraint) now rather than at
        # some later, unrelated flush: this is the exact point eval/base
        # does -- or doesn't -- raise.
        self.env.flush_all()

        self.assertFalse(
            activity.res_model,
            "With no res_id, res_model must end up False (recomputed from "
            "an unset res_model_id) -- the same orphan eval/base produces "
            "-- not 'crm.lead' paired with a null res_id, which violates "
            "mail's own _check_res_id_is_set_if_model SQL constraint."
        )
        self.assertFalse(activity.res_model_id)
        self.assertFalse(activity.res_id)
        self.assertNotIn(
            activity, lead.activity_ids,
            "An activity created with no res_id must not end up linked to "
            "any lead."
        )

    def test_action_log_call_leaves_done_note_and_no_open_activity(self):
        """ VAL-DATA-020 / expectedBehavior "action_log_call leaves a done
        note and no open activity" (architecture.md §3.3 "Log a call"):
        the offline panel queues one
        `crm.lead.action_log_call(activity_type_id, summary, note,
        user_id)` call -- the single scheduleORM entry has to both create
        the Call activity and mark it done, since the queue replays
        verbatim with no chaining between calls and no id remapping
        (architecture.md §2). Replaying it, as the salesman who owns the
        lead (no sudo: the method must not widen what an offline user can
        do), must leave the chatter with one done note and the lead with
        no open (active) activity -- the same result logging a call
        online leaves.

        VAL-DATA-020 (orchestrator-triage.md): also checks that the
        summary (not just the note) is in the message, that the message
        is tied to a Call activity type and to mail's activity subtype,
        and compares the result field-by-field with logging the same call
        online -- there is no other online "log a call" method, so "online"
        here means `activity_schedule()` + `action_feedback()`, the two
        calls crm's own `action_log_call` combines into one.
        """
        lead = self.env['crm.lead'].create({
            'name': 'Lead For Logged Call',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        })
        online_lead = self.env['crm.lead'].create({
            'name': 'Lead For Logged Call (online)',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        })
        call_type = self.env.ref('mail.mail_activity_data_call')
        salesman_lead = self.env['crm.lead'].with_user(self.user_sales_salesman).browse(lead.id)
        salesman_online_lead = self.env['crm.lead'].with_user(self.user_sales_salesman).browse(online_lead.id)
        summary = 'Called the prospect'
        note = 'Interested, will follow up next week'

        # Online comparator, done first so both messages exist to compare:
        # the two calls crm's own action_log_call combines into one.
        online_activity = salesman_online_lead.activity_schedule(
            'mail.mail_activity_data_call', summary=summary, user_id=self.user_sales_salesman.id,
        )
        online_message_id = online_activity.action_feedback(feedback=note)

        # Replay exactly as `_syncORM` replays the queued call: same
        # model, method, args -- no sudo.
        message_id = salesman_lead.action_log_call(
            call_type.id, summary, note, self.user_sales_salesman.id,
        )
        lead.invalidate_recordset()
        online_lead.invalidate_recordset()

        self.assertTrue(message_id, 'action_log_call must leave a done message in the chatter')
        message = self.env['mail.message'].browse(message_id)
        online_message = self.env['mail.message'].browse(online_message_id)
        self.assertEqual(message.model, 'crm.lead')
        self.assertEqual(message.res_id, lead.id)
        self.assertIn(summary, message.body)
        self.assertIn(note, message.body)
        self.assertEqual(
            message.mail_activity_type_id, call_type,
            'The done message must be tied to the Call activity type it closed'
        )
        self.assertEqual(
            message.subtype_id, self.env.ref('mail.mt_activities'),
            "A logged call's done note must use mail's activity subtype"
        )
        self.assertFalse(
            lead.activity_ids,
            'action_log_call must leave no open activity on the lead'
        )

        # Field-by-field parity with logging the same call online: the
        # queue replays action_log_call verbatim, so its result must not
        # differ from the two online calls it stands in for.
        self.assertEqual(message.body, online_message.body)
        self.assertEqual(message.message_type, online_message.message_type)
        self.assertEqual(message.subtype_id, online_message.subtype_id)
        self.assertEqual(message.mail_activity_type_id, online_message.mail_activity_type_id)
        self.assertEqual(message.author_id, online_message.author_id)
        self.assertFalse(
            online_lead.activity_ids,
            'Logging a call online must likewise leave no open activity on the lead'
        )

        logged_activity = self.env['mail.activity'].with_context(active_test=False).search([
            ('res_model', '=', 'crm.lead'), ('res_id', '=', lead.id),
        ])
        self.assertEqual(len(logged_activity), 1, 'Exactly one activity must have been created and then marked done')
        self.assertFalse(
            logged_activity.active,
            'The logged call activity must be archived (done), not left open'
        )
        self.assertEqual(logged_activity.activity_type_id, call_type)

        # No sudo: a user without write access to this lead (not its
        # owner, no "all leads" group) must be denied -- the rights are
        # not widened for the offline path.
        unrelated_lead = self.env['crm.lead'].create({
            'name': 'Lead Not Owned By The Salesman',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_manager.id,
            'stage_id': self.stage_team1_1.id,
        })
        with self.assertRaises(AccessError):
            self.env['crm.lead'].with_user(self.user_sales_salesman).browse(unrelated_lead.id).action_log_call(
                call_type.id, 'Should not be allowed', 'No access', self.user_sales_salesman.id,
            )

    def test_action_log_call_rejects_non_call_activity_type(self):
        """ VAL-DATA-020: the server side of the "Log a call means a call"
        invariant (see action_log_call's docstring). A stale offline
        client could have cached a To-Do as its first activity type and
        queued it through `action_log_call` -- the queue replays whatever
        was queued verbatim, with no server-side onchange to catch it
        (architecture.md §2), so `action_log_call` itself must refuse any
        `activity_type_id` whose category isn't 'phonecall', not just the
        UI. No sudo involved: this must raise before any activity is
        created, for a user who otherwise has full write access to the
        lead.
        """
        lead = self.env['crm.lead'].create({
            'name': 'Lead For Rejected Non-Call Type',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        })
        todo_type = self.env.ref('mail.mail_activity_data_todo')
        self.assertNotEqual(todo_type.category, 'phonecall')
        salesman_lead = self.env['crm.lead'].with_user(self.user_sales_salesman).browse(lead.id)

        with self.assertRaises(UserError):
            salesman_lead.action_log_call(
                todo_type.id, 'Should not be allowed', 'Not a call', self.user_sales_salesman.id,
            )
        self.assertFalse(
            self.env['mail.activity'].with_context(active_test=False).search([
                ('res_model', '=', 'crm.lead'), ('res_id', '=', lead.id),
            ]),
            'A rejected action_log_call must leave no activity behind, done or open'
        )
