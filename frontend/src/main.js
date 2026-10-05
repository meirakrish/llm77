const STORE_KEY = 'llm77.history.v1';
// Backend base URL, baked in at build time; empty means same origin (the dev server proxies /api)
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const MODES = {
  ask: { label: 'Ask', placeholder: 'Ask a question…', hint: 'Answers stream in, grounded in your knowledge base.' },
  analyze: { label: 'Analyze', placeholder: 'Paste a message or log to classify…', hint: 'Returns summary, category, urgency and action items.' },
  seed: { label: 'Knowledge', placeholder: 'Add a fact or document for Ask to use…', hint: 'Stored in the vector database for future answers.' },
};

const $ = (sel) => document.querySelector(sel);
const input = $('#input');
const historyEl = $('#history');
let mode = 'ask';
let history = load();

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(history)); } catch {}
}

// ---------- Rendering ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

function formatMetrics(m, model) {
  if (!m) return null;
  return el('div', { class: 'metrics' },
    `${model ? model + ' · ' : ''}${m.tokensPerSecond} tok/s · ${m.totalTokens} tokens · ${(m.executionTimeMs / 1000).toFixed(1)}s · queued ${m.queueWaitTimeMs}ms`);
}

function renderBody(entry) {
  if (entry.status === 'error') return el('div', { class: 'error' }, entry.error || 'Something went wrong.');

  if (entry.mode === 'ask') {
    if (!entry.text && entry.status !== 'done') return el('div', { class: 'status' }, 'Waiting for the worker…');
    return el('div', { class: 'answer' + (entry.status === 'done' ? '' : ' streaming'), 'data-answer': '' }, entry.text);
  }

  if (entry.mode === 'analyze') {
    if (entry.status !== 'done') return el('div', { class: 'status' }, 'Analyzing…');
    const d = entry.data;
    return el('div', {},
      el('div', { class: 'chips' },
        el('span', { class: 'chip' }, d.category),
        el('span', { class: 'chip ' + d.urgency }, `${d.urgency} urgency`)),
      el('div', {}, d.summary),
      d.actionItems.length
        ? el('ul', { class: 'actions' }, d.actionItems.map((a) => el('li', {}, a)))
        : el('div', { class: 'status' }, 'No action items.'));
  }

  return el('div', { class: entry.status === 'done' ? '' : 'status' }, entry.status === 'done' ? 'Added to the knowledge base.' : 'Embedding…');
}

function renderEntry(entry) {
  const node = el('article', { class: 'entry', id: 'e-' + entry.id },
    el('div', { class: 'entry-head' },
      el('span', { class: 'badge' }, MODES[entry.mode].label),
      el('time', { datetime: entry.createdAt }, new Date(entry.createdAt).toLocaleString()),
      el('span', { class: 'spacer' }),
      el('button', { class: 'link', type: 'button', onclick: () => reuse(entry) }, 'Reuse'),
      el('button', { class: 'link danger', type: 'button', onclick: () => remove(entry.id) }, 'Delete')),
    el('div', { class: 'query' }, entry.input),
    renderBody(entry),
    entry.status === 'done' ? formatMetrics(entry.metrics, entry.model) : null);

  const existing = document.getElementById('e-' + entry.id);
  if (existing) existing.replaceWith(node);
  return node;
}

function renderAll() {
  historyEl.replaceChildren(
    ...(history.length ? history.map(renderEntry) : [el('p', { class: 'empty' }, 'Nothing yet. Run a query to start your history.')]));
  $('#clear').hidden = !history.length;
}

function update(entry, changes, { persist = true } = {}) {
  Object.assign(entry, changes);
  if (persist) save();
  if (history.includes(entry)) renderEntry(entry);
}

// ---------- Mode & composer ----------

function setMode(next) {
  mode = next;
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  input.placeholder = MODES[mode].placeholder;
  $('#hint').textContent = MODES[mode].hint + ' Ctrl+Enter to run.';
}

document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); input.focus(); }));

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit();
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  const entry = { id: crypto.randomUUID(), mode, input: text, createdAt: new Date().toISOString(), status: 'pending', text: '' };
  history.unshift(entry);
  save();
  renderAll();
  input.value = '';
  run(entry);
});

$('#clear').addEventListener('click', () => {
  if (!confirm('Delete all saved queries and results?')) return;
  history = [];
  save();
  renderAll();
});

