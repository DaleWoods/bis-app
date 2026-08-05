-- §7 slide card, second pass.
--
-- The deck went out as four narrow columns of bullets plus a thumbnail, and
-- committee members could not tell from it what a ticket actually was. These
-- columns carry what the slide was missing:
--
--   card_kind           whether this is a problem, an improvement or something
--                       new. The three read differently, so the slide labels
--                       its sections differently.
--   impact_facts        the quantified facts - how many, how often, who -
--                       pulled out as chips instead of buried in a bullet.
--   screenshot_caption  what the reader is looking at in the image. A
--                       screenshot without one is decoration.
--   raw_comments        the ticket's comments, kept so a redraft has the same
--                       material the import had. The business impact is more
--                       often in a comment than in the description.
ALTER TABLE tickets ADD COLUMN card_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN impact_facts TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN screenshot_caption TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN raw_comments TEXT NOT NULL DEFAULT '';

-- The surrounding JIRA context, stored so "Redraft" works from the same
-- material the import had rather than from the description alone.
ALTER TABLE tickets ADD COLUMN priority TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN labels TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN components TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN linked_issues TEXT NOT NULL DEFAULT '';
