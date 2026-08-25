import { getDb } from '../db/index.js';
import { getAppConfig, listCategories } from './configService.js';
import { getRound, listRoundTickets } from './roundService.js';
import { fetchAttachment } from '../integrations/jira.js';

function asDataUri({ buffer, contentType }: { buffer: Buffer; contentType: string }): string {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

/**
 * A screenshot a coordinator pasted the URL of. Bounded and typed-checked: this
 * is an arbitrary address going into a document the whole committee opens, so a
 * slow host must not hold the pack up and a page of HTML must not be embedded
 * as though it were an image.
 */
async function fetchImageUrl(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} fetching the screenshot`);

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!contentType.startsWith('image/')) throw new Error(`${contentType || 'unknown type'} is not an image`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 8 * 1024 * 1024) throw new Error('screenshot is too large to embed');
  return asDataUri({ buffer, contentType });
}

/**
 * Shared by the manual pack.pptx/pack.pdf routes and automated distribution -
 * both need the same ticket content, categories and embedded screenshots to
 * build a deck from.
 */
export async function packInput(roundId: string) {
  const db = await getDb();
  const round = await getRound(db, roundId);
  if (!round) return null;
  const [tickets, categories, config] = await Promise.all([
    listRoundTickets(db, round.id),
    listCategories(db),
    getAppConfig(db),
  ]);

  /*
    Embed every screenshot as a data URI, whether it came from a JIRA attachment
    or a pasted URL. One unreachable image must never stop the pack being
    generated, so each failure is skipped.

    The pasted URLs have to be fetched here rather than handed to the renderer.
    pptxgenjs fetches a `path:` image itself while it writes the file, and a
    host that does not resolve makes it emit an unhandled 'error' event - which
    is not a rejected promise and cannot be caught around the call. One ticket
    with a stale screenshot link took the whole server process down.

    Fetched a few at a time rather than one after another: a thirty-ticket round
    was thirty sequential round-trips, which is long enough for the browser to
    give up on the download.
  */
  const screenshots: Record<string, string> = {};
  const withImages = tickets.filter((ticket) => ticket.screenshotAttachmentId || ticket.screenshotUrl);
  let next = 0;
  const fetchWorker = async (): Promise<void> => {
    while (next < withImages.length) {
      const ticket = withImages[next++];
      try {
        screenshots[ticket.id] = ticket.screenshotAttachmentId
          ? asDataUri(await fetchAttachment(ticket.screenshotAttachmentId))
          : await fetchImageUrl(ticket.screenshotUrl);
      } catch {
        // no screenshot for this ticket
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, withImages.length) }, fetchWorker));

  return { db, round, tickets, categories, config: config.pack, screenshots };
}

export function packFilenameSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'round';
}
