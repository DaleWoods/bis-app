import { test as setup } from '@playwright/test';

const ADMIN_FILE = '.auth/admin.json';
const MEMBER_FILE = '.auth/member.json';

setup('sign in as admin', async ({ page }) => {
  await page.goto('/');
  await page.getByText('e2e-admin@example.com', { exact: false }).click();
  await page.waitForURL('**/');
  await page.context().storageState({ path: ADMIN_FILE });
});

setup('create and sign in as a committee member', async ({ browser }) => {
  // A fresh member for every run, via the admin's own session, so this
  // suite never depends on a specific person already existing in the demo
  // seed - and never collides with the demo seed's own pre-scored members.
  const adminContext = await browser.newContext({ storageState: ADMIN_FILE });
  const adminPage = await adminContext.newPage();
  await adminPage.request.post('/api/members', {
    data: { name: 'E2E Member', email: 'e2e-member@example.com', team: 'QA', role: 'COMMITTEE', active: true },
  });
  await adminContext.close();

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await memberPage.goto('/');
  await memberPage.getByText('E2E MemberQA', { exact: false }).click();
  await memberPage.waitForURL('**/');
  await memberContext.storageState({ path: MEMBER_FILE });
  await memberContext.close();
});
