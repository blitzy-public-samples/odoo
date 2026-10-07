# Fun facts

Four findings from this tree that reward a second look: the animation Odoo plays when you win a deal, a markdown document that audits itself, a git history that begins seven times over, and easter eggs hiding in plain sight.

*Everything below was verified in the working tree at `/home/factory-user/repos/odoo` (branch `eval/factory-crm-offline`) on 2026-10-07. The git commands named run from the repo root and reproduce each dated claim.*

## The rainbowman

The congratulation animation that greets a won lead entered the codebase on 2017-05-11 in commit `4330ea02676`, "[ADD] web, *: add rainbowification", whose message explains it as "a way to display a nice friendly message when some business event happens" — for example when "a salesman closes a deal". It arrived as a 77-line widget, `addons/web/static/src/js/widgets/rainbow_man.js`, plus 250 lines of `rainbow.less`; in this tree the effect lives at `addons/web/static/src/core/effects/rainbow_man.js`.

CRM wired it up through `get_rainbowman_message()` at `addons/crm/models/crm_lead.py:1138`, first appearing 2020-07-06 in "[IMP] crm: harmonize won triggers with rainbowman". The method is more sentimental than an ERP has any right to be: it runs raw SQL over `crm_lead` to compute the closer's win streaks and records, then answers with lines like "Go, go, go! Congrats for your first deal.", "Boom! Team record for the past 30 days.", "You're on fire! Fifth deal won today 🔥" and — for a lead with 25 or more messages — "Phew, that took some effort — but you nailed it. Good job!"

In this fork the animation has an offline epilogue. `addons/crm/static/src/views/check_rainbowman_message.js` returns before making any RPC when the offline plugin reports the client is offline, per its own comment: "offline there is no server to ask, so the lookup must be skipped outright". Even a connection that drops mid-lookup is treated as a skip, not as an error on top of an already-successful save (commit `82cf2fd8856`, 2026-10-01). Three of the offline inventory's nine SKIP rows — A12, A14 and A16 — are this one animation. See [Offline surface inventory](apps/crm/offline-surface-inventory.md).

## The offline inventory keeps an audit trail of itself

`addons/crm/static/src/mobile/offline_inventory.md` is a 1,248-line, 168 KB markdown table classifying every crm control that needs a live server: 150 rows, 26 QUEUE, 9 SKIP, 115 DISABLE, spread over four sections. What makes it unusual is that it records its own revision history like a ledger. The original sweep states the HEAD every citation was re-read at (`8916e416`, committed as `a6a1ceef`), and each later round names the commit it re-verified against (`6e6de2b8`, `cf127d42`, `4bdd42c3`, `01ccefaa`), with every file:line citation re-read again at that HEAD.

The counts section alone narrates eight revision rounds after the original sweep: a round-1 fix closing 7 blocking gaps, a round-2 fix closing 4 more findings, a round-3 relational-field sweep that added a whole new section (B-REL), a round-4 close-out adding 32 rows, a round-5 correction pass, a user-testing round (VAL-INV-005, VAL-INV-007), and two milestone-2 reviews — with the totals moving 147 (39 QUEUE / 9 SKIP / 99 DISABLE) to 149 (28 / 9 / 112) to the final 150 (26 / 9 / 115) as rows were added, removed and reclassified, and each intermediate total preserved in prose.

Two of the document's own rules make it an audit trail rather than a changelog. Rows are never renumbered; new rows are appended to the end of each table so every cross-reference keeps pointing at the same row. And superseded plans are kept rather than quietly deleted, marked as "sweep history": "'Left to milestone 2' describes a plan milestone 2 did not take; kept only as sweep history, not as an open item." The sweep method section even reproduces its grep patterns and lists all 47 JS/XML files under `addons/crm/static/src/`, so that zero-hit files are "confirmed empty, not skipped". See [Offline surface inventory](apps/crm/offline-surface-inventory.md) and [Offline CRM](apps/crm/offline-crm.md).

## The git history begins seven times

`git rev-list --max-parents=0 HEAD` in this clone returns seven root commits, not one, out of 211,650 commits in total. The oldest is "New trunk" (`004a0b996ff`, 2006-12-07) — and the next commit in date order carries the exact same title. The day after, 2006-12-08, the history records "Merge with trunk_old", so even the first trunk had a predecessor that predates this repository.

The 2006 tree still says TinyERP everywhere a name could go: `bin/PKG-INFO` carries "Summary: TinyERP is an Enterprise Resource Management written entirely in python" and "Download-url: http://tinyerp.org/download.php", and the base module's manifest, `bin/addons/base/__terp__.py`, declares author "Tiny", website "http://tinyerp.com", description "The kernel of Tiny ERP, needed for all installation." The TinyERP name was baked into the manifest filename itself — every module shipped a `__terp__.py` — while in this tree the same file is `__manifest__.py` (`addons/crm/__manifest__.py`). The other roots joined later: "Initial commit, .gitignore" (2009-04-21, a second beginning two and a half years in), "[IMP] Piratepad web addons." (2010-10-15), a website_form_editor root (2015-08-25) and three sale-coupon roots (2016-12-20). The first commit already contained 67 "TODO" strings; today `TODO|FIXME|HACK` appears 2,246 times across 1,468 files. The TinyERP → OpenERP → Odoo lineage is told on [Lore](lore.md).

## Easter eggs: Odoobot has feelings, the test models catch Pokémon

`addons/mail_bot/models/mail_bot.py:132` has a comment that says exactly what it is — `# easter eggs` — and the bot's idle-state replies are written with real feeling: tell Odoobot "i love you" or send it a ❤️ and it answers "Aaaaaw that's really cute but, you know, bots don't work that way. You're too human for me! Let's keep it professional ❤️"; swear at it and it replies "That's not nice! I'm a bot but I have feelings... 💔".

The ORM's selection-field tests needed values nobody would put in real business data, and chose a Pokédex: `odoo/addons/test_base/models/test_orm.py:1489-1491` extends a selection with `('pikachu', "Pikachu")` and `('eevee', "Eevee")` — and Eevee's deletion policy is a lambda: `ondelete={'pikachu': 'set default', 'eevee': lambda r: r.write({'my_selection': 'bar'})}`. Pikachu also appears as a customer name in `addons/account/tests/test_invoice_taxes.py:831` and gets typed into a tag input in `addons/web/static/tests/views/fields/many2many_tags_field.test.js:1241`. And the official learning path runs through a game: "To learn the software, we recommend the Odoo eLearning, or Scale-up, the business game" (`README.md:31`).

## Related pages

- [Lore](lore.md)
- [By the numbers](by-the-numbers.md)
- [Offline surface inventory](apps/crm/offline-surface-inventory.md)
- [Offline CRM](apps/crm/offline-crm.md)
