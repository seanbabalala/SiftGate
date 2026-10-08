import type { AlertChannelConfig, AlertConnectorType, AlertEventType } from '../config/gateway.config';
export const CONNECTOR_TYPES: readonly AlertConnectorType[];
export const ALERT_EVENTS: readonly AlertEventType[];
export class ConnectorError extends Error { code: string; http_status?: number; }
export function validateChannel(channel: unknown, options?: { allowReferences?: boolean }): void;
export function buildRequest(channel: AlertChannelConfig, payload: Record<string, unknown>, now?: number): {
  url: string; headers: Record<string, string>; body: Record<string, unknown>;
};
export function sendAlert(channel: AlertChannelConfig, payload: Record<string, unknown>, options?: {
  fetch?: typeof globalThis.fetch; timeoutMs?: number; now?: number;
}): Promise<void>;
export function boundedText(value: unknown, maxBytes?: number): string;
