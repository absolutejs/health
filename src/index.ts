/**
 * @absolutejs/health — liveness + readiness probes for the
 * AbsoluteJS substrate.
 *
 * Two endpoints behind one Elysia plugin:
 *
 *   - `GET /healthz` (liveness): is this process alive at all? Used
 *     by orchestrators (Kubernetes, systemd, runtime supervisors)
 *     to decide when to restart a container.
 *   - `GET /readyz` (readiness): can this instance serve traffic
 *     RIGHT NOW? Used by load balancers to decide when to route
 *     requests. Returning false while liveness still passes is the
 *     "drain me but don't kill me" state.
 *
 * Body shape (compatible with the IETF health-check JSON draft +
 * Kubernetes conventions):
 *
 *   { status: "pass" | "warn" | "fail", checks: { name: { status, ...details } } }
 *
 * Status codes: 200 for `pass` / `warn`, 503 for `fail`. Load
 * balancers route on the HTTP status; humans + dashboards read the
 * body.
 */

// =============================================================================
// Types
// =============================================================================

export type HealthStatus = 'pass' | 'warn' | 'fail';

export type HealthKind = 'liveness' | 'readiness' | 'both';

export type CheckResult = {
	status: HealthStatus;
	/** Human-readable detail surfaced in the JSON body. */
	message?: string;
	/** Free-form structured data (latency, queue depth, etc.). */
	observed?: Record<string, unknown>;
};

export type HealthCheckDefinition = {
	name: string;
	/** Default `'both'` — runs under both `/healthz` and `/readyz`. */
	kind?: HealthKind;
	/** Hard ceiling per check. Default 2000 ms. */
	timeoutMs?: number;
	/** The actual probe. May be sync or async. Throwing → status `'fail'`. */
	check: () => CheckResult | Promise<CheckResult>;
};

export type HealthEnvelope = {
	status: HealthStatus;
	/**
	 * Per-check results keyed by name. Each carries its own status +
	 * latency-ms + optional message / observed fields.
	 */
	checks: Record<
		string,
		CheckResult & {
			latencyMs: number;
		}
	>;
	/** Wall-clock at which this envelope was produced (ms since epoch). */
	at: number;
};

export type HealthChecker = {
	/** Add a check after construction. Replacing by name is supported. */
	register: (check: HealthCheckDefinition) => void;
	/** Remove a check by name. */
	unregister: (name: string) => void;
	/** Names of currently-registered checks. */
	names: () => string[];
	/**
	 * Run all checks matching `kind` and aggregate. `kind` defaults to
	 * `'liveness'`. Aggregate status is the WORST of any check:
	 * `fail` > `warn` > `pass`.
	 */
	run: (kind?: HealthKind) => Promise<HealthEnvelope>;
};

// =============================================================================
// createHealthChecker
// =============================================================================

const WORSE_THAN: Record<HealthStatus, number> = {
	fail: 2,
	pass: 0,
	warn: 1
};

const aggregate = (results: ReadonlyArray<HealthStatus>): HealthStatus => {
	let worst: HealthStatus = 'pass';
	for (const status of results) {
		if (WORSE_THAN[status] > WORSE_THAN[worst]) worst = status;
	}
	return worst;
};

const matchesKind = (check: HealthCheckDefinition, kind: HealthKind): boolean => {
	const checkKind = check.kind ?? 'both';
	if (checkKind === 'both') return true;
	if (kind === 'both') return true;
	return checkKind === kind;
};

export type HealthCheckerOptions = {
	checks?: ReadonlyArray<HealthCheckDefinition>;
	/** Default 2000 ms — applies to checks that don't set their own. */
	defaultTimeoutMs?: number;
	/** Override clock for deterministic tests. */
	now?: () => number;
};

