import type { AlertEventType } from './api'

export type AlertConnectorType = 'webhook' | 'feishu' | 'wecom' | 'telegram'
export interface AlertConnector {
  id: string
  name: string
  type: AlertConnectorType
  enabled: boolean
  destination: string
  events: AlertEventType[]
  debounce_seconds: number
  retry: { attempts?: number; timeout_ms?: number; backoff_ms?: number }
  configured: Record<'url' | 'bot_token' | 'chat_id' | 'signing_secret' | 'headers', boolean>
}
export interface AlertConnectorSettings {
  enabled: boolean
  revision: string
  scope: 'gateway'
  connector_types: AlertConnectorType[]
  event_types: AlertEventType[]
  channels: AlertConnector[]
  watchdog: { configured: boolean; synchronized: boolean; last_synced_at: string | null; error: string | null }
}
export interface AlertConnectorInput {
  type?: AlertConnectorType
  name?: string
  enabled?: boolean
  url?: string
  bot_token?: string
  chat_id?: string
  signing_secret?: string | null
  headers?: Record<string, string> | null
  events?: AlertEventType[]
  debounce_seconds?: number
  retry?: { attempts: number; timeout_ms: number; backoff_ms: number }
}
export interface AlertConnectorTestResult {
  status: 'sent' | 'failed'
  delivery_id: string
  error_code: string | null
  sent_at: string | null
}
