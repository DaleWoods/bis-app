import { test, expect } from '@playwright/test';
import { startJiraStub } from '../fixtures/jira-stub.js';
import type { Server } from 'node:http';

test.use({ storageState: '.auth/admin.json' });

let stub: Server;
test.beforeAll(async () => {
  stub = await startJiraStub(4610);
});
test.afterAll(() => {
  stub.close();
});

test('below-minimum skip, override, already-written skip, then force re-write', async ({ page, browser }) => {
  const cfg = (await (await page.request.get('/api/config')).json()).config;
  await page.request.put('/api/config/jira', {
    data: { ...cfg.jira, businessScoreFieldId: 'customfield_101', transitionOnFinalise: true, transitionName: 'Rdy Estimation' },
  });
  await page.request.put('/api/config/scoring', { data: { ...cfg.scoring, minSubmissions: 2 } });

  const tickets = (await (await page.request.get('/api/tickets')).json()).tickets;
  const created = await page.request.post('/api/rounds', {
    data: { weekLabel: 'E2E write-back round', cutOffAt: '2099-01-01T00:00:00.000Z' },
  });
  const round = (await created.json()).round;
  await page.request.post(`/api/rounds/${round.id}/tickets`, { data: { ticketId: tickets[0].id } });
  await page.request.post(`/api/rounds/${round.id}/status`, { data: { status: 'OPEN' } });

  // Coordinators cannot score (canScore() is COMMITTEE-only, enforced
  // server-side) - the one submission this test needs has to come from the
  // committee member set up in auth.setup.ts, not from this file's own
  // admin session.
  const model = await (await page.request.get('/api/scoring-model')).json();
  const scores = Object.fromEntries(model.categories.map((c: { id: string }) => [c.id, 5]));
  const memberContext = await browser.newContext({ storageState: '.auth/member.json' });
  await memberContext.request.put(`/api/rounds/${round.id}/tickets/${tickets[0].id}/submission`, {
    data: { relevance: 'YES', scores },
  });
  await memberContext.close();

  await page.request.post(`/api/rounds/${round.id}/status`, { data: { status: 'CLOSED' } });
  await page.request.post(`/api/rounds/${round.id}/finalise`, { data: {} });

  await page.goto(`/rounds/${round.id}`);

  await page.getByRole('button', { name: 'Write scores to JIRA' }).click();
  await expect(page.getByRole('button', { name: 'Write the skipped scores anyway' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Force re-write' })).toHaveCount(0);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Write the skipped scores anyway' }).click();
  await expect(page.locator('table tbody tr td .badge').first()).toHaveText('Written');

  await page.getByRole('button', { name: 'Write scores to JIRA' }).click();
  await expect(page.getByRole('button', { name: 'Force re-write' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write the skipped scores anyway' })).toHaveCount(0);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Force re-write' }).click();
  await expect(page.locator('table tbody tr td .badge').first()).toHaveText('Written');
});
