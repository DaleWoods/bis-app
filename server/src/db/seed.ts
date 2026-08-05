import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb, Db } from './index.js';
import { migrate } from './migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, listCategories } from '../services/configService.js';
import { saveMember } from '../services/memberService.js';
import { upsertTicket } from '../services/ticketService.js';
import { addTicketToRound, createRound, setRoundStatus } from '../services/roundService.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/time.js';

/**
 * Seeds the committee and configuration. The BIS process starts clean - there is
 * no historic import from Microsoft Forms (§12.5).
 *
 *   npm run seed             committee + config only
 *   npm run seed -- --demo   also creates a demo round whose numbers reproduce
 *                            the §10.5 worked examples, for walkthroughs/tests
 */

const COMMITTEE = [
  { name: 'Nikita', email: 'nikita@example.com', team: 'Ecommerce', role: 'COORDINATOR' as const },
  { name: 'Dale', email: 'dale@example.com', team: 'Test & Quality', role: 'ADMIN' as const },
  { name: 'Matt', email: 'matt@example.com', team: 'UX', role: 'COMMITTEE' as const },
  { name: 'James', email: 'james@example.com', team: 'Digital Marketing', role: 'COMMITTEE' as const },
  { name: 'Saj', email: 'saj@example.com', team: 'Merch – Watches', role: 'COMMITTEE' as const },
  { name: 'Priya', email: 'priya@example.com', team: 'Merch – Jewellery', role: 'COMMITTEE' as const },
  { name: 'Leadership', email: 'leadership@example.com', team: 'Board', role: 'VIEWER' as const },
];

export async function seedBase(db: Db): Promise<void> {
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  for (const member of COMMITTEE) await saveMember(db, member);
}

/** Spread a bis_total across the seven categories, as a scorer effectively does. */
function scoresForTotal(total: number, categoryIds: string[]): Record<string, number> {
  const base = Math.floor(total / categoryIds.length);
  let remainder = total % categoryIds.length;
  const scores: Record<string, number> = {};
  for (const id of categoryIds) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    scores[id] = base + extra;
  }
  return scores;
}

