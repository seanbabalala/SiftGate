import type { Request } from 'express';
import type { CanonicalRequestMetadata } from '../canonical/canonical.types';
import type { GatewayApiKeyContext } from './gateway-api-key.service';

interface MetadataCarrier {
  metadata: CanonicalRequestMetadata;
}

export function gatewayApiKeyFromRequest(req?: Request): GatewayApiKeyContext | undefined {
  if (!req) return undefined;
  return (req as unknown as Record<string, unknown>).gatewayApiKey as
    | GatewayApiKeyContext
    | undefined;
}

export function attachGatewayApiKeyMetadata<T extends MetadataCarrier>(
  canonical: T,
  gatewayKey: GatewayApiKeyContext | undefined,
): T {
  canonical.metadata.api_key_name = gatewayKey?.name;
  canonical.metadata.api_key_id = gatewayKey?.id;
  canonical.metadata.workspace_id = gatewayKey?.workspace_id || null;
  canonical.metadata.namespace_id = gatewayKey?.namespace_id || null;
  canonical.metadata.namespace_name = gatewayKey?.namespace_name || null;
  canonical.metadata.team_id = gatewayKey?.team_id || null;
  canonical.metadata.team_name = gatewayKey?.team_name || null;
  canonical.metadata.api_key_model_routes = gatewayKey?.model_routes?.length ? gatewayKey.model_routes : undefined;
  canonical.metadata.api_key_permissions = gatewayKey
    ? {
        allow_auto: gatewayKey.allow_auto,
        allow_direct: gatewayKey.allow_direct,
        allowed_nodes: gatewayKey.allowed_nodes,
        allowed_models: gatewayKey.allowed_models,
        allowed_endpoints: gatewayKey.allowed_endpoints,
        allowed_modalities: gatewayKey.allowed_modalities,
      }
    : undefined;
  return canonical;
}
