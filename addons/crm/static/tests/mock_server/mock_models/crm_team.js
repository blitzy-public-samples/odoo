import { fields, models } from "@web/../tests/web_test_helpers";

/**
 * Shared `crm.team` mock for the offline test suite, so tests that need a
 * sales team (team switcher, kanban/list grouping, ...) can `defineModels`
 * it instead of redeclaring their own local model class. Add fields here
 * only when a test actually needs them.
 */
export class CrmTeam extends models.ServerModel {
    _name = "crm.team";

    sequence = fields.Integer({ string: "Sequence", default: 10 });
    use_opportunities = fields.Boolean({ string: "Pipeline", default: true });
    member_ids = fields.Many2many({ string: "Members", relation: "res.users" });
}