export async function seedDemo(db: Db): Promise<string> {
  const categories = await listCategories(db);
  const categoryIds = categories.map((c) => c.id);

  const cutOff = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const round = await createRound(db, {
    weekLabel: 'Demo round – week 1',
    cutOffAt: cutOff,
    stream: 'ECOM',
    notes: 'Seeded demo data. Numbers reproduce the worked examples in the requirements (§10.5).',
    createdBy: 'seed',
  });

  const demoTickets = [
    {
      jiraId: 'ECOM-1466',
      title: 'Checkout: saved-address selector drops the default address',
      type: 'Bug',
      stakeholder: 'Ecommerce Operations',
      affects: 'All customers with more than one saved address',
      impacts: 'Order errors and avoidable contacts to customer service',
      workaround: 'Customer re-enters the address manually at checkout',
      execSummary:
        'Returning customers with multiple saved addresses lose their default selection at checkout, so orders are placed against the wrong address. Fixing it removes a recurring source of delivery errors and support contacts.',
      panelCurrent: 'The address selector resets to the first address in the list rather than the saved default.',
      panelImpacts: 'Misdirected deliveries, refunds and re-ships; a steady stream of customer service contacts.',
      panelFuture: 'The default address is pre-selected and preserved through the whole checkout flow.',
      panelBenefits: 'Fewer delivery errors, lower support demand, better checkout completion.',
      backendPokerScore: 8,
      frontendPokerScore: 8,
      // 5 valid responses -> mean 43, sample sd 12.83, effort 16 -> 2.69 Medium
      totals: [27, 35, 43, 50, 60],
    },
    {
      jiraId: 'ECOM-1422',
      title: 'Add a printable packing note to the order confirmation email',
      type: 'Improvement',
      stakeholder: 'Customer Services',
      affects: 'Customers who return items',
      impacts: 'Manual effort in the returns team',
      workaround: 'Agents email a packing note on request',
      execSummary:
        'A printable packing note in the confirmation email would remove a manual step for the returns team and speed customers up.',
      panelCurrent: 'Packing notes are produced by hand on request.',
      panelImpacts: 'Slow returns handling and repeated inbound contacts.',
      panelFuture: 'Every confirmation email carries a printable packing note.',
      panelBenefits: 'Faster returns, less manual effort, fewer contacts.',
      backendPokerScore: 8,
      frontendPokerScore: 5,
      // mean 13, effort 13 -> ratio 1.0 Low
      totals: [10, 12, 13, 14, 16],
    },
    {
      jiraId: 'ECOM-915',
      title: 'Replatform the product recommendations widget',
      type: 'Feature',
      stakeholder: 'Digital Marketing',
      affects: 'All PDP and basket pages',
      impacts: 'Attribution gaps in reporting',
      workaround: 'None',
      execSummary:
        'The recommendations widget predates the current analytics stack and cannot be attributed. Replatforming it restores attribution and unlocks personalisation.',
      panelCurrent: 'The widget renders client-side with no analytics events.',
      panelImpacts: 'Recommendation-driven revenue is invisible in reporting.',
      panelFuture: 'A supported widget with full event tracking and personalisation hooks.',
      panelBenefits: 'Attribution, measurable uplift, a platform for personalisation.',
      backendPokerScore: 13,
      frontendPokerScore: 8,
      // sample sd 18.4 -> discussion required
      totals: [11, 25, 37, 42, 60],
    },
    {
      jiraId: 'ECOM-1775',
      title: 'SAP status sync fails silently for partially despatched orders',
      type: 'Bug',
      stakeholder: 'Operations',
      affects: 'Partially despatched orders',
      impacts: 'Orders show the wrong status to customers and agents',
      workaround: 'Operations correct the status by hand each morning',
      execSummary:
        'Partially despatched orders stop syncing status from SAP, so customers and agents see stale information. Resolving it removes a daily manual correction.',
      panelCurrent: 'The sync job fails silently and is only noticed downstream.',
      panelImpacts: 'Wrong order status, daily manual correction, avoidable contacts.',
      panelFuture: 'Reliable status sync with alerting when a batch fails.',
      panelBenefits: 'Accurate order status, no daily manual fix, fewer contacts.',
      backendPokerScore: 13,
      frontendPokerScore: 8,
      // mean 36 -> the business score confirmed against the real ticket
      totals: [30, 34, 36, 40, 40],
    },
  ];

  const scorers = await db.all<{ id: string }>(
    "SELECT id FROM members WHERE active = 1 AND role IN ('COMMITTEE', 'COORDINATOR', 'ADMIN') ORDER BY name ASC",
  );

  for (const [index, demo] of demoTickets.entries()) {
    const { totals, ...ticketInput } = demo;
    const ticket = await upsertTicket(db, { ...ticketInput, originalRequestor: 'james@example.com' });
    await addTicketToRound(db, round.id, ticket.id, index + 1);

    for (const [i, total] of totals.entries()) {
      const member = scorers[i % scorers.length];
      const submissionId = newId();
      const now = nowIso();
      await db.run(
        `INSERT INTO submissions (id, round_id, ticket_id, member_id, relevance, closure_reason, closure_info, more_info, archived, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, 'YES', '', '', ?, 0, ?, ?)`,
        [submissionId, round.id, ticket.id, member.id, '', now, now],
      );
      for (const [categoryId, score] of Object.entries(scoresForTotal(total, categoryIds))) {
        await db.run('INSERT INTO submission_scores (submission_id, category_id, score) VALUES (?, ?, ?)', [
          submissionId,
          categoryId,
          score,
        ]);
      }
    }
  }

  await setRoundStatus(db, round.id, 'OPEN');
  return round.id;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const db = await getDb();
  await seedBase(db);
  console.log(`Seeded ${COMMITTEE.length} committee members, seven categories and default configuration.`);
  if (process.argv.includes('--demo')) {
    const roundId = await seedDemo(db);
    console.log(`Seeded demo round ${roundId} with four tickets and scored submissions.`);
  }
  await closeDb();
}
