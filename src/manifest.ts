import { defineManifest, toolFactory } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type {
	HealthChecker,
	HealthCheckerOptions,
	HealthPluginOptions
} from './index';

const tool = toolFactory<HealthChecker>();

/* Serializable subset of the checker + plugin options. `checks` (probe
 * functions), `now`, `makeElysia`, and the `checker` instance itself are
 * function/instance-valued → wiring concerns. */
export const manifest = defineManifest<
	HealthCheckerOptions & HealthPluginOptions,
	HealthChecker
>()({
	contract: 1,
	identity: {
		accent: '#22c55e',
		category: 'observability',
		description:
			'Liveness (`/healthz`) and readiness (`/readyz`) probes behind one Elysia plugin. `createHealthChecker` composes named checks with per-check timeouts; the response envelope follows the IETF health-check JSON draft and Kubernetes conventions (200 for pass/warn, 503 for fail).',
		docsUrl: 'https://github.com/absolutejs/health',
		name: '@absolutejs/health',
		tagline: 'Let load balancers and monitors ask your site if it is healthy.'
	},
	requires: {
		peers: [{ name: 'elysia', range: '>= 1.4.0', reason: 'plugin host' }]
	},
	settings: Type.Object({
		defaultTimeoutMs: Type.Optional(
			Type.Integer({
				description:
					'How long one check may take before it counts as failed, in milliseconds. Default is 2000. Checks can override it individually.',
				minimum: 1,
				title: 'Check timeout (ms)'
			})
		),
		livenessPath: Type.Optional(
			Type.String({
				description:
					'Address of the "is this process alive?" endpoint, used by orchestrators to decide when to restart. Default is /healthz.',
				examples: ['/healthz'],
				title: 'Liveness address'
			})
		),
		readinessPath: Type.Optional(
			Type.String({
				description:
					'Address of the "can this instance serve traffic right now?" endpoint, used by load balancers to route requests. Default is /readyz.',
				examples: ['/readyz'],
				title: 'Readiness address'
			})
		)
	}),
	tools: {
		list_health_checks: tool.runtime({
			annotations: { readOnlyHint: true },
			description: 'List the names of the registered health checks.',
			handler: (_input, checker) => {
				const names = checker.names();

				return names.length === 0
					? 'no health checks registered'
					: JSON.stringify(names);
			},
			input: Type.Object({})
		}),
		run_health_checks: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'Run the registered health checks and report each check’s status, latency, and details plus the aggregate (worst-of-any) status.',
			handler: async ({ kind }, checker) =>
				JSON.stringify(await checker.run(kind)),
			input: Type.Object({
				kind: Type.Optional(
					Type.Union(
						[
							Type.Literal('liveness'),
							Type.Literal('readiness'),
							Type.Literal('both')
						],
						{
							default: 'both',
							description:
								'Which probe set to run. Default runs every check.'
						}
					)
				)
			})
		})
	},
	wiring: [
		{
			description:
				'Adds /healthz and /readyz endpoints that report pass, warn, or fail for every registered check.',
			id: 'default',
			server: {
				code: [
					'.use(',
					'\tawait healthPlugin({',
					'\t\tchecker: createHealthChecker({',
					'\t\t\tchecks: [',
					'\t\t\t\t// TODO: add real checks for your dependencies',
					'\t\t\t\t// (database, queue, upstream APIs).',
					"\t\t\t\tprobeCheck('self', () => true)",
					'\t\t\t],',
					'\t\t\tdefaultTimeoutMs: ${settings.defaultTimeoutMs}',
					'\t\t}),',
					'\t\tlivenessPath: ${settings.livenessPath},',
					'\t\treadinessPath: ${settings.readinessPath}',
					'\t})',
					')'
				].join('\n'),
				imports: [
					{
						from: '@absolutejs/health',
						names: [
							'createHealthChecker',
							'healthPlugin',
							'probeCheck'
						]
					}
				],
				placement: 'server-plugin'
			},
			title: 'Health endpoints for orchestrators and load balancers'
		}
	]
});
