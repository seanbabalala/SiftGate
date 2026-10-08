import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface K8sValidationResult {
  errors: string[];
  warnings: string[];
  info: string[];
}

const HELM_CHART_DIR = path.join('deploy', 'helm', 'siftgate');
const K8S_BASE_DIR = path.join('deploy', 'kubernetes', 'base');
const PRIVATE_ASSET_PATTERN = new RegExp(`${'siftgate'}[-_]${'cloud'}|enterprise`, 'i');

const REQUIRED_HELM_FILES = [
  'Chart.yaml',
  'values.yaml',
  'templates/_helpers.tpl',
  'templates/configmap.yaml',
  'templates/deployment.yaml',
  'templates/hpa.yaml',
  'templates/ingress.yaml',
  'templates/pdb.yaml',
  'templates/pvc.yaml',
  'templates/secret.yaml',
  'templates/service.yaml',
  'templates/serviceaccount.yaml',
  'templates/servicemonitor.yaml',
];

const REQUIRED_K8S_FILES = [
  'kustomization.yaml',
  'namespace.yaml',
  'serviceaccount.yaml',
  'secret.example.yaml',
  'configmap.yaml',
  'pvc.yaml',
  'deployment.yaml',
  'service.yaml',
  'ingress.example.yaml',
];

const SECRET_PATTERNS = [
  /\bsk-(?!placeholder|replace)[A-Za-z0-9_-]{12,}\b/g,
  /\bgw_sk_[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
];

export function validateK8sAssets(rootDir = process.cwd()): K8sValidationResult {
  const result: K8sValidationResult = { errors: [], warnings: [], info: [] };
  const helmDir = path.join(rootDir, HELM_CHART_DIR);
  const k8sDir = path.join(rootDir, K8S_BASE_DIR);

  requireFiles(rootDir, HELM_CHART_DIR, REQUIRED_HELM_FILES, result);
  requireFiles(rootDir, K8S_BASE_DIR, REQUIRED_K8S_FILES, result);
  if (result.errors.length > 0) return result;

  const chart = loadYamlFile(path.join(helmDir, 'Chart.yaml'), result, 'Helm Chart.yaml') as Record<string, unknown>;
  const values = loadYamlFile(path.join(helmDir, 'values.yaml'), result, 'Helm values.yaml') as Record<string, unknown>;
  const kustomization = loadYamlFile(path.join(k8sDir, 'kustomization.yaml'), result, 'Kustomization') as Record<string, unknown>;
  const baseConfigMap = firstDoc(path.join(k8sDir, 'configmap.yaml'), result, 'base ConfigMap') as Record<string, unknown>;
  const baseDeployment = firstDoc(path.join(k8sDir, 'deployment.yaml'), result, 'base Deployment') as Record<string, unknown>;
  const baseService = firstDoc(path.join(k8sDir, 'service.yaml'), result, 'base Service') as Record<string, unknown>;
  const baseSecret = firstDoc(path.join(k8sDir, 'secret.example.yaml'), result, 'base Secret example') as Record<string, unknown>;
  const packageVersion = readPackageVersion(rootDir, result);

  if (!chart || !values || !kustomization || !baseConfigMap || !baseDeployment || !baseService || !baseSecret) {
    return result;
  }

  validateHelmMetadata(chart, values, result);
  validateValuesSupport(values, result);
  validateHelmTemplateText(helmDir, result);
  validateKustomizeBase(kustomization, baseConfigMap, baseDeployment, baseService, baseSecret, packageVersion, result);
  validateDefaultGatewayConfig('Helm values config.data', getPath(values, ['config', 'data']), result);
  validateDefaultGatewayConfig(
    'Kubernetes base ConfigMap gateway.config.yaml',
    getPath(baseConfigMap, ['data', 'gateway.config.yaml']),
    result,
  );
  validateSecretLeaks(rootDir, result);

  if (result.errors.length === 0) {
    result.info.push('Kubernetes and Helm deployment assets passed validation.');
  }
  return result;
}

export function findSecretLikeValues(content: string): string[] {
  const matches: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[0]);
    }
  }
  return matches;
}

