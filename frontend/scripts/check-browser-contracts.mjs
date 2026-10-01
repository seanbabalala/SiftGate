import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/** Type-only imports still need their dependencies during a standalone frontend build. */
export function checkBrowserContracts(root) {
 const serverRoot=path.resolve(root,'../src'),seen=new Set(),entries=new Set()
 const moduleFile=(origin,specifier)=>{
  const resolved=path.resolve(path.dirname(origin),specifier)
  for(const candidate of [resolved,resolved+'.ts',resolved+'.tsx',path.join(resolved,'index.ts')])if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile())return candidate
  return null
 }
 const specifiers=file=>{const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true),refs=[];const visit=node=>{
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))refs.push(node.moduleSpecifier.text)
  if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal))refs.push(node.argument.literal.text)
  ts.forEachChild(node,visit)
 };visit(source);return refs}
 const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):/\.tsx?$/.test(entry.name)?[path.join(dir,entry.name)]:[])
 for(const file of files(path.join(root,'src')))for(const ref of specifiers(file))if(ref.startsWith('.')){const resolved=moduleFile(file,ref);if(resolved?.startsWith(serverRoot+path.sep))entries.add(resolved)}
 const visit=file=>{if(seen.has(file))return;seen.add(file);for(const ref of specifiers(file)){
  assert.ok(ref.startsWith('.')||ref.startsWith('node:'),`Browser contract ${path.relative(serverRoot,file)} depends on server-only package ${ref}; extract transport data types instead.`)
  if(ref.startsWith('.')){const resolved=moduleFile(file,ref);assert.ok(resolved&&resolved.startsWith(serverRoot+path.sep),`Unresolved/escaped shared contract ${ref}`);visit(resolved)}
 }}
 for(const file of entries)visit(file)
 assert.ok(entries.size>0)
 console.log(`Browser shared-contract boundaries passed: ${entries.size} entry modules, ${seen.size} source modules, no server-only package dependencies.`)
}
