-- Down to two roles: ADMIN runs the process, COMMITTEE scores.
--
-- COORDINATOR had identical permissions to ADMIN - isCoordinator() returned
-- true for both and nothing anywhere distinguished them - so they become
-- ADMIN with no change in what they can do.
--
-- VIEWER was read-only and could not score. Making one a COMMITTEE member
-- would quietly enrol them in the scoring maths: they would be emailed,
-- chased, and counted toward the minimum-responses gate a ticket has to clear.
-- So they are deactivated instead. Nothing is deleted, and a coordinator can
-- reactivate anyone who should have been scoring all along.
UPDATE members SET role = 'ADMIN' WHERE role = 'COORDINATOR';
UPDATE members SET role = 'COMMITTEE', active = 0 WHERE role = 'VIEWER';
