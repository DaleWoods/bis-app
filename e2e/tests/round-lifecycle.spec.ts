import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/admin.json' });

test('a round moves from draft through to a readable feedback view', async ({ page }) => {
  const tickets = (await (await page.request.get('/api/tickets')).json()).tickets;
  expect(tickets.length).toBeGreaterThan(0);

  const created = await page.request.post('/api/rounds', {
    data: { weekLabel: 'E2E lifecycle round', cutOffAt: '2099-01-01T00:00:00.000Z' },
  });
  const round = (await created.json()).round;

  await page.request.post(`/api/rounds/${round.id}/tickets`, { data: { ticketId: tickets[0].id } });
  await page.request.post(`/api/rounds/${round.id}/status`, { data: { status: 'OPEN' } });
  await page.request.post(`/api/rounds/${round.id}/status`, { data: { status: 'CLOSED' } });
  await page.request.post(`/api/rounds/${round.id}/finalise`, { data: {} });

  await page.goto(`/feedback/${round.id}`);
  await expect(page.getByRole('heading', { name: /How the committee scored/ })).toBeVisible();
});
