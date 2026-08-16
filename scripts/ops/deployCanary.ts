/**
 * Canary deploy policy (#10429) — pure planning + verdict logic.
 *
 * Deploying the internal gateway used to be a manual sequence (build → pack → scp →
 * `npm i -g` → `pm2 restart`) with nothing recording what landed and nothing proving the
 * new build served traffic. On 2026-08-14 that shipped a package built from a feature
 * branch predating #10373: the process came up, `/api/monitoring/health` answered
 * `healthy`, and every real request returned `502 … Executor result must contain a
 * Response` until a human hit it.
 *
 * Two lessons are encoded here:
 *  1. Refuse an artifact that cannot be traced to the release line (reuses #10427).
 *  2. A health check is NOT a smoke test. Only a real completion exercises the egress
 *     path where that outage lived, so the verdict requires at least one.
 *
 * Everything side-effecting (git, ssh, http) is injected or emitted as data, so the policy
 * is unit-testable without a host. The thin CLI that executes these steps lives in
 * `scripts/ops/deploy-canary.mjs`.
 */

import { resolveBuildProvenance } from "../build/buildProvenance.ts";

export type CanaryPlanInput = {
  buildSha: string;
  isAncestorOfRelease: (sha: string) => boolean;
  allowCanary: boolean;
};

export type CanaryPlan = {
  proceed: boolean;
  reason: string;
};

/**
 * Decide whether an artifact may be shipped at all. Delegates to the provenance policy so
 * the pack gate and the deploy path can never disagree about what "shippable" means.
 */
export function planCanaryDeploy(input: CanaryPlanInput): CanaryPlan {
  const provenance = resolveBuildProvenance({
    buildSha: input.buildSha,
    isAncestorOfRelease: input.isAncestorOfRelease,
    allowOverride: input.allowCanary,
  });
  return { proceed: provenance.ok, reason: provenance.message };
}

export type CompletionProbe = {
  model: string;
  ok: boolean;
  status: number;
};

export type SmokeInput = {
  healthOk: boolean;
  completions: CompletionProbe[];
};

export type SmokeVerdict = {
  ok: boolean;
  rollback: boolean;
  reason: string;
};

/**
 * Grade a deploy. Health first (cheap, and a dead process needs no further probing), then
 * every completion probe.
 *
 * An empty probe list FAILS: "no probe ran" must never read as "everything is fine" —
 * that is precisely how a broken egress path stays invisible behind a green health check.
 */
export function evaluateSmoke(input: SmokeInput): SmokeVerdict {
  if (!input.healthOk) {
    return {
      ok: false,
      rollback: true,
      reason: "health endpoint did not report healthy after restart",
    };
  }

  if (input.completions.length === 0) {
    return {
      ok: false,
      rollback: true,
      reason:
        "no completion probe ran — a health check alone cannot see a broken egress path (#10429)",
    };
  }

  const failed = input.completions.filter((probe) => !probe.ok);
  if (failed.length > 0) {
    const detail = failed.map((probe) => `${probe.model} → ${probe.status}`).join(", ");
    return {
      ok: false,
      rollback: true,
      reason: `completion probe failed: ${detail}`,
    };
  }

  return {
    ok: true,
    rollback: false,
    reason: `health + ${input.completions.length} completion probe(s) passed`,
  };
}

export type RemoteStep = {
  name: string;
  /** argv form only — never a shell string, so no value can be interpreted (Hard Rule #13). */
  argv: string[];
  description: string;
};

export type RemoteStepsInput = {
  host: string;
  tarballPath: string;
  pm2App: string;
};

/**
 * The remote sequence, as data. Ordered so the rollback anchor is captured BEFORE the
 * install overwrites it, and so the SHA is verified only after the restart has actually
 * loaded the new artifact.
 *
 * Emitted as argv arrays rather than shell strings: the paths and app names come from
 * config and CLI flags, and interpolating them into `sh -c` is exactly the pattern Hard
 * Rule #13 forbids.
 */
export function buildRemoteSteps(input: RemoteStepsInput): RemoteStep[] {
  const { host, tarballPath, pm2App } = input;
  const shaPath = "/usr/lib/node_modules/omniroute/dist/BUILD_SHA";

  return [
    {
      name: "capture-current-sha",
      argv: ["ssh", host, "cat", shaPath],
      description: "record the running BUILD_SHA so a failed smoke can be rolled back",
    },
    {
      name: "install",
      argv: ["ssh", host, "npm", "install", "-g", tarballPath, "--no-audit", "--no-fund"],
      description: "install the packaged artifact globally",
    },
    {
      name: "restart",
      argv: ["ssh", host, "pm2", "restart", pm2App, "--update-env"],
      description: "restart the service under its process manager",
    },
    {
      name: "verify-installed-sha",
      argv: ["ssh", host, "cat", shaPath],
      description: "confirm the running artifact is the one just shipped",
    },
  ];
}
