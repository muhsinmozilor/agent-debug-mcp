import { expect, test } from './fixtures.js';

/** Popup "Debug only this tab": the chosen tab stays attached, the rest go into standby and can be switched back. */
test.describe('debug only this tab', () => {
  test('switching the debugged tab standbys the rest and reconnects on demand', async ({ relay, context, waitForTabs }) => {
    const a = await context.newPage();
    await a.goto('http://localhost:5199/');
    const b = await context.newPage();
    await b.goto('http://localhost:5199/?second');
    await waitForTabs(2);

    const tabIdBy = (pred: (url: string) => boolean): number => {
      const rec = relay.link.tabs.list().find((t) => pred(t.url));
      if (!rec) throw new Error(`no matching attached tab: ${JSON.stringify(relay.link.tabs.summaries())}`);
      return Number(rec.tab.slice(1));
    };
    const idA = tabIdBy((url) => !url.includes('second'));
    const idB = tabIdBy((url) => url.includes('second'));
    expect(idA).not.toBe(idB);

    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);

    // Debug only tab B: A disappears from the relay…
    await popup.click(`button.tabBtn[data-tab="${idB}"]`);
    await expect.poll(() => relay.link.tabs.list().map((t) => t.url)).toEqual([expect.stringContaining('second')]);
    // …and its popup row turns into a standby row with a Connect button.
    await expect(popup.locator(`li:has(button.tabBtn[data-tab="${idA}"])`)).toContainText('standby');

    // Connect tab A again: B goes into standby, A re-announces with working tools.
    await popup.click(`button.tabBtn[data-tab="${idA}"]`);
    await expect.poll(() => relay.link.tabs.list().map((t) => t.url)).toEqual([expect.not.stringContaining('second')]);
    await expect.poll(() => relay.link.tabs.list()[0]?.tools.size ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  });
});
