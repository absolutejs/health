# @absolutejs/health changelog

## 0.1.0 — 2026-05-31

Initial release. Closes the first half of G12 from the second-pass
PaaS audit — the substrate now has standard liveness + readiness
probes.

### Added

- **`createHealthChecker({ checks, defaultTimeoutMs, now })`** —
  composes named health checks; supports runtime
  `register / unregister`. Aggregate status is the worst of any
  (`fail > warn > pass`).
- **`healthPlugin({ checker, livenessPath, readinessPath })`** —
  Elysia plugin (peer dep optional). `GET /healthz` runs liveness
  + both-kind checks; `GET /readyz` runs readiness + both-kind.
  200 for `pass`/`warn`, 503 for `fail`. `application/health+json`
  content type, `cache-control: no-store`.
- **Per-check timeout** with a `'fail'` envelope on overrun
  (default 2000 ms).
- **`probeCheck`** — wrap any `() => Promise<unknown>`; resolves →
  pass, throws → fail.
- **`metricsCheck`** — read a substrate package's `metrics()` and
  decide pass/warn/fail with the snapshot in `observed`.
- **`httpCheck`** — `GET url` and grade by HTTP status; injectable
  `fetch` for testing.

### Body shape

```json
{
  "status": "pass",
  "at": 1700000000000,
  "checks": {
    "queue": { "status": "pass", "latencyMs": 1, "observed": {} }
  }
}
```

Compatible with the IETF health-check JSON draft + Kubernetes
`/livez` / `/readyz` conventions.

### Tests

25 covering: status aggregation (pass / warn / fail / mixed),
throw-becomes-fail, rejected-promise-becomes-fail, per-check
timeout, liveness/readiness/both kind filtering, register/unregister
+ name-based replacement, empty-checker, clock override; `probeCheck`
(resolve + throw), `metricsCheck` (snapshot exposed, warn threshold),
`httpCheck` (2xx / 5xx / network rejection); plugin path defaults +
custom paths + status code mapping + readyz filtering.

### License

BSL-1.1 with named carveout against hosted uptime / synthetic-
monitoring services. Change date: 2030-05-31 (Apache 2.0).
