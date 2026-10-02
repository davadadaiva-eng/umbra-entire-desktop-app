import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import gsap from 'gsap';
import { useAppStore } from '../stores/appStore';
import {
  getSmartHomePlatforms,
  connectSmartHomePlatform,
  disconnectSmartHomePlatform,
  startSmartHomeOauth,
  smartHomeOauthSettled,
  fetchSmartHomeDevicesViaBackend,
  smartHomeSwitch,
  getSmartHomeSchedules,
  addSmartHomeSchedule,
  cancelSmartHomeSchedule,
  type SmartHomePlatformInfo,
  type SmartHomeDeviceAny,
  type SmartHomeSchedule,
} from '../lib/backend';
import {
  Lightbulb, Plug, ToggleLeft, Thermometer, Lock, Radio, Camera, Speaker, HelpCircle, RefreshCw,
  Loader2, House, Wifi, WifiOff, X, Eye, EyeOff, CheckCircle2, Link2, Unlink, LayoutGrid, Rows3,
  Clock, Plus, Trash2, ChevronDown, ChevronRight, Power, KeyRound,
} from 'lucide-react';

const KIND_ICONS: Record<string, typeof Lightbulb> = {
  light: Lightbulb,
  switch: ToggleLeft,
  plug: Plug,
  thermostat: Thermometer,
  lock: Lock,
  sensor: Radio,
  camera: Camera,
  speaker: Speaker,
  device: HelpCircle,
};

type FilterId = 'all' | 'switch' | 'light' | 'plug' | 'thermostat' | 'lock' | 'sensor' | 'camera';

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'switch', label: 'Switches' },
  { id: 'light', label: 'Lights' },
  { id: 'plug', label: 'Plugs' },
  { id: 'thermostat', label: 'Climate' },
  { id: 'lock', label: 'Locks' },
  { id: 'sensor', label: 'Sensors' },
  { id: 'camera', label: 'Cameras' },
];

/** Platforms that additionally need a server URL to connect. */
const URL_PLATFORMS = new Set(['homeassistant', 'hubitat', 'openhab', 'tuya']);

// ── Routines: next-run maths ───────────────────────────────────────────────

/** When will this rule next fire, given `now`? `null` if it never will. */
function nextRunAt(rule: SmartHomeSchedule, now: number): Date | null {
  if (!rule.enabled) return null;
  if (rule.kind === 'at' && rule.at) {
    const [hh, mm] = rule.at.split(':').map((n) => parseInt(n, 10) || 0);
    const d = new Date(now);
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
    // Already past today's slot → tomorrow.
    if (t.getTime() <= now) t.setDate(t.getDate() + 1);
    return t;
  }
  if (rule.kind === 'everyMinutes') {
    const interval = Math.max(1, rule.everyMinutes || 1) * 60_000;
    // A rule that has never run is treated as starting now.
    let t = (rule.lastRun || now) + interval;
    while (t <= now) t += interval;
    return new Date(t);
  }
  return null;
}

/** Compact "in 42s" / "in 3m 10s" / "in 2h 5m" relative label. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "Daily at 19:00" / "Every 30 min" — the rule's cadence in words. */
function formatCadence(rule: SmartHomeSchedule): string {
  return rule.kind === 'at' ? `Daily at ${rule.at}` : `Every ${rule.everyMinutes || 1} min`;
}

/** "Today 19:00" / "Tomorrow 07:30" / "Fri 08:00" for a next-run timestamp. */
function formatNextRun(at: Date, now: number): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (at.getTime() < startOfToday) return time;
  if (at.getTime() < startOfToday + 86_400_000) return `Today ${time}`;
  if (at.getTime() < startOfToday + 172_800_000) return `Tomorrow ${time}`;
  return at.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time;
}

