import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { eventBus } from '../core/EventBus';
import { AgentRuntime } from '../core/agent/AgentRuntime';
import { MacroSynthesizer } from '../core/recall/MacroSynthesizer';
import { ConfigManager } from '../config/ConfigManager';
import { KnowledgeGraph } from '../knowledge/KnowledgeGraph';
import { getLogger } from '../core/Logger';

export interface HUDCommand {
  input: string;
  type: 'text' | 'voice' | 'macro';
  timestamp: Date;
}

export interface HUDSuggestion {
  text: string;
  type: 'macro' | 'knowledge' | 'recent';
  confidence: number;
}

/**
 * Always-on-top WinForms ask box (Windows-only). The window is just a thin
 * shell: on submit it writes `seq|question` to an input file; the Node side
 * polls that file, runs the question through screen awareness / the agent,
 * and writes `seq|answer` back to an output file the window polls and shows.
 */
const HUD_PS = `param([string]$InPath, [string]$OutPath)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "Umbra"
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.KeyPreview = $true
$form.Width = 430
$form.Height = 264
$form.BackColor = [System.Drawing.Color]::FromArgb(22,22,30)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($screen.Right - $form.Width - 16), ($screen.Top + 16))

$title = New-Object System.Windows.Forms.Label
$title.Text = "Ask Umbra  —  ? = about screen   help/finish = take over"
$title.ForeColor = [System.Drawing.Color]::White
$title.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(12, 10)
$title.Size = New-Object System.Drawing.Size(400, 22)
$form.Controls.Add($title)

$box = New-Object System.Windows.Forms.TextBox
$box.Location = New-Object System.Drawing.Point(12, 38)
$box.Size = New-Object System.Drawing.Size(304, 26)
$box.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$form.Controls.Add($box)

$ask = New-Object System.Windows.Forms.Button
$ask.Text = "Ask"
$ask.Location = New-Object System.Drawing.Point(322, 36)
$ask.Size = New-Object System.Drawing.Size(86, 30)
$form.Controls.Add($ask)
$form.AcceptButton = $ask

$answer = New-Object System.Windows.Forms.Label
$answer.Text = "Esc hides. Examples:  'what does this error mean?'  or  'finish this'"
$answer.ForeColor = [System.Drawing.Color]::LightGray
$answer.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$answer.Location = New-Object System.Drawing.Point(12, 76)
$answer.Size = New-Object System.Drawing.Size(404, 170)
$answer.AutoSize = $false
$form.Controls.Add($answer)

$script:seq = 0

function Submit {
  $t = $box.Text.Trim()
  if ($t -eq '') { return }
  $script:seq = $script:seq + 1
  Add-Content -Path $InPath -Value ($script:seq.ToString() + '|' + $t)
  $answer.Text = 'Thinking...'
  $box.Text = ''
  $form.Refresh()
}

$ask.Add_Click({ Submit })
$form.Add_KeyDown({
  if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $form.Close() }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  if (Test-Path $OutPath) {
    $text = [System.IO.File]::ReadAllText($OutPath)
    $prefix = $script:seq.ToString() + '|'
    $idx = $text.IndexOf($prefix)
    if ($idx -ge 0) {
      $line = $text.Substring($idx)
      $nl = $line.IndexOf([char]10)
      if ($nl -ge 0) { $line = $line.Substring(0, $nl) }
      $line = $line.Trim()
      $val = $line.Substring($prefix.Length)
      if ($val) { $answer.Text = $val }
    }
  }
})
$timer.Start()

$form.Add_Shown({ $box.Focus() })
[void] $form.ShowDialog()
`;

export class CommandHUD {
  private agent?: AgentRuntime;
  private macros?: MacroSynthesizer;
  private config?: ConfigManager;
  private knowledge?: KnowledgeGraph;
  private screenAsk?: (question: string, intent: 'answer' | 'help' | 'finish') => Promise<unknown>;
  private history: HUDCommand[] = [];
  private visible: boolean = false;
  private overlayChild: ChildProcess | null = null;
  private pollTimer?: NodeJS.Timeout;
  private lastSeq: number = 0;
  private inPath: string = '';
  private outPath: string = '';

  constructor() {
    eventBus.on('overlay:toggle', () => this.toggle());
    eventBus.on('overlay:command', (cmd) => {
      void this.handleCommand(cmd);
    });
    eventBus.on('audio:gesture', (gesture) => {
      if (gesture === 'snap') this.toggle();
    });
  }

  registerSubsystems(subsystems: {
    agent?: AgentRuntime;
    macros?: MacroSynthesizer;
    config?: ConfigManager;
    knowledge?: KnowledgeGraph;
    screenAsk?: (question: string, intent: 'answer' | 'help' | 'finish') => Promise<unknown>;
  }): void {
    if (subsystems.agent) this.agent = subsystems.agent;
    if (subsystems.macros) this.macros = subsystems.macros;
    if (subsystems.config) this.config = subsystems.config;
    if (subsystems.knowledge) this.knowledge = subsystems.knowledge;
    if (subsystems.screenAsk) this.screenAsk = subsystems.screenAsk;
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    getLogger().info('Command HUD shown');
    if (process.platform === 'win32') this.launchOverlay();
  }

