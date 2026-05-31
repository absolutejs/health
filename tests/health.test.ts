/**
 * Tests for @absolutejs/health.
 */
import { describe, expect, test } from 'bun:test';
import {
	createHealthChecker,
	healthPlugin,
	httpCheck,
	metricsCheck,
	probeCheck,
	type HealthCheckDefinition
} from '../src/index';

// =============================================================================
// createHealthChecker — aggregation, registration, kind filtering
// =============================================================================

describe('createHealthChecker', () => {
	test('all checks pass → aggregate pass', async () => {
		const checker = createHealthChecker({
			checks: [
				{ check: () => ({ status: 'pass' }), name: 'a' },
				{ check: () => ({ status: 'pass' }), name: 'b' }
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.status).toBe('pass');
		expect(Object.keys(envelope.checks).sort()).toEqual(['a', 'b']);
	});

	test('any warn → aggregate warn (not fail)', async () => {
		const checker = createHealthChecker({
			checks: [
				{ check: () => ({ status: 'pass' }), name: 'a' },
				{ check: () => ({ status: 'warn' }), name: 'b' }
			]
		});
		expect((await checker.run('liveness')).status).toBe('warn');
	});

	test('any fail → aggregate fail (even with warns + passes)', async () => {
		const checker = createHealthChecker({
			checks: [
				{ check: () => ({ status: 'pass' }), name: 'a' },
				{ check: () => ({ status: 'warn' }), name: 'b' },
				{ check: () => ({ status: 'fail' }), name: 'c' }
			]
		});
		expect((await checker.run('liveness')).status).toBe('fail');
	});

	test('a thrown check becomes fail with the error message', async () => {
		const checker = createHealthChecker({
			checks: [
				{
					check: () => {
						throw new Error('database unreachable');
					},
					name: 'db'
				}
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.status).toBe('fail');
		expect(envelope.checks.db?.status).toBe('fail');
		expect(envelope.checks.db?.message).toBe('database unreachable');
	});

	test('rejected promises also become fail', async () => {
		const checker = createHealthChecker({
			checks: [
				{
					check: () => Promise.reject(new Error('timeout')),
					name: 'http'
				}
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.checks.http?.status).toBe('fail');
		expect(envelope.checks.http?.message).toBe('timeout');
	});

	test('checks exceeding timeoutMs return fail with a timeout message', async () => {
		const checker = createHealthChecker({
			checks: [
				{
					check: () =>
						new Promise((resolve) => {
							setTimeout(() => resolve({ status: 'pass' }), 200);
						}),
					name: 'slow',
					timeoutMs: 10
				}
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.checks.slow?.status).toBe('fail');
		expect(envelope.checks.slow?.message).toContain('timed out after 10ms');
	});

	test('liveness vs readiness kind filtering', async () => {
		const checker = createHealthChecker({
			checks: [
				{ check: () => ({ status: 'pass' }), kind: 'liveness', name: 'a' },
				{ check: () => ({ status: 'pass' }), kind: 'readiness', name: 'b' },
				{ check: () => ({ status: 'pass' }), kind: 'both', name: 'c' }
			]
		});
		const live = await checker.run('liveness');
		const ready = await checker.run('readiness');
		expect(Object.keys(live.checks).sort()).toEqual(['a', 'c']);
		expect(Object.keys(ready.checks).sort()).toEqual(['b', 'c']);
	});

	test('register / unregister / names', () => {
		const checker = createHealthChecker();
		const def: HealthCheckDefinition = {
			check: () => ({ status: 'pass' }),
			name: 'x'
		};
		checker.register(def);
		expect(checker.names()).toEqual(['x']);
		checker.unregister('x');
		expect(checker.names()).toEqual([]);
	});

	test('register replaces a check with the same name', async () => {
		const checker = createHealthChecker();
		checker.register({ check: () => ({ status: 'pass' }), name: 'x' });
		checker.register({ check: () => ({ status: 'fail' }), name: 'x' });
		const envelope = await checker.run('liveness');
		expect(envelope.checks.x?.status).toBe('fail');
	});

	test('empty checker → envelope status pass', async () => {
		const checker = createHealthChecker();
		const envelope = await checker.run('liveness');
		expect(envelope.status).toBe('pass');
		expect(Object.keys(envelope.checks)).toEqual([]);
	});

	test('latencyMs is non-negative', async () => {
		const checker = createHealthChecker({
			checks: [{ check: () => ({ status: 'pass' }), name: 'a' }]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.checks.a?.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test('clock override is used', async () => {
		let now = 1_000_000;
		const checker = createHealthChecker({
			checks: [{ check: () => ({ status: 'pass' }), name: 'a' }],
			now: () => now
		});
		// Bump time after the run starts to verify the clock is consulted on
		// each call, not just at construction.
		const envelopePromise = checker.run('liveness');
		now = 1_000_005;
		const envelope = await envelopePromise;
		expect(envelope.at).toBe(1_000_000);
	});
});

// =============================================================================
// Convenience factories
// =============================================================================

describe('probeCheck', () => {
	test('resolves → pass', async () => {
		const checker = createHealthChecker({
			checks: [probeCheck('ping', async () => 'ok')]
		});
		expect((await checker.run('liveness')).status).toBe('pass');
	});

	test('rejects → fail with message', async () => {
		const checker = createHealthChecker({
			checks: [
				probeCheck('ping', () => {
					throw new Error('connection refused');
				})
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.checks.ping?.status).toBe('fail');
		expect(envelope.checks.ping?.message).toBe('connection refused');
	});
});

describe('metricsCheck', () => {
	test('exposes the source snapshot to the evaluator', async () => {
		type QueueMetrics = { runs: number; failed: number };
		const source: QueueMetrics = { failed: 2, runs: 100 };
		const checker = createHealthChecker({
			checks: [
				metricsCheck<QueueMetrics>(
					'queue',
					() => source,
					(m) => ({
						observed: { failed: m.failed, runs: m.runs },
						status: m.failed > 10 ? 'warn' : 'pass'
					})
				)
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.checks.queue?.status).toBe('pass');
		expect(envelope.checks.queue?.observed).toEqual({ failed: 2, runs: 100 });
	});

	test('warn threshold trips the aggregate', async () => {
		const checker = createHealthChecker({
			checks: [
				metricsCheck(
					'queue',
					() => ({ failed: 100 }),
					(m) => ({ status: m.failed > 10 ? 'warn' : 'pass' })
				)
			]
		});
		expect((await checker.run('liveness')).status).toBe('warn');
	});
});

describe('httpCheck', () => {
	test('2xx response → pass', async () => {
		const fakeFetch = (async () =>
			new Response('ok', { status: 200 })) as unknown as typeof fetch;
		const checker = createHealthChecker({
			checks: [
				httpCheck('upstream', 'http://test.invalid/health', {
					fetch: fakeFetch
				})
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.checks.upstream?.status).toBe('pass');
	});

	test('5xx → fail with status code in observed', async () => {
		const fakeFetch = (async () =>
			new Response('boom', { status: 503 })) as unknown as typeof fetch;
		const checker = createHealthChecker({
			checks: [
				httpCheck('upstream', 'http://test.invalid/health', {
					fetch: fakeFetch
				})
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.checks.upstream?.status).toBe('fail');
		expect(envelope.checks.upstream?.observed?.status).toBe(503);
	});

	test('network rejection → fail (caught by runOne)', async () => {
		const fakeFetch = (async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;
		const checker = createHealthChecker({
			checks: [
				httpCheck('upstream', 'http://test.invalid/health', {
					fetch: fakeFetch
				})
			]
		});
		const envelope = await checker.run('liveness');
		expect(envelope.checks.upstream?.status).toBe('fail');
		expect(envelope.checks.upstream?.message).toBe('ECONNREFUSED');
	});
});

// =============================================================================
// healthPlugin — Elysia integration via injected fake
// =============================================================================

describe('healthPlugin', () => {
	const makeFakeApp = () => {
		const handlers: Record<string, () => Promise<Response> | Response> = {};
		const app = {
			get: (path: string, fn: () => Promise<Response> | Response) => {
				handlers[path] = fn;
				return app;
			}
		};
		return { app, handlers };
	};

	test('registers /healthz + /readyz with default paths', async () => {
		const { app, handlers } = makeFakeApp();
		const checker = createHealthChecker({
			checks: [{ check: () => ({ status: 'pass' }), name: 'a' }]
		});
		await healthPlugin({
			checker,
			makeElysia: () => app
		});
		expect(Object.keys(handlers).sort()).toEqual(['/healthz', '/readyz']);
	});

	test('honors custom paths', async () => {
		const { app, handlers } = makeFakeApp();
		const checker = createHealthChecker();
		await healthPlugin({
			checker,
			livenessPath: '/_alive',
			makeElysia: () => app,
			readinessPath: '/_ready'
		});
		expect(Object.keys(handlers).sort()).toEqual(['/_alive', '/_ready']);
	});

	test('pass → 200 with application/health+json body', async () => {
		const { app, handlers } = makeFakeApp();
		const checker = createHealthChecker({
			checks: [{ check: () => ({ status: 'pass' }), name: 'a' }]
		});
		await healthPlugin({ checker, makeElysia: () => app });
		const response = await handlers['/healthz']!();
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(
			'application/health+json'
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await response.json();
		expect(body.status).toBe('pass');
	});

	test('warn → 200 (not 503)', async () => {
		const { app, handlers } = makeFakeApp();
		const checker = createHealthChecker({
			checks: [{ check: () => ({ status: 'warn' }), name: 'a' }]
		});
		await healthPlugin({ checker, makeElysia: () => app });
		const response = await handlers['/healthz']!();
		expect(response.status).toBe(200);
	});

	test('fail → 503', async () => {
		const { app, handlers } = makeFakeApp();
		const checker = createHealthChecker({
			checks: [{ check: () => ({ status: 'fail' }), name: 'a' }]
		});
		await healthPlugin({ checker, makeElysia: () => app });
		const response = await handlers['/healthz']!();
		expect(response.status).toBe(503);
	});

	test('readyz filters to readiness + both checks', async () => {
		const { app, handlers } = makeFakeApp();
		const checker = createHealthChecker({
			checks: [
				{
					check: () => ({ status: 'fail' }),
					kind: 'liveness',
					name: 'liveness-only-fails'
				},
				{
					check: () => ({ status: 'pass' }),
					kind: 'readiness',
					name: 'readiness-only-passes'
				}
			]
		});
		await healthPlugin({ checker, makeElysia: () => app });
		// /readyz should NOT include `liveness-only-fails` and should be 200.
		const ready = await handlers['/readyz']!();
		expect(ready.status).toBe(200);
		const body = await ready.json();
		expect(Object.keys(body.checks)).toEqual(['readiness-only-passes']);
		// /healthz includes `liveness-only-fails` and should be 503.
		const live = await handlers['/healthz']!();
		expect(live.status).toBe(503);
	});
});
