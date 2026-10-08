'use strict';

// Shared by the Nest service and standalone watchdog. Node built-ins only.
// Copied into dist by the build; do not introduce application dependencies here.
const { createHmac } = require('node:crypto');
const CONNECTOR_TYPES = ['webhook', 'feishu', 'wecom', 'telegram'];
const ALERT_EVENTS = [
  'budget_threshold', 'budget_exceeded', 'node_down', 'node_recovered',
  'circuit_open', 'circuit_close', 'error_spike', 'latency_spike',
  'quality_gate_failed', 'cost_anomaly', 'gateway_unavailable', 'gateway_recovered',
  'gateway_restart_attempt', 'gateway_restart_failed', 'gateway_restart_unhealthy',
  'restart_rate_limited', 'disk_space_low', 'database_size_high',
  'disk_check_failed', 'database_size_check_failed',
];

class ConnectorError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    if (status !== undefined) this.http_status = status;
  }
}

const invalid = (message) => { throw new ConnectorError('invalid_config', message); };
const hasReference = (value) => typeof value === 'string' && /\$\{[^}]+\}/.test(value);

function validateChannel(channel, { allowReferences = false } = {}) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel) || !CONNECTOR_TYPES.includes(channel.type)) {
    invalid('Unsupported alert connector type.');
  }
  if (channel.enabled !== undefined && typeof channel.enabled !== 'boolean') invalid('Connector enabled must be boolean.');
  if (channel.id !== undefined && (typeof channel.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(channel.id))) invalid('Invalid connector id.');
  if (channel.name !== undefined && (typeof channel.name !== 'string' || !channel.name.trim() || channel.name.length > 100)) invalid('Connector name must contain 1–100 characters.');
  for (const key of ['url', 'signing_secret', 'bot_token', 'chat_id']) {
    if (channel[key] !== undefined && (typeof channel[key] !== 'string' || channel[key].length > 4096)) invalid(`Invalid connector ${key}.`);
  }
  if (channel.type === 'telegram') {
    if (!channel.bot_token || (!allowReferences || !hasReference(channel.bot_token)) && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(channel.bot_token)) invalid('A valid Telegram bot token is required.');
    if (!channel.chat_id || (!allowReferences || !hasReference(channel.chat_id)) && !/^(?:-?\d+|@[A-Za-z0-9_]{5,})$/.test(channel.chat_id)) invalid('A Telegram chat id or channel username is required.');
  } else {
    if (!channel.url) invalid('A connector URL is required.');
    if (!(allowReferences && hasReference(channel.url))) {
      let url;
      try { url = new URL(channel.url); } catch { invalid('Invalid connector URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid('Use an HTTP(S) URL without user information or fragments.');
      if (channel.type !== 'webhook' && (url.protocol !== 'https:' || url.port)) invalid('Chat connectors require the official HTTPS endpoint.');
      if (channel.type === 'feishu' && (!['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) ||
        !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(url.pathname) || url.search)) invalid('Use an official Feishu/Lark custom-bot webhook.');
      if (channel.type === 'wecom' && (url.hostname !== 'qyapi.weixin.qq.com' || url.pathname !== '/cgi-bin/webhook/send' ||
        !url.searchParams.get('key') || [...url.searchParams.keys()].some((key) => key !== 'key') || url.searchParams.getAll('key').length !== 1)) invalid('Use an official WeCom message webhook.');
    }
  }
  if (channel.signing_secret && channel.type !== 'feishu') invalid('Signing secrets are supported only by Feishu.');
  if (channel.type !== 'telegram' && (channel.bot_token || channel.chat_id)) invalid('Bot tokens/chat ids are supported only by Telegram.');
  if (channel.type === 'telegram' && channel.url) invalid('Telegram uses a fixed Bot API endpoint, not a custom URL.');
  if (channel.headers !== undefined) {
    if (channel.type !== 'webhook' || !channel.headers || typeof channel.headers !== 'object' || Array.isArray(channel.headers)) invalid('Custom headers are supported only by generic webhooks.');
    if (Object.keys(channel.headers).length > 20) invalid('Too many webhook headers.');
    for (const [name, value] of Object.entries(channel.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || ['host', 'content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase()) ||
          typeof value !== 'string' || !value || value.length > 4096 || /[\r\n]/.test(value)) invalid('Invalid or reserved webhook header.');
    }
  }
  if (channel.events !== undefined && (!Array.isArray(channel.events) || channel.events.length > ALERT_EVENTS.length || channel.events.some((event) => !ALERT_EVENTS.includes(event)))) invalid('Unsupported alert event.');
  if (channel.debounce_seconds !== undefined && (!Number.isFinite(channel.debounce_seconds) || channel.debounce_seconds < 0 || channel.debounce_seconds > 86400)) invalid('Debounce must be between 0 and 86400 seconds.');
  if (channel.retry !== undefined) {
    if (!channel.retry || typeof channel.retry !== 'object' || Array.isArray(channel.retry)) invalid('Invalid retry settings.');
    if (Object.keys(channel.retry).some((key) => !['attempts', 'timeout_ms', 'backoff_ms'].includes(key))) invalid('Unknown retry setting.');
    for (const [key, min, max] of [['attempts', 1, 5], ['timeout_ms', 1, 30000], ['backoff_ms', 0, 30000]]) {
      const value = channel.retry[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) invalid(`Invalid retry ${key}.`);
    }
  }
}

function boundedText(value, maxBytes = 1900) {
  let result = '';
  let bytes = 0;
  for (const character of String(value)) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes - 3) return result + '...';
    result += character;
  }
  return result;
}

function buildRequest(channel, payload, now = Date.now()) {
  validateChannel(channel);
  const text = boundedText(`[SiftGate] ${payload.severity || 'warning'} · ${payload.event}\n${payload.message || payload.event}\n${payload.timestamp || new Date(now).toISOString()}`);
  let url = channel.url;
  let body = payload;
  if (channel.type === 'feishu') {
    body = { msg_type: 'text', content: { text } };
    if (channel.signing_secret) {
      body.timestamp = String(Math.floor(now / 1000));
      body.sign = createHmac('sha256', `${body.timestamp}\n${channel.signing_secret}`).update('').digest('base64');
    }
  } else if (channel.type === 'wecom') {
    body = { msgtype: 'text', text: { content: text } };
  } else if (channel.type === 'telegram') {
    url = `https://api.telegram.org/bot${channel.bot_token}/sendMessage`;
    body = { chat_id: channel.chat_id, text, link_preview_options: { is_disabled: true } };
  }
  return { url, headers: { 'Content-Type': 'application/json', ...(channel.headers || {}) }, body };
}

async function readReceipt(response, signal) {
  // Chat receipts are tiny. Bound response size and never expose vendor body text.
  if (!response.body?.getReader) throw new ConnectorError('invalid_response', 'Connector returned no verifiable receipt.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) throw new ConnectorError('invalid_response', 'Connector receipt exceeded the size limit.');
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid receipt');
    return data;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error.name === 'AbortError' || signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ConnectorError('invalid_response', 'Connector returned an invalid receipt.');
  } finally { await reader.cancel().catch(() => undefined); }
}

async function sendAlert(channel, payload, options = {}) {
  const request = buildRequest(channel, payload, options.now ?? Date.now());
  const timeoutMs = options.timeoutMs ?? channel.retry?.timeout_ms ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await (options.fetch || globalThis.fetch)(request.url, {
      method: 'POST', redirect: 'error', headers: request.headers,
      body: JSON.stringify(request.body), signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new ConnectorError('http_error', `Connector returned HTTP ${Number(response.status)}.`, Number(response.status));
    }
    if (channel.type === 'webhook') { await response.body?.cancel?.(); return; }
    const data = await readReceipt(response, controller.signal);
    const accepted = channel.type === 'telegram' ? data.ok === true
      : channel.type === 'wecom' ? data.errcode === 0
      : (data.code === 0 || data.StatusCode === 0) && (data.code === undefined || data.code === 0) && (data.StatusCode === undefined || data.StatusCode === 0);
    if (!accepted) throw new ConnectorError('rejected', 'The messaging platform rejected the message; check credentials, permissions, and bot security settings.');
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (controller.signal.aborted || error.name === 'AbortError') throw new ConnectorError('timeout', 'Connector request timed out.');
    // Fetch errors can include the Telegram token/secret webhook URL: discard them.
    throw new ConnectorError('network_error', 'Connector connection failed; check network access and TLS.');
  } finally { clearTimeout(timer); }
}

module.exports = { CONNECTOR_TYPES, ALERT_EVENTS, ConnectorError, validateChannel, buildRequest, sendAlert, boundedText };
