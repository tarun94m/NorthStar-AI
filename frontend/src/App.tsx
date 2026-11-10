import { FormEvent, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import 'highlight.js/styles/github-dark.css';
import UsageDashboard from './UsageDashboard.js';

const MarkdownMessage = lazy(() => import('./MarkdownMessage.js'));

type Message = { id: string; role: 'user'|'assistant'; content: string; status: string; provider?: string|null; model?: string|null; requestedSelectionMode?: 'AUTO'|'MANUAL'|null; taskType?: string|null; routingPolicyVersion?: string|null; routingReasonCode?: string|null; usageStatus?: string|null; estimatedCost?: number|null; pricingCurrency?: string|null; inputTokens?: number|null; outputTokens?: number|null; estimatedInputTokens?: number|null; estimatedOutputTokens?: number|null };
type Conversation = { id: string; title: string; model: string; provider?: string; selectionMode?: 'AUTO'|'MANUAL'; selectionModelId?: string|null; messages: Message[] };
type Model = { id: string; provider: string; model: string; label: string; description: string; available: boolean; availability: string; capabilities: { streaming: boolean; nonStreaming: boolean; text: boolean; imageInput?: boolean; webSearch?: boolean; documentInput?: boolean; structuredOutput?: boolean; toolCalling?: boolean }; taskSuitability?: Record<string, { score: number; sampleSize: number; benchmark: string; evaluatedAt: string }> | null; qualityEvidence?: { score: number; sampleSize: number; benchmark: string; evaluatedAt: string } | null; contextWindow: number; maxOutputTokens: number; parameters: Record<string, { type: 'number'; min: number; max: number; default?: number }> };
type User = { id: string; email: string|null; isGuest: boolean };
type Memory = { id: string; content: string; category: string; tags: string[]; createdAt: string; updatedAt: string; lastRetrievedAt?: string|null; retrievalCount: number };
type MemorySuggestion = { id: string; proposedContent: string; proposedCategory: string; proposedTags: string[]; sourceConversationTitle: string|null; expiresAt: string };
const memoryCategoryOptions = ['preferences','technical_skills','work_projects','communication_preferences','goals','other'];
const api = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(url, { ...init, cache: 'no-store', credentials: 'include', headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `Request failed (${response.status})`); }
  if (response.status === 204) return null;
  return response.json();
};
const formatCost = (amount: number, currency = 'USD') => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 6 }).format(amount); }
  catch { return `${currency} ${amount.toFixed(6)}`; }
};

