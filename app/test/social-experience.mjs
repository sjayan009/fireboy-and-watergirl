import assert from 'node:assert/strict';
import {chromium,firefox,webkit} from 'playwright';
import {encodeInput,encodeCommand} from '../../engine/dist/net/protocol.js';
const target=process.env.FBWG_TEST_URL || 'http://127.0.0.1:5174/test/play-fixture.html';
if (!['localhost','127.0.0.1'].includes(new URL(target).hostname)) throw new Error('Social fixtures must stay local');
for(const [name,engine] of Object.entries({chromium,firefox,webkit})) {
 const browser=await engine.launch();
 try {
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname===new URL(target).hostname?r.continue():r.abort());
  /*
   * Somebody who has played before, which is who this fixture is about.
   *
   * The Leaderboard opens on the level you last played and asks
   * `leaderboard_standing` about the pair you last played it with, so without
   * a remembered partner both of those are simply off -- which is a state, but
   * not the one a friends-and-board test is exercising. Written before the
   * first load, because the screen reads it once on the way up.
   */
  await page.addInitScript(() => {
    try { localStorage.setItem('fbwg.lastPartner.00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'); } catch { /* private mode */ }
  });
  await page.goto(target+'?social=1');
  await page.waitForFunction(()=>window.__fbwg?.view?.prepared);
  await page.waitForSelector('.friend-row');
  assert(await page.locator('.play-drawer').isVisible(),'desktop begins with friends visible');
  const refresh=()=>page.evaluate(async()=>{const {getLobby}=await import('/src/lobby.ts');await (await getLobby()).refresh();});
  const filter=page.getByLabel('Find a friend',{exact:true});
  const username=page.getByLabel('Their username',{exact:true});
  await username.fill('Typing_a_name');
  await refresh();
  assert.equal(await username.inputValue(),'Typing_a_name');
  assert(await username.evaluate(e=>document.activeElement===e),'refresh preserves input focus');
  await page.keyboard.down('ArrowRight');
  assert.equal(await page.evaluate(()=>window.__fbwg.view.held.size),0,'typing cannot move the game');
  await page.keyboard.up('ArrowRight');
  await page.locator('#stage').focus();
  await page.keyboard.down('ArrowRight');
  assert(await page.evaluate(()=>window.__fbwg.view.inputEnabled),'docked panel does not disable canvas input');
  await page.keyboard.up('ArrowRight');
  await username.fill('Incoming');
  await page.getByRole('button',{name:'Send a request',exact:true}).click();
  await page.waitForFunction(()=>window.socialFixture.peers.find(p=>p.username==='Incoming').status==='accepted');
  assert(await page.getByText('You and Incoming are now friends.',{exact:true}).isVisible(),'crossed requests report acceptance');
  await username.fill('NewFriend');
  await page.evaluate(()=>{window.socialFixture.fail='request_friend';});
  await page.getByRole('button',{name:'Send a request',exact:true}).click();
  await page.getByText('Test connection interrupted',{exact:true}).waitFor();
  assert.equal(await username.inputValue(),'NewFriend','failed add retains input');
  await page.evaluate(()=>{window.socialFixture.fail='';});
  await page.getByRole('button',{name:'Send a request',exact:true}).click();
  await page.getByText('Request sent to NewFriend.',{exact:true}).waitFor();
  const outgoing=page.locator('.friend-row').filter({has:page.locator('.name',{hasText:/^Outgoing$/})});
  await outgoing.getByRole('button',{name:'Cancel',exact:true}).click();
  await outgoing.waitFor({state:'detached'});
  await filter.fill('Incoming');
  assert.equal(await page.locator('.friend-list > .friend-row:visible').filter({has:page.locator('.invite-friend')}).count(),1);
  await filter.fill('');
  const first=page.locator('.friend-row').filter({has:page.locator('.name',{hasText:'A_very_long_friend_name'})});
  await first.getByLabel('Actions for A_very_long_friend_name',{exact:true}).click();
  await first.getByRole('button',{name:'Remove friend',exact:true}).click();
  await refresh();
  assert(await first.locator('.remove-confirm').isVisible(),'refresh preserves removal confirmation');
  assert.match(await first.locator('.remove-confirm').innerText(),/shared progress will also be deleted/);
  await first.getByRole('button',{name:'Keep friend',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.socialFixture.calls.filter(c=>c==='remove_friend').length),1,'canceling removal sends no mutation');
  await first.getByRole('button',{name:/^Invite /}).click();
  await page.getByLabel('Game mode',{exact:true}).selectOption('puzzle');
  await refresh();
  assert.equal(await page.getByLabel('Game mode',{exact:true}).inputValue(),'puzzle','refresh preserves setup selection');
  await first.getByRole('button',{name:'Cancel',exact:true}).click();
  await first.getByLabel('Actions for A_very_long_friend_name',{exact:true}).click();
  await first.getByRole('button',{name:'Remove friend',exact:true}).click();
  await page.evaluate(()=>{window.socialFixture.fail='remove_friend';});
  await first.getByRole('button',{name:'Remove',exact:true}).click();
  await first.locator('.error').waitFor({state:'visible'});
  assert(await first.isVisible(),'failed removal retains the friend');
  await page.evaluate(()=>{window.socialFixture.fail='';});
  await first.getByRole('button',{name:'Remove',exact:true}).click();
  await first.waitFor({state:'detached'});
  await page.getByText('Blocked Friends',{exact:true}).click();
  await page.getByRole('button',{name:'Unblock',exact:true}).click();
  await page.waitForFunction(()=>window.socialFixture.peers.find(p=>p.username==='Blocked').status==='accepted');
  const incoming = page.locator('.friend-row').filter({has:page.locator('.name',{hasText:/^Incoming$/})});
  await incoming.getByLabel('Actions for Incoming',{exact:true}).click();
  await incoming.getByRole('button',{name:'Block',exact:true}).click();
  await page.waitForFunction(()=>window.socialFixture.peers.find(p=>p.username==='Incoming').blockedByMe);
  assert.equal(await incoming.getByRole('button',{name:/^Invite /}).count(),0,'blocked friends cannot be invited');

  await page.locator('.tool-leaderboard').click();
  await page.getByText('This level is waiting for its first pair.',{exact:true}).waitFor();
  await page.evaluate(async()=>{const {leaderboardCache}=await import('/src/ranking.ts');leaderboardCache.clear();window.socialFixture.board=[{rank:1,a_username:'You',b_username:'Partner',best_time_str:'',is_mine:true}];});
  await page.getByLabel('Leaderboard level',{exact:true}).selectOption('2');
  await page.getByRole('table').waitFor();
  await page.locator('.leaderboard-table .your-pair').waitFor();
  /*
   * The grade the query has always returned and the table used to discard.
   *
   * A board that ranks how FAST and says nothing about how WELL is half the
   * result: `medal` comes back on every row, Progress has been colouring the
   * same three tokens since it was written, and this table dropped the column.
   * The podium is the same fact applied to the first three ranks.
   */
  assert.equal(await page.locator('.leaderboard-table tbody tr:first-child .grade').innerText(),'A');
  assert.equal(await page.locator('.leaderboard-table tbody tr:first-child').evaluate(e=>e.className.includes('p1')),true,
    'first place is on the podium');
  // A header nobody can see is still a header a screen reader meets.
  assert(await page.locator('.leaderboard-table thead').evaluate(e=>e.classList.contains('sr-only')));
  assert.equal(await page.locator('.leaderboard-table thead th').count(),4);
  const expectedTime = await page.evaluate(()=>{
    const table=window.__fbwg.view.game.Translation;
    window.socialFixture.boardDelay[table.indexOf('1_3')+1]=350;
    window.socialFixture.boardDelay[table.indexOf('1_4')+1]=10;
    return `${table.indexOf('1_4')+1}:00`;
  });
  await page.getByLabel('Leaderboard level',{exact:true}).selectOption('3');
  await page.getByLabel('Leaderboard level',{exact:true}).selectOption('4');
  await page.waitForFunction(expected=>document.querySelector('.leaderboard-table .time')?.textContent===expected,expectedTime);
  await page.waitForTimeout(450);
  assert.equal(await page.locator('.leaderboard-table .time').innerText(),expectedTime,'late results never replace a newer level');
  /*
   * Where you stand, for the pairs the table itself cannot answer for.
   *
   * `leaderboard_standing` has been granted and indexed since `0018` and had
   * no caller anywhere. Outside the top twenty the board is a list of other
   * people's names, which is the one case where it tells the reader nothing.
   */
  await page.evaluate(()=>{
    window.socialFixture.board = window.socialFixture.board.map(r=>({...r,is_mine:false}));
    const node = window.__fbwg.view.game.Translation.indexOf('1_6')+1;
    window.socialFixture.standing = [{node,rank:12,entries:31}];
  });
  await page.getByLabel('Leaderboard level',{exact:true}).selectOption('6');
  await page.getByText('You are 12th of 31 pairs here.',{exact:true}).waitFor();
  // The board caches an answer for fifteen seconds, so a changed fixture needs
  // the cache dropped or the re-selection just replays what it already had.
  await page.evaluate(async()=>{
    const {leaderboardCache}=await import('/src/ranking.ts');
    leaderboardCache.clear();
    window.socialFixture.board = window.socialFixture.board.map(r=>({...r,is_mine:true}));
  });
  await page.getByLabel('Leaderboard level',{exact:true}).selectOption('2');
  await page.getByLabel('Leaderboard level',{exact:true}).selectOption('6');
  await page.locator('.leaderboard-table .your-pair').waitFor();
  assert.equal(await page.locator('.board-standing').count(),0,
    'a pair already on the board is not told where they are over the top of their own row');
  await page.evaluate(()=>{window.socialFixture.fail='leaderboard';});
  await page.getByLabel('Leaderboard level',{exact:true}).selectOption('5');
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  assert(await page.locator('.leaderboard-results .error').isVisible());
  await page.evaluate(()=>{window.socialFixture.fail='';});
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('table').waitFor();
  await page.screenshot({path:`.cache/play-evidence/${name}-elemental-leaderboard.png`,animations:'disabled'});
  /*
   * The legacy batching rollback switch keeps its original interval. The
   * rollout mode below publishes input edges immediately and coalesces holds.
   *
   * A relayed pair waits 230 ms before a packet leaves the browser, out of a
   * 1154 ms rollback window -- so far enough apart, the batching alone is what
   * stalls them. `hurry` halves that wait at roughly double the messages, and
   * the play screen turns it on for the pairs that have actually stalled twice.
   * Asserted here rather than in a pair test because forcing a real stall on
   * one machine is not something a browser test can do honestly; what can be
   * checked is that the dial exists and moves the queue.
   */
  // Check exact timer boundaries with a controlled clock in a separate context.
  // Real browser timers can fire late under CPU contention; their lateness is
  // a performance measurement, not evidence that hurry chose a wrong interval.
  const clockPage=await browser.newPage();
  try {
    const clockUrl=new URL('/test/transport-clock.html',target).href;
    await clockPage.route(clockUrl,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Transport clock</title>'}));
    await clockPage.clock.install({time:new Date('2026-01-01T00:00:00Z')});
    await clockPage.goto(clockUrl);
    await clockPage.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
    const input=(frame,bits,epoch=0)=>Array.from(encodeInput({kind:1,slot:0,epoch,frame,bits,hashFrame:0,hash:0}));
    const packets={
      idle:input(0,[0]), idleHeld:input(1,[0,0]), down:input(2,[2,0,0]),
      held:input(3,[2,2,0,0]), heldNext:input(4,[2,2,2,0,0]),
      heldPending:input(5,[2,2,2,2,0,0]), up:input(6,[0,2,2,2,2,0,0]),
      boundary:input(0,[0],1),
      command:Array.from(encodeCommand({kind:2,slot:0,epoch:1,frame:4,command:2,a:1,b:0})),
    };
    await clockPage.evaluate(async packets=>{
      const {RealtimeTransport}=await import('/src/net/realtime.ts');
      window.sent=[];
      window.link=new RealtimeTransport({onBytes:()=>()=>{},onStatus:()=>()=>{},
        sendBytes:()=>{window.sent.push(Date.now());}},{legacyBatching:true});
      window.packets=packets;
      window.packet=(name='idle')=>new Uint8Array(window.packets[name]);
    },packets);
    for(const [hurried,interval] of [[false,230],[true,115],[false,230]]) {
      await clockPage.clock.runFor(230);
      await clockPage.evaluate(on=>{
        window.link.hurry(on);
        window.sent.length=0;
        window.link.send(window.packet());
        window.link.send(window.packet());
      },hurried);
      assert.equal(await clockPage.evaluate(()=>window.sent.length),1,'leading packet leaves immediately');
      await clockPage.clock.runFor(interval-1);
      assert.equal(await clockPage.evaluate(()=>window.sent.length),1,`batch cannot leave before ${interval}ms`);
      await clockPage.clock.runFor(1);
      assert.equal(await clockPage.evaluate(()=>window.sent.length),2,'queued packet leaves at its deadline');
      assert.equal(await clockPage.evaluate(()=>window.sent[1]-window.sent[0]),interval);
    }
    await clockPage.evaluate(()=>window.link.close());
    await clockPage.evaluate(async()=>{
      const {RealtimeTransport}=await import('/src/net/realtime.ts');
      window.sent.length=0;
      window.link=new RealtimeTransport({onBytes:()=>()=>{},onStatus:()=>()=>{},
        sendBytes:()=>{window.sent.push(Date.now());}},{legacyBatching:false});
      window.link.send(window.packet('idle'));
      window.link.send(window.packet('idleHeld'));
    });
    assert.equal(await clockPage.evaluate(()=>window.sent.length),1,'unchanged idle input waits for its heartbeat');
    await clockPage.evaluate(()=>window.link.send(window.packet('down')));
    assert.equal(await clockPage.evaluate(()=>window.sent.length),2,'key down replaces pending idle and publishes immediately');
    assert.equal(await clockPage.evaluate(()=>window.sent[1]-window.sent[0]),0);
    await clockPage.evaluate(()=>window.link.send(window.packet('held')));
    await clockPage.clock.runFor(50);
    await clockPage.evaluate(()=>window.link.send(window.packet('heldNext')));
    await clockPage.clock.runFor(64);
    assert.equal(await clockPage.evaluate(()=>window.sent.length),2,'coalesced held input waits until the original 115ms deadline');
    await clockPage.clock.runFor(1);
    assert.equal(await clockPage.evaluate(()=>window.sent.length),3,'held input publishes one newest-history heartbeat');
    assert.equal(await clockPage.evaluate(()=>window.sent[2]-window.sent[1]),115);
    await clockPage.evaluate(()=>{
      window.link.send(window.packet('heldPending'));
      window.link.send(window.packet('up'));
    });
    assert.equal(await clockPage.evaluate(()=>window.sent.length),4,'key up cancels a waiting held packet and publishes immediately');
    assert.equal(await clockPage.evaluate(()=>window.sent[3]-window.sent[2]),0);
    await clockPage.evaluate(()=>window.link.send(window.packet('boundary')));
    assert.equal(await clockPage.evaluate(()=>window.sent.length),5,'epoch boundary publishes immediately');
    await clockPage.evaluate(()=>window.link.send(window.packet('command')));
    assert.equal(await clockPage.evaluate(()=>window.sent.length),6,'command publishes immediately');
    await clockPage.clock.runFor(115);
    assert.equal(await clockPage.evaluate(()=>window.sent.length),6,'cancelled input timers produce no extra publish');
    await clockPage.evaluate(()=>window.link.close());
  } finally {await clockPage.close();}

  await page.locator('.tool-friends').click();
  await page.getByLabel('Close panel',{exact:true}).click();
  await page.reload();
  await page.waitForFunction(()=>window.__fbwg?.view?.prepared);
  assert(await page.locator('.play-drawer').isHidden(),'collapse preference survives reload');
  await page.setViewportSize({width:390,height:844});
  await page.locator('.tool-friends').click();
  assert.equal(await page.locator('.play-drawer').getAttribute('aria-modal'),'true');
  await page.getByLabel('Close panel',{exact:true}).focus();
  await page.keyboard.press('Shift+Tab');
  assert(await page.evaluate(()=>document.querySelector('.play-drawer').contains(document.activeElement)),'narrow panel traps focus');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'phone has no horizontal overflow');
  await page.screenshot({path:`.cache/play-evidence/${name}-elemental-mobile.png`,animations:'disabled'});
  await page.keyboard.press('Escape');
  assert(await page.locator('.play-drawer').isHidden());
  assert(await page.evaluate(()=>!document.querySelector('.play-drawer').contains(document.activeElement)));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('.tool-menu').click();
  assert.equal(await page.locator('.menu-actions').evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.keyboard.press('Escape');
  /*
   * Reduced motion has to reach the JAVASCRIPT too, not only the stylesheet.
   *
   * `[hidden]` is `display:none` and cannot be animated, so the banner plays
   * its exit and sets the attribute on a timer afterwards. Under the blanket
   * `animation:none` rule that timer would still run -- 140ms of a motionless
   * banner sitting there before it blinks out, which is the worst of both
   * answers. The screen asks `matchMedia` and skips straight to hidden.
   */
  await page.locator('.tool-friends').click();
  await page.getByRole('button',{name:/^Invite /}).first().click();
  await page.locator('.banner').waitFor();
  assert.equal(await page.locator('.banner').evaluate(e=>getComputedStyle(e).animationName),'none',
    'reduced motion stops the banner arriving');
  await page.locator('.banner').getByRole('button',{name:'Cancel',exact:true}).click();
  assert(await page.locator('.banner').evaluate(e=>e.hidden && !e.classList.contains('leaving')),
    'and takes it down at once rather than waiting out an animation that is not playing');
  await page.emulateMedia({reducedMotion:null});
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:683,height:384});
  await page.locator('.tool-friends').click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'200% equivalent viewport fits');
  await page.evaluate(()=>{window.socialFixture.peers.splice(0);});
  await refresh();
  await page.getByText('Add a friend below to play together. You can also play on one keyboard.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log(`PASS ${name}: add/crossed requests, failure recovery, removal, focus preservation, inline setup, leaderboard races, adaptive batching, mobile and reduced motion`);
 } finally {await browser.close();}
}
