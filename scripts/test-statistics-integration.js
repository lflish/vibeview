const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-stats-integration-'));
let server, browser, base, cookie;
const repo = path.join(__dirname,'..');
async function stop() { if (server && server.exitCode === null) { const exited = once(server,'exit'); server.kill(); await exited; } }
async function run() {
  const listener = net.createServer().listen(0,'127.0.0.1'); await once(listener,'listening'); const port = listener.address().port; await new Promise(resolve=>listener.close(resolve)); base='http://127.0.0.1:'+port;
  const configPath=path.join(root,'config.json');
  fs.writeFileSync(configPath,JSON.stringify({ server:{port,base_url:base,trust_proxy:false},storage:{retention_days:0},statistics:{timezone:'Asia/Shanghai'},admin:{user:'test',password:'stats-test-password',session_secret:'stats-isolated-secret'},tokens:[{name:'alice',token:'PRIVATE-UPLOAD-TOKEN'},{name:'expiry',token:'PRIVATE-EXPIRY-TOKEN',retention_days:1}] }));
  const metaDir=path.join(root,'data/meta');fs.mkdirSync(metaDir,{recursive:true});
  const legacyId='0000000000000001',expiredId='0000000000000002';
  for(const [id,source,filename] of [[legacyId,'old-source','LEGACY-SENSITIVE.html'],[expiredId,'expiry','EXPIRED-SENSITIVE.html']]){
    const dir=path.join(root,'data/html',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,filename),'legacy');
    fs.writeFileSync(path.join(metaDir,id+'.json'),JSON.stringify({id,type:'html',source,filename,description:'PRIVATE-DESCRIPTION',size:6,createdAt:new Date(Date.now()-3*86400000).toISOString()}));
  }
  async function start() {
    let logs='';server=spawn(process.execPath,['server.js'],{cwd:repo,env:{...process.env,DVIEW_CONFIG_PATH:configPath,DVIEW_PREVIEW_PROXY:'false'},stdio:['ignore','pipe','pipe']});server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
    for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/healthz')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw Error(logs);
  }
  const request=(route,options={})=>fetch(base+route,{...options,redirect:'manual',signal:AbortSignal.timeout(10000)});
  const auth=(route,options={})=>request(route,{...options,headers:{cookie,...options.headers}});
  async function login(){const r=await request('/admin/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({user:'test',password:'stats-test-password'})});assert.equal(r.status,302);cookie=r.headers.get('set-cookie').split(';')[0];}
  async function summary(query=''){const r=await auth('/admin/api/statistics'+query);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');return r.json();}
  async function upload(name='PRIVATE-LIVE.html', token='PRIVATE-UPLOAD-TOKEN'){const form=new FormData();form.set('file',new Blob(['<title>Private resource</title>'],{type:'text/html'}),name);const r=await request('/upload',{method:'POST',headers:{authorization:'Bearer '+token},body:form});assert.equal(r.status,200);return r.json();}
  await start();
  for(const route of ['/admin/api/statistics','/admin/api/statistics/day']){const r=await request(route,{headers:{authorization:'Bearer PRIVATE-UPLOAD-TOKEN'}});assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');}
  assert.equal((await request('/admin/statistics')).status,302);await login();
  let s=await summary();assert.equal(s.summary.uploads.count,2);assert.equal(s.summary.current.count,1);assert.equal(s.summary.deletions.retention,1);assert.equal(s.coverage.backfilledUploads,2);
  const first=await upload();s=await summary();assert.equal(s.summary.uploads.count,3);assert.equal(s.summary.today.count,1);
  const update=await auth('/admin/api/item/'+first.id+'/access',{method:'PATCH',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({mode:'public'})});assert.equal(update.status,200);assert.equal((await summary()).summary.uploads.count,3);
  const badForm=new FormData();badForm.set('file',new Blob(['bad'],{type:'text/plain'}),'bad.txt');assert.equal((await request('/upload',{method:'POST',headers:{authorization:'Bearer PRIVATE-UPLOAD-TOKEN'},body:badForm})).status,400);assert.equal((await summary()).summary.uploads.count,3);
  const ownerDeleted=await upload('OWNER-SENSITIVE.html');assert.equal((await request('/api/me/items/'+ownerDeleted.id,{method:'DELETE',headers:{authorization:'Bearer PRIVATE-UPLOAD-TOKEN'}})).status,200);
  const bulk=await Promise.all([upload('BULK-A.html'),upload('BULK-B.html')]);const ids=bulk.map(r=>r.id);assert.equal((await auth('/admin/api/items',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({ids})})).status,200);
  assert.equal((await auth('/admin/api/item/'+first.id,{method:'DELETE'})).status,200);assert.equal((await auth('/admin/api/item/'+first.id,{method:'DELETE'})).status,200);
  s=await summary();assert.equal(s.summary.uploads.count,6);assert.equal(s.summary.current.count,1);assert.equal(s.summary.deletions.count,5);assert.equal(s.summary.deletions.admin,3);assert.equal(s.summary.deletions.owner,1);
  assert.ok(s.availableSources.includes('expiry'));assert.ok(s.deletionActivities.length>=4);
  const day=await (await auth('/admin/api/statistics/day?date='+s.today+'&pageSize=2&page=2')).json();assert.equal(day.total,4);assert.equal(day.retainedCount,0);assert.equal(day.items.length,2);assert.ok(day.items.every(r=>r.filename===null));
  const serialized=JSON.stringify(s);for(const secret of ['PRIVATE-UPLOAD-TOKEN','PRIVATE-EXPIRY-TOKEN','PRIVATE-DESCRIPTION','stats-test-password','accessCode','hash'])assert.ok(!serialized.includes(secret));
  for(const query of ['?from=2026-02-30','?range=invalid','?type=bad','?source[]=alice','?from=2020-01-01'])assert.equal((await auth('/admin/api/statistics'+query)).status,400);
  const historyBefore=s.summary.uploads.count,startedAt=s.coverage.startedAt;await stop();await start();await login();s=await summary();assert.equal(s.summary.uploads.count,historyBefore);assert.equal(s.coverage.startedAt,startedAt);assert.equal(s.summary.deletions.count,5);
  const newRows=[];for(let i=0;i<15;i++)newRows.push(await upload('live-'+i+'.html'));
  if(process.argv.includes('--browser')){
    const {chromium}=require('playwright');browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/admin/login');await page.locator('#user').fill('test');await page.locator('#password').fill('stats-test-password');await page.locator('#submit').click();await page.waitForSelector('#rows tr');
    await page.getByRole('link',{name:'统计',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('stats-content').hidden&&document.getElementById('selected-count').textContent.includes('19'));
    assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(246, 248, 251)');assert.match(await page.locator('#period-value').textContent(),/21/);assert.match(await page.locator('#stock-value').textContent(),/16/);assert.ok(await page.locator('#coverage-note').isVisible());
    await page.locator('#source').selectOption('expiry');await page.waitForFunction(()=>!document.getElementById('stats-content').hidden&&document.getElementById('source').value==='expiry');assert.equal((await page.locator('#period-value').textContent()).trim(),'1个');assert.equal((await page.locator('#stock-value').textContent()).trim(),'0个');
    await page.getByRole('button',{name:'重置',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('stats-content').hidden&&document.getElementById('selected-count').textContent.includes('19'));
    await page.getByRole('button',{name:'上传体积',exact:true}).click();assert.match(await page.locator('#trend-total').textContent(),/ B|KB|MB/);
    await page.getByRole('button',{name:'近 7 天',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('stats-content').hidden&&document.querySelectorAll('#trend-chart .bar').length===7);
    await page.locator('#trend-chart .bar').first().click();await page.waitForFunction(()=>document.getElementById('selected-count').textContent==='0 个');assert.equal(await page.locator('#day-all').isDisabled(),true);
    await page.getByRole('button',{name:'回到今天',exact:true}).click();await page.waitForFunction(()=>document.getElementById('selected-count').textContent==='19 个');
    await page.getByRole('button',{name:'查看当日记录 →',exact:true}).click();await page.waitForSelector('#dialog-body tbody tr');assert.equal(await page.locator('#dialog-body tbody tr').count(),12);await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.pager')?.textContent.includes('第 2'));assert.equal(await page.locator('#dialog-body tbody tr').count(),7);assert.match(await page.locator('#dialog-body').textContent(),/已删除/);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'删除',exact:true}).click();assert.match(await page.locator('#activity-list').textContent(),/管理员删除/,'deletion filter includes events older than latest eight uploads');
    await page.locator('#theme-select').selectOption('dark');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.reload();await page.waitForSelector('#stats-content:not([hidden])');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.locator('#theme-select').selectOption('light');
    // Failed responses hide stale results and can be retried.
    let fail=true;await page.route('**/admin/api/statistics?**',async route=>{if(fail)await route.fulfill({status:503,contentType:'application/json',body:'{}'});else await route.continue();});
    await page.getByRole('button',{name:'近 30 天',exact:true}).click();await page.waitForSelector('#load-error:not([hidden])');assert.equal(await page.locator('#stats-content').isVisible(),false);fail=false;await page.locator('#retry').click();await page.waitForSelector('#stats-content:not([hidden])');await page.unroute('**/admin/api/statistics?**');
    // An old response must not replace a newer source selection.
    let release,observed;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>observed=resolve);
    await page.route('**/admin/api/statistics?**',async route=>{if(new URL(route.request().url()).searchParams.get('source')==='old-source'){observed();await gate;try{await route.abort('failed');}catch{}}else await route.continue();});
    await page.locator('#source').selectOption('old-source');await started;await page.locator('#source').selectOption('alice');await page.waitForFunction(()=>!document.getElementById('stats-content').hidden&&document.getElementById('source').value==='alice');release();await page.waitForTimeout(100);assert.equal(await page.locator('#load-error').isVisible(),false);await page.unroute('**/admin/api/statistics?**');
    for(const width of [1440,768,390]){await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(50);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/vibeview-statistics-product-'+width+'.png',fullPage:true});}
    await context.clearCookies();await page.getByRole('button',{name:'本月',exact:true}).click();await page.waitForSelector('#login-again:not([hidden])');assert.equal(await page.locator('#stats-content').isVisible(),false);assert.deepEqual(errors,[]);await browser.close();browser=null;
    console.log('statistics browser: live filters/calendar/day pagination, history coverage, dark/light persistence, stale/error/401 handling and responsive layouts passed');
  }
  // Journal survives deletion of the disposable SQLite index, and restart backfill is idempotent.
  await stop();fs.rmSync(path.join(root,'data/resources.sqlite'),{force:true});await start();await login();assert.equal((await summary()).summary.uploads.count,21);
  console.log('statistics integration: auth, backfill before retention, successful/failed uploads, access edits, owner/admin/bulk deletes, restart/index rebuild and privacy passed');
}
run().finally(async()=>{if(browser)await browser.close();await stop();fs.rmSync(root,{recursive:true,force:true});}).catch(error=>{console.error(error);process.exitCode=1;});
