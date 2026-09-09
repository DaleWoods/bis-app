-- A scorer's own signal that the card itself was too thin to score from -
-- distinct from "Notes or questions", which is about the ticket rather than
-- how it was written up. Surfaced to the coordinator per ticket, alongside
-- the automated card checks, so a card scorers actually struggled with gets
-- rewritten rather than just re-read.
ALTER TABLE submissions ADD COLUMN card_unclear INTEGER NOT NULL DEFAULT 0;
