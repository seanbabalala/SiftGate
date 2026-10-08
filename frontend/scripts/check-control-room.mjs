import assert from 'node:assert/strict'
import fs from 'node:fs'
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')
const page = read('../src/pages/ControlRoomPage.tsx')
const controller = read('../../src/operator/operator-status.controller.ts')
const service = read('../../src/operator/operator-status.service.ts')
const overlay = read('../../deploy/customer/compose.operator-status.yaml')
assert.ok(page.includes("apiGet<Status>('/api/dashboard/operator/status')"))
for (const forbidden of ['apiPost(', 'apiPut(', 'apiDelete(', 'window.open(']) assert.equal(page.includes(forbidden), false, forbidden)
assert.equal(/\bfetch\s*\(/.test(page), false)
assert.ok(page.includes('enabled: admin'))
assert.ok(page.includes('navigator.clipboard.writeText(value)'))
assert.ok(page.includes('src="/favicon.svg"'))
assert.ok(page.includes("needsSetup ?") && page.includes('`${command} status`'))
assert.ok(controller.includes("@RequireDashboardRole('admin')"))
assert.equal(controller.includes('@Post('), false)
for (const required of ['O_NOFOLLOW', '256 * 1024', 'data.installation_id === identity', 'stale', 'restore_drill_verified === false']) assert.ok(service.includes(required), required)
for (const forbidden of ['child_process','exec(', 'spawn(', 'createConnection(', 'writeFile(']) assert.equal(service.includes(forbidden), false)
assert.ok(overlay.includes(':/operator-status:ro'))
assert.ok(overlay.includes('SIFTGATE_OPERATOR_INSTALLATION_ID'))
assert.equal(overlay.includes('/var/run/docker.sock'), false)
const keys = ['control.manualTrust','control.hostOwner','control.windowNotice','control.restoreNotVerified','control.independentChannel','control.needsAttention']
for (const locale of ['en','zh','zh-TW','ja','ko','th','es']) {
 const dictionary=JSON.parse(read(`../src/locales/${locale}/dashboard.json`))
 for (const key of keys) assert.equal(typeof dictionary[key], 'string', `${locale}:${key}`)
}
console.log('Control Room contract passed: administrator-only read path, instance binding, bounded no-follow file read, no command API, original logo, historical/restore boundaries and seven locales.')