export function SmartHomeView() {
  const { avatar, addJournal } = useAppStore();
  const [platforms, setPlatforms] = useState<SmartHomePlatformInfo[]>([]);
  const [devices, setDevices] = useState<SmartHomeDeviceAny[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [layout, setLayout] = useState<'rooms' | 'grid'>('rooms');
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Connect flow
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [pat, setPat] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [showPat, setShowPat] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnectingKey, setDisconnectingKey] = useState<string | null>(null);
  /** Platform key currently sitting in an OAuth consent round trip. */
  const [signingInKey, setSigningInKey] = useState<string | null>(null);

  // Routines (device schedules)
  const [schedules, setSchedules] = useState<SmartHomeSchedule[]>([]);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [addingSchedule, setAddingSchedule] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [schedForm, setSchedForm] = useState({
    deviceId: '',
    command: 'on' as 'on' | 'off',
    kind: 'at' as 'at' | 'everyMinutes',
    at: '19:00',
    everyMinutes: 30,
  });
  /** Ticks once a second so next-run countdowns stay live without refetching. */
  const [now, setNow] = useState(() => Date.now());

  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setRefreshing(true);
    setError(null);
    try {
      const platformsRes = await getSmartHomePlatforms();
      setPlatforms(platformsRes.platforms || []);
      const anyConnected = (platformsRes.platforms || []).some((p) => p.configured);
      if (anyConnected) {
        const devRes = await fetchSmartHomeDevicesViaBackend();
        setDevices(((devRes as { devices?: SmartHomeDeviceAny[] }).devices) || []);
      } else {
        setDevices([]);
      }
      // Schedules are independent of the device list — a failing fetch here
      // shouldn't blank the whole view.
      try {
        const schedRes = await getSmartHomeSchedules();
        setSchedules(schedRes.schedules || []);
      } catch {
        setSchedules([]);
      }
    } catch (e) {
      setError((e as Error).message || 'Failed to reach the Umbra backend');
      setPlatforms([]);
      setDevices([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Live countdown clock for the routines panel. Only ticks when there is
  // something to count down, so the device grid isn't re-rendered every second.
  useEffect(() => {
    if (schedules.length === 0) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [schedules.length]);

  // Entrance animation matching the other views.
  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power2.out', duration: 0.4 } });
      tl.fromTo(headerRef.current, { opacity: 0, y: 12 }, { opacity: 1, y: 0 });
      if (contentRef.current) {
        const cards = contentRef.current.querySelectorAll('.sm-card');
        tl.fromTo(cards, { opacity: 0, y: 16, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, stagger: 0.04 }, '-=0.15');
      }
    }, [headerRef, contentRef]);
    return () => ctx.revert();
  }, [devices.length > 0, filter, platformFilter, layout, connectingKey]);

  const connected = platforms.filter((p) => p.configured);
  const available = platforms.filter((p) => !p.configured);

  const openConnect = (p: SmartHomePlatformInfo) => {
    setConnectingKey(p.key);
    setPat('');
    setServerUrl('');
    setShowPat(false);
  };

  const handleConnect = async () => {
    if (!connectingKey) return;
    const t = pat.trim();
    if (!t) { showToast('error', 'Paste the platform token first'); return; }
    setConnecting(true);
    try {
      const res = await connectSmartHomePlatform(connectingKey, t, serverUrl.trim() || undefined);
      showToast('success', `Connected — ${res.deviceCount} device${res.deviceCount === 1 ? '' : 's'} found`);
      addJournal('action', `Smart home: connected ${connectingKey} (${res.deviceCount} devices)`);
      setConnectingKey(null);
      await load(false);
    } catch (e) {
      showToast('error', (e as Error).message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  /**
   * Cloud platforms with a registered OAuth app sign in through the vendor
   * instead of a pasted token. The backend holds the PKCE verifier, so the
   * desktop just opens the consent URL and then polls until the vendor's
   * loopback redirect has landed the session in the vault.
   */
  const handleSignIn = async (p: SmartHomePlatformInfo) => {
    setSigningInKey(p.key);
    try {
      const { authorizeUrl } = await startSmartHomeOauth(p.key);
      // Electron blocks window.open, so prefer the OS browser (same path the
      // MCP connector sign-in uses).
      const opened = (window as unknown as { umbraDesktop?: { openExternal(u: string): Promise<boolean> } })
        .umbraDesktop?.openExternal
        ? await (window as unknown as { umbraDesktop: { openExternal(u: string): Promise<boolean> } })
            .umbraDesktop.openExternal(authorizeUrl)
        : false;
      if (!opened) window.open(authorizeUrl, '_blank', 'width=600,height=700');

      setToast({ type: 'success', text: `Finish signing in to ${p.label} in your browser…` });
      const settled = await smartHomeOauthSettled(p.key);
      if (settled) {
        showToast('success', `Signed in to ${p.label}`);
        addJournal('action', `Smart home: signed in to ${p.key} via OAuth`);
        await load(false);
      } else {
        showToast('error', `Sign-in to ${p.label} did not complete — try again`);
      }
    } catch (e) {
      showToast('error', (e as Error).message || 'Sign-in failed');
    } finally {
      setSigningInKey(null);
    }
  };

  const handleDisconnect = async (key: string) => {
    setDisconnectingKey(key);
    try {
      await disconnectSmartHomePlatform(key);
      showToast('success', 'Platform disconnected');
      addJournal('action', `Smart home: disconnected ${key}`);
      await load(false);
    } catch (e) {
      showToast('error', (e as Error).message || 'Disconnect failed');
    } finally {
      setDisconnectingKey(null);
    }
  };

  const handleToggle = async (device: SmartHomeDeviceAny, next: 'on' | 'off') => {
    if (!device.switchCapable || pending.has(device.id)) return;
    // Optimistic update
    setDevices((cur) => cur.map((d) => (d.id === device.id ? { ...d, switchState: next } : d)));
    setPending((cur) => new Set(cur).add(device.id));
    try {
      await smartHomeSwitch(device.id, next);
      addJournal('action', `Smart home: turned ${next} ${device.name} (${device.platformLabel})`);
    } catch (e) {
      // Revert on failure and show the real state
      setDevices((cur) => cur.map((d) => (d.id === device.id ? { ...d, switchState: device.switchState } : d)));
      showToast('error', `${device.name}: ${(e as Error).message || 'Command failed'}`);
    } finally {
      setPending((cur) => {
        const nextSet = new Set(cur);
        nextSet.delete(device.id);
        return nextSet;
      });
    }
  };

  // ── Routines ──

  /** Devices a routine can target: anything with a switch. */
  const schedulableDevices = useMemo(
    () => devices.filter((d) => d.switchCapable),
    [devices],
  );

  const handleAddSchedule = async () => {
    const device = devices.find((d) => d.id === schedForm.deviceId);
    if (!device) { showToast('error', 'Pick a device for the routine'); return; }
    setAddingSchedule(true);
    try {
      const res = await addSmartHomeSchedule({
        deviceId: device.id,
        deviceName: device.name,
        command: schedForm.command,
        kind: schedForm.kind,
        at: schedForm.kind === 'at' ? schedForm.at : undefined,
        everyMinutes: schedForm.kind === 'everyMinutes' ? schedForm.everyMinutes : undefined,
      });
      setSchedules((cur) => [...cur, res.schedule]);
      showToast('success', `Routine created — ${device.name} ${schedForm.command}`);
      addJournal('action', `Smart home: routine created for ${device.name} (${device.platformLabel})`);
      setShowScheduleForm(false);
      setSchedForm((f) => ({ ...f, deviceId: '' }));
    } catch (e) {
      showToast('error', (e as Error).message || 'Could not create routine');
    } finally {
      setAddingSchedule(false);
    }
  };

  const handleCancelSchedule = async (id: string) => {
    setCancellingId(id);
    try {
      await cancelSmartHomeSchedule(id);
      setSchedules((cur) => cur.filter((s) => s.id !== id));
      showToast('success', 'Routine cancelled');
      addJournal('action', 'Smart home: routine cancelled');
    } catch (e) {
      showToast('error', (e as Error).message || 'Could not cancel routine');
    } finally {
      setCancellingId(null);
    }
  };

  // ── Filtering: kind chips → platform chips → room grouping ──

  const kindFiltered = useMemo(
    () => (filter === 'all' ? devices : devices.filter((d) => d.kind === filter)),
    [devices, filter],
  );

  const visible = useMemo(
    () => (platformFilter === 'all' ? kindFiltered : kindFiltered.filter((d) => d.platform === platformFilter)),
    [kindFiltered, platformFilter],
  );

  /** Distinct platforms present among loaded devices (chips shown only when 2+). */
  const platformOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of devices) if (!seen.has(d.platform)) seen.set(d.platform, d.platformLabel || d.platform);
    return Array.from(seen.entries()).map(([key, label]) => ({ key, label }));
  }, [devices]);
  const showPlatformChips = platformOptions.length > 1;

  /** Room groups sorted alphabetically, "Unassigned" last. */
  const roomGroups = useMemo(() => {
    const map = new Map<string, SmartHomeDeviceAny[]>();
    for (const d of visible) {
      const room = d.room || 'Unassigned';
      if (!map.has(room)) map.set(room, []);
      map.get(room)!.push(d);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return a.localeCompare(b);
    });
  }, [visible]);

  const hasActiveFilters = filter !== 'all' || platformFilter !== 'all';
  const clearFilters = () => { setFilter('all'); setPlatformFilter('all'); };

  const onlineCount = devices.filter((d) => d.online).length;
  const onCount = devices.filter((d) => d.switchState === 'on').length;
  const availableFilters = FILTERS.filter((f) =>
    f.id === 'all' || devices.some((d) => d.kind === f.id),
  );
  const connectTarget = platforms.find((p) => p.key === connectingKey);

  // Shared card renderer — used by both the room-grouped and flat layouts.
  const renderCard = (d: SmartHomeDeviceAny) => {
    const Icon = KIND_ICONS[d.kind] || HelpCircle;
    const isOn = d.switchState === 'on';
    const busy = pending.has(d.id);
    return (
      <div key={d.id} className="sm-card card card-hover p-4 flex flex-col" style={{ background: 'var(--surface-1)' }}>
        <div className="flex items-center justify-between mb-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{
              background: isOn ? `${avatar.accent}1c` : 'var(--surface-2)',
              border: `1px solid ${isOn ? `${avatar.accent}44` : 'var(--hairline)'}`,
            }}
          >
            <Icon size={18} style={{ color: isOn ? avatar.accent : 'var(--text-faint)' }} />
          </div>
          <span
            title={d.online ? 'Online' : 'Status unknown'}
            style={{ width: 8, height: 8, borderRadius: '50%', background: d.online ? '#22c55e' : 'var(--text-faint)', boxShadow: d.online ? '0 0 6px rgba(34,197,94,0.5)' : 'none' }}
          />
        </div>

        <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</p>
        <p className="text-[11px] font-light mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>
          {layout === 'rooms' ? d.platformLabel : `${d.room} · ${d.platformLabel}`}
        </p>

        <div className="mt-auto pt-3 flex items-center justify-between">
          <span className="text-[10px] font-light" style={{ color: 'var(--text-faint)' }}>
            {!d.switchCapable ? 'No switch' : d.switchState === null ? '—' : isOn ? 'ON' : 'OFF'}
          </span>
          {d.switchCapable ? (
            <button
              onClick={() => void handleToggle(d, isOn ? 'off' : 'on')}
              disabled={busy}
              className="relative rounded-full transition-all"
              style={{
                width: 42,
                height: 24,
                background: isOn ? 'var(--accent-gradient)' : 'var(--surface-3)',
                border: `1px solid ${isOn ? 'transparent' : 'var(--hairline-strong)'}`,
                boxShadow: isOn ? '0 0 14px rgba(59,130,246,0.35)' : 'none',
                cursor: busy ? 'wait' : 'pointer',
                opacity: busy ? 0.7 : 1,
              }}
              aria-label={`Turn ${isOn ? 'off' : 'on'} ${d.name}`}
            >
              <span
                className="absolute top-1/2 rounded-full"
                style={{
                  width: 18,
                  height: 18,
                  background: '#fff',
                  transform: `translate(${isOn ? 20 : 2}px, -50%)`,
                  transition: 'transform 0.18s ease',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                }}
              />
            </button>
          ) : (
            <Wifi size={13} style={{ color: 'var(--text-faint)' }} />
          )}
        </div>
      </div>
    );
  };

  const gridClass = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ═══ HEADER ═══ */}
      <div
        ref={headerRef}
        className="px-6 py-5 hairline-b flex items-end justify-between gap-4 flex-shrink-0"
        style={{ background: 'rgba(6,7,9,0.68)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }}
      >
        <div>
          <h1 className="hero-heading font-black uppercase tracking-tight leading-none" style={{ fontSize: 'clamp(1.6rem, 3.5vw, 2.4rem)' }}>
            Smart Home
          </h1>
          <p className="text-sm mt-1 font-light" style={{ color: 'var(--text-dim)' }}>
            {loading
              ? 'Connecting to your home…'
              : `${connected.length} platform${connected.length === 1 ? '' : 's'} · ${devices.length} devices · ${onCount} on · ${onlineCount}/${devices.length} online`}
          </p>
        </div>
        <button
          onClick={() => void load(true)}
          disabled={refreshing || loading}
          className="flex items-center gap-1.5 px-3.5 rounded-xl flex-shrink-0"
          style={{
            height: 34,
            background: `${avatar.accent}1c`,
            color: avatar.accent,
            border: `1px solid ${avatar.accent}44`,
            fontFamily: 'var(--font)',
            fontSize: 12,
            cursor: refreshing ? 'default' : 'pointer',
          }}
        >
          {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      <div ref={contentRef} className="flex-1 overflow-y-auto px-6 py-5" style={{ maxWidth: 1080, width: '100%', margin: '0 auto' }}>
        {/* ═══ ERROR BANNER ═══ */}
        {error && (
          <div className="card p-4 mb-4 flex items-center justify-between" style={{ background: 'var(--surface-1)', borderColor: 'rgba(239,68,68,0.35)' }}>
            <div className="flex items-center gap-2.5">
              <WifiOff size={15} style={{ color: '#ef4444' }} />
              <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{error}</p>
            </div>
            <button
              onClick={() => void load(true)}
              className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded-lg"
              style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', fontFamily: 'var(--font)' }}
            >
              <RefreshCw size={10} /> Retry
            </button>
          </div>
        )}

        {/* ═══ CONNECTED PLATFORMS ═══ */}
        {!loading && connected.length > 0 && (
          <div className="flex flex-col gap-2 mb-4">
            {connected.map((p) => (
              <div key={p.key} className="card p-3.5 flex items-center justify-between gap-3" style={{ background: 'var(--surface-1)', border: '1px solid rgba(34,197,94,0.35)' }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <CheckCircle2 size={15} style={{ color: '#22c55e' }} />
                  <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {p.label} connected{p.tokenMasked ? ` · token ${p.tokenMasked}` : ''}
                    {p.lastError ? <span style={{ color: '#f59e0b' }}> · {p.lastError}</span> : null}
                  </p>
                </div>
                <button
                  onClick={() => void handleDisconnect(p.key)}
                  disabled={disconnectingKey === p.key}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50 flex-shrink-0"
                  style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', fontFamily: 'var(--font)', cursor: disconnectingKey === p.key ? 'wait' : 'pointer' }}
                >
                  {disconnectingKey === p.key ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />}
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ═══ CONNECT FLOW (inline for a chosen platform) ═══ */}
        {connectTarget && (
          <div className="card p-6 mb-4" style={{ background: 'var(--surface-1)', border: `1px solid ${avatar.accent}33` }}>
            <div className="flex items-start gap-3 mb-4">
              <span className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${avatar.accent}1a`, border: `1px solid ${avatar.accent}33`, color: avatar.accent }}>
                <Link2 size={18} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Connect {connectTarget.label}</p>
                <p className="text-xs mt-1 font-light leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {connectTarget.help}
                  {connectTarget.credentialsUrl ? (
                    <>
                      {' '}Get credentials at{' '}
                      <a href={connectTarget.credentialsUrl} target="_blank" rel="noreferrer" style={{ color: avatar.accent }}>{connectTarget.credentialsUrl.replace(/^https?:\/\//, '')}</a>.
                    </>
                  ) : null}
                  {' '}Stored encrypted in the vault on this machine — never sent elsewhere.
                </p>
              </div>
              <button onClick={() => setConnectingKey(null)} style={{ color: 'var(--text-faint)' }} title="Cancel">
                <X size={16} />
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {connectTarget.authMode === 'oauth' && (
                <button
                  onClick={() => void handleSignIn(connectTarget)}
                  disabled={!connectTarget.oauthConfigured || signingInKey === connectTarget.key}
                  className="flex items-center justify-center gap-2 rounded-xl text-sm font-medium disabled:opacity-60"
                  style={{ height: 40, background: avatar.accent, color: '#fff', border: 'none', fontFamily: 'var(--font)', cursor: connectTarget.oauthConfigured ? 'pointer' : 'not-allowed' }}
                  title={connectTarget.oauthConfigured
                    ? 'Sign in through the vendor and grant device access'
                    : 'Set the platform OAuth client id/secret in backend/.env to enable sign-in'}
                >
                  {signingInKey === connectTarget.key
                    ? <Loader2 size={14} className="animate-spin" />
                    : <KeyRound size={14} />}
                  {connectTarget.oauthLabel || 'Sign in'}
                </button>
              )}
              {connectTarget.authMode === 'oauth' && (
                <p className="text-[11px] font-light" style={{ color: 'var(--text-faint)' }}>
                  {connectTarget.oauthConfigured
                    ? 'Opens the vendor consent page in your browser. Tokens stay encrypted in the vault on this machine.'
                    : `Sign-in needs a registered ${connectTarget.label} OAuth app — add its client id and secret to backend/.env, then restart. You can still paste a personal access token below.`}
                </p>
              )}
              {connectTarget.authMode === 'oauth' && (
                <div className="flex items-center gap-2 my-1">
                  <div className="h-px flex-1" style={{ background: 'var(--hairline-strong)' }} />
                  <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>or paste a token</span>
                  <div className="h-px flex-1" style={{ background: 'var(--hairline-strong)' }} />
                </div>
              )}
              {URL_PLATFORMS.has(connectTarget.key) && (
                <div className="flex items-center gap-2 rounded-xl px-3" style={{ height: 40, background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)' }}>
                  <input
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
                    placeholder="Server URL (e.g. http://homeassistant.local:8123)"
                    className="bg-transparent outline-none text-sm flex-1 min-w-0"
                    style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
                    autoComplete="off"
                  />
                </div>
              )}
              <div className="flex gap-2">
                <div className="flex-1 flex items-center gap-2 rounded-xl px-3" style={{ height: 40, background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)' }}>
                  <input
                    type={showPat ? 'text' : 'password'}
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
                    placeholder="Paste access token"
                    className="bg-transparent outline-none text-sm flex-1 min-w-0"
                    style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
                    autoComplete="off"
                  />
                  <button onClick={() => setShowPat(!showPat)} style={{ color: 'var(--text-faint)' }} title={showPat ? 'Hide' : 'Show'}>
                    {showPat ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <button
                  onClick={handleConnect}
                  disabled={connecting || !pat.trim()}
                  className="flex items-center gap-1.5 px-5 rounded-xl text-sm font-medium disabled:opacity-50"
                  style={{ height: 40, background: avatar.accent, color: '#fff', border: 'none', fontFamily: 'var(--font)', cursor: connecting ? 'wait' : 'pointer' }}
                >
                  {connecting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Connect
                </button>
              </div>
              <p className="text-[11px] font-light" style={{ color: 'var(--text-faint)' }}>
                Tokens are validated before saving — if the platform rejects them you'll see the exact reason.
              </p>
            </div>
          </div>
        )}

        {/* ═══ AVAILABLE PLATFORMS (connect cards) ═══ */}
        {!loading && available.length > 0 && !connectTarget && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-5">
            {available.map((p) => (
              <button
                key={p.key}
                onClick={() => (p.authMode === 'oauth' && p.oauthConfigured ? void handleSignIn(p) : openConnect(p))}
                disabled={p.authMode === 'oauth' && p.oauthConfigured && signingInKey === p.key}
                className="sm-card card card-hover p-4 flex flex-col text-left disabled:opacity-60"
                style={{ background: 'var(--surface-1)', cursor: p.authMode === 'oauth' && p.oauthConfigured ? 'pointer' : undefined }}
                title={p.authMode === 'oauth'
                  ? (p.oauthConfigured ? 'Sign in with the vendor' : 'Needs a registered OAuth app in backend/.env — click to paste a token instead')
                  : undefined}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}>
                    <House size={16} style={{ color: 'var(--text-dim)' }} />
                  </div>
                  <Link2 size={14} style={{ color: avatar.accent }} />
                </div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{p.label}</p>
                <p className="text-[11px] font-light mt-1 leading-snug" style={{ color: 'var(--text-dim)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {p.help}
                </p>
                <span className="text-[10px] font-medium mt-auto pt-2" style={{ color: avatar.accent }}>
                  {p.authMode === 'oauth' && p.oauthConfigured
                    ? (signingInKey === p.key ? 'Waiting for consent…' : `${p.oauthLabel || 'Sign in'} →`)
                    : 'Connect →'}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ═══ FILTERS: kind chips · platform chips · layout toggle ═══ */}
        {!loading && devices.length > 0 && (
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
            {availableFilters.map((f) => {
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className="px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors"
                  style={{
                    background: active ? `${avatar.accent}1c` : 'var(--surface-2)',
                    color: active ? avatar.accent : 'var(--text-dim)',
                    border: `1px solid ${active ? `${avatar.accent}44` : 'var(--hairline-strong)'}`,
                    fontFamily: 'var(--font)',
                  }}
                >
                  {f.label}
                </button>
              );
            })}

            {showPlatformChips && (
              <>
                <span className="mx-1 w-px self-stretch" style={{ background: 'var(--hairline-strong)' }} />
                <button
                  onClick={() => setPlatformFilter('all')}
                  className="px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors"
                  style={{
                    background: platformFilter === 'all' ? `${avatar.accent}1c` : 'var(--surface-2)',
                    color: platformFilter === 'all' ? avatar.accent : 'var(--text-dim)',
                    border: `1px solid ${platformFilter === 'all' ? `${avatar.accent}44` : 'var(--hairline-strong)'}`,
                    fontFamily: 'var(--font)',
                  }}
                >
                  All hubs
                </button>
                {platformOptions.map((p) => {
                  const active = platformFilter === p.key;
                  return (
                    <button
                      key={p.key}
                      onClick={() => setPlatformFilter(p.key)}
                      className="px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors"
                      style={{
                        background: active ? `${avatar.accent}1c` : 'var(--surface-2)',
                        color: active ? avatar.accent : 'var(--text-dim)',
                        border: `1px solid ${active ? `${avatar.accent}44` : 'var(--hairline-strong)'}`,
                        fontFamily: 'var(--font)',
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </>
            )}

            <div className="ml-auto flex items-center rounded-lg overflow-hidden flex-shrink-0" style={{ border: '1px solid var(--hairline-strong)' }}>
              {([
                ['rooms', 'Rooms', <Rows3 key="r" size={12} />],
                ['grid', 'Grid', <LayoutGrid key="g" size={12} />],
              ] as const).map(([id, label, icon]) => {
                const active = layout === id;
                return (
                  <button
                    key={id}
                    onClick={() => setLayout(id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium"
                    style={{
                      background: active ? `${avatar.accent}1c` : 'transparent',
                      color: active ? avatar.accent : 'var(--text-faint)',
                      fontFamily: 'var(--font)',
                      cursor: 'pointer',
                    }}
                  >
                    {icon}
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══ ROUTINES ═══ */}
        {connected.length > 0 && (
          <div className="card mb-4" style={{ background: 'var(--surface-1)' }}>
            <button
              onClick={() => setShowSchedules((s) => !s)}
              className="w-full flex items-center gap-2.5 px-4 py-3 text-left"
              style={{ fontFamily: 'var(--font)', cursor: 'pointer' }}
            >
              {showSchedules
                ? <ChevronDown size={13} style={{ color: 'var(--text-faint)' }} />
                : <ChevronRight size={13} style={{ color: 'var(--text-faint)' }} />}
              <Clock size={14} style={{ color: avatar.accent }} />
              <span className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: 'var(--text-primary)' }}>
                Routines
              </span>
              <span className="text-[10px] font-light" style={{ color: 'var(--text-faint)' }}>
                {schedules.length === 0 ? 'none yet' : `${schedules.length} scheduled`}
              </span>
              {!showSchedules && schedules.length > 0 && (
                <span className="text-[10px] font-light ml-auto truncate" style={{ color: 'var(--text-dim)' }}>
                  {(() => {
                    const soonest = schedules
                      .map((s) => nextRunAt(s, now))
                      .filter((d): d is Date => d !== null)
                      .sort((a, b) => a.getTime() - b.getTime())[0];
                    return soonest ? `next ${formatNextRun(soonest, now)}` : '';
                  })()}
                </span>
              )}
            </button>

            {showSchedules && (
              <div className="px-4 pb-4">
                {schedules.length === 0 ? (
                  <p className="text-xs font-light py-3" style={{ color: 'var(--text-dim)' }}>
                    No routines yet. Create one to have Umbra switch a device on or off automatically.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5 mb-3">
                    {schedules.map((s) => {
                      const next = nextRunAt(s, now);
                      const device = devices.find((d) => d.id === s.deviceId);
                      return (
                        <div
                          key={s.id}
                          className="flex items-center gap-3 rounded-lg px-3 py-2.5"
                          style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
                        >
                          <span
                            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                            style={{
                              background: s.command === 'on' ? `${avatar.accent}1c` : 'var(--surface-3)',
                              border: `1px solid ${s.command === 'on' ? `${avatar.accent}44` : 'var(--hairline-strong)'}`,
                            }}
                          >
                            <Power size={12} style={{ color: s.command === 'on' ? avatar.accent : 'var(--text-faint)' }} />
                          </span>

                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                              {s.deviceName} <span style={{ color: 'var(--text-faint)' }}>{s.command}</span>
                            </p>
                            <p className="text-[10px] font-light truncate mt-0.5" style={{ color: 'var(--text-dim)' }}>
                              {formatCadence(s)}
                              {device ? ` · ${device.platformLabel}` : ''}
                            </p>
                          </div>

                          <div className="text-right flex-shrink-0">
                            <p className="text-[11px] font-medium" style={{ color: next ? avatar.accent : 'var(--text-faint)' }}>
                              {next ? formatNextRun(next, now) : 'paused'}
                            </p>
                            {next && (
                              <p className="text-[10px] font-light" style={{ color: 'var(--text-faint)' }}>
                                in {formatCountdown(next.getTime() - now)}
                              </p>
                            )}
                          </div>

                          <button
                            onClick={() => void handleCancelSchedule(s.id)}
                            disabled={cancellingId === s.id}
                            title="Cancel routine"
                            className="flex-shrink-0 rounded-lg p-1.5"
                            style={{
                              background: 'transparent',
                              color: 'var(--text-faint)',
                              border: '1px solid var(--hairline)',
                              cursor: cancellingId === s.id ? 'default' : 'pointer',
                              opacity: cancellingId === s.id ? 0.5 : 1,
                            }}
                          >
                            {cancellingId === s.id
                              ? <Loader2 size={12} className="animate-spin" />
                              : <Trash2 size={12} />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* ── Create form ── */}
                {!showScheduleForm ? (
                  <button
                    onClick={() => setShowScheduleForm(true)}
                    disabled={schedulableDevices.length === 0}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium"
                    style={{
                      background: `${avatar.accent}1c`,
                      color: avatar.accent,
                      border: `1px solid ${avatar.accent}44`,
                      fontFamily: 'var(--font)',
                      cursor: schedulableDevices.length === 0 ? 'default' : 'pointer',
                      opacity: schedulableDevices.length === 0 ? 0.5 : 1,
                    }}
                  >
                    <Plus size={12} /> New routine
                  </button>
                ) : (
                  <div
                    className="rounded-lg p-3.5 flex flex-col gap-2.5"
                    style={{ background: 'var(--surface-2)', border: `1px solid ${avatar.accent}33` }}
                  >
                    <select
                      value={schedForm.deviceId}
                      onChange={(e) => setSchedForm((f) => ({ ...f, deviceId: e.target.value }))}
                      className="w-full rounded-lg px-2.5 py-2 text-xs"
                      style={{ background: 'var(--surface-1)', color: 'var(--text-primary)', border: '1px solid var(--hairline-strong)', fontFamily: 'var(--font)' }}
                    >
                      <option value="">Select a device…</option>
                      {schedulableDevices.map((d) => (
                        <option key={d.id} value={d.id}>{d.name} — {d.platformLabel}</option>
                      ))}
                    </select>

                    <div className="flex flex-wrap gap-2">
                      <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--hairline-strong)' }}>
                        {(['on', 'off'] as const).map((c) => (
                          <button
                            key={c}
                            onClick={() => setSchedForm((f) => ({ ...f, command: c }))}
                            className="px-3 py-1.5 text-[11px] font-medium"
                            style={{
                              background: schedForm.command === c ? `${avatar.accent}1c` : 'transparent',
                              color: schedForm.command === c ? avatar.accent : 'var(--text-faint)',
                              fontFamily: 'var(--font)',
                              cursor: 'pointer',
                            }}
                          >
                            Turn {c}
                          </button>
                        ))}
                      </div>

                      <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--hairline-strong)' }}>
                        {([['at', 'Daily'], ['everyMinutes', 'Interval']] as const).map(([k, label]) => (
                          <button
                            key={k}
                            onClick={() => setSchedForm((f) => ({ ...f, kind: k }))}
                            className="px-3 py-1.5 text-[11px] font-medium"
                            style={{
                              background: schedForm.kind === k ? `${avatar.accent}1c` : 'transparent',
                              color: schedForm.kind === k ? avatar.accent : 'var(--text-faint)',
                              fontFamily: 'var(--font)',
                              cursor: 'pointer',
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      {schedForm.kind === 'at' ? (
                        <input
                          type="time"
                          value={schedForm.at}
                          onChange={(e) => setSchedForm((f) => ({ ...f, at: e.target.value }))}
                          className="rounded-lg px-2.5 py-1.5 text-[11px]"
                          style={{ background: 'var(--surface-1)', color: 'var(--text-primary)', border: '1px solid var(--hairline-strong)', fontFamily: 'var(--font)' }}
                        />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-light" style={{ color: 'var(--text-faint)' }}>every</span>
                          <input
                            type="number"
                            min={1}
                            value={schedForm.everyMinutes}
                            onChange={(e) => setSchedForm((f) => ({ ...f, everyMinutes: Math.max(1, Number(e.target.value) || 1) }))}
                            className="rounded-lg px-2 py-1.5 text-[11px] w-16"
                            style={{ background: 'var(--surface-1)', color: 'var(--text-primary)', border: '1px solid var(--hairline-strong)', fontFamily: 'var(--font)' }}
                          />
                          <span className="text-[11px] font-light" style={{ color: 'var(--text-faint)' }}>min</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleAddSchedule()}
                        disabled={addingSchedule}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium"
                        style={{
                          background: 'var(--accent-gradient)',
                          color: '#fff',
                          border: 'none',
                          fontFamily: 'var(--font)',
                          cursor: addingSchedule ? 'wait' : 'pointer',
                          opacity: addingSchedule ? 0.7 : 1,
                        }}
                      >
                        {addingSchedule && <Loader2 size={11} className="animate-spin" />}
                        Create routine
                      </button>
                      <button
                        onClick={() => setShowScheduleForm(false)}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium"
                        style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--hairline-strong)', fontFamily: 'var(--font)', cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ DEVICE AREA ═══ */}
        {loading ? (
          <div className={gridClass}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="card p-4" style={{ background: 'var(--surface-1)' }}>
                <div className="w-10 h-10 rounded-full mb-3 animate-pulse" style={{ background: 'var(--surface-3)' }} />
                <div className="h-3 rounded mb-2 animate-pulse" style={{ background: 'var(--surface-3)', width: '70%' }} />
                <div className="h-2.5 rounded animate-pulse" style={{ background: 'var(--surface-2)', width: '45%' }} />
              </div>
            ))}
          </div>
        ) : devices.length === 0 ? (
          connected.length === 0 ? (
            <div className="card p-10 flex flex-col items-center justify-center text-center" style={{ background: 'var(--surface-1)' }}>
              <House size={30} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>No smart home platform connected</p>
              <p className="text-xs mt-1 font-light" style={{ color: 'var(--text-dim)' }}>
                Connect SmartThings, Home Assistant, Hubitat, openHAB, Tuya/Smart Life, Hive, Homey, Apple Home, Alexa or Google Home above — then Umbra can see and control everything from one place.
              </p>
            </div>
          ) : (
            <div className="card p-10 flex flex-col items-center justify-center text-center" style={{ background: 'var(--surface-1)' }}>
              <Wifi size={30} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>No devices found</p>
              <p className="text-xs mt-1 font-light" style={{ color: 'var(--text-dim)' }}>
                Connect devices in your platform app and press Refresh.
              </p>
            </div>
          )
        ) : visible.length === 0 ? (
          <div className="card p-10 flex flex-col items-center justify-center text-center" style={{ background: 'var(--surface-1)' }}>
            <House size={30} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>No devices match the current filters</p>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-xs font-medium mt-3 px-3 py-1.5 rounded-lg"
                style={{ background: `${avatar.accent}1c`, color: avatar.accent, border: `1px solid ${avatar.accent}44`, fontFamily: 'var(--font)' }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : layout === 'rooms' ? (
          roomGroups.map(([room, roomDevices]) => {
            const roomOn = roomDevices.filter((d) => d.switchState === 'on').length;
            return (
              <div key={room} className="mb-6">
                <div className="flex items-baseline gap-2 mb-2.5 px-1">
                  <h2 className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: 'var(--text-dim)', fontFamily: 'var(--font)' }}>
                    {room}
                  </h2>
                  <span className="text-[10px] font-light" style={{ color: 'var(--text-faint)' }}>
                    {roomDevices.length} device{roomDevices.length === 1 ? '' : 's'}{roomOn > 0 ? ` · ${roomOn} on` : ''}
                  </span>
                </div>
                <div className={gridClass}>
                  {roomDevices.map(renderCard)}
                </div>
              </div>
            );
          })
        ) : (
          <div className={gridClass}>
            {visible.map(renderCard)}
          </div>
        )}
      </div>

      {/* ═══ TOAST ═══ */}
      {toast && (
        <div
          className="fixed bottom-6 left-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl"
          style={{
            transform: 'translateX(-50%)',
            background: 'var(--surface-3)',
            border: `1px solid ${toast.type === 'success' ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}`,
            boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
          }}
        >
          {toast.type === 'success'
            ? <Wifi size={13} style={{ color: '#22c55e' }} />
            : <X size={13} style={{ color: '#ef4444' }} />}
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{toast.text}</span>
        </div>
      )}
    </div>
  );
}
