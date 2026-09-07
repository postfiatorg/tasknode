import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "espree";

export function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "range") continue;
    if (Array.isArray(child)) child.forEach((entry) => walkAst(entry, visit));
    else if (child && typeof child === "object") walkAst(child, visit);
  }
}

// Follow named imports through exports/barrels and local function references.
// Namespace or dynamic imports conservatively include the entire module.
export function inferenceCallGraph(entries) {
  const modules = new Map(), visited = new Set(), violations = [];
  function local(file, specifier) {
    if (!specifier?.startsWith(".")) return null;
    const target = path.resolve(path.dirname(file), specifier);
    return [target, `${target}.js`, `${target}.mjs`].find((candidate) => existsSync(candidate) && !candidate.endsWith(".json"));
  }
  function module(file) {
    if (modules.has(file)) return modules.get(file);
    const source = readFileSync(file,"utf8");
    const ast = parse(source,{ecmaVersion:"latest",sourceType:"module",loc:true,range:true});
    const result = { source, ast, bindings:new Map(), exports:new Map(), stars:[] };
    modules.set(file,result);
    for (const item of ast.body) {
      if (item.type === "ImportDeclaration") for (const specifier of item.specifiers) result.bindings.set(specifier.local.name,{ imported:specifier.imported?.name || (specifier.type === "ImportDefaultSpecifier" ? "default" : "*"), file:local(file,item.source.value) });
      if (item.type === "ExportAllDeclaration") result.stars.push(local(file,item.source.value));
      const declaration = item.declaration || item;
      if (declaration.type === "VariableDeclaration") for (const binding of declaration.declarations) {
        const names = [];
        walkAst(binding.id, node=>{if(node.type==="Identifier")names.push(node.name);});
        for (const name of names) { result.bindings.set(name,{node:binding}); if(item.type==="ExportNamedDeclaration")result.exports.set(name,name); }
      }
      else if (declaration.id?.name) { result.bindings.set(declaration.id.name,{node:declaration}); if(item.type==="ExportNamedDeclaration")result.exports.set(declaration.id.name,declaration.id.name); }
      if (item.type === "ExportDefaultDeclaration") { result.bindings.set("default",{node:declaration});result.exports.set("default","default"); }
      if (item.type === "ExportNamedDeclaration") for (const specifier of item.specifiers || []) {
        result.exports.set(specifier.exported.name,item.source ? {file:local(file,item.source.value), imported:specifier.local.name} : specifier.local.name);
      }
    }
    return result;
  }
  function inspect(file,node) {
    const data=module(file);
    walkAst(node,item=>{
      if(item.regex || (item.type==="Identifier" && item.name==="RegExp"))violations.push({file:path.relative(process.cwd(),file),line:item.loc.start.line,source:data.source.slice(...item.range)});
      if(item.type==="Identifier" && data.bindings.has(item.name))binding(file,item.name);
      if(item.type==="ImportExpression") { const target=local(file,item.source?.value); if(target)entry(target); }
    });
  }
  function binding(file,name) {
    const id=`${file}:${name}`;if(visited.has(id))return;visited.add(id);
    const found=module(file).bindings.get(name);
    if(found?.node)inspect(file,found.node);
    else if(found?.file) exported(found.file,found.imported);
  }
  function exported(file,name) {
    if(!file)return;
    const id=`export:${file}:${name}`;if(visited.has(id))return;visited.add(id);
    if(name==="*"){entry(file);return;}
    const data=module(file), found=data.exports.get(name);
    if(typeof found==="string")binding(file,found);
    else if(found?.file)exported(found.file,found.imported);
    else for(const star of data.stars)exported(star,name);
  }
  function entry(file) {
    const id=`entry:${file}`;if(visited.has(id))return;visited.add(id);
    inspect(file,module(file).ast);
  }
  entries.forEach(file=>entry(path.resolve(file)));
  const unique=new Map(violations.map(item=>[`${item.file}:${item.line}:${item.source}`,item]));
  return { files:[...modules.keys()].map(file=>path.relative(process.cwd(),file)).sort(),violations:[...unique.values()].sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line) };
}
