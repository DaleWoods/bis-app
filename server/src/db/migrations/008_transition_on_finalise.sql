-- Move the ticket on once its score is in JIRA.
--
-- transitionOnFinalise shipped defaulting to false, on the reasoning that
-- writing a field is safe and moving a ticket through a workflow is not. In
-- practice the whole point of the round is to get scored tickets to "Ready for
-- Estimation", and leaving them behind in Business Scoring means someone has
-- to move every one of them by hand.
--
-- The default flips in code. This patches an installation that has already
-- saved its JIRA settings, because a saved section is stored whole and would
-- otherwise keep the old default for good. JSON.stringify writes no spaces, so
-- the literal below is what is actually in the column; a coordinator who has
-- deliberately switched it off since can switch it off again in Settings.
UPDATE app_config
   SET value = REPLACE(value, '"transitionOnFinalise":false', '"transitionOnFinalise":true')
 WHERE key = 'jira';
