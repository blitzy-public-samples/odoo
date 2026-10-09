# Part of Odoo. See LICENSE file for full copyright and licensing details.

import mimetypes
from datetime import timedelta

from lxml import etree

from odoo import fields
from odoo.exceptions import AccessError
from odoo.service.model import call_kw
from odoo.tests import HttpCase, tagged
from odoo.tools import mute_logger
from odoo.tools.safe_eval import safe_eval

from odoo.addons.crm.tests.common import TestCrmCommon
from odoo.addons.web.models.models import UnlinkBlockedError

# Icon of the CRM shortcuts: the addon's existing 100x100 asset.
CRM_SHORTCUT_ICONS = [
    {'sizes': '100x100', 'src': '/crm/static/description/icon.png', 'type': 'image/png'},
]
# Main manifest icons served to CRM users: the addon's existing assets at their pixel sizes.
CRM_MANIFEST_ICONS = [
    {'src': '/crm/static/description/icon_hi.png', 'sizes': '512x512', 'type': 'image/png'},
    {'src': '/crm/static/description/icon.png', 'sizes': '100x100', 'type': 'image/png'},
]
# Main manifest icons of the parent controller, kept for visitors without CRM.
ODOO_MANIFEST_ICONS = [
    {'src': '/web/static/img/odoo-icon-192x192.png', 'sizes': '192x192', 'type': 'image/png'},
    {'src': '/web/static/img/odoo-icon-512x512.png', 'sizes': '512x512', 'type': 'image/png'},
]
# Icon of the scoped app manifest for an app without its own SVG icon (``_icon_path``).
SCOPED_APP_ICONS = [
    {'src': '/web/static/img/odoo-icon-192x192.png', 'sizes': 'any', 'type': 'image/png'},
]

# Literals of the ``crm_mobile_offline`` tour (addons/crm/static/tests/tours/crm_mobile_offline.js).
# The launcher creates the lead before the tour and asserts every value the tour enters: both sides
# must stay identical.
# Fixture lead, matched by the tour's card selector (``:contains('Offline Tour Lead')``).
TOUR_LEAD_NAME = 'Offline Tour Lead'
# "edit the lead name" and "edit the expected revenue" (offline form edit).
TOUR_EDITED_NAME = 'Offline Tour Lead Edited'
TOUR_EDITED_REVENUE = 4242.0
# "enter the lead name" ... "enter the expected revenue" (offline mobile quick create). The stage
# select is left on its default, the displayed stage "New" (``stage_team1_1``).
TOUR_QC_NAME = 'Offline Tour New Lead'
TOUR_QC_CONTACT = 'Offline Tour Contact'
TOUR_QC_PHONE = '+32470000000'
TOUR_QC_EMAIL = 'offline.tour@example.com'
TOUR_QC_REVENUE = 1500.0
# "choose the To-Do activity type", "enter the follow-up summary" and "enter the follow-up due
# date" (offline follow-up from the lead card).
TOUR_FOLLOWUP_TYPE_LABEL = 'To-Do'
TOUR_FOLLOWUP_SUMMARY = 'Offline tour follow-up'
TOUR_FOLLOWUP_DATE = '2030-01-15'
# "move the lead to the won stage": the tour picks the stage option whose text is exactly this.
TOUR_WON_STAGE_LABEL = 'Won'

# The values the mobile quick create queues, exactly
# (addons/crm/static/src/mobile/crm_mobile_quick_create/crm_mobile_quick_create.js).
QUICK_CREATE_FIELDS = {'name', 'contact_name', 'phone', 'email_from', 'expected_revenue', 'stage_id'}