function requireFiles(
  rootDir: string,
  baseDir: string,
  files: string[],
  result: K8sValidationResult,
): void {
  for (const file of files) {
    const fullPath = path.join(rootDir, baseDir, file);
    if (!fs.existsSync(fullPath)) {
      result.errors.push(`Missing required file: ${path.join(baseDir, file)}`);
    }
  }
}

function loadYamlFile(
  filePath: string,
  result: K8sValidationResult,
  label: string,
): unknown {
  try {
    return yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    result.errors.push(`${label} is not valid YAML: ${(err as Error).message}`);
    return null;
  }
}

function firstDoc(
  filePath: string,
  result: K8sValidationResult,
  label: string,
): unknown {
  try {
    const docs = yaml.loadAll(fs.readFileSync(filePath, 'utf8'));
    if (!docs.length) {
      result.errors.push(`${label} has no YAML documents.`);
      return null;
    }
    return docs[0];
  } catch (err) {
    result.errors.push(`${label} is not valid YAML: ${(err as Error).message}`);
    return null;
  }
}

function readPackageVersion(rootDir: string, result: K8sValidationResult): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version;
    }
    result.errors.push('package.json must declare a release version for Kubernetes image validation.');
  } catch (err) {
    result.errors.push(`package.json is not readable for Kubernetes image validation: ${(err as Error).message}`);
  }
  return 'unknown';
}

function validateHelmMetadata(
  chart: Record<string, unknown>,
  values: Record<string, unknown>,
  result: K8sValidationResult,
): void {
  if (chart.apiVersion !== 'v2') {
    result.errors.push('Helm Chart.yaml must use apiVersion: v2.');
  }
  if (chart.name !== 'siftgate') {
    result.errors.push('Helm chart name must be siftgate.');
  }
  const imageRepo = getPath(values, ['image', 'repository']);
  if (typeof imageRepo !== 'string' || !imageRepo.includes('ai-gateway')) {
    result.errors.push('Helm values image.repository must point at the OSS ai-gateway image.');
  }
  if (typeof imageRepo === 'string' && PRIVATE_ASSET_PATTERN.test(imageRepo)) {
    result.errors.push('Helm values image.repository must not reference Cloud or enterprise images.');
  }
  result.info.push(`Helm chart ${chart.name || 'unknown'} appVersion=${chart.appVersion || 'unknown'}`);
}

function validateValuesSupport(
  values: Record<string, unknown>,
  result: K8sValidationResult,
): void {
  const requiredPaths = [
    ['redis', 'enabled'],
    ['postgres', 'enabled'],
    ['ingress', 'enabled'],
    ['autoscaling', 'enabled'],
    ['podDisruptionBudget', 'enabled'],
    ['serviceMonitor', 'enabled'],
    ['resources'],
    ['persistence', 'enabled'],
    ['secrets', 'existingSecret'],
    ['config', 'existingConfigMap'],
    ['existingSecret'],
    ['existingConfigMap'],
  ];
  for (const keyPath of requiredPaths) {
    if (getPath(values, keyPath) === undefined) {
      result.errors.push(`Helm values missing support for ${keyPath.join('.')}.`);
    }
  }
  if (getPath(values, ['redis', 'enabled']) !== false) {
    result.errors.push('Helm default redis.enabled must be false.');
  }
  if (getPath(values, ['postgres', 'enabled']) !== false) {
    result.errors.push('Helm default postgres.enabled must be false.');
  }
  if (getPath(values, ['ingress', 'enabled']) !== false) {
    result.errors.push('Helm default ingress.enabled must be false.');
  }
  if (getPath(values, ['autoscaling', 'enabled']) !== false) {
    result.errors.push('Helm default autoscaling.enabled must be false.');
  }
}

