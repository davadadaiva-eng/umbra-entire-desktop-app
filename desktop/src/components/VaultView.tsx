import { useRef, useEffect, useState } from 'react';
import gsap from 'gsap';
import { useAppStore } from '../stores/appStore';
import { isBackendAvailable, getAuditStats, getVaultEntries, setVaultEntry, deleteVaultEntry, type VaultEntry as BackendVaultEntry, type BackendError } from '../lib/backend';
import { Search, Plus, Copy, Trash2, Lock, Globe, CreditCard, Wifi, KeyRound, Mail, Eye, EyeOff, Check, Shield } from 'lucide-react';

interface VaultItem {
  id: string;
  kind: 'password' | 'email' | 'card' | 'note' | 'wifi';
  name: string;
  username?: string;
  secret?: string;
  url?: string;
}

type VaultKind = VaultItem['kind'];

const KIND_META: Record<VaultKind, { icon: typeof Globe; label: string }> = {
  password: { icon: KeyRound, label: 'Password' },
  email: { icon: Mail, label: 'Email' },
  card: { icon: CreditCard, label: 'Card' },
  note: { icon: Lock, label: 'Note' },
  wifi: { icon: Wifi, label: 'WiFi' },
};

const KIND_OPTIONS: VaultKind[] = ['password', 'email', 'card', 'wifi', 'note'];

function toVaultItem(e: BackendVaultEntry): VaultItem {
  // Map backend service -> kind heuristic; store kind in username prefix if needed, else default password
  const service = e.service || '';
  const lower = service.toLowerCase();
  let kind: VaultKind = 'password';
  if (lower.includes('wifi') || lower.includes('wpa')) kind = 'wifi';
  else if (lower.includes('card') || lower.includes('visa') || lower.includes('amex')) kind = 'card';
  else if (lower.includes('note') || lower.includes('recovery')) kind = 'note';
  else if (lower.includes('mail') || lower.includes('email')) kind = 'email';
  return { id: e.id, kind, name: service, username: e.username, secret: e.secret, url: '' };
}