@tagged('post_install', '-at_install')
class TestCrmOffline(HttpCase, TestCrmCommon):
    """ Server side of the CRM offline and mobile feature.

    Lane 1: the PWA manifest served to CRM users (shortcuts and icons), and the
    server replay of the calls the framework offline queue stores for CRM
    records (lead edits, stage moves and mark-won, stage and team creates and
    edits, activity creates and mark-done), in the exact shape the queue keeps
    them and in the order its synchronisation replays them.

    Lane 3: the launcher of the ``crm_mobile_offline`` tour, an end-to-end
    offline session on the small-screen pipeline, whose replayed writes are
    asserted on the server after the tour.

    The browser size and touch emulation mirror ``MobileWebSuite``: only the
    tour opens a browser, and it needs the small-screen signal.
    """

    browser_size = '375x667'
    touch_enabled = True

    # ------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------

    def _queued(self, model, method, args, kwargs=None, time_stamp=0, error=None):
        """ Build a value shaped like the one ``OfflinePlugin.scheduleORM`` stores
        (``{model, method, args, kwargs, extras}``).

        :param str model: model of the queued call
        :param str method: method of the queued call
        :param list args: positional arguments, ids first for record methods
        :param dict kwargs: keyword arguments; defaults to the record-save kwargs
          ``{'context': {}, 'specification': {}}``. Pass ``{}`` for calls such as
          ``action_archive`` that take none.
        :param int time_stamp: ``extras.timeStamp``, the replay order key
        :param error: ``extras.error`` of a parked call (rejected on a previous sync)
        :return: queued value
        :rtype: dict
        """
        extras = {'timeStamp': time_stamp}
        if error:
            extras['error'] = error
        return {
            'model': model,
            'method': method,
            'args': args,
            'kwargs': kwargs if kwargs is not None else {'context': {}, 'specification': {}},
            'extras': extras,
        }

    def _replay(self, entries, user=None):
        """ Replay queued values as ``OfflinePlugin._syncORM`` does on reconnect.

        Parked calls (``extras.error`` set) are skipped, the others are sorted by
        ``extras.timeStamp`` and each is issued as the RPC the client sends, through
        ``call_kw`` on the model bound to the session user. No ``sudo()``: a replayed
        call carries the identity of the online call, so server access rights stay
        the only authority.

        :param list entries: values built by ``_queued``
        :param user: ``res.users`` record replaying the calls; defaults to
          ``user_sales_leads``
        :return: the result of each replayed call, in replay order
        :rtype: list
        """
        user = user or self.user_sales_leads
        pending = sorted(
            (entry for entry in entries if not entry['extras'].get('error')),
            key=lambda entry: entry['extras']['timeStamp'],
        )
        results = [
            call_kw(
                self.env[entry['model']].with_user(user),
                entry['method'],
                entry['args'],
                entry['kwargs'],
            )
            for entry in pending
        ]
        self.env.flush_all()
        self.env.invalidate_all()
        return results

    def _get_manifest(self):
        """ GET the main web manifest of the current session and return it decoded. """
        response = self.url_open('/web/manifest.webmanifest')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Content-Type'], 'application/manifest+json')
        return response.json()

    def _expected_parent_shortcuts(self, user):
        """ Compute the shortcuts the parent controller builds for ``user``.

        Same logic as ``WebManifest._get_shortcuts`` of the web addon
        (addons/web/controllers/webmanifest.py:15-40): installed modules among
        mail, crm, project and project_todo, in that order, each kept only when
        one of its menus is a root menu the user sees, in the parent's entry
        shape. It is the reference proving the parent's entries reach the
        manifest unchanged.

        :param user: ``res.users`` record the manifest is requested for
        :return: the parent's shortcuts for this user
        :rtype: list
        """
        env = self.env(user=user)
        module_names = ['mail', 'crm', 'project', 'project_todo']
        modules = env['ir.module.module'].search([
            ('state', '=', 'installed'), ('name', 'in', module_names),
        ]).sorted(key=lambda module: module_names.index(module.name))
        menu_roots = env['ir.ui.menu'].get_user_roots()
        datas = env['ir.model.data'].sudo().search([
            ('model', '=', 'ir.ui.menu'),
            ('res_id', 'in', menu_roots.ids),
            ('module', 'in', module_names),
        ])
        shortcuts = []
        for module in modules:
            data = datas.filtered(lambda res, name=module.name: res.module == name)
            if data:
                shortcuts.append({
                    'name': module.display_name,
                    'url': '/odoo?menu_id=%s' % data.mapped('res_id')[0],
                    'description': module.summary,
                    'icons': [{
                        'sizes': '100x100',
                        'src': module.icon,
                        'type': mimetypes.guess_type(module.icon)[0] or 'image/png',
                    }],
                })
        return shortcuts

    def _create_opportunity(self, name, **values):
        """ Create an opportunity of ``user_sales_leads`` in the first stage of ``sales_team_1``. """
        return self.env['crm.lead'].create({
            'name': name,
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_leads.id,
            'stage_id': self.stage_team1_1.id,
            **values,
        })

    def _count_lead_messages(self, lead):
        """ Number of messages posted on ``lead``'s chatter. """
        return self.env['mail.message'].search_count([
            ('model', '=', 'crm.lead'), ('res_id', '=', lead.id),
        ])

    def _create_lead_activity(self, lead, activity_type, summary):
        """ Create a persisted activity of ``user_sales_leads`` on ``lead``, due in two days. """
        return self.env['mail.activity'].create({
            'res_model_id': self.env['ir.model']._get_id('crm.lead'),
            'res_id': lead.id,
            'activity_type_id': activity_type.id,
            'summary': summary,
            'user_id': self.user_sales_leads.id,
            'date_deadline': fields.Date.today() + timedelta(days=2),
        })

    def _action_context(self, xmlid, **group_defaults):
        """ Context the views of a window action store with the calls they queue.

        The action's own context, evaluated as the web client evaluates it, plus the
        defaults a grouped view gives each group (``default_<group by field>``, see the
        group configs of ``RelationalModel``). The session keys of the client user
        context (``lang``, ``tz``, ``uid``, ``allowed_company_ids``) are left out, as in
        every replay of this class: the replaying user's environment carries the session.

        :param str xmlid: xmlid of the ``ir.actions.act_window``
        :param group_defaults: group defaults, such as ``default_stage_id``
        :return: stored context
        :rtype: dict
        """
        return {**safe_eval(self.env.ref(xmlid).context), **group_defaults}

    # ------------------------------------------------------------
    # PART 5: PWA manifest
    # ------------------------------------------------------------

    def test_webmanifest_crm_shortcuts(self):
        """ PART 5: "My Pipeline" and "New Lead" follow the parent's unchanged shortcuts, in its shape. """
        self.authenticate('user_sales_salesman', 'user_sales_salesman')
        shortcuts = self._get_manifest()['shortcuts']

        root = self.env.ref('crm.crm_menu_root')
        pipeline_menu = self.env.ref('crm.menu_crm_opportunities')
        expected = self._expected_parent_shortcuts(self.user_sales_salesman)
        self.assertIn(
            f'/odoo?menu_id={root.id}', [shortcut['url'] for shortcut in expected],
            'The parent lists the CRM app for a salesman: the CRM shortcuts are eligible',
        )
        self.assertEqual(shortcuts[:len(expected)], expected,
                         'The parent entries come first, unchanged, the CRM app entry included')
        self.assertEqual(len(shortcuts), len(expected) + 2)

        my_pipeline, new_lead = shortcuts[-2:]
        self.assertEqual(my_pipeline['name'], 'My Pipeline')
        self.assertEqual(my_pipeline['url'], f'/odoo?menu_id={pipeline_menu.id}')
        self.assertEqual(new_lead['name'], 'New Lead')
        self.assertEqual(
            new_lead['url'],
            f'/odoo?menu_id={root.id}&action=crm.crm_lead_action_pipeline&view_type=form',
        )
        for shortcut in (my_pipeline, new_lead):
            self.assertTrue(shortcut['name'])
            self.assertTrue(shortcut['description'])
            self.assertTrue(shortcut['url'].startswith('/odoo?menu_id='))
            self.assertEqual(shortcut['icons'], CRM_SHORTCUT_ICONS)
            for icon in shortcut['icons']:
                self.assertEqual(self.url_open(icon['src']).status_code, 200,
                                 f'Icon {icon["src"]} is an existing asset')

        # upstream invariants of every shortcut (addons/web/tests/test_webmanifest.py)
        for shortcut in shortcuts:
            self.assertGreater(len(shortcut['name']), 0)
            self.assertGreater(len(shortcut['description']), 0)
            self.assertGreater(len(shortcut['icons']), 0)
            self.assertTrue(shortcut['url'].startswith('/odoo?menu_id='))

        with self.subTest(case='missing pipeline menu'):
            # a customization removed the pipeline menu's reference: no partial CRM set is published
            self.env['ir.model.data'].search([
                ('module', '=', 'crm'), ('name', '=', 'menu_crm_opportunities'),
            ]).unlink()
            self.assertIsNone(self.env.ref('crm.menu_crm_opportunities', raise_if_not_found=False))
            data = self._get_manifest()
            self.assertEqual(data['shortcuts'], self._expected_parent_shortcuts(self.user_sales_salesman),
                             'A missing pipeline menu leaves the parent shortcuts untouched')
            self.assertEqual(data['icons'], CRM_MANIFEST_ICONS, 'The CRM app entry is still listed')

    def test_webmanifest_crm_icon(self):
        """ PART 5, K3: CRM users get the addon's icons; every other manifest key, route and icon stays the parent's. """
        self.authenticate('user_sales_salesman', 'user_sales_salesman')
        data = self._get_manifest()

        self.assertEqual(data['icons'], CRM_MANIFEST_ICONS)
        for icon in data['icons']:
            self.assertEqual(self.url_open(icon['src']).status_code, 200,
                             f'Icon {icon["src"]} is an existing asset')

        web_app_name = self.env['ir.config_parameter'].sudo().get_str('web.web_app_name') or 'Odoo'
        self.assertEqual(data['name'], web_app_name)
        self.assertEqual(data['scope'], '/odoo')
        self.assertEqual(data['start_url'], '/odoo')
        self.assertEqual(data['display'], 'standalone')
        self.assertEqual(data['background_color'], '#714B67')
        self.assertEqual(data['theme_color'], '#714B67')
        self.assertIs(data['prefer_related_applications'], False)
        self.assertEqual(data['share_target']['action'], '/odoo?share_target=trigger')
        self.assertEqual(data['share_target']['method'], 'POST')

        # the offline page and the scoped apps keep the parent's ``_icon_path``
        self.assertEqual(self.url_open('/odoo/offline').status_code, 200)
        response = self.url_open('/web/manifest.scoped_app_manifest?app_id=test&path=/test&app_name=Test')
        self.assertEqual(response.status_code, 200)
        scoped = response.json()
        self.assertEqual(scoped['icons'], SCOPED_APP_ICONS)
        self.assertEqual(scoped['shortcuts'], [])

    def test_webmanifest_unauthenticated_no_crm_shortcuts(self):
        """ PART 5, K3: anonymous visitors get no shortcut and the parent's Odoo icons. """
        data = self._get_manifest()
        self.assertEqual(len(data['shortcuts']), 0)
        self.assertCountEqual(data['icons'], ODOO_MANIFEST_ICONS)

    # ------------------------------------------------------------
    # PART 2.2 / 3a: replay of the framework-queued CRM writes
    # ------------------------------------------------------------

    def test_offline_edit_replay_matches_online(self):
        """ PART 2.2, K7: a replayed offline form save propagates email and phone to the partner as the online save does. """
        email, phone = 'offline.sync@test.example.com', '+32 494 44 44 44'
        partner_a, partner_b = self.env['res.partner'].create([
            {'name': 'Offline Sync Partner A'},
            {'name': 'Offline Sync Partner B'},
        ])
        lead_a = self._create_opportunity('Offline Sync Lead A', partner_id=partner_a.id, email_from=email, phone=phone)
        lead_b = self._create_opportunity('Offline Sync Lead B', partner_id=partner_b.id, email_from=email, phone=phone)
        (partner_a + partner_b).write({'email': False, 'phone': False})
        for lead in lead_a + lead_b:
            self.assertEqual(lead.email_from, email)
            self.assertEqual(lead.phone, phone)
            self.assertTrue(lead.partner_email_update)
            self.assertTrue(lead.partner_phone_update)

        # lead A: the queued call, carrying the form's partner-sync copy of email and phone
        self._replay([self._queued('crm.lead', 'web_save', [
            [lead_a.id],
            {
                'name': 'Offline Edited Lead',
                'expected_revenue': 4242.0,
                'email_from': lead_a.email_from,
                'phone': lead_a.phone,
            },
        ], {'context': {}, 'specification': {}}, time_stamp=1)])

        # lead B: the online form save of the same values
        call_kw(self.env['crm.lead'].with_user(self.user_sales_leads), 'web_save', [
            [lead_b.id],
            {
                'name': 'Offline Edited Lead',
                'expected_revenue': 4242.0,
                'email_from': lead_b.email_from,
                'phone': lead_b.phone,
            },
        ], {
            'context': {'lang': 'en_US'},
            'specification': {
                'name': {}, 'expected_revenue': {}, 'email_from': {}, 'phone': {},
                'partner_email_update': {}, 'partner_phone_update': {},
            },
        })
        self.env.flush_all()
        self.env.invalidate_all()

        def lead_state(lead):
            return (
                lead.name, lead.expected_revenue, lead.email_from, lead.phone,
                lead.partner_id.email, lead.partner_id.phone,
                lead.partner_email_update, lead.partner_phone_update,
            )

        self.assertEqual(lead_state(lead_a), lead_state(lead_b),
                         'The replayed offline save ends in the state of the online save')
        self.assertEqual(lead_a.name, 'Offline Edited Lead')
        self.assertEqual(lead_a.expected_revenue, 4242.0)
        self.assertEqual(partner_a.email, email, 'The lead email was propagated to the partner')
        self.assertEqual(partner_a.phone, phone, 'The lead phone was propagated to the partner')
        self.assertFalse(lead_a.partner_email_update)
        self.assertFalse(lead_a.partner_phone_update)

    def test_offline_mark_won_replay(self):
        """ PART 3a, K4, N2: a replayed stage move to the won stage marks the lead won. """
        lead = self._create_opportunity('Offline Won Lead', expected_revenue=1000)
        self.assertEqual(lead.won_status, 'pending')

        self._replay([self._queued(
            'crm.lead', 'web_save', [[lead.id], {'stage_id': self.stage_team1_won.id}],
            {'context': {}, 'specification': {}}, time_stamp=1,
        )])

        self.assertEqual(lead.stage_id, self.stage_team1_won)
        self.assertEqual(lead.won_status, 'won')
        self.assertEqual(lead.probability, 100)
        self.assertTrue(lead.active)

    def test_offline_stage_team_replay(self):
        """ PART 3a, rows C2/C3: replayed offline creates and edits of stages and teams reach the server. """
        stage_create = self._queued('crm.stage', 'web_save', [
            [], {'name': 'Offline Stage', 'team_ids': [[4, self.sales_team_1.id]]},
        ], {'context': {}, 'specification': {}}, time_stamp=1)
        [stage_result] = self._replay([stage_create], user=self.user_sales_manager)
        stage = self.env['crm.stage'].browse(stage_result[0]['id'])
        self._replay([self._queued(
            'crm.stage', 'web_save', [[stage.id], {'name': 'Offline Stage Renamed'}],
            {'context': {}, 'specification': {}}, time_stamp=2,
        )], user=self.user_sales_manager)

        team_create = self._queued('crm.team', 'web_save', [
            [], {'name': 'Offline Team'},
        ], {'context': {}, 'specification': {}}, time_stamp=3)
        [team_result] = self._replay([team_create], user=self.user_sales_manager)
        team = self.env['crm.team'].browse(team_result[0]['id'])
        self._replay([self._queued(
            'crm.team', 'web_save', [[team.id], {'name': 'Offline Team Renamed'}],
            {'context': {}, 'specification': {}}, time_stamp=4,
        )], user=self.user_sales_manager)

        self.assertTrue(stage.exists())
        self.assertEqual(stage.name, 'Offline Stage Renamed')
        self.assertEqual(stage.team_ids, self.sales_team_1)
        self.assertTrue(team.exists())
        self.assertEqual(team.name, 'Offline Team Renamed')

    def test_offline_last_write_wins_replay(self):
        """ Gate 8: queued writes replay in timestamp order, the later one wins and a parked one is skipped. """
        lead = self._create_opportunity('Offline Priority Lead', priority='0')
        # K1: the form save, K2: the later kanban star click, both on the same field
        k1 = self._queued('crm.lead', 'web_save', [[lead.id], {'priority': '1'}], time_stamp=1000)
        k2 = self._queued('crm.lead', 'web_save', [[lead.id], {'priority': '3'}], time_stamp=2000)
        # a call rejected by a previous sync stays parked, whatever its timestamp
        parked = self._queued('crm.lead', 'web_save', [[lead.id], {'priority': '2'}], time_stamp=3000, error='x')

        # handed over out of order: replayed in timestamp order, so the later write wins
        results = self._replay([k2, parked, k1])

        self.assertEqual(len(results), 2, 'The parked call is not replayed')
        self.assertEqual(lead.priority, '3')

    # ------------------------------------------------------------
    # PART 3a, rows A, B, C1 and D1-D6: replay of the other framework-queued CRM calls
    # ------------------------------------------------------------

    def test_offline_partner_color_edit_replay(self):
        """ PART 3a, 3c, K9 (Q13, Q14): replayed partner and kanban color edits reach the lead as online saves do. """
        with self.subTest(shape='Q13 partner edit'):
            partner = self.env['res.partner'].create({
                'name': 'Offline Edit Partner',
                'email': 'offline.edit.partner@test.example.com',
                'phone': '+32 470 99 88 77',
            })
            lead = self._create_opportunity('Offline Partner Lead')
            self.assertFalse(lead.partner_id)
            self.assertFalse(lead.email_from)
            self.assertFalse(lead.phone)

            # the form save of a name edit and of a partner picked from the cached suggestions
            self._replay([self._queued('crm.lead', 'web_save', [
                [lead.id], {'name': 'Offline Partner Lead Edited', 'partner_id': partner.id},
            ], {'context': {}, 'specification': {}}, time_stamp=1)])

            self.assertEqual(lead.name, 'Offline Partner Lead Edited')
            self.assertEqual(lead.partner_id, partner)
            # the partner's email and phone reach the lead through its computes, as online
            self.assertEqual(lead.email_from, 'offline.edit.partner@test.example.com')
            self.assertEqual(lead.phone, '+32 470 99 88 77')
            self.assertFalse(lead.partner_email_update)
            self.assertFalse(lead.partner_phone_update)

        with self.subTest(shape='Q14 color edit'):
            lead = self._create_opportunity('Offline Color Lead')
            self.assertEqual(lead.color, 0)

            # the kanban color picker's save
            self._replay([self._queued(
                'crm.lead', 'web_save', [[lead.id], {'color': 2}],
                {'context': {}, 'specification': {}}, time_stamp=2,
            )])

            self.assertEqual(lead.color, 2)

    def test_offline_archive_unarchive_replay(self):
        """ PART 3a, rows C1, D1-D3 (Q15, Q16, Q18, Q19): replayed lead and team archives and unarchives reach the server. """
        # Archive and Unarchive store the view's context as their only keyword argument
        pipeline_context = self._action_context('crm.crm_lead_action_pipeline')
        team_context = self._action_context('sales_team.crm_team_action_config')

        with self.subTest(shape='Q15 lead archive'):
            lead_1 = self._create_opportunity('Offline Archived Lead 1')
            lead_2 = self._create_opportunity('Offline Archived Lead 2')

            # the list selection's Archive: one positional argument holding the ids
            [result] = self._replay([self._queued(
                'crm.lead', 'action_archive', [[lead_1.id, lead_2.id]],
                {'context': pipeline_context}, time_stamp=1,
            )])

            self.assertFalse(result, 'No action for the client to open')
            self.assertFalse(lead_1.active)
            self.assertFalse(lead_2.active)

        with self.subTest(shape='Q16 lead unarchive'):
            lost_reason = self.env['crm.lost.reason'].create({'name': 'Offline Lost Reason'})
            lead = self._create_opportunity('Offline Lost Lead')
            lead.action_set_lost(lost_reason_id=lost_reason.id)
            self.assertFalse(lead.active)
            self.assertEqual(lead.won_status, 'lost')

            # the form's Unarchive
            [result] = self._replay([self._queued(
                'crm.lead', 'action_unarchive', [[lead.id]], {'context': pipeline_context}, time_stamp=2,
            )])

            self.assertFalse(result, 'No action for the client to open')
            self.assertTrue(lead.active)
            # the CRM override of ``action_unarchive`` reverts the loss, as online
            self.assertFalse(lead.lost_reason_id)
            self.assertEqual(lead.won_status, 'pending')

        with self.subTest(shape='Q18, Q19 team archive and unarchive'):
            team = self.env['crm.team'].create({'name': 'Offline Archived Team'})

            self._replay([self._queued(
                'crm.team', 'action_archive', [[team.id]], {'context': team_context}, time_stamp=3,
            )], user=self.user_sales_manager)
            self.assertFalse(team.active)

            self._replay([self._queued(
                'crm.team', 'action_unarchive', [[team.id]], {'context': team_context}, time_stamp=4,
            )], user=self.user_sales_manager)
            self.assertTrue(team.active)

    def test_offline_unlink_replay(self):
        """ PART 3a, rows B and D4-D6 (Q17, Q20, Q21): replayed lead, team and stage deletes of a sales manager reach the server. """
        # Delete stores the view's context as its only keyword argument
        with self.subTest(shape='Q17 lead delete'):
            leads = self._create_opportunity('Offline Deleted Lead 1') + self._create_opportunity('Offline Deleted Lead 2')

            # the list selection's Delete: one positional argument holding the ids
            [result] = self._replay([self._queued(
                'crm.lead', 'web_unlink', [leads.ids],
                {'context': self._action_context('crm.crm_lead_action_pipeline')}, time_stamp=1,
            )], user=self.user_sales_manager)

            self.assertIs(result, True)
            self.assertFalse(leads.exists())

        with self.subTest(shape='Q20 team delete'):
            # a team no stage lists: ``crm.stage.team_ids`` restricts the deletion of a listed team
            team = self.env['crm.team'].create({'name': 'Offline Deleted Team'})
            self.assertFalse(self.env['crm.stage'].search_count([('team_ids', 'in', team.ids)]))

            [result] = self._replay([self._queued(
                'crm.team', 'web_unlink', [[team.id]],
                {'context': self._action_context('sales_team.crm_team_action_config')}, time_stamp=2,
            )], user=self.user_sales_manager)

            self.assertIs(result, True)
            self.assertFalse(team.exists())

        with self.subTest(shape='Q21 stage delete'):
            # a stage of the team's pipeline holding no lead
            stage = self.env['crm.stage'].create({
                'name': 'Offline Deleted Stage',
                'team_ids': [(4, self.sales_team_1.id)],
            })
            self.assertFalse(self.env['crm.lead'].with_context(active_test=False).search_count([
                ('stage_id', '=', stage.id),
            ]))

            [result] = self._replay([self._queued(
                'crm.stage', 'web_unlink', [[stage.id]],
                {'context': self._action_context('crm.crm_stage_action')}, time_stamp=3,
            )], user=self.user_sales_manager)

            self.assertIs(result, True)
            self.assertFalse(stage.exists())

    def test_offline_unlink_rejected_replay(self):
        """ PART 3a, rows B and D4-D6 (Q17, Q21): a replayed delete the server forbids raises and deletes nothing, so the client parks it. """
        with self.subTest(case='Q17 lead delete without the unlink right'):
            # ``group_sale_salesman_all_leads`` may create, read and write leads, not delete them
            lead = self._create_opportunity('Offline Undeletable Lead')
            message_count = self._count_lead_messages(lead)
            self.assertTrue(message_count)

            with self.assertRaises(AccessError):
                self._replay([self._queued(
                    'crm.lead', 'web_unlink', [[lead.id]],
                    {'context': self._action_context('crm.crm_lead_action_pipeline')}, time_stamp=1,
                )])

            # the transaction stays usable, and neither the lead nor its chatter is deleted
            self.assertTrue(lead.exists())
            self.assertEqual(self._count_lead_messages(lead), message_count)

        with self.subTest(case='Q21 stage delete of a stage holding a lead'):
            # ``crm.lead.stage_id`` restricts the deletion of a stage that still holds a lead
            stage = self.env['crm.stage'].create({
                'name': 'Offline Undeletable Stage',
                'team_ids': [(4, self.sales_team_1.id)],
            })
            lead = self._create_opportunity('Offline Staged Lead', stage_id=stage.id)

            # the database refuses the DELETE, which ``web_unlink`` rolls back and reports
            with mute_logger('odoo.sql_db'), self.assertRaises(UnlinkBlockedError) as blocked:
                self._replay([self._queued(
                    'crm.stage', 'web_unlink', [[stage.id]],
                    {'context': self._action_context('crm.crm_stage_action')}, time_stamp=2,
                )], user=self.user_sales_manager)

            self.assertEqual(blocked.exception.context['res_model'], 'crm.stage')
            self.assertEqual(blocked.exception.context['blocked_ids'], stage.ids)
            self.assertIs(blocked.exception.context['archivable'], False, 'A stage cannot be archived instead')
            self.assertTrue(stage.exists())
            self.assertEqual(lead.stage_id, stage)

    # ------------------------------------------------------------
    # PART 3b: replay of the activity calls queued by the lead card
    # ------------------------------------------------------------

    def test_offline_activity_create_replay(self):
        """ PART 3b, N3: a replayed follow-up or log-call create, given ``res_model`` only, links the activity to the lead. """
        lead = self._create_opportunity('Offline Activity Lead')
        crm_lead_model = self.env['ir.model']._get('crm.lead')
        date_deadline = fields.Date.today() + timedelta(days=2)
        for xmlid, summary in (
            ('mail.mail_activity_data_todo', 'Offline follow-up'),
            ('mail.mail_activity_data_call', 'Offline log call'),
        ):
            with self.subTest(activity_type=xmlid):
                activity_type = self.env.ref(xmlid)
                # Exactly the values the card queues: the client knows the model name, never
                # the ``ir.model`` id. Without the ``mail.activity.create`` override of crm,
                # ``res_model`` (a readonly related of ``res_model_id``) is left empty and the
                # create fails the ``_check_res_id_is_set_if_model`` constraint.
                [result] = self._replay([self._queued('mail.activity', 'web_save', [[], {
                    'res_model': 'crm.lead',
                    'res_id': lead.id,
                    'activity_type_id': activity_type.id,
                    'summary': summary,
                    'date_deadline': fields.Date.to_string(date_deadline),
                    'user_id': self.user_sales_leads.id,
                }], {'context': {}, 'specification': {}}, time_stamp=1)])
                activity = self.env['mail.activity'].browse(result[0]['id'])

                self.assertIn(activity, lead.activity_ids)
                self.assertEqual(activity.res_model_id, crm_lead_model)
                self.assertEqual(activity.res_model, 'crm.lead')
                self.assertEqual(activity.res_id, lead.id)
                self.assertEqual(activity.activity_type_id, activity_type)
                self.assertEqual(activity.summary, summary)
                self.assertEqual(activity.date_deadline, date_deadline)
                self.assertEqual(activity.user_id, self.user_sales_leads)

    def test_offline_activity_done_replay(self):
        """ PART 3b, N4: a replayed mark-done archives the activity only: no feedback, no event, no upload. """
        lead = self._create_opportunity('Offline Done Lead')
        crm_lead_model_id = self.env['ir.model']._get_id('crm.lead')

        with self.subTest(category='default'):
            activity = self._create_lead_activity(lead, self.env.ref('mail.mail_activity_data_todo'), 'To do')
            message_count = self._count_lead_messages(lead)

            self._replay([self._queued('mail.activity', 'action_archive', [[activity.id]], kwargs={}, time_stamp=1)])

            self.assertIs(activity.active, False)
            self.assertEqual(activity.state, 'done')
            self.assertNotIn(activity, lead.activity_ids)
            self.assertEqual(self._count_lead_messages(lead), message_count,
                             'No feedback message, unlike the online "action_done"')

        with self.subTest(category='meeting'):
            start = fields.Datetime.now().replace(microsecond=0) + timedelta(days=3)
            event = self.env['calendar.event'].create({
                'name': 'Offline Meeting',
                'start': start,
                'stop': start + timedelta(hours=1),
                'user_id': self.user_sales_leads.id,
                'opportunity_id': lead.id,
                'res_model_id': crm_lead_model_id,
                'res_id': lead.id,
                'meeting_activity_ids': [(0, 0, {
                    'activity_type_id': self.activity_type_1.id,
                    'res_model_id': crm_lead_model_id,
                    'res_id': lead.id,
                    'user_id': self.user_sales_leads.id,
                    'date_deadline': start.date(),
                })],
            })
            meeting = event.meeting_activity_ids
            self.assertEqual(len(meeting), 1)
            self.assertEqual(meeting.calendar_event_id, event)
            self.assertEqual(meeting.activity_type_id.category, 'meeting')
            self.env.flush_all()
            self.env.invalidate_all()
            event_dates = (event.start, event.stop)
            event_count = self.env['calendar.event'].search_count([])
            message_count = self._count_lead_messages(lead)

            self._replay([self._queued('mail.activity', 'action_archive', [[meeting.id]], kwargs={}, time_stamp=2)])

            self.assertIs(meeting.active, False)
            self.assertEqual(meeting.state, 'done')
            self.assertEqual((event.start, event.stop), event_dates, 'The linked event is not moved')
            self.assertEqual(self.env['calendar.event'].search_count([]), event_count, 'No event is created')
            self.assertEqual(self._count_lead_messages(lead), message_count, 'No feedback message')

        with self.subTest(category='upload_file'):
            upload_type = self.env.ref('mail.mail_activity_data_upload_document')
            self.assertEqual(upload_type.category, 'upload_file')
            activity = self._create_lead_activity(lead, upload_type, 'Upload the offer')
            attachment_domain = [('res_model', '=', 'crm.lead'), ('res_id', '=', lead.id)]
            attachment_count = self.env['ir.attachment'].search_count(attachment_domain)
            message_count = self._count_lead_messages(lead)

            self._replay([self._queued('mail.activity', 'action_archive', [[activity.id]], kwargs={}, time_stamp=3)])

            self.assertIs(activity.active, False)
            self.assertEqual(activity.state, 'done')
            self.assertEqual(self.env['ir.attachment'].search_count(attachment_domain), attachment_count,
                             'No document is uploaded')
            self.assertEqual(self._count_lead_messages(lead), message_count, 'No feedback message')

    # ------------------------------------------------------------
    # PART 4, N1: replay of the mobile quick create
    # ------------------------------------------------------------

    def test_offline_quick_create_replay(self):
        """ PART 4, N1 (Q01): a replayed mobile quick create makes an opportunity of the six values and the group defaults, and no contact. """
        stage = self.stage_team1_2
        # the context of the pipeline group the sheet saves into, as the quick create stores it
        group_context = self._action_context('crm.crm_lead_action_pipeline', default_stage_id=stage.id)
        self.assertEqual(group_context['default_type'], 'opportunity')
        # without the group's ``default_type``, this user would create a lead, not an opportunity
        self.assertTrue(self.user_sales_leads.has_group('crm.group_use_lead'))
        partners = self.env['res.partner'].with_context(active_test=False)
        partner_count = partners.search_count([])

        for case, vals in (
            ('all values', {
                'name': 'Offline Quick Lead',
                'contact_name': 'Offline Quick Contact',
                'phone': '+32 470 12 34 56',
                'email_from': 'offline.quick@test.example.com',
                'expected_revenue': 1500.0,
                'stage_id': stage.id,
            }),
            # the sheet writes ``false`` for an empty char and 0 for an empty revenue
            ('empty optional values', {
                'name': 'Offline Quick Lead Empty',
                'contact_name': False,
                'phone': False,
                'email_from': False,
                'expected_revenue': 0,
                'stage_id': stage.id,
            }),
        ):
            with self.subTest(case=case):
                self.assertEqual(set(vals), QUICK_CREATE_FIELDS)
                [result] = self._replay([self._queued(
                    'crm.lead', 'web_save', [[], vals],
                    {'context': group_context, 'specification': {}}, time_stamp=1,
                )])

                # ``web_save`` answers with the saved records: the client reads ``result[0]['id']``
                self.assertEqual(len(result), 1)
                self.assertIsInstance(result[0], dict)
                lead = self.env['crm.lead'].browse(result[0]['id'])
                self.assertEqual(lead, self.env['crm.lead'].search([('name', '=', vals['name'])]))
                self.assertEqual(lead.name, vals['name'])
                self.assertEqual(lead.contact_name, vals['contact_name'])
                self.assertEqual(lead.phone, vals['phone'])
                self.assertEqual(lead.email_from, vals['email_from'])
                self.assertEqual(lead.expected_revenue, vals['expected_revenue'])
                self.assertEqual(lead.stage_id, stage)
                # defaults: the group's type, the replaying salesperson and that salesperson's team
                self.assertEqual(lead.type, 'opportunity')
                self.assertEqual(lead.user_id, self.user_sales_leads)
                self.assertEqual(lead.team_id, self.sales_team_1)
                self.assertTrue(lead.active)
                # the contact is captured as a name only: no partner is linked or created
                self.assertFalse(lead.partner_id)
                self.assertEqual(partners.search_count([]), partner_count)

    # ------------------------------------------------------------
    # K9 and DISABLE guards: offline wiring of the production views
    # ------------------------------------------------------------

    def test_offline_availability_view_wiring(self):
        """ K9, DISABLE guards: the production views keep the offline wiring the lane-2 fixtures repeat. """
        def own_arch(xmlid):
            # the view's own arch, as its XML file defines it, without inheriting views
            return etree.fromstring(self.env.ref(xmlid).arch)

        # pipeline card menu: Edit and Delete stay usable offline, the offline plugin reads the
        # attribute the card compiler copies onto the rendered anchors
        [menu] = own_arch('crm.crm_case_kanban_view_leads').xpath("//templates/t[@t-name='menu']")
        for anchor_type in ('open', 'delete'):
            with self.subTest(anchor=anchor_type):
                anchors = menu.xpath(f".//a[@type='{anchor_type}']")
                self.assertEqual(len(anchors), 1)
                self.assertEqual(anchors[0].get('data-available-offline'), '1')

        # lead name: rendered by ``web.TextField``, whose <textarea> the CRM extension marks
        [name_field] = own_arch('crm.crm_lead_view_form').xpath("//field[@name='name'][not(ancestor::field)]")
        self.assertEqual(name_field.get('widget'), 'text')

        # CRM settings: each DISABLE button is named as ``CRM_FOREIGN_DISABLED_BUTTONS`` lists it,
        # the action buttons by xmlid (not by database id), and opens the same target online
        settings = own_arch('crm.res_config_settings_view_form')
        for name, button_type in (
            ('crm.crm_recurring_plan_action', 'action'),
            ('crm.crm_lead_pls_update_action', 'action'),
            ('action_crm_assign_leads', 'object'),
        ):
            with self.subTest(button=name):
                buttons = settings.xpath(f"//button[@name='{name}']")
                self.assertEqual(len(buttons), 1)
                self.assertEqual(buttons[0].get('type'), button_type)
                if button_type == 'action':
                    self.assertEqual(self.env.ref(name)._name, 'ir.actions.act_window')
                else:
                    self.assertTrue(callable(getattr(self.env['res.config.settings'], name, None)))

    def test_mobile_pipeline_arch_fetches_fields_it_reads(self):
        """ PART 4: the production pipeline arch, as served to a salesman, fetches every lead field the mobile pipeline and its cards read. """
        pipeline_view = self.env.ref('crm.crm_case_kanban_view_leads')
        result = self.env['crm.lead'].with_user(self.user_sales_salesman).get_views([(pipeline_view.id, 'kanban')])
        arch = etree.fromstring(result['views']['kanban']['arch'])

        # the mobile pipeline gate: grouped by stage, rendered by ``crm_mobile_pipeline``
        self.assertEqual(arch.tag, 'kanban')
        self.assertEqual(arch.get('js_class'), 'crm_mobile_pipeline')
        self.assertEqual(arch.get('default_group_by'), 'stage_id')
        # the stage revenue totals read ``record.data[sum_field]``
        [progressbar] = arch.xpath('//progressbar')
        self.assertEqual(progressbar.get('sum_field'), 'expected_revenue')

        # The web client fetches the arch's field nodes and their widgets' declared dependencies;
        # only relational sub-specs get a ``display_name``, the root record gets none. So the
        # pipeline must read only fields this arch fetches: root ``display_name`` is not one of them.
        root_fields = set(arch.xpath('//field[not(ancestor::field)]/@name'))
        lead_fields = result['models']['crm.lead']['fields']
        for field_name in (
            'stage_id',  # pending stage placement, ``CrmKanbanRecord.serverStageId``
            'expected_revenue',  # stage revenue totals, card revenue
            'name',  # card name, move and create status announcements
            'partner_id',  # card partner
            'contact_name',  # card partner fallback
            'company_currency',  # card revenue currency
        ):
            with self.subTest(field=field_name):
                self.assertIn(field_name, root_fields)
                self.assertIn(field_name, lead_fields)

    # ------------------------------------------------------------
    # Lane 3: end-to-end offline session on the mobile pipeline
    # ------------------------------------------------------------

    def test_mobile_offline_tour(self):
        """ Gate 6, lane 3: an offline edit, quick create, follow-up and mark-won on a phone all reach the server on reconnect. """
        partner = self.env['res.partner'].create({'name': 'Offline Tour Partner'})
        lead = self._create_opportunity(TOUR_LEAD_NAME, partner_id=partner.id, expected_revenue=500)

        # The pipeline lists the user's team stages plus every team-less stage, which include
        # the data stages "New" and "Won" and the "Generic Won" fixture. Move every other stage
        # to a team without members, so the tour's exact stage labels are unique: the pipeline
        # shows New -> Proposition -> Won of sales_team_1 only.
        team_stages = self.stage_team1_1 + self.stage_team1_2 + self.stage_team1_won
        hidden_team = self.env['crm.team'].create({'name': 'Offline Tour Hidden Team'})
        self.env['crm.stage'].search([('id', 'not in', team_stages.ids)]).write({
            'team_ids': [(6, 0, hidden_team.ids)],
        })
        self.assertEqual(
            team_stages.filtered(lambda stage: stage.name == TOUR_WON_STAGE_LABEL), self.stage_team1_won,
        )

        self.start_tour('/odoo/action-crm.crm_lead_action_pipeline', 'crm_mobile_offline', login='user_sales_leads')
        self.env.invalidate_all()

        # offline form edit
        self.assertEqual(lead.name, TOUR_EDITED_NAME)
        self.assertEqual(lead.expected_revenue, TOUR_EDITED_REVENUE)

        # offline quick create: the six values, in the displayed stage, as an opportunity
        new_lead = self.env['crm.lead'].search([('name', '=', TOUR_QC_NAME)])
        self.assertEqual(len(new_lead), 1)
        self.assertEqual(new_lead.contact_name, TOUR_QC_CONTACT)
        self.assertEqual(new_lead.phone, TOUR_QC_PHONE)
        self.assertEqual(new_lead.email_from, TOUR_QC_EMAIL)
        self.assertEqual(new_lead.expected_revenue, TOUR_QC_REVENUE)
        self.assertEqual(new_lead.stage_id, self.stage_team1_1)
        self.assertEqual(new_lead.type, 'opportunity')

        # offline follow-up from the lead card
        activity = lead.activity_ids.filtered(lambda act: act.summary == TOUR_FOLLOWUP_SUMMARY)
        self.assertEqual(len(activity), 1)
        self.assertEqual(activity.res_model_id, self.env['ir.model']._get('crm.lead'))
        self.assertEqual(activity.activity_type_id.name, TOUR_FOLLOWUP_TYPE_LABEL)
        self.assertEqual(activity.date_deadline, fields.Date.to_date(TOUR_FOLLOWUP_DATE))
        self.assertEqual(activity.user_id, self.user_sales_leads)

        # offline mark-won through the card's stage list
        self.assertEqual(lead.stage_id, self.stage_team1_won)
        self.assertTrue(lead.stage_id.is_won)
        self.assertEqual(lead.won_status, 'won')
        self.assertEqual(lead.probability, 100)
        self.assertTrue(lead.active)
