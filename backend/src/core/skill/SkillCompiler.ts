/**
 * Skill Compiler — turns a skill package (spec) into deployable units:
 * system prompts, tool descriptors, native bindings, and MCP registry
 * entries. Hot skills are compiled to native binaries by a backend.
 */

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** If true, the tool maps to a native entry point. */
  native?: boolean;
}

export interface SkillSpec {
  name: string;
  version: string;
  domain: string;
  description: string;
  systemPrompt: string;
  tools: ToolDescriptor[];
  triggers?: string[];
  /** Expected peak working set in bytes (drives plan tiering). */
  memorySize?: number;
  /** Author flags the skill as hot (frequent) → compile to native. */
  hot?: boolean;
}

export interface CompiledSkill {
  name: string;
  version: string;
  domain: string;
  description: string;
  systemPrompt: string;
  tools: ToolDescriptor[];
  triggers: string[];
  memorySize: number;
  hot: boolean;
  compiledAt: number;
  native?: NativeArtifact;
  mcpRegistry: McpRegistryEntry[];
}

export interface McpRegistryEntry {
  skill: string;
  tool: string;
  method: string;
}

export interface NativeArtifact {
  language: string;
  entry: string;
  sourcePath: string;
  buildId: string;
}

export interface SkillCompilerOptions {
  /** Output directory for generated sources/binaries. */
  outDir: string;
  /** Native backend; undefined = metadata-only compilation. */
  backend?: NativeBackend;
  /** Auto-compile hot skills. */
  compileHot?: boolean;
}

export interface NativeBackend {
  readonly language: string;
  compile(skill: CompiledSkill, outDir: string): Promise<NativeArtifact>;
}

export class SkillCompiler {
  private outDir: string;
  private backend?: NativeBackend;
  private compileHot: boolean;

  constructor(options: SkillCompilerOptions) {
    this.outDir = options.outDir;
    this.backend = options.backend;
    this.compileHot = options.compileHot ?? true;
  }

  async compile(spec: SkillSpec): Promise<CompiledSkill> {
    const skill: CompiledSkill = {
      name: spec.name,
      version: spec.version,
      domain: spec.domain,
      description: spec.description,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      triggers: spec.triggers ?? [],
      memorySize: spec.memorySize ?? 0,
      hot: spec.hot ?? false,
      compiledAt: Date.now(),
      mcpRegistry: spec.tools.map(tool => ({
        skill: spec.name,
        tool: tool.name,
        method: tool.native ? 'native' : 'prompt',
      })),
    };

    if (this.backend && skill.hot && this.compileHot) {
      skill.native = await this.backend.compile(skill, this.outDir);
    }
    return skill;
  }

  async compileMany(specs: SkillSpec[]): Promise<CompiledSkill[]> {
    return Promise.all(specs.map(s => this.compile(s)));
  }
}
