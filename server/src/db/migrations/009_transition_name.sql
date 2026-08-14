-- The transition name never matched the workflow.
--
-- It shipped as "RA: Ready for Estimation", taken from the requirements
-- document. The live workflow calls the status "[RA] Rdy Estimation", so the
-- lookup found nothing and every ticket kept its score and stayed where it
-- was - quietly, because a failed move is reported per ticket and the score
-- had gone across fine.
--
-- Only the wrong shipped default is corrected. A name a coordinator has since
-- typed themselves is left alone, whatever it says.
UPDATE app_config
   SET value = REPLACE(value, '"transitionName":"RA: Ready for Estimation"', '"transitionName":"[RA] Rdy Estimation"')
 WHERE key = 'jira';
