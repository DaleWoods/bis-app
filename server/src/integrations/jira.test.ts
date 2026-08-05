import { describe, expect, it } from 'vitest';
import { adfToText, mapAttachments } from './jira.js';

describe('mapAttachments', () => {
  it('marks image attachments and leaves the rest alone', () => {
    const attachments = mapAttachments({
      attachment: [
        { id: '1', filename: 'basket.png', mimeType: 'image/png', size: 1200 },
        { id: '2', filename: 'trace.log', mimeType: 'text/plain', size: 90 },
        { id: '3', filename: 'shot.JPEG', mimeType: 'image/jpeg', size: 400 },
      ],
    });
    expect(attachments.map((a) => a.isImage)).toEqual([true, false, true]);
    expect(attachments[0].filename).toBe('basket.png');
  });

  it('copes with a ticket that has no attachments', () => {
    expect(mapAttachments({})).toEqual([]);
    expect(mapAttachments({ attachment: null })).toEqual([]);
  });
});

describe('adfToText', () => {
  it('flattens Atlassian Document Format into readable lines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Gift wrap fails.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Impact: orders stick.' }] },
      ],
    };
    expect(adfToText(doc).trim()).toBe('Gift wrap fails.\nImpact: orders stick.');
  });

  it('returns an empty string for nothing', () => {
    expect(adfToText(null)).toBe('');
  });
});