function validateHelmTemplateText(helmDir: string, result: K8sValidationResult): void {
  const deployment = read(path.join(helmDir, 'templates', 'deployment.yaml'));
  const configmap = read(path.join(helmDir, 'templates', 'configmap.yaml'));
  const secret = read(path.join(helmDir, 'templates', 'secret.yaml'));

  requireText(deployment, 'containerPort:', 'Helm deployment must expose a container port.', result);
  requireText(deployment, 'GATEWAY_CONFIG_PATH', 'Helm deployment must set GATEWAY_CONFIG_PATH.', result);
  requireText(deployment, '.Values.config.mountPath', 'Helm deployment must mount configurable gateway config path.', result);
  requireText(deployment, 'path: /ready', 'Helm readinessProbe must use /ready.', result);
  requireText(deployment, 'path: /live', 'Helm livenessProbe must use /live.', result);
  requireText(deployment, 'persistentVolumeClaim', 'Helm deployment must mount the SQLite data PVC when persistence is enabled.', result);
  requireText(configmap, '.Values.config.data', 'Helm ConfigMap must render config.data.', result);
  requireText(secret, 'stringData:', 'Helm Secret template must use stringData placeholders/values.', result);
}

function validateKustomizeBase(
  kustomization: Record<string, unknown>,
  configMap: Record<string, unknown>,
  deployment: Record<string, unknown>,
  service: Record<string, unknown>,
  secret: Record<string, unknown>,
  expectedImageTag: string,
  result: K8sValidationResult,
): void {
  const resources = new Set(
    Array.isArray(kustomization.resources)
      ? kustomization.resources.filter((item): item is string => typeof item === 'string')
      : [],
  );
  for (const required of [
    'namespace.yaml',
    'serviceaccount.yaml',
    'secret.example.yaml',
    'configmap.yaml',
    'pvc.yaml',
    'deployment.yaml',
    'service.yaml',
  ]) {
    if (!resources.has(required)) {
      result.errors.push(`Kustomization missing resource ${required}.`);
    }
  }

  if (configMap.kind !== 'ConfigMap') result.errors.push('base/configmap.yaml must be a ConfigMap.');
  if (deployment.kind !== 'Deployment') result.errors.push('base/deployment.yaml must be a Deployment.');
  if (service.kind !== 'Service') result.errors.push('base/service.yaml must be a Service.');
  if (secret.kind !== 'Secret') result.errors.push('base/secret.example.yaml must be a Secret.');

  const container = getPath(deployment, ['spec', 'template', 'spec', 'containers', 0]) as Record<string, unknown> | undefined;
  if (!container) {
    result.errors.push('Kubernetes base Deployment must define a siftgate container.');
    return;
  }
  if (container.name !== 'siftgate') {
    result.errors.push('Kubernetes base container name must be siftgate.');
  }
  const image = container.image;
  if (typeof image !== 'string' || !image.includes(`ai-gateway:${expectedImageTag}`)) {
    result.errors.push(`Kubernetes base image must reference the OSS ai-gateway:${expectedImageTag} image.`);
  }
  if (typeof image === 'string' && PRIVATE_ASSET_PATTERN.test(image)) {
    result.errors.push('Kubernetes base image must not reference Cloud or enterprise images.');
  }
  const ports = Array.isArray(container.ports) ? container.ports : [];
  if (!ports.some((port) => (port as Record<string, unknown>).containerPort === 2099)) {
    result.errors.push('Kubernetes base container must expose port 2099.');
  }
  const env = Array.isArray(container.env) ? container.env : [];
  if (!env.some((item) => (item as Record<string, unknown>).name === 'GATEWAY_CONFIG_PATH')) {
    result.errors.push('Kubernetes base container must set GATEWAY_CONFIG_PATH.');
  }
  const mounts = Array.isArray(container.volumeMounts) ? container.volumeMounts : [];
  if (!mounts.some((mount) => (mount as Record<string, unknown>).mountPath === '/app/config/gateway.config.yaml')) {
    result.errors.push('Kubernetes base must mount gateway.config.yaml at /app/config/gateway.config.yaml.');
  }
  if (!mounts.some((mount) => (mount as Record<string, unknown>).mountPath === '/app/data')) {
    result.errors.push('Kubernetes base must mount /app/data for SQLite persistence.');
  }
  const readinessPath = getPath(container, ['readinessProbe', 'httpGet', 'path']);
  if (readinessPath !== '/ready') {
    result.errors.push('Kubernetes base readinessProbe must use /ready.');
  }
  const livenessPath = getPath(container, ['livenessProbe', 'httpGet', 'path']);
  if (livenessPath !== '/live') {
    result.errors.push('Kubernetes base livenessProbe must use /live.');
  }
  const servicePorts = Array.isArray(getPath(service, ['spec', 'ports']))
    ? (getPath(service, ['spec', 'ports']) as unknown[])
    : [];
  if (!servicePorts.some((port) => (port as Record<string, unknown>).port === 2099)) {
    result.errors.push('Kubernetes base Service must expose port 2099.');
  }
  const secretData = getPath(secret, ['stringData']);
  if (!secretData || typeof secretData !== 'object') {
    result.errors.push('Kubernetes base Secret example must use stringData placeholders.');
  }
}

