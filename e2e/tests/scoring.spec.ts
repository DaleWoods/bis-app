import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/member.json' });

test('scores every ticket in the open round and reaches the completion panel', async ({ page }) => {
  await page.goto('/score');
  const ticketCount = await page.locator('.ticket-card').count();
  expect(ticketCount).toBeGreaterThan(0);

  // Jump to the first unscored ticket via the rail, confirm the heading
  // lands clear of the sticky rail rather than hidden underneath it.
  const jumpButton = page.getByRole('button', { name: /Jump to next unscored/ });
  if (await jumpButton.count()) {
    await jumpButton.click();
    const { railBottom, headingTop } = await page.evaluate(() => {
      const rail = document.querySelector('.progress-rail')!;
      const heading = [...document.querySelectorAll('h3[id^="ticket-"]')].reduce((best, h) => {
        const top = h.getBoundingClientRect().top;
        return !best || Math.abs(top) < Math.abs(best.top) ? { top } : best;
      }, null as { top: number } | null)!;
      return { railBottom: rail.getBoundingClientRect().bottom, headingTop: heading.top };
    });
    expect(headingTop).toBeGreaterThanOrEqual(railBottom - 2);
  }

  const model = await (await page.request.get('/api/scoring-model')).json();
  const categoryIds: string[] = model.categories.map((c: { id: string }) => c.id);

  for (let i = 0; i < ticketCount; i += 1) {
    const submit = page.getByRole('button', { name: 'Submit my score' }).first();
    if (!(await submit.count())) break;

    // Score buttons from already-submitted tickets stay in the DOM (as
    // disabled fieldset content), ahead of the ticket still being worked on
    // - so every lookup must be scoped to the specific card that owns this
    // submit button, not to the page as a whole.
    const card = submit.locator('xpath=ancestor::article[contains(@class, "ticket-card")]');
    const groups = card.locator('.score-buttons');
    const groupCount = await groups.count();
    expect(groupCount).toBe(categoryIds.length);
    for (let c = 0; c < groupCount; c += 1) {
      await groups.nth(c).getByRole('button', { name: '5', exact: true }).click();
    }
    await submit.click();
    await page.waitForTimeout(300);
  }

  await expect(page.locator('.round-done')).toBeVisible();
});
