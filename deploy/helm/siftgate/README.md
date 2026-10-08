# SiftGate Helm Chart

This chart deploys the MIT open-source SiftGate Data Plane only. It does not
install external control-plane components or private images.

## Quickstart

```bash
helm upgrade --install siftgate ./deploy/helm/siftgate \
  --namespace siftgate \
  --create-namespace \
  --set secrets.env.OPENAI_API_KEY="$OPENAI_API_KEY"
```

The default chart runs one pod with SQLite on a PVC and the memory state backend.
Redis, PostgreSQL, Ingress, HPA, PodDisruptionBudget, ServiceMonitor, external
Secrets, external ConfigMaps, resource limits, and persistence are opt-in.

## Production Notes

- Use `existingSecret` or `secrets.existingSecret` for provider keys.
- Use `existingConfigMap` or `config.existingConfigMap` when another controller
  owns `gateway.config.yaml`.
- Switch `config.data.database` to PostgreSQL before setting
  `postgres.enabled=true`.
- Use `/ready` for readiness, `/live` for liveness, and `/health` for monitoring. `/ready`
  checks database availability only; provider degradation stays visible in
  `/health` without evicting pods.
- Switch `config.data.state.backend` to `redis` before setting
  `redis.enabled=true`.
- Keep `realtime.enabled=false` unless your Ingress supports WebSocket upgrades
  and the idle timeout is appropriate for realtime sessions.

Run `npm run validate:k8s` after editing chart or manifest files.
