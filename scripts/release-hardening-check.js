#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const frontendRoot = path.join(root, 'frontend');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const includeDocker = args.has('--include-docker') || truthy(process.env.SIFTGATE_RELEASE_INCLUDE_DOCKER);
const includePostgres = args.has('--include-postgres') || truthy(process.env.SIFTGATE_RELEASE_INCLUDE_POSTGRES);

if (args.has('--help') || args.has('-h')) {
  printHelp();
  process.exit(0);
}

for (const arg of args) {
  if (!['--dry-run', '--include-docker', '--include-postgres', '--help', '-h'].includes(arg)) {
    fail(`Unknown argument: ${arg}`);
  }
}

const steps = [
  step('Node runtime policy', [npm, 'run', 'runtime:check']),
  step('Public repository boundary', [npm, 'run', 'public:check']),
  step('Documentation links and safety scan', [npm, 'run', 'docs:check']),
  step('Zero-warning backend/script lint', [npm, 'run', 'lint']),
  step('Backend and runtime plugin build', [npm, 'run', 'build']),
  step('Backend unit tests', [npm, 'test', '--', '--runInBand']),
  step('Backend e2e tests', [npm, 'run', 'test:e2e']),
  step('Example config validation', [npm, 'run', 'validate:config', '--', '--config', 'gateway.config.example.yaml']),
  step('Kubernetes manifest validation', [npm, 'run', 'validate:k8s']),
  step('Release metadata sync', [npm, 'run', 'release:check']),
  step('Provider registry validation', [npm, 'run', 'provider-registry:check']),
  step('Production dependency audit', [npm, 'audit', '--omit=dev', '--audit-level=critical']),
  step('TypeScript SDK build', [npm, 'run', 'build:sdk']),
  step('TypeScript SDK tests', [npm, 'run', 'test:sdk']),
  step('TypeScript SDK typecheck', [npm, 'run', 'typecheck:sdk']),
  step('Python SDK tests', [npm, 'run', 'test:python-sdk']),
  step('Frontend checks', [npm, 'test'], { cwd: frontendRoot }),
  step('Frontend build and bundle budget', [npm, 'run', 'build'], { cwd: frontendRoot }),
];

if (includeDocker) {
  steps.push(step('Optional Docker smoke', [npm, 'run', 'smoke:docker']));
}

if (includePostgres) {
  if (!process.env.SIFTGATE_TEST_POSTGRES_URL && !dryRun) {
    fail('SIFTGATE_TEST_POSTGRES_URL is required when --include-postgres is set.');
  }
  steps.push(step(
    'Optional PostgreSQL budget row-lock smoke',
    [npm, 'run', 'test:postgres-budget-smoke'],
    {
      env: {
        ...process.env,
        SIFTGATE_RUN_DATABASE_URL_INTEGRATION_TESTS: 'true',
      },
    },
  ));
}

if (dryRun) {
  console.log('Release hardening dry run. Commands that would run:');
  for (const [index, item] of steps.entries()) {
    console.log(`${index + 1}. ${item.name}`);
    console.log(`   cwd: ${path.relative(root, item.cwd) || '.'}`);
    console.log(`   ${shellLine(item.command)}`);
  }
  if (!includeDocker) {
    console.log('Optional Docker smoke skipped. Add --include-docker or SIFTGATE_RELEASE_INCLUDE_DOCKER=1 to include it.');
  }
  if (!includePostgres) {
    console.log('Optional PostgreSQL smoke skipped. Add --include-postgres or SIFTGATE_RELEASE_INCLUDE_POSTGRES=1 to include it.');
  }
  process.exit(0);
}

console.log(`Running ${steps.length} release hardening checks...`);
for (const [index, item] of steps.entries()) {
  console.log(`\n[${index + 1}/${steps.length}] ${item.name}`);
  console.log(`cwd: ${path.relative(root, item.cwd) || '.'}`);
  console.log(`$ ${shellLine(item.command)}`);

  const result = spawnSync(item.command[0], item.command.slice(1), {
    cwd: item.cwd,
    env: item.env,
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`${item.name} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${item.name} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

console.log('\nRelease hardening checks passed.');

function step(name, command, options = {}) {
  return {
    name,
    command,
    cwd: options.cwd || root,
    env: options.env || process.env,
  };
}

function shellLine(command) {
  return command.map((part) => {
    if (/^[A-Za-z0-9_./:=@-]+$/.test(part)) return part;
    return JSON.stringify(part);
  }).join(' ');
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function fail(message) {
  console.error(`release-hardening-check: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: npm run release:hardening -- [--dry-run] [--include-docker] [--include-postgres]

Runs the repeatable release hardening gate for the OSS data plane.

Options:
  --dry-run           Print the commands without running them.
  --include-docker    Also run npm run smoke:docker.
  --include-postgres  Also run npm run test:postgres-budget-smoke.

Environment:
  SIFTGATE_RELEASE_INCLUDE_DOCKER=1      Include Docker smoke.
  SIFTGATE_RELEASE_INCLUDE_POSTGRES=1    Include PostgreSQL smoke.
  SIFTGATE_TEST_POSTGRES_URL=...         Required with --include-postgres.
`);
}
