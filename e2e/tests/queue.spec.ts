import { test, expect } from '@playwright/test';
import { startJiraStub } from '../fixtures/jira-stub.js';
import type { Server } from 'node:http';

test.use({ storageState: '.auth/admin.json' });

let stub: Server;
test.beforeAll(async () => {
  stub = await startJiraStub(4610, [
    { key: 'ECOM-9001', fields: { summary: 'Stub ticket one', status: { name: 'Rdy FE Dev' }, customfield_101: 60, customfield_103: 3, customfield_102: 0 } },
    { key: 'ECOM-9002', fields: { summary: 'Stub ticket two', status: { name: 'Rdy BE Dev' }, customfield_101: 40, customfield_103: 0, customfield_102: 2 } },
  ]);
});
test.afterAll(() => {
  stub.close();
});

test('ranks the hopper and finds a ticket by key', async ({ page }) => {
  const cfg = (await (await page.request.get('/api/config')).json()).config;
  await page.request.put('/api/config/jira', { data: { ...cfg.jira, businessScoreFieldId: 'customfield_101' } });
  await page.request.put('/api/config/scoring', {
    data: { ...cfg.scoring, effort: { ...cfg.scoring.effort, backendFieldId: 'customfield_102', frontendFieldId: 'customfield_103' } },
  });
  await page.request.put('/api/config/queue', {
    data: { hopperJql: 'project = "ECOM"', enabled: true },
  });

  await page.goto('/queue');
  // exact: true, scoped to the jira-id badge - the page also shows each
  // ticket's key inside a leaderboard hint ("ECOM-9001 is out in front."),
  // which a substring match picks up as a second, ambiguous match.
  await expect(page.getByText('ECOM-9001', { exact: true })).toBeVisible();
  await expect(page.getByText('ECOM-9002', { exact: true })).toBeVisible();

  await page.locator('#ticket-lookup').fill('ECOM-9001');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText(/Currently 1st in the Frontend queue/)).toBeVisible();
});
