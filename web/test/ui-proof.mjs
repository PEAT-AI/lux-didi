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
  fixture.setLive({state:'speaking',since:'synthetic-ui-proof',cursor:1,entries:[
    {seq:1,kind:'outputTranscription',text:'Hel'},
  ]});
  browser = await chromium.launch({channel:'chromium',headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url);
  await page.getByLabel('One-time pairing code').fill('synthetic-only');
  await page.getByRole('button',{name:'Pair this browser',exact:true}).click();
  await page.locator('#connected-route').waitFor();
  await page.locator('.live-latest-turn').getByText('Hel',{exact:true}).waitFor();
  await page.locator('#live-details > summary').click();
  assert.ok(await page.locator('#live-details').evaluate(details => details.open));
  assert.equal(await page.locator('.live-transcript .entry').count(),1);
  fixture.setLive({state:'speaking',since:'synthetic-ui-proof',cursor:2,entries:[
    {seq:2,kind:'outputTranscription',text:'lo'},
  ]});
  await page.locator('.live-latest-turn').getByText('Hello',{exact:true}).waitFor();
  assert.ok(await page.locator('#live-details').evaluate(details => details.open),'live details stay open across polling');
  assert.equal(await page.locator('.live-transcript .entry').count(),1);
  fixture.setLive({state:'speaking',since:'synthetic-ui-proof',cursor:8,entries:[
    {seq:3,kind:'turnComplete'},
    {seq:4,kind:'outputTranscription',text:'ha'},
    {seq:5,kind:'outputTranscription',text:'ha'},
    {seq:6,kind:'turnComplete'},
    {seq:7,kind:'inputTranscription',text:'Tell me more'},
    {seq:8,kind:'toolResult',tool:{name:'search',status:'completed',markdown:'A concise answer',sources:[]}},
  ]});
  await page.locator('.live-latest-turn').getByText('haha',{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /Cannot read properties|displayName/);
  assert.equal(await page.locator('#connected-error').count(), 0);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.getByText('SPACE TO THINK',{exact:true}).count(),0);
    assert.ok(await page.locator('#conversation-history').isVisible());
    assert.equal(await page.locator('#live-panel ol').count(),0,'populated transcription is not a numbered list');
    assert.deepEqual(await page.locator('.live-transcript .entry p').allTextContents(),['Hello','haha','Tell me more']);
    assert.equal(await page.getByRole('heading',{name:'Latest answer',exact:true}).count(),1);
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
  assert.deepEqual(errors,[]); console.log('UI-PROOF PASS synthetic host, consent, coherent transcript, latest answer, guide links, desktop/390');
} finally { await browser?.close(); await fixture.close(); }
