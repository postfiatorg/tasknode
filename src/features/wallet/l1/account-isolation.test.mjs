const WEB=process.env.L1_WEB_ORIGIN||'http://127.0.0.1:5198';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page = await browser.newPage();await page.goto(WEB+'');
 const result=await page.evaluate(async()=>{
  const {L1WalletCore}=await import('/src/features/wallet/l1/core.js');
  const {loadVault}=await import('/src/features/wallet/l1/lib/vault.js');
  const password='synthetic-isolation-passphrase';let current='alice';
  const alice=new L1WalletCore('alice',()=>current==='alice');
  const a=await alice.create(password);
  current='bob';
  const staleUnlocked=alice.unlocked;
  const bob=new L1WalletCore('bob',()=>current==='bob');
  const bobInitiallyEmpty=(await bob.status())===null;
  const b=await bob.create(password);
  bob.dispose();
  current='alice';const again=new L1WalletCore('alice',()=>current==='alice');
  const restored=await again.unlock(password);
  let rejectedOverwrite=false;try{await again.create(password);}catch{rejectedOverwrite=true;}
  const pending=new L1WalletCore('pending');const task=pending.create(password);pending.dispose();
  let staleRejected=false;try{await task;}catch{staleRejected=true;}
  let emptyRejected=false;try{await loadVault();}catch{emptyRejected=true;}
  let wrongPasswordRejected=false;again.lock();try{await again.unlock('incorrect-password');}catch{wrongPasswordRejected=true;}
  return {distinct:a!==b,restored:a===restored,staleUnlocked,bobInitiallyEmpty,rejectedOverwrite,staleRejected,pendingEmpty:await loadVault('pending')===null,emptyRejected,wrongPasswordRejected,locked:!again.unlocked};
 });
 assert.deepEqual(result,{distinct:true,restored:true,staleUnlocked:false,bobInitiallyEmpty:true,rejectedOverwrite:true,staleRejected:true,pendingEmpty:true,emptyRejected:true,wrongPasswordRejected:true,locked:true});
 console.log('PASS: account-keyed encrypted vaults; separate addresses; switch/reload preserves original; stale async create, overwrite, missing account and wrong passphrase rejected; dispose/lock clears signing state.');
}finally{await browser.close();}
