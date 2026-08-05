-- Card media (§7): screenshots come from the ticket's own JIRA attachments,
-- so a coordinator does not have to find and host an image by hand.
ALTER TABLE tickets ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN screenshot_attachment_id TEXT NOT NULL DEFAULT '';
