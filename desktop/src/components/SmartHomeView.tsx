import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import gsap from 'gsap';
import { useAppStore } from '../stores/appStore';
import {
  getSmartHomePlatforms,
  connectSmartHomePlatform,
  disconnectSmartHomePlatform,
  fetchSmartHomeDevicesViaBackend,
  smartHomeSwitch,
  type SmartHomePlatformInfo,
  type SmartHomeDeviceAny,
} from '../lib/backend';
import {
  Lightbulb, Plug, ToggleLeft, Thermometer, Lock, Radio, Camera, Speaker, HelpCircle, RefreshCw,
  Loader2, House, Wifi, WifiOff, X, Eye, EyeOff, CheckCircle2, Link2, Unlink, LayoutGrid, Rows3,
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
                onClick={() => openConnect(p)}
                className="sm-card card card-hover p-4 flex flex-col text-left"
                style={{ background: 'var(--surface-1)' }}
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
                <span className="text-[10px] font-medium mt-auto pt-2" style={{ color: avatar.accent }}>Connect →</span>
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
