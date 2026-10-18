-- Testers work a 6-hour day, not the 7.5 the value matrix first shipped with.
--
-- The default changes in code. This patches an installation that saved its
-- value matrix settings in between, because a saved section is stored whole
-- and would otherwise keep the old figure for good. JSON.stringify writes no
-- spaces, so the literal below is what is actually in the column.
UPDATE app_config
   SET value = REPLACE(value, '"testingHoursPerDay":7.5', '"testingHoursPerDay":6')
 WHERE key = 'matrix';
