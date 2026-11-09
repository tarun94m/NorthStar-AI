import { FormEvent, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import 'highlight.js/styles/github-dark.css';

const MarkdownMessage = lazy(() => import('./MarkdownMessage.js'));

type Message = { id: string; role: 'user'|'assistant'; content: string; status: string; estimatedCost?: number|null; inputTokens?: number|null; outputTokens?: number|null };
type Conversation = { id: string; title: string; model: string; messages: Message[] };
type Model = { id: string; provider: string; model: string; label: string; description: string; available: boolean; availability: string; capabilities: { streaming: boolean; nonStreaming: boolean; text: boolean }; contextWindow: number; maxOutputTokens: number; parameters: Record<string, { type: 'number'; min: number; max: number; default?: number }> };
type User = { id: string; email: string|null; isGuest: boolean };
const api = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(url, { ...init, credentials: 'include', headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `Request failed (${response.status})`); }
  if (response.status === 204) return null;
  return response.json();
};

export default function App() {
  const [user, setUser] = useState<User|null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string|null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('openai:gpt-4.1-mini');
  const [providerName, setProviderName] = useState('mock');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login'|'register'>('register');
  const [mobileNav, setMobileNav] = useState(false);
  const [filter, setFilter] = useState('');
  const [cost, setCost] = useState<number|null>(null);
  const [guestLimit, setGuestLimit] = useState(12);
  const [theme, setTheme] = useState<'dark'|'light'>(() => localStorage.getItem('northstar-theme') === 'light' ? 'light' : 'dark');
  const bootedRef = useRef(false);
  const abortRef = useRef<AbortController|null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string|null>(null);
  const current = conversations.find(c => c.id === active);
  const persistedStreaming = Boolean(current?.messages.some(m => m.status === 'streaming'));

  const refresh = useCallback(async (selectId?: string) => {
    const data = await api('/api/conversations');
    setConversations(data.conversations);
    if (selectId) { setActive(selectId); activeRef.current = selectId; }
  }, []);
  useEffect(() => {
    (async () => {
      if (bootedRef.current) return;
      bootedRef.current = true;
      try {
        let auth;
        try { auth = await api('/api/auth/me'); }
        catch { auth = await api('/api/auth/guest', { method: 'POST' }); }
        setUser(auth.user); setProviderName(auth.provider || 'mock'); setGuestLimit(auth.guestDailyMessageLimit ?? 12);
        const modelData = await api('/api/models'); setModels(modelData.models);
        const firstAvailable = modelData.models.find((model: Model) => model.available);
        if (firstAvailable) setModelId(firstAvailable.id);
        await refresh();
      } catch (e) { setError((e as Error).message); }
    })();
  }, [refresh]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => {
    if (!persistedStreaming || busy || !active) return;
    const timer = window.setInterval(() => { void refresh(active).catch(() => {}); }, 1500);
    return () => window.clearInterval(timer);
  }, [persistedStreaming, busy, active, refresh]);
  useEffect(() => { localStorage.setItem('northstar-theme', theme); }, [theme]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: busy ? 'smooth' : 'auto' }); }, [conversations, active, busy]);

  async function newChat() {
    try { const result = await api('/api/conversations', { method: 'POST', body: '{}' }); await refresh(result.conversation.id); setMobileNav(false); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  async function stream(content?: string, regenerate = false) {
    const conversationId = activeRef.current;
    if (!conversationId || busy) return;
    const controller = new AbortController(); abortRef.current = controller; setBusy(true); setError(''); setCost(null);
    if (content) setInput('');
    try {
      const response = await fetch('/api/chat/stream', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, content, modelId, regenerate }), signal: controller.signal });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || 'Could not send message.'); }
      if (!response.body) throw new Error('Streaming is unavailable in this browser.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let assistantId = ''; let replacement = '';
      const upsertAssistant = (text: string, status = 'streaming') => {
        if (!assistantId) return;
        setConversations(prev => prev.map(c => c.id !== conversationId ? c : ({ ...c, messages: [...c.messages.filter(m => m.id !== assistantId), { id: assistantId, role: 'assistant', content: text, status }] })));
      };
      const handle = (block: string) => {
        const event = block.match(/^event: (.+)$/m)?.[1]; const raw = block.match(/^data: (.+)$/m)?.[1]; if (!event || !raw) return;
        const data = JSON.parse(raw);
        if (event === 'meta') {
          assistantId = data.assistantMessageId; setProviderName(data.provider);
          setConversations(prev => {
            const conv = prev.find(c => c.id === conversationId); if (!conv) return prev;
            const userMessage = content ? { id: data.userMessageId, role: 'user' as const, content, status: 'complete' } : null;
            return prev.map(c => {
              if (c.id !== conversationId) return c;
              const reverseIndex = [...c.messages].reverse().findIndex(m => m.role === 'user');
              const lastUserIndex = reverseIndex < 0 ? -1 : c.messages.length - 1 - reverseIndex;
              const baseMessages = userMessage ? [...c.messages, userMessage] : c.messages.slice(0, lastUserIndex + 1);
              return { ...c, title: c.title === 'New chat' && content ? content.slice(0, 60) : c.title, messages: [...baseMessages, { id: assistantId, role: 'assistant', content: '', status: 'streaming' }] };
            });
          });
        } else if (event === 'delta') { replacement += data.text; upsertAssistant(replacement); }
        else if (event === 'done') { setCost(data.estimatedCost); upsertAssistant(replacement, data.status); }
        else if (event === 'error') { setError(data.error); upsertAssistant(replacement, data.partial ? 'partial' : 'error'); }
      };
      while (true) {
        const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let divider; while ((divider = buffer.indexOf('\n\n')) >= 0) { handle(buffer.slice(0, divider)); buffer = buffer.slice(divider + 2); }
        if (done) break;
      }
      await refresh(conversationId);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      await refresh(conversationId).catch(() => {});
    } finally { setBusy(false); abortRef.current = null; }
  }
  function submit(e: FormEvent) { e.preventDefault(); const message = input.trim(); if (!message) return; if (!active) { void createAndSend(message); return; } void stream(message); }
  async function createAndSend(message: string) { try { const result = await api('/api/conversations', { method: 'POST', body: '{}' }); const id = result.conversation.id; await refresh(id); activeRef.current = id; setTimeout(() => void stream(message), 0); } catch (e) { setError((e as Error).message); } }
  async function authSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const data = new FormData(e.currentTarget); setError('');
    try { const result = await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) }); setUser(result.user); setAuthOpen(false); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }
  async function signOut() { try { await api('/api/auth/logout', { method: 'POST' }); setUser(null); setConversations([]); setActive(null); const result = await api('/api/auth/guest', { method: 'POST' }); setUser(result.user); setProviderName(result.provider); setGuestLimit(result.guestDailyMessageLimit ?? 12); } catch (e) { setError((e as Error).message); } }
  async function rename(c: Conversation) { const title = prompt('Rename conversation', c.title); if (!title?.trim()) return; try { await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ title }) }); await refresh(active ?? undefined); } catch (e) { setError((e as Error).message); } }
  async function remove(c: Conversation) { if (!confirm(`Delete “${c.title}”?`)) return; try { await api(`/api/conversations/${c.id}`, { method: 'DELETE' }); if (active === c.id) setActive(null); await refresh(); } catch (e) { setError((e as Error).message); } }
  async function editMessage(m: Message) { const content = prompt('Edit your message', m.content); if (!content?.trim()) return; try { await api(`/api/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ content }) }); await refresh(active ?? undefined); } catch (e) { setError((e as Error).message); } }
  const visible = conversations.filter(c => c.title.toLowerCase().includes(filter.toLowerCase()));
  const selectedModel = models.find(m => m.id === modelId);

  return <div className={`app-shell ${theme === 'light' ? 'light-theme' : ''}`}>
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark">✳</div><span>northstar</span><button className="mobile-close" onClick={() => setMobileNav(false)}>×</button></div>
      <button className="new-chat" onClick={newChat}><span>＋</span> New chat <kbd>⌘ K</kbd></button>
      <div className="side-label">YOUR SPACE</div>
      <div className="search-box"><span>⌕</span><input aria-label="Search conversations" placeholder="Search conversations" value={filter} onChange={e => setFilter(e.target.value)} /></div>
      <div className="history-label">Recent</div>
      <nav className="conversation-list">{visible.map(c => <div key={c.id} className={`conversation-row ${active === c.id ? 'selected' : ''}`}><button onClick={() => { setActive(c.id); setMobileNav(false); }} title={c.title}><span className="chat-icon">◌</span><span className="row-title">{c.title}</span></button><div className="row-actions"><button aria-label="Rename conversation" onClick={() => void rename(c)}>···</button><button aria-label="Delete conversation" onClick={() => void remove(c)}>×</button></div></div>)}</nav>
      <div className="sidebar-bottom"><div className="profile-avatar">{user?.email?.[0]?.toUpperCase() || 'G'}</div><div className="profile-info"><b>{user?.email || 'Guest session'}</b><small>{user?.isGuest ? 'Limited access' : 'Personal workspace'}</small></div><button className="profile-menu" aria-label="Sign out" onClick={() => user?.isGuest ? setAuthOpen(true) : void signOut()}>···</button></div>
    </aside>
    {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
    <main className="main-panel">
      <header className="topbar"><div className="top-left"><button className="menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation">☰</button><span className="breadcrumb">Workspace <span>/</span> <b>{current?.title || 'New chat'}</b></span></div><div className="top-right"><label className="model-label">MODEL</label><select aria-label="Select AI model" value={modelId} onChange={e => setModelId(e.target.value)}>{models.map(m => <option key={m.id} value={m.id} disabled={!m.available}>{m.label}{!m.available ? ' · unavailable' : ''}</option>)}</select><span className={`provider-pill ${(selectedModel?.provider || providerName) === 'mock' ? 'mock' : ''}`} title={selectedModel?.description || 'Configured AI provider'}>{selectedModel?.provider === 'mock' ? '◉ Mock' : selectedModel?.provider === 'gemini' ? '● Gemini' : selectedModel ? '● OpenAI' : '● Provider'}</span><button className="theme-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☼' : '☾'}</button></div></header>
      <section className="chat-area">
        {!current || current.messages.length === 0 ? <div className="welcome"><div className="welcome-symbol">✳</div><p className="eyebrow">A CLEARER WAY FORWARD</p><h1>What can I help you<br/><em>think through?</em></h1><p className="welcome-sub">Ask a question, explore an idea, or bring a challenge.<br/>We’ll work through it together.</p><div className="suggestions">{['Explain a complex idea simply','Help me plan a project','Write something with me'].map((s,i) => <button key={s} onClick={() => setInput(s)}><span>{['✳','◫','↗'][i]}</span>{s}<b>↗</b></button>)}</div></div> : <div className="messages">{current.messages.map((m,i) => <article className={`message ${m.role}`} key={m.id}><div className="message-avatar">{m.role === 'assistant' ? '✳' : user?.email?.[0]?.toUpperCase() || 'Y'}</div><div className="message-main"><div className="message-heading"><b>{m.role === 'assistant' ? 'Northstar' : 'You'}</b>{m.status === 'partial' && <small className="partial-label">Interrupted · partial response</small>}{m.status === 'error' && <small className="partial-label">Response failed</small>}</div>{m.role === 'assistant' ? <div className="markdown"><Suspense fallback={null}><MarkdownMessage content={m.content || (busy ? ' ' : 'The response was interrupted before any text arrived.')} /></Suspense></div> : <div className="user-content">{m.content}</div>}<div className="message-actions">{m.role === 'user' ? <button onClick={() => void editMessage(m)}>Edit ↗</button> : <><button onClick={() => navigator.clipboard.writeText(m.content)}>Copy</button><button onClick={() => void stream(undefined,true)}>Regenerate ↻</button>{m.estimatedCost != null && <span>{m.inputTokens} in · {m.outputTokens} out · ${m.estimatedCost.toFixed(6)} est.</span>}</>}</div></div></article>)}{busy && <div className="stream-indicator"><span/> Thinking</div>}<div ref={bottomRef}/></div>}
      </section>
      <div className="composer-wrap"><form className="composer" onSubmit={submit}><textarea aria-label="Message" placeholder="Message Northstar..." rows={1} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }} disabled={busy}/><div className="composer-footer"><div className="composer-hints"><span>↵ Send</span><span>⇧ ↵ New line</span></div>{busy ? <button type="button" className="stop-button" onClick={() => abortRef.current?.abort()}>■ Stop</button> : <button className="send-button" aria-label="Send message" disabled={!input.trim()}>↑</button>}</div></form><div className="disclaimer">Northstar can make mistakes. Check important information.</div>{error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}{cost != null && <div className="cost-note">Estimated request cost: ${cost.toFixed(6)} USD</div>}</div>
    </main>
    {authOpen && <div className="modal-backdrop" role="presentation"><form className="auth-card" onSubmit={authSubmit}><button type="button" className="modal-close" onClick={() => setAuthOpen(false)}>×</button><div className="welcome-symbol">✳</div><h2>{authMode === 'register' ? 'Create your account' : 'Welcome back'}</h2><p>Save your conversations and keep them in sync.</p><label>Email<input name="email" type="email" autoComplete="email" required/></label><label>Password<input name="password" type="password" minLength={10} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} required/><small>At least 10 characters</small></label><button className="auth-submit">{authMode === 'register' ? 'Create account' : 'Sign in'}</button><button type="button" className="auth-switch" onClick={() => setAuthMode(authMode === 'register' ? 'login' : 'register')}>{authMode === 'register' ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></form></div>}
    {user?.isGuest && <div className="guest-banner"><span>Guest mode · {guestLimit} messages per day</span><button onClick={() => { setAuthMode('register'); setAuthOpen(true); }}>Create an account <b>→</b></button></div>}
  </div>;
}