  hide(): void {
    this.visible = false;
    getLogger().info('Command HUD hidden');
    this.closeOverlay();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Handle a HUD command and return a displayable result. `?`/`help`/`finish`
   * go to screen awareness; `/macro` runs a macro; anything else is a task.
   */
  async handleCommand(input: string): Promise<string> {
    const command: HUDCommand = {
      input,
      type: input.startsWith('/') ? 'macro' : 'text',
      timestamp: new Date(),
    };

    this.history.push(command);
    if (this.history.length > 100) this.history.shift();

    getLogger().info({ input, type: command.type }, 'HUD command received');

    if (command.type === 'macro') {
      const macroName = input.substring(1).trim();
      try {
        await this.macros?.executeMacro(macroName);
        return `Macro executed: /${macroName}`;
      } catch (err: any) {
        getLogger().warn({ macro: macroName, err: err.message }, 'Macro execution failed');
        return `Macro failed: ${err.message}`;
      }
    }

    // Screen-aware asks: `?` answers a question about the screen; `help` /
    // `finish` asks Umbra to help finish (or take over) the on-screen task.
    const text = input.trim();
    if (text.startsWith('?')) {
      const question = text.slice(1).trim();
      if (question && this.screenAsk) {
        return await this.askScreen(question, 'answer');
      }
    }
    const helpMatch = text.match(/^(help|finish|help me finish|take over)\s+(.+)$/i);
    if (helpMatch && this.screenAsk) {
      return await this.askScreen(helpMatch[2].trim(), 'finish');
    }

    if (this.agent) {
      const task = await this.agent.submitTask(input);
      return `Task started: ${(task as any)?.id ?? 'ok'}`;
    }
    return 'No agent available to run this task.';
  }

  private async askScreen(question: string, intent: 'answer' | 'help' | 'finish'): Promise<string> {
    try {
      const res = (await this.screenAsk!(question, intent)) as { answer?: string };
      return res?.answer ?? 'No answer returned.';
    } catch (err: any) {
      return `Screen ask failed: ${err.message}`;
    }
  }

  async getSuggestions(partial: string): Promise<HUDSuggestion[]> {
    const suggestions: HUDSuggestion[] = [];

    if (this.macros) {
      const macroSuggestions = await this.macros.intelligentlySuggestMacros();
      for (const m of macroSuggestions) {
        if (m.keyword.includes(partial.toLowerCase()) || m.description.includes(partial.toLowerCase())) {
          suggestions.push({ text: `/${m.keyword}`, type: 'macro', confidence: m.confidence });
        }
      }
    }

    if (this.history.length > 0) {
      const recent = this.history
        .filter(h => h.input.includes(partial))
        .slice(-5)
        .map(h => ({ text: h.input, type: 'recent' as const, confidence: 50 }));
      suggestions.push(...recent);
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
  }

  getHistory(): HUDCommand[] {
    return this.history;
  }

  // ── Overlay window + file IPC (Windows-only) ──────────────

  private tmpDir(): string {
    const base = this.config?.raw.paths.dataDir
      || path.join(process.env['USERPROFILE'] || '.', '.umbra');
    return path.join(base, 'tmp');
  }

  private launchOverlay(): void {
    if (this.overlayChild) return;
    const tmp = this.tmpDir();
    fs.mkdirSync(tmp, { recursive: true });
    this.inPath = path.join(tmp, 'hud-in.txt');
    this.outPath = path.join(tmp, 'hud-out.txt');
    const psPath = path.join(tmp, 'hud-overlay.ps1');

    try { fs.rmSync(this.inPath, { force: true }); } catch { }
    try { fs.rmSync(this.outPath, { force: true }); } catch { }
    fs.writeFileSync(psPath, HUD_PS, 'utf-8');

    this.overlayChild = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath, this.inPath, this.outPath],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    this.overlayChild.on('exit', () => {
      this.overlayChild = null;
      if (this.visible) this.visible = false;
    });
    this.overlayChild.unref();

    this.pollTimer = setInterval(() => void this.pollInput(), 250);
    getLogger().info('HUD overlay launched (always-on-top)');
  }

  private closeOverlay(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.overlayChild) {
      try { this.overlayChild.kill(); } catch { }
      this.overlayChild = null;
    }
  }

  private async pollInput(): Promise<void> {
    if (!this.inPath) return;
    let raw = '';
    try {
      raw = fs.readFileSync(this.inPath, 'utf-8');
    } catch {
      return;
    }
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let maxSeq = this.lastSeq;
    const pending: Array<{ seq: number; text: string }> = [];
    for (const line of lines) {
      const i = line.indexOf('|');
      if (i <= 0) continue;
      const seq = parseInt(line.slice(0, i), 10);
      if (isNaN(seq) || seq <= this.lastSeq) continue;
      pending.push({ seq, text: line.slice(i + 1).trim() });
      if (seq > maxSeq) maxSeq = seq;
    }
    if (pending.length === 0) return;

    for (const item of pending) {
      if (item.text) {
        const answer = await this.handleCommand(item.text);
        this.writeAnswer(item.seq, answer);
      }
    }
    this.lastSeq = maxSeq;
  }

  private writeAnswer(seq: number, answer: string): void {
    if (!this.outPath) return;
    const safe = answer.replace(/\r?\n/g, ' ').replace(/\|/g, '¦').slice(0, 4000);
    try {
      fs.appendFileSync(this.outPath, `${seq}|${safe}\n`, 'utf-8');
    } catch { }
  }
}
