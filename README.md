# @absolutejs/health

Liveness + readiness probes for the AbsoluteJS substrate. One Elysia
plugin, two endpoints, a standard JSON envelope that load balancers
and Kubernetes-style orchestrators understand out of the box.

```ts
import { Elysia } from 'elysia';
import {
  createHealthChecker,
  healthPlugin,
  metricsCheck,
  probeCheck,
  httpCheck,
} from '@absolutejs/health';

const checker = createHealthChecker({
  checks: [
    // Synthesis from a substrate package's metrics() snapshot.
    metricsCheck('queue', () => worker.metrics(), (m) => ({
      status: m.failed > 100 ? 'warn' : 'pass',
      observed: { runs: m.runs, failed: m.failed },
    })),

    // Wrap an arbitrary probe.
    probeCheck('postgres', () => pg.query('SELECT 1')),

    // Downstream HTTP dependency.
    httpCheck('otlp-collector', 'http://collector:4318/healthz', {
      kind: 'readiness',  // run only under /readyz
    }),
  ],
});

const app = new Elysia().use(await healthPlugin({ checker }));
// GET /healthz → liveness:  200 / 503 with { status, checks, at }
// GET /readyz  → readiness: same shape, filtered to readiness + both
```

## Two endpoints, two semantics

| Endpoint | Purpose | Used by |
| --- | --- | --- |
| `/healthz` | "Is this process alive?" If `fail`, the orchestrator restarts the container. | Kubernetes liveness probe, systemd `WatchdogSec`, `@absolutejs/runtime` |
| `/readyz` | "Can this instance serve traffic right now?" If `fail`, the LB stops routing to it (but doesn't kill it). | Load balancer health checks, drain workflows |

The distinction matters: a draining instance returns `readyz: fail`
+ `healthz: pass`. The LB stops sending new traffic while in-flight
requests finish.

## Body shape

```json
{
  "status": "pass",
  "at": 1717161600000,
  "checks": {
    "queue": {
      "status": "pass",
      "latencyMs": 1,
      "observed": { "runs": 1057, "failed": 0 }
    },
    "postgres": { "status": "pass", "latencyMs": 12 }
  }
}
```

Compatible with the [IETF health-check JSON
draft](https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check-06)
and the [Kubernetes `livez` /
`readyz`](https://kubernetes.io/docs/reference/using-api/health-checks/)
conventions. `content-type: application/health+json`.

## Status codes

- `pass` → `200 OK`
- `warn` → `200 OK` (don't reroute traffic; surface in your dashboard)
- `fail` → `503 Service Unavailable`

LBs route on status code; humans + dashboards read the body.

## Aggregation

Status is the WORST of any check: `fail > warn > pass`. A single
failing dependency fails the whole envelope — same as Kubernetes
`/healthz` rollup behavior.

## Check factories

- **`probeCheck(name, () => promise)`** — wrap any
  `() => Promise<unknown>`. Resolves → `pass`; throws → `fail` with
  the error message.
- **`metricsCheck(name, () => metrics(), evaluator)`** — read a
  substrate package's `metrics()` and decide pass/warn/fail. Snapshot
  values can land in `observed` for dashboards.
- **`httpCheck(name, url, options?)`** — `GET url` and grade by HTTP
  status. 2xx → `pass`, anything else → `fail`.
- **Roll your own** — any `{ name, check: () => CheckResult |
  Promise<CheckResult> }` works.

## Kind filtering

```ts
{ name: 'shutting-down', kind: 'readiness', check: () => ({
  status: draining ? 'fail' : 'pass'
})}
```

A check's `kind` (`'liveness'` / `'readiness'` / `'both'`, default
`'both'`) controls which endpoint runs it. Run heavy downstream
checks under readiness only; keep liveness limited to "the JS
process is responsive."

## License

BSL-1.1 with named carveout against hosted uptime / synthetic-
monitoring services. Change date: 2030-05-31 (Apache 2.0).
