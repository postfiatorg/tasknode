// Read-only proposal generator for authored JSX colors, preserving source formatting.
import {readFile,readdir} from "node:fs/promises";
import {parse} from "@babel/parser";
import traverseModule from "@babel/traverse";
import {themeValue} from "./theme-color-migration.mjs";
const traverse=traverseModule.default;
async function files(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(dir+"/"+e.name):dir+"/"+e.name))).flat();}
const edits=[];
for(const file of (await files("src")).filter(p=>p.endsWith(".jsx"))){
 const old_string=await readFile(file,"utf8"), changes=[];
 const tree=parse(old_string,{sourceType:"module",plugins:["jsx"]});
 traverse(tree,{
  StringLiteral(path){
   let parent=path.parentPath;
   while(parent&&(parent.isConditionalExpression()||parent.isLogicalExpression()||parent.isArrayExpression()))parent=parent.parentPath;
   if(!parent?.isObjectProperty()||parent.node.value.start>path.node.start)return;
   const key=parent.node.key.name||parent.node.key.value||"";
   let prop=key.replace(/[A-Z]/g,c=>"-"+c.toLowerCase());
   if(file.includes("/profile/")&&/^(paper|ink|rule|success|warning|rust|flag|layer)/.test(key)){
    prop=key.startsWith("paper")?"background":key.startsWith("rule")?"border-color":"color";
   }
   const value=themeValue(prop,"inline",path.node.value);
   if(value!==path.node.value)changes.push({start:path.node.start,end:path.node.end,value:JSON.stringify(value)});
  },
  TemplateElement(path){
   // Only literal CSS declarations inside a style template; expressions stay intact.
   const text=path.node.value.raw;
   const value=text.replace(/(color|background(?:-color)?|border(?:-[a-z]+)?|box-shadow|outline(?:-[a-z]+)?)\s*:\s*([^;{}]+);/g,(all,prop,v)=>all.replace(v,themeValue(prop,"inline",v)));
   if(value!==text)changes.push({start:path.node.start,end:path.node.end,value});
  }
 });
 let new_string=old_string;
 for(const c of changes.sort((a,b)=>b.start-a.start))new_string=new_string.slice(0,c.start)+c.value+new_string.slice(c.end);
 if(new_string!==old_string)edits.push({path:"tasknode/"+file,old_string,new_string});
}
process.stdout.write(JSON.stringify(edits));