function validateDefaultGatewayConfig(
  label: string,
  rawConfig: unknown,
  result: K8sValidationResult,
): void {
  if (typeof rawConfig !== 'string' || rawConfig.trim().length === 0) {
    result.errors.push(`${label} must contain gateway.config.yaml data.`);
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = yaml.load(rawConfig) as Record<string, unknown>;
  } catch (err) {
    result.errors.push(`${label} embedded gateway config is invalid YAML: ${(err as Error).message}`);
    return;
  }
  if (getPath(config, ['database', 'type']) !== 'sqlite') {
    result.errors.push(`${label} must default to database.type=sqlite.`);
  }
  if (getPath(config, ['database', 'path']) !== '/app/data/gateway.db') {
    result.errors.push(`${label} must persist SQLite at /app/data/gateway.db.`);
  }
  if (getPath(config, ['state', 'backend']) !== 'memory') {
    result.errors.push(`${label} must default to state.backend=memory.`);
  }
  if (getPath(config, ['cluster', 'enabled']) !== false) {
    result.errors.push(`${label} must default to cluster.enabled=false.`);
  }
  if (getPath(config, ['realtime', 'enabled']) !== false) {
    result.errors.push(`${label} must keep realtime disabled by default.`);
  }
  if (getPath(config, ['control_plane', 'enabled']) === true) {
    result.errors.push(`${label} must not enable control_plane by default.`);
  }
  if (PRIVATE_ASSET_PATTERN.test(rawConfig)) {
    result.errors.push(`${label} must not reference Cloud or enterprise assets.`);
  }
  result.info.push(`${label} defaults to SQLite + memory state.`);
}

function validateSecretLeaks(rootDir: string, result: K8sValidationResult): void {
  const files = [
    path.join(HELM_CHART_DIR, 'values.yaml'),
    path.join(HELM_CHART_DIR, 'templates', 'secret.yaml'),
    path.join(K8S_BASE_DIR, 'secret.example.yaml'),
    path.join(K8S_BASE_DIR, 'configmap.yaml'),
  ];
  for (const relative of files) {
    const fullPath = path.join(rootDir, relative);
    const content = read(fullPath);
    const leaks = findSecretLikeValues(content);
    if (leaks.length > 0) {
      result.errors.push(`${relative} contains secret-like value(s): ${leaks.join(', ')}`);
    }
  }
}

function requireText(
  content: string,
  needle: string,
  message: string,
  result: K8sValidationResult,
): void {
  if (!content.includes(needle)) {
    result.errors.push(message);
  }
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function getPath(value: unknown, keyPath: Array<string | number>): unknown {
  let current = value as Record<string, unknown> | unknown[] | undefined;
  for (const key of keyPath) {
    if (current == null) return undefined;
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[key] as Record<string, unknown> | unknown[] | undefined;
      continue;
    }
    if (typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key] as Record<string, unknown> | unknown[] | undefined;
  }
  return current;
}

function main(): void {
  const result = validateK8sAssets();
  for (const line of result.info) console.log(`info: ${line}`);
  for (const line of result.warnings) console.warn(`warning: ${line}`);
  for (const line of result.errors) console.error(`error: ${line}`);
  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