export default function App() {
  const [user, setUser] = useState<User|null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string|null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('openai:gpt-4.1-mini');
  const [selectionMode, setSelectionMode] = useState<'AUTO'|'MANUAL'>('AUTO');
  const [providerName, setProviderName] = useState('mock');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login'|'register'>('register');
  const [mobileNav, setMobileNav] = useState(false);
  const [filter, setFilter] = useState('');
  const [cost, setCost] = useState<number|null>(null);
  const [costCurrency, setCostCurrency] = useState('USD');
  const [guestLimit, setGuestLimit] = useState(12);
  const [memoryPanel, setMemoryPanel] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memorySuggestions, setMemorySuggestions] = useState<MemorySuggestion[]>([]);
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryCategory, setMemoryCategory] = useState('other');
  const [memoryTags, setMemoryTags] = useState('');
  const [suggestionEdits, setSuggestionEdits] = useState<Record<string, { content: string; category: string; tags: string }>>({});
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [theme, setTheme] = useState<'dark'|'light'>(() => localStorage.getItem('northstar-theme') === 'light' ? 'light' : 'dark');
  const [page, setPage] = useState<'chat'|'usage'>('chat');
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
        if (!auth.user.isGuest) {
          const account = await api('/api/settings').catch(() => null);
          if (account?.settings) { setSelectionMode(account.settings.selectionMode); if (account.settings.defaultModelId) setModelId(account.settings.defaultModelId); }
        }
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
    try { const result = await api('/api/conversations', { method: 'POST', body: '{}' }); setPage('chat'); setSelectionMode(result.conversation.selectionMode); if (result.conversation.selectionModelId) setModelId(result.conversation.selectionModelId); await refresh(result.conversation.id); setMobileNav(false); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  function openConversation(conversation: Conversation) {
    setPage('chat');
    setActive(conversation.id); activeRef.current = conversation.id;
    setSelectionMode(conversation.selectionMode ?? 'AUTO');
    if (conversation.selectionModelId) setModelId(conversation.selectionModelId);
  }
  async function toggleConversationPin() {
    if (!current || user?.isGuest) return;
    const nextMode = current.selectionMode === 'MANUAL' ? 'AUTO' : 'MANUAL';
    const nextModel = modelId || models.find(item => item.available)?.id;
    try {
      const result = await api(`/api/conversations/${current.id}/model-selection`, { method: 'PATCH', body: JSON.stringify({ selectionMode: nextMode, ...(nextMode === 'MANUAL' && nextModel ? { selectionModelId: nextModel } : {}) }) });
      setSelectionMode(result.conversation.selectionMode);
      if (result.conversation.selectionModelId) setModelId(result.conversation.selectionModelId);
      await refresh(current.id);
    } catch (e) { setError((e as Error).message); }
  }
  async function stream(content?: string, regenerate = false) {
    const conversationId = activeRef.current;
    if (!conversationId || busy) return;
    const controller = new AbortController(); abortRef.current = controller; setBusy(true); setError(''); setCost(null);
    if (content) setInput('');
    try {
      const response = await fetch('/api/chat/stream', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, content, selectionMode, ...(selectionMode === 'MANUAL' ? { modelId } : {}), regenerate }), signal: controller.signal });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || 'Could not send message.'); }
      if (!response.body) throw new Error('Streaming is unavailable in this browser.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let assistantId = ''; let replacement = ''; let routeMetadata: Partial<Message> = {};
      const upsertAssistant = (text: string, status = 'streaming') => {
        if (!assistantId) return;
        setConversations(prev => prev.map(c => c.id !== conversationId ? c : ({ ...c, messages: [...c.messages.filter(m => m.id !== assistantId), { id: assistantId, role: 'assistant', content: text, status, ...routeMetadata }] })));
      };
      const handle = (block: string) => {
        const event = block.match(/^event: (.+)$/m)?.[1]; const raw = block.match(/^data: (.+)$/m)?.[1]; if (!event || !raw) return;
        const data = JSON.parse(raw);
        if (event === 'meta') {
          assistantId = data.assistantMessageId; setProviderName(data.provider);
          routeMetadata = { provider: data.provider, model: data.model, requestedSelectionMode: data.requestedSelectionMode, taskType: data.taskType, routingPolicyVersion: data.routingPolicyVersion, routingReasonCode: data.routingReasonCode };
          setConversations(prev => {
            const conv = prev.find(c => c.id === conversationId); if (!conv) return prev;
            const userMessage = content ? { id: data.userMessageId, role: 'user' as const, content, status: 'complete' } : null;
            return prev.map(c => {
              if (c.id !== conversationId) return c;
              const reverseIndex = [...c.messages].reverse().findIndex(m => m.role === 'user');
              const lastUserIndex = reverseIndex < 0 ? -1 : c.messages.length - 1 - reverseIndex;
              const baseMessages = userMessage ? [...c.messages, userMessage] : c.messages.slice(0, lastUserIndex + 1);
              return { ...c, title: c.title === 'New chat' && content ? content.slice(0, 60) : c.title, messages: [...baseMessages, { id: assistantId, role: 'assistant', content: '', status: 'streaming', ...routeMetadata }] };
            });
          });
        } else if (event === 'delta') { replacement += data.text; upsertAssistant(replacement); }
        else if (event === 'done') { setCost(data.estimatedCost); setCostCurrency(data.pricingCurrency || 'USD'); upsertAssistant(replacement, data.status); }
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
    try { const result = await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) }); setUser(result.user); setAuthOpen(false); const account = await api('/api/settings'); setSelectionMode(account.settings.selectionMode); setModelId(account.settings.defaultModelId); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }
  async function signOut() { try { await api('/api/auth/logout', { method: 'POST' }); setUser(null); setConversations([]); setActive(null); setSelectionMode('AUTO'); const result = await api('/api/auth/guest', { method: 'POST' }); setUser(result.user); setProviderName(result.provider); setGuestLimit(result.guestDailyMessageLimit ?? 12); } catch (e) { setError((e as Error).message); } }
  async function rename(c: Conversation) { const title = prompt('Rename conversation', c.title); if (!title?.trim()) return; try { await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ title }) }); await refresh(active ?? undefined); } catch (e) { setError((e as Error).message); } }
  async function remove(c: Conversation) { if (!confirm(`Delete “${c.title}”?`)) return; try { await api(`/api/conversations/${c.id}`, { method: 'DELETE' }); if (active === c.id) setActive(null); await refresh(); } catch (e) { setError((e as Error).message); } }
  async function editMessage(m: Message) { const content = prompt('Edit your message', m.content); if (!content?.trim()) return; try { await api(`/api/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ content }) }); await refresh(active ?? undefined); } catch (e) { setError((e as Error).message); } }
  async function reloadMemories() {
    setMemoryLoading(true);
    try {
      const [settings, saved, pending] = await Promise.all([api('/api/memory/settings'), api('/api/memories'), api('/api/memory/suggestions')]);
      setMemoryEnabled(settings.memoryEnabled); setMemories(saved.memories); setMemorySuggestions(pending.suggestions);
      setSuggestionEdits(Object.fromEntries(pending.suggestions.map((s: MemorySuggestion) => [s.id, { content: s.proposedContent, category: s.proposedCategory, tags: s.proposedTags.join(', ') }])));
    } catch (e) { setError((e as Error).message); }
    finally { setMemoryLoading(false); }
  }
  async function openMemoryPanel() { setMemoryPanel(true); await reloadMemories(); }
  async function toggleMemory(enabled: boolean) {
    try { const result = await api('/api/memory/settings', { method: 'PATCH', body: JSON.stringify({ memoryEnabled: enabled }) }); setMemoryEnabled(result.memoryEnabled); }
    catch (e) { setError((e as Error).message); }
  }
  const parsedTags = (value: string) => [...new Set(value.split(',').map(tag => tag.trim()).filter(Boolean))];
  async function createMemory(e: FormEvent) {
    e.preventDefault();
    try { await api('/api/memories', { method: 'POST', body: JSON.stringify({ content: memoryContent, category: memoryCategory, tags: parsedTags(memoryTags) }) }); setMemoryContent(''); setMemoryTags(''); await reloadMemories(); }
    catch (e) { setError((e as Error).message); }
  }
  async function editMemory(memory: Memory) {
    const content = prompt('Edit memory content', memory.content); if (content === null) return;
    const category = prompt('Edit memory category', memory.category); if (category === null) return;
    const tags = prompt('Edit comma-separated tags', memory.tags.join(', ')); if (tags === null) return;
    try { await api(`/api/memories/${memory.id}`, { method: 'PATCH', body: JSON.stringify({ content, category, tags: parsedTags(tags) }) }); await reloadMemories(); }
    catch (e) { setError((e as Error).message); }
  }
  async function deleteMemory(memory: Memory) {
    if (!confirm('Delete this saved memory? It will be excluded from the next response.')) return;
    try { await api(`/api/memories/${memory.id}`, { method: 'DELETE' }); setMemories(previous => previous.filter(item => item.id !== memory.id)); }
    catch (e) { setError((e as Error).message); }
  }
  async function generateMemorySuggestions() {
    if (!active) return;
    setMemoryLoading(true);
    try { await api('/api/memory/suggestions/generate', { method: 'POST', body: JSON.stringify({ conversationId: active }) }); await reloadMemories(); }
    catch (e) { setError((e as Error).message); }
    finally { setMemoryLoading(false); }
  }
  async function approveMemorySuggestion(suggestion: MemorySuggestion) {
    const edit = suggestionEdits[suggestion.id] ?? { content: suggestion.proposedContent, category: suggestion.proposedCategory, tags: suggestion.proposedTags.join(', ') };
    try { await api(`/api/memory/suggestions/${suggestion.id}/approve`, { method: 'POST', body: JSON.stringify({ content: edit.content, category: edit.category, tags: parsedTags(edit.tags) }) }); await reloadMemories(); }
    catch (e) { setError((e as Error).message); }
  }
  async function rejectMemorySuggestion(suggestion: MemorySuggestion) {
    try { await api(`/api/memory/suggestions/${suggestion.id}/reject`, { method: 'POST', body: '{}' }); await reloadMemories(); }
    catch (e) { setError((e as Error).message); }
  }
  const visible = conversations.filter(c => c.title.toLowerCase().includes(filter.toLowerCase()));
  const selectedModel = models.find(m => m.id === modelId);
  const providerGroups = [...new Set(models.map(model => model.provider))];
  const routeExplanation = (reason?: string|null) => ({
    task_suitability_evidence: 'Chosen using task-specific evaluation evidence.',
    quality_evidence: 'Chosen using available model quality evaluation evidence.',
    account_model_preference: 'Your saved account model is the current routing preference.',
    configured_model_preference: 'Chosen by the configured routing preference; comparative quality data is not available.',
    eligible_model_fallback: 'Chosen from eligible models; comparative quality data is not available.',
    retryable_provider_failure: 'Switched providers after a retryable failure before response text began.',
    context_fit_fallback: 'Another eligible model was selected because its context window fits this request.',
    explicit_model_selection: 'You selected this model for the request.',
    conversation_selection: 'This conversation is pinned to this model.',
    account_default: 'This response used your saved model preference.',
    legacy_configured_default: 'This response used the configured default model.',
  } as Record<string,string>)[reason ?? ''] ?? '';

  return <div className={`app-shell ${theme === 'light' ? 'light-theme' : ''}`}>
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark">✳</div><span>northstar</span><button className="mobile-close" onClick={() => setMobileNav(false)}>×</button></div>
      <button className="new-chat" onClick={newChat}><span>＋</span> New chat <kbd>⌘ K</kbd></button>
      <button className={`usage-nav ${page === 'usage' ? 'active' : ''}`} onClick={() => { setPage('usage'); setMobileNav(false); }} aria-current={page === 'usage' ? 'page' : undefined}><span>◷</span> Usage &amp; costs</button>
      <div className="side-label">YOUR SPACE</div>
      <div className="search-box"><span>⌕</span><input aria-label="Search conversations" placeholder="Search conversations" value={filter} onChange={e => setFilter(e.target.value)} /></div>
      <div className="history-label">Recent</div>
      <nav className="conversation-list">{visible.map(c => <div key={c.id} className={`conversation-row ${active === c.id ? 'selected' : ''}`}><button onClick={() => { openConversation(c); setMobileNav(false); }} title={c.title}><span className="chat-icon">◌</span><span className="row-title">{c.title}</span></button><div className="row-actions"><button aria-label="Rename conversation" onClick={() => void rename(c)}>···</button><button aria-label="Delete conversation" onClick={() => void remove(c)}>×</button></div></div>)}</nav>
      <div className="sidebar-bottom"><div className="profile-avatar">{user?.email?.[0]?.toUpperCase() || 'G'}</div><div className="profile-info"><b>{user?.email || 'Guest session'}</b><small>{user?.isGuest ? 'Limited access' : 'Personal workspace'}</small></div><button className="profile-menu" aria-label="Sign out" onClick={() => user?.isGuest ? setAuthOpen(true) : void signOut()}>···</button></div>
    </aside>
    {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
    <main className="main-panel">
      <header className="topbar">
        <div className="top-left"><button className="menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation">☰</button><span className="breadcrumb">Workspace <span>/</span> <b>{page === 'usage' ? 'Usage & costs' : current?.title || 'New chat'}</b></span></div>
        <div className="top-right">
          {page === 'chat' ? <>
            <label className="model-label">MODEL</label>
            <select aria-label="Select AI model" value={selectionMode === 'AUTO' ? 'AUTO' : modelId} onChange={e => { if (e.target.value === 'AUTO') setSelectionMode('AUTO'); else { setModelId(e.target.value); setSelectionMode('MANUAL'); } }}>
              <option value="AUTO">Auto · route each request</option>
              {providerGroups.map(provider => <optgroup key={provider} label={provider === 'openai' ? 'OpenAI' : provider === 'gemini' ? 'Google Gemini' : provider}>
                {models.filter(model => model.provider === provider).map(model => <option key={model.id} value={model.id} disabled={!model.available}>{model.label}{!model.available ? ' · unavailable' : ''}</option>)}
              </optgroup>)}
            </select>
            <span className={`provider-pill ${selectionMode === 'MANUAL' && selectedModel?.provider === 'mock' ? 'mock' : ''}`} title={selectionMode === 'AUTO' ? 'A suitable configured model will be selected per request.' : selectedModel?.description || 'Choose an available model'}>{selectionMode === 'AUTO' ? '✳ Auto' : selectedModel?.provider === 'mock' ? '◉ Mock' : selectedModel?.provider === 'gemini' ? '● Gemini' : selectedModel ? '● OpenAI' : '● Manual'}</span>
            {current && user && !user.isGuest && <button className="memory-open" onClick={() => void toggleConversationPin()}>{current.selectionMode === 'MANUAL' ? 'Use Auto for this chat' : 'Pin to Manual'}</button>}
            {user && !user.isGuest && <button className="memory-open" onClick={() => void openMemoryPanel()}>Memory</button>}
          </> : <button className="memory-open" onClick={() => setPage('chat')}>Back to chat</button>}
          <button className="theme-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☼' : '☾'}</button>
        </div>
      </header>
      {page === 'usage' ? <UsageDashboard /> : <>
      <div className="model-detail" aria-live="polite">{selectionMode === 'AUTO' ? 'Auto selects among configured models that fit the task and context. Quality evaluation is shown only when available.' : selectedModel ? `${selectedModel.label} · ${selectedModel.available ? 'Available' : selectedModel.availability.replaceAll('_', ' ')}` : 'Choose a model returned by the server catalog.'}</div>
      <section className="chat-area">
        {!current || current.messages.length === 0 ? <div className="welcome"><div className="welcome-symbol">✳</div><p className="eyebrow">A CLEARER WAY FORWARD</p><h1>What can I help you<br/><em>think through?</em></h1><p className="welcome-sub">Ask a question, explore an idea, or bring a challenge.<br/>We’ll work through it together.</p><div className="suggestions">{['Explain a complex idea simply','Help me plan a project','Write something with me'].map((s,i) => <button key={s} onClick={() => setInput(s)}><span>{['✳','◫','↗'][i]}</span>{s}<b>↗</b></button>)}</div></div> : <div className="messages">{current.messages.map((m,i) => <article className={`message ${m.role}`} key={m.id}><div className="message-avatar">{m.role === 'assistant' ? '✳' : user?.email?.[0]?.toUpperCase() || 'Y'}</div><div className="message-main"><div className="message-heading"><b>{m.role === 'assistant' ? 'Northstar' : 'You'}</b>{m.role === 'assistant' && m.provider && <small className={`actual-model ${m.provider === 'mock' ? 'mock' : ''}`}>{m.provider} · {m.model}</small>}{m.status === 'partial' && <small className="partial-label">Interrupted · partial response</small>}{m.status === 'error' && <small className="partial-label">Response failed</small>}</div>{m.role === 'assistant' && routeExplanation(m.routingReasonCode) && <div className="route-explanation">{routeExplanation(m.routingReasonCode)}</div>}{m.role === 'assistant' ? <div className="markdown"><Suspense fallback={null}><MarkdownMessage content={m.content || (busy ? ' ' : 'The response was interrupted before any text arrived.')} /></Suspense></div> : <div className="user-content">{m.content}</div>}<div className="message-actions">{m.role === 'user' ? <button onClick={() => void editMessage(m)}>Edit ↗</button> : <><button onClick={() => navigator.clipboard.writeText(m.content)}>Copy</button><button onClick={() => void stream(undefined,true)}>Regenerate ↻</button>{m.estimatedCost != null && <span>{m.inputTokens ?? m.estimatedInputTokens ?? '—'} in · {m.outputTokens ?? m.estimatedOutputTokens ?? '—'} out · {m.usageStatus === 'provider_reported' ? 'provider-reported tokens' : m.usageStatus === 'partial' ? 'partial provider usage' : 'estimated tokens'} · {formatCost(m.estimatedCost, m.pricingCurrency || "USD")} est.</span>}</>}</div></div></article>)}{busy && <div className="stream-indicator"><span/> Thinking</div>}<div ref={bottomRef}/></div>}
      </section>
      <div className="composer-wrap"><form className="composer" onSubmit={submit}><textarea aria-label="Message" placeholder="Message Northstar..." rows={1} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }} disabled={busy}/><div className="composer-footer"><div className="composer-hints"><span>↵ Send</span><span>⇧ ↵ New line</span></div>{busy ? <button type="button" className="stop-button" onClick={() => abortRef.current?.abort()}>■ Stop</button> : <button className="send-button" aria-label="Send message" disabled={!input.trim()}>↑</button>}</div></form><div className="disclaimer">Northstar can make mistakes. Check important information.</div>{error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}{cost != null && <div className="cost-note">Estimated request cost: {formatCost(cost, costCurrency)} estimate</div>}</div>
      </>}
    </main>
    {authOpen && <div className="modal-backdrop" role="presentation"><form className="auth-card" onSubmit={authSubmit}><button type="button" className="modal-close" onClick={() => setAuthOpen(false)}>×</button><div className="welcome-symbol">✳</div><h2>{authMode === 'register' ? 'Create your account' : 'Welcome back'}</h2><p>Save your conversations and keep them in sync.</p><label>Email<input name="email" type="email" autoComplete="email" required/></label><label>Password<input name="password" type="password" minLength={10} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} required/><small>At least 10 characters</small></label><button className="auth-submit">{authMode === 'register' ? 'Create account' : 'Sign in'}</button><button type="button" className="auth-switch" onClick={() => setAuthMode(authMode === 'register' ? 'login' : 'register')}>{authMode === 'register' ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></form></div>}
    {memoryPanel && <div className="modal-backdrop memory-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setMemoryPanel(false); }}><section className="memory-panel" role="dialog" aria-label="Memory settings"><button className="modal-close" aria-label="Close memory settings" onClick={() => setMemoryPanel(false)}>×</button><p className="eyebrow">PERSONAL CONTEXT</p><h2>Memory</h2><p className="memory-explainer">Save useful details for future conversations. Suggestions are shown to you and saved only after you approve them. Memory text is treated as reference information, not instructions.</p><label className="memory-toggle"><span><b>Use saved memories</b><small>Turn off to stop retrieval and suggestions. You can still manage saved memories.</small></span><input aria-label="Enable long-term memory" type="checkbox" checked={memoryEnabled} onChange={e => void toggleMemory(e.target.checked)}/></label><div className="memory-section-heading"><h3>Saved memories</h3><span>{memories.length}</span></div><form className="memory-create" onSubmit={e => void createMemory(e)}><textarea aria-label="New memory content" placeholder="Add a useful detail you want remembered" maxLength={2000} value={memoryContent} onChange={e => setMemoryContent(e.target.value)} required/><div className="memory-fields"><input aria-label="New memory category" list="memory-category-options" value={memoryCategory} maxLength={40} onChange={e => setMemoryCategory(e.target.value)}/><input aria-label="New memory tags" placeholder="Tags, separated by commas" value={memoryTags} onChange={e => setMemoryTags(e.target.value)}/></div><datalist id="memory-category-options">{memoryCategoryOptions.map(category => <option key={category} value={category}/>)}</datalist><button type="submit" disabled={!memoryContent.trim()}>Save memory</button></form><div className="memory-list">{memoryLoading && <p>Loading memory…</p>}{memories.map(memory => <article className="memory-card" key={memory.id}><div><b>{memory.category}</b><p>{memory.content}</p><small>{memory.tags.join(' · ')}</small></div><div className="memory-actions"><button onClick={() => void editMemory(memory)}>Edit</button><button onClick={() => void deleteMemory(memory)}>Delete</button></div></article>)}{!memoryLoading && memories.length === 0 && <p className="memory-empty">No saved memories yet.</p>}</div><div className="memory-section-heading"><h3>Suggestions</h3><span>{memorySuggestions.length} pending</span></div>{current && <button className="memory-generate" disabled={!memoryEnabled || memoryLoading} onClick={() => void generateMemorySuggestions()}>{memoryLoading ? 'Working…' : 'Find suggestions from this conversation'}</button>}{!memoryEnabled && <p className="memory-muted">Enable memory to generate suggestions and use approved memories in chat.</p>}<div className="memory-list">{memorySuggestions.map(suggestion => { const edit = suggestionEdits[suggestion.id] ?? { content: suggestion.proposedContent, category: suggestion.proposedCategory, tags: suggestion.proposedTags.join(', ') }; return <article className="memory-suggestion-card" key={suggestion.id}><small>Suggested from {suggestion.sourceConversationTitle || 'a conversation'}</small><textarea aria-label={`Suggested memory ${suggestion.id}`} maxLength={2000} value={edit.content} onChange={e => setSuggestionEdits(old => ({ ...old, [suggestion.id]: { ...edit, content: e.target.value } }))}/><div className="memory-fields"><input aria-label="Suggestion category" list="memory-category-options" maxLength={40} value={edit.category} onChange={e => setSuggestionEdits(old => ({ ...old, [suggestion.id]: { ...edit, category: e.target.value } }))}/><input aria-label="Suggestion tags" value={edit.tags} onChange={e => setSuggestionEdits(old => ({ ...old, [suggestion.id]: { ...edit, tags: e.target.value } }))}/></div><div className="memory-actions"><button onClick={() => void approveMemorySuggestion(suggestion)}>Approve exact text</button><button onClick={() => void rejectMemorySuggestion(suggestion)}>Reject</button></div></article>; })}{!memoryLoading && memorySuggestions.length === 0 && <p className="memory-empty">No pending suggestions.</p>}</div></section></div>}
    {user?.isGuest && <div className="guest-banner"><span>Guest mode · {guestLimit} messages per day</span><button onClick={() => { setAuthMode('register'); setAuthOpen(true); }}>Create an account <b>→</b></button></div>}
  </div>;
}
