-- Commercial Impact was seeded with "N/A" at the bottom of its scale while the
-- other six categories say "Not Impacted". On the scoring form that reads as a
-- different kind of answer - "this doesn't apply" rather than "zero impact" -
-- when 0 means the same thing in all seven.
--
-- Only the seeded wording is corrected. A category whose label a coordinator
-- has since edited to something else is left alone.
UPDATE categories
   SET zero_label = 'Not Impacted'
 WHERE id = 'commercial-impact'
   AND zero_label = 'N/A';