const runOne = async (
	check: HealthCheckDefinition,
	defaultTimeout: number,
	now: () => number
): Promise<{ name: string; result: CheckResult & { latencyMs: number } }> => {
	const started = now();
	const timeout = check.timeoutMs ?? defaultTimeout;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<CheckResult>((resolve) => {
		timer = setTimeout(() => {
			resolve({
				message: `check timed out after ${timeout}ms`,
				status: 'fail'
			});
		}, timeout);
	});
	let result: CheckResult;
	try {
		const probe = Promise.resolve().then(() => check.check());
		result = await Promise.race([probe, timeoutPromise]);
	} catch (error) {
		result = {
			message: error instanceof Error ? error.message : String(error),
			status: 'fail'
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	return {
		name: check.name,
		result: { ...result, latencyMs: now() - started }
	};
};

export const createHealthChecker = (
	options: HealthCheckerOptions = {}
): HealthChecker => {
	const defaultTimeout = options.defaultTimeoutMs ?? 2000;
	const now = options.now ?? Date.now;
	const checks = new Map<string, HealthCheckDefinition>();
	for (const check of options.checks ?? []) checks.set(check.name, check);

	return {
		names: () => [...checks.keys()],
		register: (check) => {
			checks.set(check.name, check);
		},
		run: async (kind = 'liveness') => {
			const at = now();
			const selected = [...checks.values()].filter((c) => matchesKind(c, kind));
			const results = await Promise.all(
				selected.map((c) => runOne(c, defaultTimeout, now))
			);
			const envelope: HealthEnvelope = {
				at,
				checks: {},
				status: aggregate(results.map((r) => r.result.status))
			};
			for (const { name, result } of results) envelope.checks[name] = result;
			return envelope;
		},
		unregister: (name) => {
			checks.delete(name);
		}
	};
};

// =============================================================================
// Convenience: built-in check factories
// =============================================================================

/**
 * Wrap an arbitrary `() => Promise<unknown>` into a check. Resolves
 * → `pass`; rejects → `fail` with the error message.
 */
export const probeCheck = (
	name: string,
	probe: () => Promise<unknown> | unknown,
	options: Omit<HealthCheckDefinition, 'name' | 'check'> = {}
): HealthCheckDefinition => ({
	check: async () => {
		await probe();
		return { status: 'pass' };
	},
	name,
	...options
});

/**
 * Build a check from a substrate package's `metrics()` snapshot.
 * Pass a predicate that returns `pass` / `warn` / `fail` plus an
 * optional message.
 *
 * @example
 *   metricsCheck('queue', () => worker.metrics(), (m) => ({
 *     status: m.failed > 100 ? 'warn' : 'pass',
 *     observed: { failed: m.failed, runs: m.runs },
 *   }))
 */
export const metricsCheck = <M>(
	name: string,
	source: () => M | Promise<M>,
	evaluate: (
		snapshot: M
	) => CheckResult | Promise<CheckResult>,
	options: Omit<HealthCheckDefinition, 'name' | 'check'> = {}
): HealthCheckDefinition => ({
	check: async () => {
		const snapshot = await source();
		return evaluate(snapshot);
	},
	name,
	...options
});

/**
 * HTTP probe — `pass` if the URL returns 2xx within `timeoutMs`,
 * `fail` otherwise. Useful for downstream-dependency checks
 * (database HTTP gateway, OTLP collector, etc.).
 */
export const httpCheck = (
	name: string,
	url: string,
	options: Omit<HealthCheckDefinition, 'name' | 'check'> & {
		fetch?: typeof fetch;
	} = {}
): HealthCheckDefinition => {
	const f = options.fetch ?? fetch;
	const checkOpts: Omit<HealthCheckDefinition, 'name' | 'check'> = {};
	if (options.kind !== undefined) checkOpts.kind = options.kind;
	if (options.timeoutMs !== undefined) checkOpts.timeoutMs = options.timeoutMs;
	return {
		check: async () => {
			const response = await f(url);
			if (response.ok) {
				return {
					observed: { status: response.status, url },
					status: 'pass'
				};
			}
			return {
				message: `${url} returned ${response.status}`,
				observed: { status: response.status, url },
				status: 'fail'
			};
		},
		name,
		...checkOpts
	};
};

// =============================================================================
// Elysia plugin
// =============================================================================

type ElysiaLike = {
	get: (path: string, handler: () => Promise<Response> | Response) => ElysiaLike;
};

export type HealthPluginOptions = {
	checker: HealthChecker;
	/** Liveness endpoint path. Default `/healthz`. */
	livenessPath?: string;
	/** Readiness endpoint path. Default `/readyz`. */
	readinessPath?: string;
	/** Inject a fake Elysia (tests). */
	makeElysia?: () => ElysiaLike;
};

const statusCode = (status: HealthStatus): number =>
	status === 'fail' ? 503 : 200;

export const healthPlugin = async (
	options: HealthPluginOptions
): Promise<ElysiaLike> => {
	const livenessPath = options.livenessPath ?? '/healthz';
	const readinessPath = options.readinessPath ?? '/readyz';

	let app: ElysiaLike;
	if (options.makeElysia !== undefined) {
		app = options.makeElysia();
	} else {
		const mod = (await import('elysia')) as {
			Elysia: new (init?: { name?: string }) => ElysiaLike;
		};
		app = new mod.Elysia({ name: '@absolutejs/health' });
	}

	const handler = (kind: HealthKind) => async (): Promise<Response> => {
		const envelope = await options.checker.run(kind);
		return new Response(JSON.stringify(envelope), {
			headers: {
				'cache-control': 'no-store',
				'content-type': 'application/health+json'
			},
			status: statusCode(envelope.status)
		});
	};

	app.get(livenessPath, handler('liveness'));
	app.get(readinessPath, handler('readiness'));
	return app;
};
