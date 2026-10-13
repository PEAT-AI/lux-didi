import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { startFixture } from './fixture.mjs';
const artifacts = process.env.DIDI_WEB_ARTIFACTS;
assert.ok(artifacts, 'caller owns artifacts');
await mkdir(artifacts, { recursive: true });
const configured = process.env.DIDI_UI_CONFIGURED === '1';
const fixture = await startFixture({configured}); let browser;
try {
  browser = await chromium.launch({channel:'chromium',headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url);
  await page.getByLabel('One-time pairing code').fill('synthetic-only');
  await page.getByRole('button',{name:'Pair this browser',exact:true}).click();
  await page.locator('#connected-route').waitFor();
  await page.waitForTimeout(300);
  assert.doesNotMatch(await page.locator('body').innerText(), /Cannot read properties|displayName/);
  assert.equal(await page.locator('#connected-error').count(), 0);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.locator('#live-panel ol').count(),0,'empty transcription is not a numbered list');
    for (const id of ['connected-consent','connected-remember']) {
      const result = await page.locator(`#${id}`).evaluate(input => {
        const label = input.labels[0]; const a = input.getBoundingClientRect(); const b = label.getBoundingClientRect();
        return {name:label.textContent.trim(),display:getComputedStyle(label).display,near:a.left-b.left,width:a.width};
      });
      assert.ok(result.name); assert.equal(result.display,'flex'); assert.ok(result.near < 2 && result.width < 30);
    }
    assert.ok(await page.locator('#connected-start').isDisabled());
    if (configured) {
      await page.getByLabel('I agree to this route for a new conversation.').check();
      assert.ok(await page.locator('#connected-start').isEnabled());
      await page.getByLabel('I agree to this route for a new conversation.').uncheck();
      assert.ok(await page.locator('#connected-start').isDisabled());
    }
    await page.screenshot({path:`${artifacts}/${width}-conversation.png`,fullPage:true});
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    const link = page.locator('#settings-summary a').filter({hasText:'Setup guide'}).first();
    await link.waitFor(); assert.equal(await link.getAttribute('href'),'https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:`${artifacts}/${width}-settings.png`,fullPage:true});
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
  }
  assert.deepEqual(errors,[]); console.log('UI-PROOF PASS synthetic unconfigured host, consent, empty transcript, guide links, desktop/390');
} finally { await browser?.close(); await fixture.close(); }
