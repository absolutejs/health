import { Elysia } from 'elysia';
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
// Real Elysia integration: mount, route, status, headers, and check filtering.
describe('healthPlugin', () => {
	test('mounts directly with default paths', async () => {
		const app = new Elysia().use(
			await healthPlugin({ checker: createHealthChecker() })
		);
		for (const path of ['/healthz', '/readyz']) {
			const response = await app.handle(new Request(`http://localhost${path}`));
			expect(response.status).toBe(200);
			expect((await response.json()).status).toBe('pass');
		}
	});
	test('honors custom paths without installing the defaults', async () => {
		const app = new Elysia().use(
			await healthPlugin({
				checker: createHealthChecker(),
				livenessPath: '/_alive',
				readinessPath: '/_ready'
			})
		);
		expect(
			(await app.handle(new Request('http://localhost/_alive'))).status
		).toBe(200);
		expect(
			(await app.handle(new Request('http://localhost/_ready'))).status
		).toBe(200);
		expect(
			(await app.handle(new Request('http://localhost/healthz'))).status
		).toBe(404);
	});
	for (const [health, code] of [
		['pass', 200],
		['warn', 200],
		['fail', 503]
	] as const) {
		test(`${health} produces HTTP ${code} with health headers`, async () => {
			const checker = createHealthChecker({
				checks: [{ name: 'fixture', check: () => ({ status: health }) }]
			});
			const app = new Elysia().use(await healthPlugin({ checker }));
			const response = await app.handle(
				new Request('http://localhost/healthz')
			);
			expect(response.status).toBe(code);
			expect(response.headers.get('content-type')).toBe(
				'application/health+json'
			);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect((await response.json()).status).toBe(health);
		});
	}
	test('readiness and liveness run only their matching checks', async () => {
		const checker = createHealthChecker({
			checks: [
				{ name: 'live', kind: 'liveness', check: () => ({ status: 'fail' }) },
				{ name: 'ready', kind: 'readiness', check: () => ({ status: 'pass' }) }
			]
		});
		const app = new Elysia().use(await healthPlugin({ checker }));
		const ready = await app.handle(new Request('http://localhost/readyz'));
		expect(ready.status).toBe(200);
		expect(Object.keys((await ready.json()).checks)).toEqual(['ready']);
		expect(
			(await app.handle(new Request('http://localhost/healthz'))).status
		).toBe(503);
	});
});
