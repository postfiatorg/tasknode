import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import postcss from "postcss";
import {browserFixture} from "./browser-fixture-driver.mjs";
async function files(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(dir+"/"+e.name):dir+"/"+e.name))).flat();}
const pairs=[],variables={};
for(const file of (await files("src")).filter(f=>f.endsWith(".css")&&!f.endsWith("styles-theme.css"))){
 const root=postcss.parse(await readFile(file,"utf8"));
 root.walkDecls(d=>{if(d.prop.startsWith("--"))variables[d.prop]=d.value;});
 root.walkRules(rule=>{
  const decls=rule.nodes.filter(d=>d.type==="decl"),fg=decls.findLast(d=>d.prop==="color"),bg=decls.findLast(d=>["background","background-color"].includes(d.prop));
  if(fg&&bg&&!bg.value.includes("gradient")&&!bg.value.includes("url(")&&!rule.selector.includes("disabled"))pairs.push({file,selector:rule.selector,fg:fg.value,bg:bg.value});
 });
}
for (const role of ["focus", "control-border"]) {
 for (const surface of ["bg", "surface", "surface-raised", "surface-hover"]) {
  pairs.push({file:"src/styles-theme.css",selector:`${role} on ${surface}`,fg:`var(--tn-${role})`,bg:`var(--tn-${surface})`,minimum:3});
 }
}
const browser=await browserFixture({port:9377});
try{
 const page=await browser.page({url:"http://127.0.0.1:5197"});
 await page.until("Boolean(window.tasknodeAppearance)");
 await page.evaluate("window.tasknodeAppearance.setPreference('dark')");
 await page.until("getComputedStyle(document.documentElement).getPropertyValue('--tn-dark-text').trim().length>0");
 const failures=await page.evaluate(`(()=>{
  const pairs=${JSON.stringify(pairs)},vars=${JSON.stringify(variables)},host=document.createElement('div');
  for(const [k,v] of Object.entries(vars))host.style.setProperty(k,v);
  document.body.append(host);
  const rgb=s=>(s.match(/[\\d.]+/g)||[]).map(Number);
  const lum=c=>c.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
  const out=[];
  for(const p of pairs){
   const el=document.createElement('span');el.style.color=p.fg;el.style.background=p.bg;host.append(el);
   const s=getComputedStyle(el),fg=rgb(s.color),bg=rgb(s.backgroundColor);
   if(bg.length===4&&bg[3]<1){const a=bg[3];for(let i=0;i<3;i++)bg[i]=bg[i]*a+[23,24,22][i]*(1-a);}
   const l1=lum(fg),l2=lum(bg),ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
   if(ratio<(p.minimum||4.5))out.push({...p,fg:s.color,bg:s.backgroundColor,ratio:Number(ratio.toFixed(2))});
   el.remove();
  }host.remove();return out;
 })()`);
 // Dots contain no text; transparent avatar text deliberately hides the fallback under an image.
 const decorative = new Set([".hive-task-dot.is-amber", ".hive-task-dot.is-green", ".hive-task-dot.is-muted", ".profile-avatar.has-image"]);
 const actionable = failures.filter(p => !decorative.has(p.selector));
 console.log(JSON.stringify({pairs:pairs.length,decorativeExclusions:failures.length-actionable.length,failures:actionable},null,2));
 assert.deepEqual(actionable, [], "Text pairs must reach 4.5:1; focus/control boundaries must reach 3:1");
}finally{await browser.close();}
