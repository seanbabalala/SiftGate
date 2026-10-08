import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const assetsDir = path.join(process.cwd(), 'dist', 'assets')

// Data-router navigation protection adds 17.5 KiB to shared vendor (measured 123.47 KiB).
// The 125 KiB cap replaces 120 KiB; pricing itself stays in a capped lazy route.
const budgets = [
  { label: 'dashboard entry', prefix: 'index-', suffix: '.js', gzipKb: 20 },
  { label: 'React vendor', prefix: 'react-vendor-', suffix: '.js', gzipKb: 70 },
  { label: 'shared vendor', prefix: 'vendor-', suffix: '.js', gzipKb: 125 },
  { label: 'pricing route', prefix: 'pricing-page-', suffix: '.js', gzipKb: 24 },
  { label: 'request cost route', prefix: 'request-cost-page-', suffix: '.js', gzipKb: 8 },
  { label: 'budget recovery route', prefix: 'recovery-page-', suffix: '.js', gzipKb: 12 },
  { label: 'attempt correction route', prefix: 'attempt-correction-page-', suffix: '.js', gzipKb: 12 },
  { label: 'group disposition route', prefix: 'group-disposition-page-', suffix: '.js', gzipKb: 16 },
  { label: 'outcome disposition route', prefix: 'outcome-disposition-page-', suffix: '.js', gzipKb: 12 },
  { label: 'usage recovery route', prefix: 'usage-recovery-page-', suffix: '.js', gzipKb: 12 },
  { label: 'cost report route', prefix: 'cost-report-page-', suffix: '.js', gzipKb: 12 },
  { label: 'admission preview route', prefix: 'admission-preview-page-', suffix: '.js', gzipKb: 12 },
  { label: 'media inventory route', prefix: 'media-tasks-page-', suffix: '.js', gzipKb: 8 },
  { label: 'media task route', prefix: 'media-task-page-', suffix: '.js', gzipKb: 12 },
  { label: 'media disposition route', prefix: 'media-disposition-page-', suffix: '.js', gzipKb: 12 },
  { label: 'media sources route', prefix: 'media-sources-page-', suffix: '.js', gzipKb: 10 },
  { label: 'charts vendor', prefix: 'charts-vendor-', suffix: '.js', gzipKb: 95 },
  { label: 'largest route chunk', prefix: 'NodesPage-', suffix: '.js', gzipKb: 30 },
]

if (!fs.existsSync(assetsDir)) {
  throw new Error('Bundle budget check requires dist/assets. Run `npm run build` first.')
}

const files = fs.readdirSync(assetsDir)
const failures = []
const measured = []

for (const budget of budgets) {
  const file = files.find((candidate) =>
    candidate.startsWith(budget.prefix) && candidate.endsWith(budget.suffix),
  )
  if (!file) {
    failures.push(`${budget.label}: missing ${budget.prefix}*${budget.suffix}`)
    continue
  }
  const body = fs.readFileSync(path.join(assetsDir, file))
  const gzipKb = zlib.gzipSync(body).byteLength / 1024
  measured.push(`${budget.label} ${gzipKb.toFixed(2)} kB gzip <= ${budget.gzipKb} kB`)
  if (gzipKb > budget.gzipKb) {
    failures.push(`${budget.label}: ${gzipKb.toFixed(2)} kB gzip exceeds ${budget.gzipKb} kB (${file})`)
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`Bundle budget failed: ${failure}`)
  }
  process.exit(1)
}

console.log(`Bundle budgets passed: ${measured.join('; ')}.`)
