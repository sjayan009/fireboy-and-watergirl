import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
const port=5176;
const server=spawn(process.execPath,["../node_modules/vite/bin/vite.js","--host","127.0.0.1","--port",String(port),"--strictPort"],{cwd:fileURLToPath(new URL("../",import.meta.url)),stdio:["ignore","pipe","inherit"]});
let serverError=null;
server.on("error",e=>{serverError=e;});
server.on("exit",code=>{serverError=new Error(`Fixture server exited (${code})`);});
server.stdout.resume();
const target=`http://127.0.0.1:${port}/test/play-fixture.html`;
try {
  let ready=false;
  for(let tries=0;tries<100;tries++) {
    if(serverError) throw serverError;
    try {if((await fetch(target)).ok){ready=true;break;}} catch { /* server starting */ }
    await delay(100);
  }
  if(!ready) throw new Error("Fixture server did not become ready");
  const cases=["app/test/play-experience.mjs","app/test/play-pair.mjs","app/test/social-experience.mjs","app/test/play-guest.mjs"];
  const selected=process.argv[2] ? cases.filter(test=>test.endsWith(`/${process.argv[2]}.mjs`)) : cases;
  if(!selected.length) throw new Error("Unknown play fixture test");
  for(const test of selected) {
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[test],{cwd:root,env:{...process.env,FBWG_TEST_URL:target},stdio:"inherit"});
      child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(new Error(`${test} failed (${code})`)));
    });
  }
} finally {server.kill();}
