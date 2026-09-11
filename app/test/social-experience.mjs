import assert from 'node:assert/strict';
import {chromium,firefox,webkit} from 'playwright';
const target=process.env.FBWG_TEST_URL || 'http://127.0.0.1:5174/test/play-fixture.html';
if (!['localhost','127.0.0.1'].includes(new URL(target).hostname)) throw new Error('Social fixtures must stay local');
for(const [name,engine] of Object.entries({chromium,firefox,webkit})) {
 const browser=await engine.launch();
 try {
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname===new URL(target).hostname?r.continue():r.abort());
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
  assert(await page.getByText('Your pair',{exact:true}).isVisible());
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
  await page.evaluate(()=>{window.socialFixture.fail='leaderboard';});
  await page.getByLabel('Leaderboard level',{exact:true}).selectOption('5');
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  assert(await page.locator('.leaderboard-results .error').isVisible());
  await page.evaluate(()=>{window.socialFixture.fail='';});
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('table').waitFor();
  await page.screenshot({path:`.cache/play-evidence/${name}-elemental-leaderboard.png`,animations:'disabled'});
  /*
   * The batch interval, which is the difference between two people playing and
   * two people watching each other freeze.
   *
   * A relayed pair waits 230 ms before a packet leaves the browser, out of a
   * 539 ms rollback window -- so far enough apart, the batching alone is what
   * stalls them. `hurry` halves that wait at roughly double the messages, and
   * the play screen turns it on for the pairs that have actually stalled twice.
   * Asserted here rather than in a pair test because forcing a real stall on
   * one machine is not something a browser test can do honestly; what can be
   * checked is that the dial exists and moves the queue.
   */
  const waits = await page.evaluate(async()=>{
    const {RealtimeTransport}=await import('/src/net/realtime.ts');
    const sent=[];
    const channel={onBytes:()=>()=>{},onStatus:()=>()=>{},sendBytes:()=>{sent.push(Date.now());}};
    const link=new RealtimeTransport(channel);
    // Two input packets: the first goes at once (leading edge) and the second
    // waits out the interval behind it. The gap between them IS the interval.
    const packet=()=>{const d=new Uint8Array(20);d[0]=1;return d;};
    const measure=async()=>{
      sent.length=0;
      link.send(packet());
      const first=Date.now();
      link.send(packet());
      await new Promise(r=>setTimeout(r,400));
      return sent.length>1?sent[sent.length-1]-first:-1;
    };
    const slow=await measure();
    link.hurry(true);
    const fast=await measure();
    link.hurry(false);
    const back=await measure();
    link.close();
    return {slow,fast,back};
  });
  assert(waits.slow>=200&&waits.slow<300,`the ordinary batch interval is ~230ms: ${waits.slow}`);
  assert(waits.fast>=90&&waits.fast<180,`a hurried pair waits ~115ms: ${waits.fast}`);
  assert(waits.back>=200,`and it goes back when the hurry is withdrawn: ${waits.back}`);

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
