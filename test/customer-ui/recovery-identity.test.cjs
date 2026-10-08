const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const code = fs.readFileSync(path.resolve(__dirname, '../../deploy/customer/container-ops.cjs'), 'utf8')
async function restore(dashboard, corruptDump = false) {
  const original = {database:{type:'sqlite',path:'/app/data/gateway.db'}, dashboard,
    auth:{api_keys:['synthetic-business-key']}, nodes:[{id:'local',api_key:'synthetic-provider',models:['synthetic-model']}], prices:{input:'0.00000001'}}
  let text = JSON.stringify(original); const logs = [], errors = []
  const process = {argv:['node','container-ops.cjs','restore-identity'],umask(){},exitCode:0}
  const sandbox = {Buffer,process,console:{log: value => logs.push(value),error: value => errors.push(value)}, require:name=>{
    if (name==='node:fs') return {readFileSync:(file,encoding)=>encoding ? text : Buffer.from(text),writeFileSync:(file,value)=>{text=value}}
    // Only JSON-compatible YAML fixture values are simulated here. Native smoke
    // uses the image's actual js-yaml parser and real legacy login sessions.
    if (name==='js-yaml') return {load:JSON.parse,dump:value=>JSON.stringify(corruptDump ? {...value,auth:{api_keys:[]}} : value)}
    return require(name)
  }}
  await vm.runInNewContext(code,sandbox)
  return {original,restored:JSON.parse(text),logs,errors,process}
}
test('legacy restore rotates explicit, env-referenced and password-derived signing secrets only', async () => {
  for (const dashboard of [{password:'synthetic-bcrypt-hash',session_secret:'old-secret'},
    {password:'synthetic-bcrypt-hash',session_secret:'${env:SYNTHETIC_SESSION_SECRET}'},
    {password:'synthetic-bcrypt-hash'},
    {oidc:{enabled:true,issuer:'https://identity.example.invalid'},session_secret:'old-oidc-secret'}]) {
    const result=await restore({auth_required:true,...dashboard})
    assert.equal(result.process.exitCode,0)
    const evidence=JSON.parse(result.logs[0])
    assert.equal(evidence.identity_mode,'legacy_session_secret'); assert.equal(evidence.only_session_secret_changed,true)
    assert.match(result.restored.dashboard.session_secret,/^[a-f0-9]{64}$/)
    assert.notEqual(result.restored.dashboard.session_secret,dashboard.session_secret)
    const before=structuredClone(result.original),after=structuredClone(result.restored)
    delete before.dashboard.session_secret; delete after.dashboard.session_secret
    assert.deepEqual(after,before)
    assert.equal(evidence.original_config_sha256,crypto.createHash('sha256').update(JSON.stringify(result.original)).digest('hex'))
    assert.equal(result.logs.join('').includes('synthetic-business-key'),false)
    assert.equal(result.logs.join('').includes('synthetic-bcrypt-hash'),false)
  }
})
test('unauthenticated or missing legacy identity fails closed without changing customer fields',async()=>{
  for (const dashboard of [{auth_required:false,password:'synthetic-password'},{}]) {
    const result=await restore(dashboard)
    assert.equal(result.process.exitCode,1); assert.deepEqual(result.restored,result.original)
    assert.equal(result.logs.length,0)
  }
})
test('unintended semantic configuration changes never report successful recovery',async()=>{
  const result=await restore({password:'synthetic-password'},true)
  assert.equal(result.process.exitCode,1); assert.equal(result.logs.length,0)
  assert.equal(result.errors.join('').includes('synthetic-password'),false)
})