function reuse(entry) {
  setMode(entry.mode);
  input.value = entry.input;
  input.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function remove(id) {
  history = history.filter((e) => e.id !== id);
  save();
  renderAll();
}

// ---------- API calls ----------

async function postJson(url, body) {
  const res = await fetch(API_URL + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res;
}

async function run(entry) {
  try {
    if (entry.mode === 'ask') await runAsk(entry);
    else if (entry.mode === 'analyze') await runAnalyze(entry);
    else await runSeed(entry);
  } catch (error) {
    update(entry, { status: 'error', error: error.message });
  }
}

async function runAsk(entry) {
  const res = await postJson('/api/stream', { prompt: entry.input });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE messages are separated by a blank line
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      handleStreamEvent(entry, buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }

  // The connection dropped before a final event; recover the result by polling the job
  if (entry.status !== 'done' && entry.status !== 'error') await poll(entry);
}

function handleStreamEvent(entry, raw) {
  let type = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  const payload = data ? JSON.parse(data) : {};

  if (type === 'queued') {
    update(entry, { jobId: payload.jobId, status: 'streaming' });
  } else if (type === 'token') {
    entry.text += payload.token;
    // Update just the answer text per token instead of re-rendering the entry
    const answer = document.querySelector(`#e-${entry.id} [data-answer]`);
    if (answer) answer.textContent = entry.text;
    else renderEntry(entry);
  } else if (type === 'done') {
    update(entry, { status: 'done', text: payload.text, model: payload.model, metrics: payload.metrics });
  } else if (type === 'error') {
    update(entry, { status: 'error', error: payload.message });
  }
}

async function runAnalyze(entry) {
  const res = await postJson('/api/analyze', { text: entry.input });
  const { jobId } = await res.json();
  update(entry, { jobId });
  await poll(entry);
}

async function runSeed(entry) {
  await postJson('/api/seed', { text: entry.input });
  update(entry, { status: 'done' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a queued job until it settles; used for analysis and to resume jobs after a reload
async function poll(entry) {
  for (;;) {
    if (!history.includes(entry)) return; // deleted while waiting
    try {
      const res = await fetch(`${API_URL}/api/jobs/${encodeURIComponent(entry.jobId)}`);
      if (res.status === 404) {
        update(entry, { status: 'error', error: 'Job not found. It may have expired from the queue.' });
        return;
      }
      const job = await res.json();
      if (job.status === 'completed') {
        const result = entry.mode === 'analyze' ? { data: job.data } : { text: job.data };
        update(entry, { status: 'done', model: job.model, metrics: job.metrics, ...result });
        return;
      }
      if (job.status === 'failed') {
        update(entry, { status: 'error', error: job.failedReason });
        return;
      }
    } catch {
      // API temporarily unreachable; keep trying
    }
    await sleep(1000);
  }
}

// ---------- Model info ----------

function modelRow(label, model) {
  const details = [model.family, model.parameterSize, model.quantization].filter(Boolean).join(' · ');
  return [
    el('dt', {}, label),
    el('dd', {},
      el('span', { class: 'name' }, model.name),
      details ? el('span', { class: 'detail' }, ` — ${details}`) : null,
      model.digest ? el('span', { class: 'digest', title: 'Model digest (identifies the exact build)' }, ` ${model.digest}`) : null)
  ];
}

async function refreshInfo() {
  const box = $('#model-info');
  let info;
  try {
    const res = await fetch(`${API_URL}/api/info`);
    if (!res.ok) throw new Error();
    info = await res.json();
  } catch {
    box.replaceChildren(el('dt', {}, 'Status'), el('dd', {}, el('span', { class: 'dot off' }), 'Backend unreachable'));
    return;
  }

  if (!info.workerOnline) {
    box.replaceChildren(el('dt', {}, 'Status'),
      el('dd', {}, el('span', { class: 'dot off' }), 'Worker offline. Queries will wait in the queue until it starts.'));
    return;
  }

  box.replaceChildren(
    ...modelRow('Model', info.llmModel),
    ...modelRow('Embeddings', info.embedModel),
    el('dt', {}, 'Ollama'),
    el('dd', {}, info.ollamaVersion ?? 'unknown'),
    el('dt', {}, 'Worker'),
    el('dd', {}, el('span', { class: 'dot ' + (info.error ? 'off' : 'ok') }),
      info.error ? `Online, but Ollama reported: ${info.error}` : 'Online'));
}

// ---------- Startup ----------

setMode('ask');
renderAll();
refreshInfo();
setInterval(refreshInfo, 15000);

// Resume anything that was still running when the page was closed
for (const entry of history) {
  if (entry.status === 'done' || entry.status === 'error') continue;
  if (entry.jobId) {
    update(entry, { status: entry.mode === 'ask' ? 'streaming' : 'pending' });
    poll(entry);
  } else {
    update(entry, { status: 'error', error: 'Interrupted before it was queued. Use Reuse to run it again.' });
  }
}
