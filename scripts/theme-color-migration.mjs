// One-time, reviewable CSS migration. Prints proposed edits; never writes files.
// Operates on CSS declarations, not application/user/model content.
import { readFile, readdir } from "node:fs/promises";
import postcss from "postcss";
const colors = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;
function parse(value) {
  if (value === "white") return [255,255,255,1];
  if (value === "black") return [0,0,0,1];
  if (value.startsWith("#")) {
    let h=value.slice(1); if(h.length===3||h.length===4)h=h.split("").map(c=>c+c).join("");
    return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)).concat(h.length===8?parseInt(h.slice(6),16)/255:1);
  }
  const parts=value.slice(value.indexOf("(")+1,-1).split(/[ ,/]+/).filter(Boolean).map(Number);
  return parts.length===3?parts.concat(1):parts;
}
function role(prop, selector, value) {
  const [r,g,b,a]=parse(value);
  if(![r,g,b,a].every(Number.isFinite)||a===0)return "";
  const brightness=(r+g+b)/765, chroma=Math.max(r,g,b)-Math.min(r,g,b);
  let type=prop;
  if(prop.startsWith("--")){
    if(/shadow/.test(prop))type="box-shadow";
    else if(/border|rule/.test(prop))type="border-color";
    else if(/ink|text|muted/.test(prop))type="color";
    else if(/soft|cream|surface|paper|bg|tag/.test(prop))type="background";
    else type="color";
  }
  if(type.includes("shadow"))return "shadow";
  if(/outline/.test(type))return "focus";
  const background=type.includes("background");
  const border=type.includes("border");
  if(background&&/backdrop|lightbox|image-viewer/.test(selector)&&brightness<0.3)return "backdrop";
  if(background&&a<0.4)return a>0.12?"overlay-strong":"overlay";
  let hue="";
  if(chroma>30 && !(r>g&&g>b&&chroma<65&&brightness>0.65)){
    if(g>r*1.08&&g>b*1.08)hue="success";
    else if(b>r*1.1&&b>g*.95)hue="info";
    else if(r>b*1.2&&g>b*1.2&&g>r*.6)hue="warning";
    else if(r>g*1.15&&r>b*1.1)hue="danger";
    else if(r>b*.85&&b>g*1.15)hue="purple";
    else if(g>r&&b>r)hue="info";
  }
  if(border)return /input|textarea|select|button|pill|toggle/.test(selector)?"control-border":"border";
  if(background){
    if(hue)return hue+"-surface";
    if(brightness<0.38)return "inverse-surface";
    if(/sidebar|rail/.test(selector))return "sidebar";
    if(/hover|active|selected/.test(selector))return "hover";
    if(/modal|dialog|popover|menu/.test(selector))return "raised";
    if(/body|:root|app-shell|workspace/.test(selector))return "bg";
    return brightness>0.985?"surface":brightness>0.92?"bg":"hover";
  }
  if(hue)return hue;
  if(brightness>0.91&&a>0.6)return "on-inverse";
  if(brightness>0.4||a<0.65)return "muted";
  if(brightness>0.17)return "secondary";
  return "text";
}
export function themeValue(prop, selector, value) {
  if(value.includes("url(")||value.includes("var(--tn-"))return value;
  if(!prop.startsWith("--")&&!/color|background|border|outline|shadow|fill|stroke/.test(prop))return value;
  return value.replace(colors,original=>{
    const token=role(prop,selector,original.toLowerCase());
    return token?`var(--tn-dark-${token}, ${original})`:original;
  });
}
async function files(dir) {
  const entries=await readdir(dir,{withFileTypes:true});
  const result=await Promise.all(entries.map(e=>e.isDirectory()?files(dir+"/"+e.name):dir+"/"+e.name));
  return result.flat();
}
if (process.argv[2] === "--css") {
  const edits=[];
  for(const path of (await files("src")).filter(p=>p.endsWith(".css")&&!p.endsWith("styles-theme.css"))){
    const old_string=await readFile(path,"utf8");
    const root=postcss.parse(old_string);
    root.walkDecls(decl=>{decl.value=themeValue(decl.prop,decl.parent.selector||"",decl.value);});
    const new_string=root.toString();
    if(old_string!==new_string)edits.push({path:"tasknode/"+path,old_string,new_string});
  }
  process.stdout.write(JSON.stringify(edits));
}