export function VaultView() {
  const { avatar } = useAppStore();
  const headerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftKind, setDraftKind] = useState<VaultKind>('password');
  const [draft, setDraft] = useState<{ name: string; secret: string; username: string }>({ name: '', secret: '', username: '' });
  const [auditStats, setAuditStats] = useState<Record<string, unknown> | null>(null);
  const [auditError, setAuditError] = useState('');
  const [vaultError, setVaultError] = useState('');

  const loadVault = async () => {
    setLoading(true);
    setVaultError('');
    try {
      const online = await isBackendAvailable();
      setBackendOnline(online);
      if (!online) {
        setVaultError('Backend offline — vault requires Umbra backend (AES-256-GCM, HWID+DPAPI). Start backend to manage credentials securely.');
        setItems([]);
        return;
      }
      const res = await getVaultEntries();
      const mapped = (res.entries || []).map(toVaultItem);
      // Hide internal smartthings PAT from the Vault UI (managed via Smart Home)
      setItems(mapped.filter(i => i.name !== 'smartthings'));
    } catch (e) {
      setVaultError((e as BackendError).message || 'Failed to load vault');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadVault();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!(await isBackendAvailable())) return;
      try {
        const stats = await getAuditStats();
        if (cancelled || !stats) return;
        setAuditStats(stats as Record<string, unknown>);
      } catch (e) {
        if (!cancelled) setAuditError((e as BackendError).message || 'Failed to load audit stats');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power2.out', duration: 0.4 } });
      tl.fromTo(headerRef.current, { opacity: 0, y: 12 }, { opacity: 1, y: 0 });
      if (listRef.current) {
        tl.fromTo(listRef.current.querySelectorAll('.vault-row'), { opacity: 0, y: 10 }, { opacity: 1, y: 0, stagger: 0.03 }, '-=0.15');
      }
    }, [headerRef, listRef]);
    return () => ctx.revert();
  }, [items.length]);

  const filtered = items.filter((i) => `${i.name} ${i.username} ${i.url}`.toLowerCase().includes(query.toLowerCase()));

  const copy = async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item?.secret) return;
    try {
      await navigator.clipboard.writeText(item.secret);
    } catch {
      // fallback: create temp textarea
      const ta = document.createElement('textarea');
      ta.value = item.secret;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(id);
    setTimeout(() => setCopied(null), 1400);
  };

  const remove = async (id: string) => {
    try {
      await deleteVaultEntry(id);
      setItems((cur) => cur.filter((i) => i.id !== id));
    } catch (e) {
      setVaultError((e as BackendError).message || 'Delete failed');
    }
  };

  const addItem = async () => {
    if (!draft.name.trim() || !draft.secret.trim()) return;
    try {
      const res = await setVaultEntry({ service: draft.name.trim(), username: draft.username.trim(), secret: draft.secret });
      const item = toVaultItem(res.entry as BackendVaultEntry);
      // Preserve chosen kind for display (store kind hint in service? we already map)
      (item as VaultItem).kind = draftKind;
      setItems((cur) => [...cur, item]);
      setDraft({ name: '', secret: '', username: '' });
      setAdding(false);
      setVaultError('');
    } catch (e) {
      setVaultError((e as BackendError).message || 'Save failed');
    }
  };

  const auditEntries = auditStats ? (auditStats.entries ?? auditStats.totalEntries ?? 0) : 0;
  const auditLastTime = auditStats?.lastEntryTime ? new Date(String(auditStats.lastEntryTime)) : null;
  const auditIntegrity = auditStats?.integrity === true || auditStats?.integrityOk === true || (auditStats as any)?.chainValid === true;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div ref={headerRef} className="px-6 py-5 hairline-b flex items-end justify-between gap-4" style={{ background: 'rgba(6,7,9,0.68)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }}>
        <div>
          <h1 className="hero-heading font-black uppercase tracking-tight leading-none" style={{ fontSize: 'clamp(1.6rem, 3.5vw, 2.4rem)' }}>Vault</h1>
          <p className="text-sm mt-1 font-light" style={{ color: 'var(--text-dim)' }}>
            {loading ? 'Loading...' : `${items.length} items · AES-256-GCM · HWID+DPAPI · ${backendOnline ? 'backend' : 'offline'}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 rounded-xl" style={{ height: 34, background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)' }}>
            <Search size={13} style={{ color: 'var(--text-faint)' }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search vault…"
              className="bg-transparent outline-none text-sm w-40"
              style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
            />
          </div>
          <button onClick={() => setAdding((v) => !v)} className="flex items-center gap-1.5 px-3.5 rounded-xl" style={{ height: 34, background: avatar.accent, color: '#fff', border: 'none', fontFamily: 'var(--font)', fontSize: 12 }}>
            <Plus size={13} /> {adding ? 'Cancel' : 'Add item'}
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-6 py-5" style={{ maxWidth: 880, width: '100%', margin: '0 auto' }}>
        {vaultError && (
          <div className="card p-3 mb-4 flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <Lock size={14} style={{ color: '#ef4444' }} />
            <p className="text-xs" style={{ color: '#ef4444' }}>{vaultError}</p>
            <button onClick={() => void loadVault()} className="ml-auto text-[11px] px-2 py-1 rounded-md" style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}>Retry</button>
          </div>
        )}
        {auditStats && (
          <div className="card p-4 mb-4" style={{ background: 'var(--surface-1)' }}>
            <div className="flex items-center gap-2.5 mb-3">
              <span className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${avatar.accent}1c`, color: avatar.accent, border: `1px solid ${avatar.accent}44` }}>
                <Shield size={14} />
              </span>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}>Audit Vault</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}>
                <p className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>Log entries</p>
                <p className="mt-1 text-lg font-bold tabular-nums" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}>{String(auditEntries)}</p>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}>
                <p className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>Last entry</p>
                <p className="mt-1 text-sm font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}>
                  {auditLastTime ? auditLastTime.toLocaleDateString() : '—'}
                </p>
                {auditLastTime && (
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-faint)' }}>{auditLastTime.toLocaleTimeString()}</p>
                )}
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}>
                <p className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>Integrity</p>
                <p className="mt-1 text-sm font-semibold flex items-center gap-1.5" style={{ color: auditIntegrity ? '#22c55e' : '#f59e0b', fontFamily: 'var(--font)' }}>
                  {auditIntegrity ? <Check size={12} /> : <Lock size={12} />}
                  {auditIntegrity ? 'Verified' : 'Pending'}
                </p>
              </div>
            </div>
            {auditError && (
              <p className="text-[11px] mt-2" style={{ color: '#f59e0b' }}>Audit stats unavailable: {auditError}</p>
            )}
          </div>
        )}

        {adding && (
          <div className="card p-4 mb-4" style={{ background: 'var(--surface-1)' }}>
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              {KIND_OPTIONS.map((k) => (
                <button
                  key={k}
                  onClick={() => setDraftKind(k)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors"
                  style={{
                    background: draftKind === k ? `${avatar.accent}22` : 'var(--surface-2)',
                    border: `1px solid ${draftKind === k ? avatar.accent + '66' : 'var(--hairline-strong)'}`,
                    color: draftKind === k ? avatar.accent : 'var(--text-dim)',
                    fontFamily: 'var(--font)',
                  }}
                >
                  {(() => {
                    const Icon = KIND_META[k].icon;
                    return <Icon size={11} />;
                  })()}
                  {KIND_META[k].label}
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Service — e.g. GitHub"
                className="flex-1 px-3 py-2 rounded-xl outline-none text-sm"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
              />
              <input
                value={draft.username}
                onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
                placeholder="Username"
                className="flex-1 px-3 py-2 rounded-xl outline-none text-sm"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
              />
              <input
                value={draft.secret}
                onChange={(e) => setDraft((d) => ({ ...d, secret: e.target.value }))}
                placeholder="Secret"
                className="flex-1 px-3 py-2 rounded-xl outline-none text-sm"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
              />
              <button onClick={() => void addItem()} className="px-4 rounded-xl text-sm" style={{ background: avatar.accent, color: '#fff', border: 'none', fontFamily: 'var(--font)' }}>
                Save
              </button>
            </div>
            <p className="text-[11px] mt-2" style={{ color: 'var(--text-faint)' }}>Encrypted at rest (AES-256-GCM, HWID+DPAPI). Stored in <code>C:\Users\...\.umbra\vault.bin</code>.</p>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-center py-12" style={{ color: 'var(--text-faint)' }}>Loading vault…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm font-light text-center py-16" style={{ color: 'var(--text-faint)' }}>{items.length === 0 ? 'Vault is empty — add your first credential.' : `Nothing matches "${query}".`}</p>
        ) : (
          filtered.map((i) => {
            const Icon = KIND_META[i.kind].icon;
            const isRevealed = revealed.has(i.id);
            const isCopied = copied === i.id;
            return (
              <div key={i.id} className="vault-row card flex items-center gap-4 px-4 py-3 mb-2 group" style={{ background: 'var(--surface-1)' }}>
                <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--surface-2)', color: avatar.accent, border: '1px solid var(--hairline-strong)' }}>
                  <Icon size={15} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font)' }}>{i.name}</span>
                    {i.username && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-md" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--hairline)', color: 'var(--text-faint)' }}>{i.username}</span>
                    )}
                  </div>
                  <p className="text-[11px] font-mono mt-0.5 truncate" style={{ color: isRevealed ? 'var(--text-primary)' : 'var(--text-faint)' }}>
                    {isRevealed ? i.secret : '••••••••••••'}
                  </p>
                </div>
                <button
                  onClick={() => { setRevealed((r) => { const n = new Set(r); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; }); }}
                  className="w-7 h-7 rounded-md flex items-center justify-center transition-colors opacity-60 group-hover:opacity-100"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: 'var(--text-dim)' }}
                  title="Reveal / hide"
                >
                  {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button
                  onClick={() => void copy(i.id)}
                  className="w-7 h-7 rounded-md flex items-center justify-center transition-colors opacity-60 group-hover:opacity-100"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: isCopied ? '#22c55e' : 'var(--text-dim)' }}
                  title="Copy to clipboard"
                >
                  {isCopied ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <button
                  onClick={() => void remove(i.id)}
                  className="w-7 h-7 rounded-md flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)', color: '#ef4444' }}
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
