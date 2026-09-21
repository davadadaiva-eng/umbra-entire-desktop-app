import { useEffect, useState } from 'react'
import { Menu, X } from 'lucide-react'

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260803_192301_9231ed6b-c55c-4a48-909c-4ebe11cf2e11.mp4'

const API = (typeof window !== 'undefined' && (window as any).__UMBRA_API__) || 'http://127.0.0.1:8787'
const GRADIENT = '[background:linear-gradient(to_bottom,#2B2B2B,#101010)]'

function Logo({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M 128 128 C 128 198.692 70.692 256 0 256 C 0 185.308 57.308 128 128 128 Z M 128 128 C 198.692 128 256 185.308 256 256 C 185.308 256 128 198.692 128 128 Z M 0 0 C 70.692 0 128 57.308 128 128 C 57.308 128 0 70.692 0 0 Z M 256 0 C 256 70.692 198.692 128 128 128 C 128 57.308 185.308 0 256 0 Z"
      />
    </svg>
  )
}

function Dashboard() {
  const [status, setStatus] = useState<any>(null)
  const [tasks, setTasks] = useState<any[]>([])
  const [logins, setLogins] = useState<any[]>([])
  const [input, setInput] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [liveImg, setLiveImg] = useState<string | null>(null)

  async function refresh() {
    try {
      const s = await fetch(`${API}/api/status`).then(r => r.json())
      setStatus(s)
      const t = await fetch(`${API}/api/tasks`).then(r => r.json())
      setTasks(t.tasks || [])
      const l = await fetch(`${API}/api/chrome/logins`).then(r => r.json()).catch(() => [])
      setLogins(Array.isArray(l) ? l : (l as any).logins || [])
      setErr(null)
    } catch (e: any) { setErr(String(e.message || e)) }
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id) }, [])
  useEffect(() => {
    let ws: WebSocket | null = null
    try {
      ws = new WebSocket(`${API.replace('http', 'ws')}/api/ws`)
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'event' && String(msg.name).startsWith('task:')) refresh()
        } catch {}
      }
    } catch {}
    return () => { try { ws?.close() } catch {} }
  }, [])
  // preview stream
  useEffect(() => {
    let ws: WebSocket | null = null; let timer: any = null
    try {
      ws = new WebSocket(API.replace('http', 'ws').replace('8787', '9090'))
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'subscribe' }))
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data)
          if (m.type === 'frame' && m.image) setLiveImg(`data:image/png;base64,${m.image}`)
        } catch {}
      }
    } catch {}
    return () => { clearInterval(timer); try { ws?.close() } catch {} }
  }, [])

  async function submit() {
    if (!input.trim()) return
    await fetch(`${API}/api/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: input }) })
    setInput(''); refresh()
  }
  async function approveLogin(u: string, p: string) {
    await fetch(`${API}/api/chrome/logins/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u, provider: p }) })
    refresh()
  }

  return (
    <div className="min-h-screen bg-[#0a0a12] text-white p-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Logo className="h-6 w-6" /><span className="font-semibold">umbra</span><span className="ml-2 text-xs opacity-60">dashboard</span></div>
          <a href="#" onClick={(e)=>{e.preventDefault(); location.hash=''; location.reload()}} className="text-sm opacity-70 hover:opacity-100">landing →</a>
        </div>
        {err && <div className="mt-4 rounded bg-red-900/50 p-3 text-sm">{err} — is Umbra running on :8787?</div>}
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-white/5 p-4 backdrop-blur"><div className="text-xs opacity-60">Agent</div><div className="text-sm">{status?.agent ? `${status.agent.activeTasks} active` : '—'} {status?.consent?.emergencyStopArmed ? '· STOP ARMED' : ''}</div></div>
          <div className="rounded-xl bg-white/5 p-4 backdrop-blur"><div className="text-xs opacity-60">Desktop2</div><div className="text-sm">{status?.desktop2 ? `${status.desktop2.isRunning ? 'running' : 'idle'} · ${status.desktop2.pageUrl || ''}` : '—'}</div></div>
          <div className="rounded-xl bg-white/5 p-4 backdrop-blur"><div className="text-xs opacity-60">Chrome Link</div><div className="text-sm">{status?.chromeExtension ? `${status.chromeExtension.eventCount} events · ${status.chromeExtension.loginEvents} logins` : '—'}</div></div>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl bg-white/5 p-4">
            <div className="font-medium">Ask Umbra</div>
            <div className="mt-3 flex gap-2"><input value={input} onChange={e=>setInput(e.target.value)} placeholder="Do a task: open chrome, research, etc." className="flex-1 rounded bg-white px-3 py-2 text-sm text-black outline-none" /><button onClick={submit} className={`rounded-full px-5 py-2 text-sm text-white ${GRADIENT}`}>Run</button></div>
            <div className="mt-4 space-y-2 max-h-64 overflow-auto">{tasks.length===0 ? <div className="text-sm opacity-60">No active tasks</div> : tasks.map((t:any)=>(<div key={t.id} className="rounded bg-black/30 p-2 text-xs"><div className="font-mono">{t.id.slice(0,8)} · {t.status}</div><div className="opacity-80">{t.description}</div></div>))}</div>
          </div>
          <div className="rounded-xl bg-white/5 p-4">
            <div className="font-medium">Live preview :9090</div>
            <div className="mt-3 aspect-video overflow-hidden rounded bg-black">{liveImg ? <img src={liveImg} className="h-full w-full object-contain" /> : <div className="flex h-full items-center justify-center text-sm opacity-60">No frame — open Desktop2/Chrome</div>}</div>
            <div className="mt-3 flex gap-2"><button onClick={async()=>{await fetch(`${API}/api/desktop2/action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'screenshot',params:{}})}); refresh()}} className="rounded bg-white/10 px-3 py-1.5 text-xs">Screenshot</button><button onClick={refresh} className="rounded bg-white/10 px-3 py-1.5 text-xs">Refresh</button></div>
          </div>
        </div>
        <div className="mt-6 rounded-xl bg-white/5 p-4">
          <div className="font-medium">Logins detected — approve to save to vault</div>
          <div className="mt-3 space-y-2 max-h-48 overflow-auto">{logins.length===0 ? <div className="text-sm opacity-60">No logins yet — log in somewhere in Chrome with the extension installed</div> : logins.slice(0,20).map((l:any,i:number)=>(<div key={i} className="flex items-center justify-between rounded bg-black/30 p-2 text-xs"><span>{l.provider} · {l.url.slice(0,60)}</span><button onClick={()=>approveLogin(l.url,l.provider)} className="rounded bg-emerald-600 px-3 py-1">Approve</button></div>))}</div>
        </div>
        <div className="mt-6 rounded-xl bg-white/5 p-4">
          <div className="text-xs opacity-60">Memory · Voice · Meetings</div>
          <div className="mt-2 grid gap-3 md:grid-cols-3 text-xs">
            <div>Voice: {status?.voiceStack ? JSON.stringify(status.voiceStack.ok ?? status.voiceStack) : '—'} <a href={`${API}/api/voice/health?refresh=1`} target="_blank" className="underline">health</a></div>
            <div>Meetings: <a href={`${API}/api/meeting/status`} target="_blank" className="underline">/api/meeting/status</a> · <a href={`${API}/api/audio/devices`} target="_blank" className="underline">audio devices</a></div>
            <div>Memory: <button onClick={async()=>{const q=prompt('recall query?'); if(!q) return; const r=await fetch(`${API}/api/memory/recall?q=${encodeURIComponent(q)}`).then(r=>r.json()); alert(JSON.stringify(r).slice(0,2000))}} className="underline">recall</button> · <button onClick={async()=>{const t=prompt('remember fact?'); if(!t) return; await fetch(`${API}/api/memory/remember`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})}); refresh()}} className="underline">remember</button></div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [open, setOpen] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const isDashboard = typeof window !== 'undefined' && (location.hash === '#dashboard' || location.search.includes('dashboard'))
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = '' } }, [open])
  if (isDashboard) return <Dashboard />
  return (
    <section className="relative h-screen w-full overflow-hidden">
      <video className="absolute inset-0 h-full w-full object-cover" src={VIDEO_URL} autoPlay loop muted playsInline />
      <div className="relative z-10 flex h-full flex-col">
        <nav className="px-5 py-5 sm:px-8 sm:py-6 lg:px-12">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[#010101] lg:text-white"><Logo className="h-6 w-6" /><span className="text-lg font-semibold">umbra</span></div>
            <div className="hidden md:flex items-center gap-3">
              <a href="#dashboard" className="rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-[#010101] backdrop-blur lg:text-white">Dashboard →</a>
              <button className={`rounded-full px-5 py-2.5 text-sm font-medium text-white ${GRADIENT}`}>Get started</button>
            </div>
            <button aria-label="Toggle menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={`relative z-50 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-lg md:hidden ${open ? 'text-white' : 'text-[#010101]'}`}>
              <Menu className={`absolute h-5 w-5 transition-all duration-300 ${open ? 'rotate-90 scale-0 opacity-0' : 'rotate-0 scale-100 opacity-100'}`} />
              <X className={`absolute h-5 w-5 transition-all duration-300 ${open ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0'}`} />
            </button>
          </div>
        </nav>
        <div onClick={() => setOpen(false)} className={`fixed inset-0 z-40 bg-black/80 backdrop-blur-md transition-opacity ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`} />
        <aside className={`fixed right-0 top-0 z-40 flex h-full w-72 flex-col bg-black/90 backdrop-blur-xl transition-transform duration-500 ${open ? 'translate-x-0' : 'translate-x-full'}`}>
          <div className="mt-auto px-6 pb-10 space-y-3"><a href="#dashboard" className={`block w-full rounded-full bg-white/10 py-3.5 text-center text-sm font-medium text-white ${GRADIENT}`}>Open Dashboard</a><button className={`w-full rounded-full py-3.5 text-sm font-medium text-white ${GRADIENT}`}>Get started</button></div>
        </aside>
        <main className="mt-auto px-5 pb-8 sm:px-8 sm:pb-12 lg:px-12 lg:pb-16">
          <div className="flex flex-col gap-6 sm:gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-xl">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 backdrop-blur-lg"><span className="h-1.5 w-1.5 rounded-full bg-[#010101] lg:bg-white" /><span className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#010101]/70 lg:text-white/70">Umbra OS</span></div>
              <h1 className="text-3xl font-semibold leading-[1.1] tracking-tight text-[#010101] sm:text-4xl lg:text-[3.5rem] lg:text-white">Ship AI workers that grind while you rest</h1>
              {submitted ? <div className="mt-6 flex items-center gap-3 rounded-full bg-white/10 px-6 py-3.5 text-sm text-[#010101] backdrop-blur lg:text-white"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />You’re on the list — watch your inbox. <a href="#dashboard" className="ml-2 underline">Open dashboard →</a></div> : <form onSubmit={(e)=>{e.preventDefault(); setSubmitted(true)}} className="mt-6 flex flex-col gap-3 sm:mt-8 sm:inline-flex sm:flex-row sm:items-center sm:rounded-full sm:bg-white sm:p-1.5"><input type="email" required placeholder="Type your email" className="rounded-full bg-white px-5 py-3 text-sm text-gray-900 outline-none placeholder-gray-400 sm:w-64 sm:rounded-none sm:bg-transparent sm:px-4 sm:py-2" /><button type="submit" className={`rounded-full px-6 py-3 text-sm font-medium text-white sm:py-2.5 ${GRADIENT}`}>Get started</button></form>}
            </div>
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex flex-col justify-between rounded-2xl bg-white/10 p-5 backdrop-blur sm:w-64 sm:p-6"><div><p className="font-silkscreen text-3xl font-normal tracking-tight text-[#010101] sm:text-4xl lg:text-white">42,500+</p><p className="mt-3 text-sm leading-relaxed text-[#010101]/70 lg:text-white/70">Teams run Umbra to handle recurring ops daily.</p></div><a href="#dashboard" className="mt-4 inline-block text-xs underline opacity-70">Try live dashboard →</a></div>
              <div className="rounded-2xl bg-white/10 p-5 backdrop-blur sm:w-64 sm:p-6"><div className="mb-3 flex items-center gap-2"><div className="flex h-6 w-6 items-center justify-center rounded-lg bg-black"><span className="text-sm font-bold text-white">S</span></div><span className="text-sm font-semibold text-[#010101] lg:text-white">Stratify</span></div><p className="text-sm leading-relaxed text-[#010101]/80 lg:text-white/80">“With Umbra we went from tedious ops to AI agents that handle everything.”</p><div className="mt-4 flex items-center gap-3"><img src="https://i.pravatar.cc/72?img=12" alt="Sara Klein" className="h-9 w-9 rounded-full object-cover" /><div><p className="text-sm font-semibold text-[#010101] lg:text-white">Sara Klein</p><p className="text-xs text-[#010101]/60 lg:text-white/60">Dir of Operations</p></div></div></div>
            </div>
          </div>
        </main>
      </div>
    </section>
  )
}
