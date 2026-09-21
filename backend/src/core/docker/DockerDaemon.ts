/**
 * DockerDaemon — manages containerized skill workers. Hot skills compiled to
 * native run in isolated containers; the daemon handles image pull, run,
 * stop, and resource accounting for the plan tier.
 */

import { spawn } from 'child_process';

export interface ContainerSpec {
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
  memoryLimitMb?: number;
  cpuQuotaPct?: number;
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
}

export class DockerDaemon {
  private binary: string;
  private dryRun: boolean;
  private registry?: string;
  private containers = new Map<string, ContainerState>();

  constructor(options: DockerOptions = {}) {
    this.binary = options.binary ?? 'docker';
    this.dryRun = options.dryRun ?? false;
    this.registry = options.registry;
  }

  async run(spec: ContainerSpec): Promise<ContainerState> {
    const state: ContainerState = {
      name: spec.name,
      running: true,
      startedAt: Date.now(),
    };
    this.containers.set(spec.name, state);

    if (this.dryRun) {
      return state;
    }

    const image = this.registry ? `${this.registry}/${spec.image}` : spec.image;
    const args = ['run', '-d', '--name', spec.name];
    if (spec.memoryLimitMb) args.push('--memory', `${spec.memoryLimitMb}m`);
    if (spec.cpuQuotaPct) args.push('--cpus', (spec.cpuQuotaPct / 100).toFixed(2));
    for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push(image, ...(spec.command ?? []));

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
    const state = this.containers.get(name);
    if (!state) return false;
    if (!this.dryRun) {
      try {
        await this.exec(['stop', name]);
      } catch {
        // Already stopped.
      }
    }
    state.running = false;
    state.exitCode = 0;
    return true;
  }

  async remove(name: string): Promise<boolean> {
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
    if (this.dryRun) return true;
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
