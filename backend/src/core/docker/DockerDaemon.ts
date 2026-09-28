/**
 * DockerDaemon — manages containerized skill workers. Hot skills compiled to
 * native run in isolated containers; the daemon handles image pull, run,
 * stop, and resource accounting for the plan tier.
 *
 * Hardened from OpenMuse apps/computer/Dockerfile + apps/server/src/computer.ts
 * (inspect/lease/execute caps):
 * - explicit error when Docker is disabled (no silent dryRun fake),
 * - mem/cpu/pids/network-none caps enforced on every run,
 * - least-privilege flags (--cap-drop ALL, no-new-privileges, --network none).
 */

import { spawn } from 'child_process';

export interface ContainerSpec {
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
  memoryLimitMb?: number;
  cpuQuotaPct?: number;
  /** Max processes inside the container (default + cap 128). */
  pidsLimit?: number;
}

export interface ContainerState {
  name: string;
  running: boolean;
  memoryBytes?: number;
  startedAt?: number;
  exitCode?: number;
}

export interface DockerOptions {
  /** Binary path, default `docker`. */
  binary?: string;
  /** Disable real docker and fake outcomes (tests). */
  dryRun?: boolean;
  registry?: string;
  /**
   * Explicit kill-switch. Defaults to UMBRA_DOCKER_ENABLED !== '0'.
   * When false, EVERY operation throws instead of faking success.
   */
  enabled?: boolean;
}

export class DockerDisabledError extends Error {
  readonly code = 'DOCKER_DISABLED';
  constructor(message = 'Docker is disabled (UMBRA_DOCKER_ENABLED=0). Enable Docker and rebuild the worker image.') {
    super(message);
    this.name = 'DockerDisabledError';
  }
}

/** Hard caps mirrored from the OpenMuse computer sandbox. */
export const DOCKER_MAX_MEMORY_MB = 512;
export const DOCKER_MAX_CPU_PCT = 100;
export const DOCKER_MAX_PIDS = 128;

const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export class DockerDaemon {
  private binary: string;
  private dryRun: boolean;
  private registry?: string;
  private explicitlyEnabled?: boolean;
  private containers = new Map<string, ContainerState>();

  constructor(options: DockerOptions = {}) {
    this.binary = options.binary ?? 'docker';
    this.dryRun = options.dryRun ?? false;
    this.registry = options.registry;
    this.explicitlyEnabled = options.enabled;
  }

  private isEnabled(): boolean {
    if (this.explicitlyEnabled !== undefined) return this.explicitlyEnabled;
    return process.env['UMBRA_DOCKER_ENABLED'] !== '0';
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) throw new DockerDisabledError();
  }

  private validatedSpec(spec: ContainerSpec): { name: string; image: string; memoryMb: number; cpuPct: number; pids: number } {
    if (!NAME_RE.test(spec.name)) throw new Error(`Invalid container name: ${spec.name}`);
    const image = this.registry ? `${this.registry}/${spec.image}` : spec.image;
    if (!IMAGE_RE.test(image)) throw new Error(`Invalid container image: ${image}`);
    const memoryMb = spec.memoryLimitMb ?? DOCKER_MAX_MEMORY_MB;
    if (!Number.isFinite(memoryMb) || memoryMb <= 0 || memoryMb > DOCKER_MAX_MEMORY_MB) {
      throw new Error(`memoryLimitMb must be 1–${DOCKER_MAX_MEMORY_MB} (got ${spec.memoryLimitMb})`);
    }
    const cpuPct = spec.cpuQuotaPct ?? DOCKER_MAX_CPU_PCT;
    if (!Number.isFinite(cpuPct) || cpuPct <= 0 || cpuPct > DOCKER_MAX_CPU_PCT) {
      throw new Error(`cpuQuotaPct must be 1–${DOCKER_MAX_CPU_PCT} (got ${spec.cpuQuotaPct})`);
    }
    const pids = spec.pidsLimit ?? DOCKER_MAX_PIDS;
    if (!Number.isFinite(pids) || pids <= 0 || pids > DOCKER_MAX_PIDS) {
      throw new Error(`pidsLimit must be 1–${DOCKER_MAX_PIDS} (got ${spec.pidsLimit})`);
    }
    return { name: spec.name, image, memoryMb, cpuPct, pids };
  }

  async run(spec: ContainerSpec): Promise<ContainerState> {
    // Explicit failure when disabled — never fake a running container.
    this.assertEnabled();
    const checked = this.validatedSpec(spec);
    const state: ContainerState = {
      name: checked.name,
      running: true,
      startedAt: Date.now(),
    };
    this.containers.set(checked.name, state);

    if (this.dryRun) {
      return state;
    }

    const args = [
      'run', '-d',
      '--name', checked.name,
      // ── Hardened isolation (mirrors OpenMuse computer sandbox) ──
      '--network', 'none',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--memory', `${checked.memoryMb}m`,
      '--memory-swap', `${checked.memoryMb}m`,
      '--cpus', (checked.cpuPct / 100).toFixed(2),
      '--pids-limit', String(checked.pids),
      '--restart', 'no',
    ];
    for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push(checked.image, ...(spec.command ?? []));

    try {
      await this.exec([...args]);
      return state;
    } catch (err) {
      state.running = false;
      state.exitCode = 1;
      throw new Error(`docker run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(name: string): Promise<boolean> {
    this.assertEnabled();
    const state = this.containers.get(name);
    if (!state) return false;
    if (!this.dryRun) {
      try {
        await this.exec(['stop', '--time', '2', name]);
      } catch {
        // Already stopped.
      }
    }
    state.running = false;
    state.exitCode = 0;
    return true;
  }

  async remove(name: string): Promise<boolean> {
    this.assertEnabled();
    const existed = this.containers.delete(name);
    if (!this.dryRun && existed) {
      try {
        await this.exec(['rm', '-f', name]);
      } catch {
        // Best-effort cleanup.
      }
    }
    return existed;
  }

  list(): ContainerState[] {
    return [...this.containers.values()];
  }

  async ensureImage(image: string): Promise<boolean> {
    this.assertEnabled();
    if (this.dryRun) return true;
    if (!IMAGE_RE.test(image)) throw new Error(`Invalid container image: ${image}`);
    try {
      await this.exec(['image', 'inspect', image]);
      return true;
    } catch {
      try {
        await this.exec(['pull', image]);
        return true;
      } catch {
        return false;
      }
    }
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (err += d));
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve(out);
        else reject(new Error(err || `exit ${code}`));
      });
    });
  }
}
