import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const source=await readFile(new URL("../public/theme-init.js",import.meta.url),"utf8");
function fixture({saved=null,dark=false,blocked=false,noMedia=false}={}){
 const events=new Map(), changes=new Set(), root={dataset:{},style:{}}, meta={content:""};
 const data=new Map(saved===null?[]:[["tasknode.appearance.v1",saved]]);
 const storage={getItem:k=>{if(blocked)throw Error("blocked");return data.get(k)||null;},setItem:(k,v)=>{if(blocked)throw Error("blocked");data.set(k,v);}};
 const media={matches:dark,addEventListener:(_,f)=>changes.add(f),removeEventListener:(_,f)=>changes.delete(f)};
 const window={localStorage:storage,matchMedia:()=>{if(noMedia)throw Error("unavailable");return media;},addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k)};
 const context=vm.createContext({window,document:{documentElement:root,querySelector:()=>meta}});
 vm.runInContext(source,context);
 return {store:window.tasknodeAppearance,root,data,events,changes,storage,meta,os:(v)=>{media.matches=v;changes.forEach(f=>f());},rerun:()=>vm.runInContext(source,context)};
}
for(const saved of [null,"auto","invalid","system","light","dark"]){
 for(const dark of [false,true]){
  const f=fixture({saved,dark}), expected=saved==="light"||saved==="dark"?saved:dark?"dark":"light";
  assert.equal(f.root.dataset.theme,expected);assert.equal(f.root.style.colorScheme,expected);
  assert.equal(f.store.getSnapshot().preference,saved==="light"||saved==="dark"?saved:"system");
  const store=f.store;f.rerun();assert.equal(f.store,store);
 }
}
const f=fixture({dark:true});let notified=0;const unsub=f.store.subscribe(()=>notified++);
f.os(false);assert.equal(f.root.dataset.theme,"light");
f.store.setPreference("dark");f.os(false);assert.equal(f.root.dataset.theme,"dark");
assert.equal(f.data.get("tasknode.appearance.v1"),"dark");
f.events.get("storage")({key:"tasknode.appearance.v1",newValue:"light",storageArea:f.storage});assert.equal(f.root.dataset.theme,"light");
f.events.get("storage")({key:"tasknode.appearance.v1",newValue:"dark",storageArea:{}});assert.equal(f.root.dataset.theme,"light");
f.events.get("storage")({key:null,newValue:null,storageArea:f.storage});assert.equal(f.store.getSnapshot().preference,"system");
assert.ok(notified>=4);unsub();assert.equal(f.changes.size,0);assert.equal(f.events.size,0);
f.data.set("tasknode.appearance.v1", "light");
const reconnect = f.store.subscribe(() => {}); assert.equal(f.root.dataset.theme, "light"); reconnect();
const privateMode=fixture({blocked:true});privateMode.store.setPreference("dark");assert.equal(privateMode.root.dataset.theme,"dark");assert.equal(privateMode.store.getSnapshot().sessionOnly,true);
assert.equal(fixture({noMedia:true}).root.dataset.theme,"light");
console.log("appearance store passed: startup, preference precedence, invalid storage, privacy mode, OS changes, cross-tab sync and listener cleanup");
