import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { Bot, Play, Square, MessageSquare, FileText, Loader2, WifiOff, ExternalLink, Send, X, Mic, Video } from 'lucide-react';

const BOT_API = 'http://127.0.0.1:8000';

interface BotStatus {
  state: 'idle' | 'joining' | 'in_meeting' | 'leaving' | 'error';
  meeting_url?: string;
  platform?: string;
  bot_name?: string;
  uptime_seconds?: number;
  transcript_lines?: number;
  error?: string;
}

interface TranscriptLine {
  speaker: string;
  text: string;
  ts: number;
}

interface CommandResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export function MeetingBotView() {
  const { avatar } = useAppStore();
  const transcriptRef = useRef<HTMLDivElement>(null);

  const [meetingUrl, setMeetingUrl] = useState('');
  const [platform, setPlatform] = useState<'google_meet' | 'teams'>('google_meet');
  const [botName, setBotName] = useState('Umbra Bot');

  const [status, setStatus] = useState<BotStatus>({ state: 'idle' });
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [commandInput, setCommandInput] = useState('');
  const [commandLoading, setCommandLoading] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isMeetingActive = status.state === 'in_meeting' || status.state === 'joining' || status.state === 'leaving';

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(`${BOT_API}/status`);
      if (res.ok) {
        const data: BotStatus = await res.json();
        setStatus(data);
        if (data.state === 'error' && data.error) {
          setError(data.error);
        }
      }
    } catch {
      setStatus((prev) => ({ ...prev, state: 'idle' }));
    }
  }, []);

  const fetchTranscript = useCallback(async () => {
    try {
      const res = await fetch(`${BOT_API}/transcript`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.lines)) {
          setTranscript(data.lines);
        }
      }
    } catch {
      // silent
    }
  }, []);

  const joinMeeting = useCallback(async () => {
    if (!meetingUrl.trim()) {
      setError('Please enter a meeting URL');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${BOT_API}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_url: meetingUrl.trim(),
          platform,
          bot_name: botName.trim() || 'Umbra Bot',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Failed to join meeting' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setStatus({ state: 'joining', meeting_url: meetingUrl.trim(), platform, bot_name: botName.trim() || 'Umbra Bot' });
      setTranscript([]);
    } catch (e) {
      setError(`Failed to join: ${(e as Error).message}`);
    }
    setLoading(false);
  }, [meetingUrl, platform, botName]);

  const leaveMeeting = useCallback(async () => {
    setCommandLoading(true);
    setError('');
    try {
      const res = await fetch(`${BOT_API}/leave`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Failed to leave meeting' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setStatus({ state: 'leaving' });
    } catch (e) {
      setError(`Failed to leave: ${(e as Error).message}`);
    }
    setCommandLoading(false);
  }, []);

  const sendCommand = useCallback(async (command: string) => {
    if (!command.trim()) return;
    setCommandLoading(true);
    setError('');
    try {
      const res = await fetch(`${BOT_API}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Command failed' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const result: CommandResult = await res.json();
      if (!result.success) {
        setError(result.message || 'Command failed');
      }
      setCommandInput('');
    } catch (e) {
      setError(`Command failed: ${(e as Error).message}`);
    }
    setCommandLoading(false);
  }, []);

  // Poll status every 3 seconds when in meeting
  useEffect(() => {
    if (!isMeetingActive) return;
    const interval = setInterval(() => {
      void refreshStatus();
      void fetchTranscript();
    }, 3000);
    return () => clearInterval(interval);
  }, [isMeetingActive, refreshStatus, fetchTranscript]);

  // Initial status check
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  const formatUptime = (seconds?: number) => {
    if (!seconds) return '0s';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const stateColors: Record<string, string> = {
    idle: '#64748b',
    joining: '#F59E0B',
    in_meeting: '#22c55e',
    leaving: '#F59E0B',
    error: '#EF4444',
  };

  const stateLabels: Record<string, string> = {
    idle: 'Idle',
    joining: 'Joining...',
    in_meeting: 'In Meeting',
    leaving: 'Leaving...',
    error: 'Error',
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-5 hairline-b flex items-end justify-between gap-4" style={{ background: 'rgba(6,7,9,0.68)', backdropFilter: 'blur(18px)' }}>
        <div>
          <h1 className="hero-heading font-black uppercase tracking-tight leading-none" style={{ fontSize: 'clamp(1.6rem, 3.5vw, 2.4rem)' }}>Meeting Bot</h1>
          <p className="text-sm mt-1 font-light flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
            <span
              className="inline-block rounded-full"
              style={{ width: 7, height: 7, background: stateColors[status.state] || '#64748b', boxShadow: isMeetingActive ? `0 0 8px ${stateColors[status.state]}88` : 'none' }}
            />
            {stateLabels[status.state] || status.state}
            {status.meeting_url && (
              <span className="text-[10px] truncate max-w-[200px]" style={{ color: 'var(--text-faint)' }}>
                {status.meeting_url}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`${BOT_API}/health`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 rounded-xl text-[11px] font-medium transition-all hover:opacity-80"
            style={{ height: 34, background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: 'var(--text-dim)', fontFamily: 'var(--font)' }}
          >
            <ExternalLink size={11} /> Bot Health
          </a>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-3 px-4 py-2.5 rounded-xl flex items-center gap-2 text-[11px]" style={{ background: 'rgba(255,90,90,0.1)', border: '1px solid rgba(255,90,90,0.3)', color: '#FF8A8A' }}>
          <WifiOff size={13} /> {error}
          <button onClick={() => setError('')} className="ml-auto" style={{ color: '#FF8A8A' }}><X size={12} /></button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5" style={{ maxWidth: 1100, width: '100%', margin: '0 auto' }}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Left column: Join form + Status */}
          <div className="lg:col-span-1 space-y-4">
            {/* Join form */}
            <div className="rounded-xl p-5" style={{ background: 'var(--surface-1)', border: '1px solid var(--hairline-strong)' }}>
              <div className="flex items-center gap-2 mb-4">
                <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${avatar.accent}16`, color: avatar.accent, border: `1px solid ${avatar.accent}44` }}>
                  <Video size={15} />
                </span>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}>Join Meeting</h3>
                  <p className="text-[10px] font-light" style={{ color: 'var(--text-faint)' }}>Send the bot to any video call</p>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-medium uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-faint)' }}>Meeting URL</label>
                  <input
                    value={meetingUrl}
                    onChange={(e) => setMeetingUrl(e.target.value)}
                    placeholder="https://meet.google.com/xxx-xxxx-xxx"
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
                  />
                </div>

                <div>
                  <label className="text-[10px] font-medium uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-faint)' }}>Platform</label>
                  <div className="flex gap-2">
                    {([
                      { id: 'google_meet' as const, label: 'Google Meet' },
                      { id: 'teams' as const, label: 'Teams' },
                    ]).map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setPlatform(p.id)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-medium transition-colors"
                        style={{
                          background: platform === p.id ? avatar.accent : 'var(--surface-2)',
                          color: platform === p.id ? '#fff' : 'var(--text-dim)',
                          border: `1px solid ${platform === p.id ? 'transparent' : 'var(--hairline-strong)'}`,
                          fontFamily: 'var(--font)',
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-medium uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-faint)' }}>Bot Name</label>
                  <input
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                    placeholder="Umbra Bot"
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
                  />
                </div>

                <div className="flex gap-2 pt-1">
                  {!isMeetingActive ? (
                    <button
                      onClick={joinMeeting}
                      disabled={loading || !meetingUrl.trim()}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
                      style={{ background: '#22c55e', color: '#fff', border: 'none', fontFamily: 'var(--font)' }}
                    >
                      {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                      {loading ? 'Joining...' : 'Join Meeting'}
                    </button>
                  ) : (
                    <button
                      onClick={leaveMeeting}
                      disabled={commandLoading || status.state === 'leaving'}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
                      style={{ background: '#EF4444', color: '#fff', border: 'none', fontFamily: 'var(--font)' }}
                    >
                      {status.state === 'leaving' ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
                      {status.state === 'leaving' ? 'Leaving...' : 'Leave Meeting'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Status panel */}
            <div className="rounded-xl p-5" style={{ background: 'var(--surface-1)', border: '1px solid var(--hairline-strong)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Bot size={15} style={{ color: avatar.accent }} />
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}>Bot Status</h3>
              </div>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>State</span>
                  <span className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: stateColors[status.state] || 'var(--text-dim)' }}>
                    <span className="rounded-full" style={{ width: 6, height: 6, background: stateColors[status.state] || '#64748b' }} />
                    {stateLabels[status.state] || status.state}
                  </span>
                </div>
                {status.platform && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>Platform</span>
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>{status.platform === 'google_meet' ? 'Google Meet' : 'Teams'}</span>
                  </div>
                )}
                {status.bot_name && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>Bot Name</span>
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>{status.bot_name}</span>
                  </div>
                )}
                {status.state === 'in_meeting' && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>Uptime</span>
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>{formatUptime(status.uptime_seconds)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>Transcript Lines</span>
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>{status.transcript_lines ?? transcript.length}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right column: Transcript + Commands */}
          <div className="lg:col-span-2 space-y-4">
            {/* Transcript */}
            <div className="rounded-xl flex flex-col" style={{ background: 'var(--surface-1)', border: '1px solid var(--hairline-strong)', height: 'calc(100vh - 280px)', minHeight: 320 }}>
              <div className="flex items-center gap-2 px-5 py-3 hairline-b" style={{ background: 'rgba(6,7,9,0.4)' }}>
                <MessageSquare size={14} style={{ color: avatar.accent }} />
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}>Live Transcript</h3>
                <span className="text-[10px] ml-auto px-2 py-0.5 rounded-md" style={{ background: 'var(--surface-2)', color: 'var(--text-faint)', border: '1px solid var(--hairline)' }}>
                  {transcript.length} lines
                </span>
              </div>
              <div ref={transcriptRef} className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
                {transcript.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <Mic size={28} style={{ color: 'var(--text-faint)', opacity: 0.3 }} />
                    <p className="text-[11px] mt-3 font-light" style={{ color: 'var(--text-faint)' }}>
                      {isMeetingActive ? 'Waiting for conversation...' : 'Join a meeting to see the transcript'}
                    </p>
                  </div>
                )}
                {transcript.map((line, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-[11px] font-semibold flex-shrink-0 mt-0.5" style={{ color: avatar.accent, minWidth: 70 }}>{line.speaker || 'Unknown'}</span>
                    <span className="text-[11px] font-light" style={{ color: 'var(--text-dim)' }}>{line.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Command input */}
            {status.state === 'in_meeting' && (
              <div className="rounded-xl p-4" style={{ background: 'var(--surface-1)', border: '1px solid var(--hairline-strong)' }}>
                <div className="flex items-center gap-2 mb-3">
                  <FileText size={14} style={{ color: avatar.accent }} />
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}>Bot Commands</h3>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1 flex items-center gap-2 px-3 rounded-lg" style={{ height: 38, background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)' }}>
                    <input
                      value={commandInput}
                      onChange={(e) => setCommandInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && sendCommand(commandInput)}
                      placeholder='e.g. "take notes", "summarize", "generate report"'
                      className="bg-transparent outline-none text-sm flex-1"
                      style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
                    />
                  </div>
                  <button
                    onClick={() => sendCommand(commandInput)}
                    disabled={commandLoading || !commandInput.trim()}
                    className="flex items-center gap-1.5 px-4 rounded-lg text-[11px] font-medium transition-all hover:opacity-90 disabled:opacity-50"
                    style={{ height: 38, background: avatar.accent, color: '#fff', border: 'none', fontFamily: 'var(--font)' }}
                  >
                    {commandLoading ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    Send
                  </button>
                </div>
                <div className="flex gap-2 mt-2 flex-wrap">
                  {['take notes', 'summarize', 'generate report', 'action items'].map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => { setCommandInput(cmd); void sendCommand(cmd); }}
                      disabled={commandLoading}
                      className="px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors hover:opacity-80"
                      style={{ background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--hairline)', fontFamily: 'var(--font)' }}
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
