import type { AlertConnectorType, AlertEventType } from '../config/gateway.config';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface GatewayAlertEvent {
  type: AlertEventType;
  severity: AlertSeverity;
  message: string;
  timestamp?: string;
  dedupeKey?: string;
  details?: Record<string, unknown>;
}

export type AlertDeliveryState = 'queued' | 'sent' | 'failed' | 'debounced';

export interface AlertDeliveryStatus {
  id: string;
  event: AlertEventType;
  severity: AlertSeverity;
  channel: string;
  channel_id?: string;
  status: AlertDeliveryState;
  attempts: number;
  timestamp: string;
  message: string;
  dedupe_key: string | null;
  last_error: string | null;
  sent_at: string | null;
}

export interface AlertChannelStatus {
  name: string;
  type: AlertConnectorType;
  events: AlertEventType[];
  last_status: AlertDeliveryState | null;
  last_error: string | null;
  last_event: AlertEventType | null;
  last_sent_at: string | null;
}

export interface AlertsDashboardSnapshot {
  enabled: boolean;
  configured_channels: number;
  channels: AlertChannelStatus[];
  recent: AlertDeliveryStatus[];
}
