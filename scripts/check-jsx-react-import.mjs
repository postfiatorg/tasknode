#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const srcDir = path.join(rootDir, "src");

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) entries.push(...walk(fullPath));
    else if (fullPath.endsWith(".jsx")) entries.push(fullPath);
  }
  return entries;
}

const offenders = walk(srcDir).filter((filePath) => {
  const source = readFileSync(filePath, "utf8");
  return !source.includes("import React");
});

if (offenders.length > 0) {
  console.error("JSX files must import React for this Vite/classic JSX runtime:");
  for (const filePath of offenders) {
    console.error(`- ${path.relative(rootDir, filePath)}`);
  }
  process.exit(1);
}

console.log("jsx React import check ok");
