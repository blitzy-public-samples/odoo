# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import Command
from odoo.addons.base.tests.common import HttpCaseWithUserDemo


class TestCrmOffline(HttpCaseWithUserDemo):
    """ HTTP-level proof for controllers/webmanifest.py's ``_get_shortcuts()``
    override (architecture.md §3.5, VAL-PWA-001..004): the override only
    ever ADDS to the parent's shortcuts, resolves both menu ids from their
    XML ids at request time (never hardcoded), and gates the two CRM
    entries on the CRM root menu being visible to the current user -- the
    same gate web's own module shortcuts use (``ir.ui.menu.get_user_roots()``).

    This class intentionally shares its name with ``test_crm_offline.py``'s
    ``TestCrmOffline`` (a ``TestCrmCommon``/``TransactionCase``): Odoo's
    ``--test-tags`` class filter (``odoo/tests/tag_selector.py``) matches on
    ``test.__class__.__name__`` only, independent of the file it is defined
    in, so ``./scripts/dev/test-py.sh TestCrmOffline`` (``--test-tags
    /crm:TestCrmOffline``) runs both classes. An HttpCase is required here
    (unlike the rest of TestCrmOffline) because the assertions are about the
    actual served ``/web/manifest.webmanifest`` route, which needs a real
    HTTP request/response cycle, not a controller method called in-process.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # A plain internal user with no sales_team group: crm_menu_root's
        # menuitem is restricted to group_sale_salesman/group_sale_manager,
        # so this user cannot see it and must get no CRM shortcut
        # (VAL-PWA-003). `demo` is unusable for this: crm's demo data makes
        # it a salesman.
        cls.user_no_crm_access = cls.env['res.users'].create({
            'name': 'No CRM Access',
            'login': 'test_crm_offline_no_crm_access',
            'group_ids': [Command.set([cls.env.ref('base.group_user').id])],
        })

    def test_crm_shortcuts_added_for_user_with_crm_root_menu(self):
        """ A user who can see crm.crm_menu_root (admin: sales manager)
        gets the parent's shortcuts plus exactly "My Pipeline" and
        "New Lead", shaped like the parent's own shortcuts, with both menu
        ids resolved from their XML ids. """
        self.authenticate('admin', 'admin')
        response = self.url_open('/web/manifest.webmanifest')
        self.assertEqual(response.status_code, 200)
        data = response.json()

        pipeline_menu_id = self.env.ref('crm.menu_crm_opportunities').id
        crm_root_menu_id = self.env.ref('crm.crm_menu_root').id
        expected_icons = [{
            'sizes': '100x100',
            'src': '/crm/static/description/icon.png',
            'type': 'image/png',
        }]

        shortcuts_by_name = {shortcut['name']: shortcut for shortcut in data['shortcuts']}
        self.assertIn('My Pipeline', shortcuts_by_name)
        self.assertIn('New Lead', shortcuts_by_name)

        pipeline_shortcut = shortcuts_by_name['My Pipeline']
        self.assertEqual(pipeline_shortcut['url'], f'/odoo?menu_id={pipeline_menu_id}')
        self.assertTrue(pipeline_shortcut['description'])
        self.assertEqual(pipeline_shortcut['icons'], expected_icons)

        new_lead_shortcut = shortcuts_by_name['New Lead']
        self.assertEqual(new_lead_shortcut['url'], f'/odoo?menu_id={crm_root_menu_id}&action=crm&resId=new')
        self.assertTrue(new_lead_shortcut['description'])
        self.assertEqual(new_lead_shortcut['icons'], expected_icons)

        # The override only adds to what the parent produces; it never
        # removes or replaces a parent-produced entry.
        self.assertGreaterEqual(len(data['shortcuts']), 2)

    def test_crm_shortcuts_absent_without_crm_root_menu(self):
        """ A user who cannot see crm.crm_menu_root gets no CRM shortcut:
        the override adds nothing beyond whatever the parent already
        returns for that user (VAL-PWA-003). """
        self.authenticate('test_crm_offline_no_crm_access', 'does-not-matter')
        response = self.url_open('/web/manifest.webmanifest')
        self.assertEqual(response.status_code, 200)
        data = response.json()

        names = {shortcut['name'] for shortcut in data['shortcuts']}
        self.assertNotIn('My Pipeline', names)
        self.assertNotIn('New Lead', names)

    def test_crm_shortcuts_absent_unauthenticated(self):
        """ web's own test_webmanifest_unauthenticated expects 0 shortcuts
        for an anonymous request; the crm override must not add any CRM
        entry for the public user either. """
        response = self.url_open('/web/manifest.webmanifest')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['shortcuts'], [])

    def test_crm_shortcut_icon_is_served(self):
        """ The shortcut icon URL actually resolves to an image
        (VAL-PWA-004). """
        response = self.url_open('/crm/static/description/icon.png')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers['Content-Type'].startswith('image/'))

    def test_crm_share_target_kept(self):
        """ The crm override only touches _get_shortcuts; the share target
        flipped on by the existing _has_share_target() override must stay on
        (VAL-PWA-005), with no other manifest key disturbed. """
        self.authenticate('admin', 'admin')
        response = self.url_open('/web/manifest.webmanifest')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn('share_target', data)
        self.assertEqual(data['share_target']['action'], '/odoo?share_target=trigger')
