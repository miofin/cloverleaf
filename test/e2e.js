#!/usr/bin/env node
'use strict';
/*
 * Drives the built page in headless Chromium: approve, deny, reword, undo,
 * typing in the source, loading a JSON edit list, and reload persistence.
 * Needs Playwright (npm install, then npx playwright install chromium).
 * Network is blocked, so the page runs in its "MathJax couldn't load" mode.
 */
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const page_url = pathToFileURL(path.join(__dirname, '..', 'dist', 'galley.html')).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/^https?:/, (r) => r.abort());

  const src = () => page.evaluate(() => document.getElementById('ed').value);
  const tally = () => page.innerText('#tally');
  const settle = () => page.waitForTimeout(300);
  const step = async (name, fn) => { await fn(); console.log('ok  ' + name); };

  await page.goto(page_url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#paper .blk');

  await step('opens on the example with five edits waiting', async () => {
    assert.equal(await tally(), '0 approved, 0 denied, 5 to go');
    assert.equal(await page.innerText('#tRevN'), '5');
    assert.ok(await page.locator('#paper .hl').count(), 'current edit is highlighted in the preview');
  });

  await step('approving writes the change into the source; denying does not', async () => {
    await page.keyboard.press('a'); await settle();
    await page.keyboard.press('d'); await settle();
    await page.click('[data-act=approve]'); await settle();
    const s = await src();
    assert.ok(s.includes('one simple rule'));
    assert.ok(s.includes('The the total'), 'denied edit left alone');
    assert.ok(s.includes('an invariant of the game'));
    assert.equal(await tally(), '2 approved, 1 denied, 2 to go');
  });

  await step('a reworded replacement is what gets applied', async () => {
    await page.click('[data-act=rew]');
    await page.fill('#rew', 'Every graph here is a tree.');
    await page.click('[data-act=rew-ok]');
    await page.keyboard.press('a'); await settle();
    assert.ok((await src()).includes('Every graph here is a tree.'));
  });

  await step('finishing the queue shows the summary', async () => {
    await page.keyboard.press('a'); await settle();
    assert.equal(await tally(), '4 approved, 1 denied, 0 to go');
    assert.ok((await page.innerText('#card')).includes('Every edit is reviewed'));
  });

  await step('undo restores the original text', async () => {
    await page.click('#elist li:nth-child(1) button');
    await page.keyboard.press('u'); await settle();
    assert.ok((await src()).includes('a rule that is simple'));
    assert.equal(await tally(), '3 approved, 1 denied, 1 to go');
  });

  await step('edits still land in the right place after typing in the source', async () => {
    await page.evaluate(() => {
      const e = document.getElementById('ed');
      e.setRangeText('% hello\n', 0, 0, 'end');
      e.dispatchEvent(new Event('input'));
    });
    await page.waitForTimeout(900);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('a'); await settle();
    const s = await src();
    assert.ok(s.startsWith('% hello\n\\documentclass'));
    assert.ok(s.includes('one simple rule'));
  });

  await step('loading a JSON list replaces the example edits and flags a misquote', async () => {
    await page.click('#bLoad');
    await page.fill('#dlgTa', JSON.stringify([
      { type: 'typo', find: 'no loops', replace: 'no self-loops', reason: 'precision' },
      { find: 'not there at all', replace: 'x' }
    ]));
    await page.click('#dlgAdd'); await settle();
    assert.equal(await tally(), '0 approved, 0 denied, 2 to go');
    assert.equal(await page.locator('#elist .rl', { hasText: 'not found' }).count(), 1);
  });

  await step('source and edit list survive a reload', async () => {
    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForSelector('#paper .blk');
    assert.equal(await tally(), '0 approved, 0 denied, 2 to go');
    assert.ok((await src()).startsWith('% hello'));
  });

  await step('pane pills hide and show panes, and one always stays open', async () => {
    const shown = (id) => page.locator(id).isVisible();
    assert.equal(await shown('#pSrc'), false, 'source is tucked away while reviewing');
    await page.click('#tSrc'); assert.equal(await shown('#pSrc'), true);
    await page.click('#tSrc'); await page.click('#tPrev'); await page.click('#tRev');
    assert.equal(await shown('#pRev'), true);
    await page.click('#tPrev');
  });

  await step('double-clicking the preview selects that passage in the source', async () => {
    await page.dblclick('#paper .thm p');
    const sel = await page.evaluate(() => { const e = document.getElementById('ed'); return e.value.slice(e.selectionStart, e.selectionEnd); });
    assert.ok(sel.includes('\\emph{configuration}'));
  });

  await browser.close();
  assert.deepEqual(errors, [], 'no uncaught page errors');
  console.log('\nall end-to-end checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
