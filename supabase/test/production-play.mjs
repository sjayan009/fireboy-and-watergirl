import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import pg from "pg";
import { ENGINE_VERSION } from "../../engine/dist/version.js";
import { canonicalReplay } from "../../engine/dist/verified.js";
import { versions } from "../../worker/versions.mjs";

// Deliberately local-only. Auth/Realtime service tables below are bounded fixtures.
const connectionString = process.env.FBWG_LOCAL_TEST_DATABASE || "postgres://supabase_admin:local-fixture-only@127.0.0.1:55439/postgres";
if (!["127.0.0.1","localhost","[::1]"].includes(new URL(connectionString).hostname)) throw new Error("This fixture must never run against a remote database");
const db = new pg.Client({ connectionString });
await db.connect();
try {
  await db.query("begin");
  await db.query(`
    create table if not exists auth.mfa_factors(id uuid primary key default gen_random_uuid(), user_id uuid, status text);
    create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create table if not exists realtime.messages(id bigint, extension text, topic text, private boolean);
    alter table realtime.messages enable row level security;
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    grant select,insert on realtime.messages to authenticated;
  `);
  const dir = new URL("../migrations/",import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(file,dir),"utf8");
    try { await db.query(sql); }
    catch (e) { console.error(file, sql.slice(Math.max(0,Number(e.position) - 100),Number(e.position) + 100)); throw e; }
  }
  console.log("All baseline and production-play migrations applied in a rollback transaction");
  const ids = [randomUUID(),randomUUID(),randomUUID()].sort();
  const [a,b,c] = ids;
  for (const [i,id] of ids.entries()) {
    await db.query("insert into auth.users(id,email) values($1,$2)",[id,`fixture${i}@example.test`]);
    await db.query("insert into public.profiles(id,username) values($1,$2)",[id,`fixture${i}`]);
  }
  await db.query("insert into public.friendships(user_a,user_b,status,requested_by) values($1,$2,'accepted',$1),($1,$3,'accepted',$1)",[a,b,c]);
  await db.query("insert into play_private.engine_versions(version) values($1)",[ENGINE_VERSION]);
  const as = async (id,role="authenticated") => {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[id,JSON.stringify({ sub:id,role,aal:"aal1" })]);
    await db.query(`set local role ${role}`);
  };
  const denied = async (sql,args=[]) => {
    await db.query("savepoint negative_fixture");
    let rejected = false;
    try { await db.query(sql,args); } catch { rejected = true; }
    await db.query("rollback to negative_fixture");
    assert(rejected,"unauthorized/invalid action must fail");
  };
  const register = async (peer,run=1,connection=match) => (await db.query("select public.register_ranked_attempt($1,$2,$3,$4,$5,$6) id",[peer,connection,run,"speed",3,ENGINE_VERSION])).rows[0].id;
  const submit = async (id,digest,replay=null) => (await db.query("select public.submit_ranked_replay($1,$2,$3) state",[id,digest,replay])).rows[0].state;
  const fixture=JSON.parse(readFileSync(new URL("../../worker/fixtures/speed3.json",import.meta.url),"utf8"));
  const replay=canonicalReplay({version:1,engine:ENGINE_VERSION,mode:fixture.mode,num:fixture.num,frames:fixture.frames,inputs:fixture.inputs,commands:fixture.commands});
  const match = randomUUID(), digest = createHash("sha256").update(replay).digest("hex");
  await as(a);
  assert.equal((await db.query("select * from public.list_friends()")).rows.length,2);
  const attempt = await register(b);
  assert.equal(await register(b),attempt,"registration is idempotent");
  await denied("select * from play_private.ranked_attempts");
  await denied("select * from play_private.claim_replay($1)",[[ENGINE_VERSION]]);
  assert.equal(await submit(attempt,digest,replay),"waiting");
  await denied("select public.submit_ranked_replay($1,$2,null)",[attempt,"b".repeat(64)]);
  await as(c);
  await denied("select public.submit_ranked_replay($1,$2,null)",[attempt,digest]);
  assert.equal((await db.query("select * from public.ranked_status($1)",[attempt])).rows.length,0);
  await as(b);
  assert.equal(await register(a),attempt);
  assert.equal(await submit(attempt,digest),"queued");
  assert.equal(await submit(attempt,digest),"queued");
  await as(a,"fbwg_verifier");
  await denied("select * from auth.users");
  await denied("select * from public.pair_progress");
  const claim = (await db.query("select * from play_private.claim_replay($1)",[[ENGINE_VERSION]])).rows[0];
  assert.equal(claim.id,attempt);
  assert.equal((await db.query("select * from play_private.claim_replay($1)",[[ENGINE_VERSION]])).rows.length,0,"claimed job cannot be claimed twice");
  assert.equal((await db.query("select play_private.finish_replay($1,$2,null,null) ok",[attempt,randomUUID()])).rows[0].ok,false);
  // Execute the leased replay in the actual isolated engine, then publish only
  // that result through the scoped worker role. No success state is injected.
  const executor=new Worker(new URL("../../worker/replay-slot.mjs",import.meta.url),{workerData:{module:versions.get(ENGINE_VERSION),job:claim},env:{},resourceLimits:{maxOldGenerationSizeMb:256}});
  const deadline=setTimeout(()=>executor.terminate(),10000);
  let result;
  try {
    const outcome=await new Promise((resolve,reject)=>{executor.once("message",resolve);executor.once("error",reject);executor.once("exit",()=>reject(new Error("Worker did not finish")));});
    result=outcome.result;assert.deepEqual(result,fixture.expected);
  } finally {clearTimeout(deadline);await executor.terminate();}
  assert.equal((await db.query("select play_private.finish_replay($1,$2,$3,null) ok",[attempt,claim.lease,result])).rows[0].ok,true);
  assert.equal((await db.query("select play_private.finish_replay($1,$2,$3,null) ok",[attempt,claim.lease,result])).rows[0].ok,false);
  await as(a);
  assert.equal((await db.query("select * from public.verified_leaderboard(12::smallint)")).rows[0].best_time_s,8);
  const another = await register(b,2);
  await submit(another,digest,"fixture replay");
  await as(b); await register(a,2);
  assert.equal(await submit(another,"b".repeat(64)),"not_ranked");
  // A crash expires the lease; exactly three executions are permitted.
  await as(a); const crashed = await register(b,3); await submit(crashed,digest,"fixture replay");
  await as(b); await register(a,3); await submit(crashed,digest);
  await as(a,"fbwg_verifier");
  assert.equal((await db.query("select * from play_private.claim_replay($1)",[["unsupported-version"]])).rows.length,0);
  let previousLease;
  for (let execution=0;execution<3;execution++) {
    const job = (await db.query("select * from play_private.claim_replay($1)",[[ENGINE_VERSION]])).rows[0];
    assert.equal(job.id,crashed); assert.notEqual(job.lease,previousLease); previousLease=job.lease;
    await db.query("reset role");
    await db.query("update play_private.ranked_attempts set leased_until=now()-interval '1 second' where id=$1",[crashed]);
    await as(a,"fbwg_verifier");
    assert.equal((await db.query("select play_private.renew_replay($1,$2) ok",[crashed,job.lease])).rows[0].ok,false);
  }
  assert.equal((await db.query("select * from play_private.claim_replay($1)",[[ENGINE_VERSION]])).rows.length,0);
  await as(a);
  assert.equal((await db.query("select * from public.ranked_status($1)",[crashed])).rows[0].state,"not_ranked");
  await db.query("reset role");
  assert.equal((await db.query("select has_function_privilege('anon','public.sync_progress(uuid,smallint[],integer[],text[])','execute') ok")).rows[0].ok,false);
  assert.equal((await db.query("select has_function_privilege('authenticated','public.sync_progress(uuid,smallint[],integer[],text[])','execute') ok")).rows[0].ok,true);
  const consent = async (peer,on) => (await db.query("select * from public.match_consent($1,$2,$3)",[match,peer,on])).rows[0];
  await as(a); const first = await consent(b,true); assert.equal(first.shared,false);
  await as(c); assert.equal((await db.query("select public.can_watch_pair_topic($1) ok",[first.topic])).rows[0].ok,false);
  await as(b); const both = await consent(a,true); assert.equal(both.shared,true);
  await as(c); assert.equal((await db.query("select public.can_watch_pair_topic($1) ok",[both.topic])).rows[0].ok,true);
  assert.equal((await db.query("select public.can_feed_watch_topic($1) ok",[both.topic])).rows[0].ok,false);
  await as(a); const revoked = await consent(b,false); assert.notEqual(revoked.topic,both.topic);
  await as(c); assert.equal((await db.query("select public.can_watch_pair_topic($1) ok",[both.topic])).rows[0].ok,false);
  /*
   * The shape the PREVIOUS release publishes to, which this migration has to
   * go on answering. `deployed` applies migrations before it waits for Vercel,
   * so that client is briefly talking to this schema; if these four answers
   * change, spectating breaks at the moment of every deploy. The contract
   * migration in `supabase/deferred/` is what finally turns the first three
   * false, and it runs a release later.
   */
  const derived = (x,y) => `watch:${x}:${y}`;
  const may = async (fn,topic) => (await db.query(`select public.${fn}($1) ok`,[topic])).rows[0].ok;
  await as(a); assert.equal(await may("can_feed_watch_topic",derived(a,b)),true,"a player still feeds the derived topic");
  await as(c); assert.equal(await may("can_watch_pair_topic",derived(a,b)),true,"a friend of a player still watches it");
  assert.equal(await may("can_feed_watch_topic",derived(a,b)),false,"but a watcher still cannot feed it");
  assert.equal(await may("can_watch_pair_topic",derived(b,c)),false,"and a pair that is not a friendship names nothing");
  await as(a); await consent(b,true);
  await db.query("select public.block_friend($1)",[b]);
  await denied("select public.register_ranked_attempt($1,$2,3,'adventure',1,$3)",[b,match,ENGINE_VERSION]);
  await db.query("reset role");
  assert.equal((await db.query("select consent_a or consent_b as consent from play_private.match_sharing where id=$1",[match])).rows[0].consent,false);
  console.log("PASS: account/pair authorization, immutable acknowledgements, duplicate claims, leased completion, verified-only scores, independent spectator consent and revocation");
} finally { await db.query("rollback"); await db.end(); }
