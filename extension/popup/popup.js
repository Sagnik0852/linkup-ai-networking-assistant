// ================================================================
// LinkUp popup v2 — capture + AI draft + FEEDBACK LOOP.
// The three feedback buttons are what make the system learn:
//   Used as-is → strong positive example for future retrieval
//   Edited     → your final text is stored; diffs teach the voice profile
//   Discard    → negative example, excluded from retrieval
// ================================================================

const $ = (id) => document.getElementById(id);

let lastExampleId = null;      // which message_examples row we're rating
let lastOriginalDraft = '';    // to detect whether you actually edited
let lastKind = null;           // 'profile' | 'thread' — for the refine call
let lastRefineContext = '';    // who/what the draft is for, passed to the refiner

// Injected into the LinkedIn tab. On messaging pages it targets the OPEN
// thread only (not the conversation list); elsewhere it grabs main content.
function extractPage() {
  const isMessaging = location.pathname.startsWith('/messaging');
  let text = '';
  let participant = null;

  if (isMessaging) {
    // Who is this thread with? (thread header shows the other person's name)
    const header = document.querySelector(
      '.msg-entity-lockup__entity-title, .msg-thread__link-to-profile, ' +
      '.msg-title-bar h2, #thread-detail-jump-target'
    );
    if (header) participant = header.innerText.trim().split('\n')[0];

    // 1st choice: the active conversation pane itself
    const thread = document.querySelector(
      '.msg-convo-wrapper, .msg-s-message-list-container'
    );
    if (thread) {
      text = thread.innerText;
    } else {
      // Fallback: clone the page and CUT OUT the conversation list,
      // so only the open thread's text remains.
      const clone = (document.querySelector('main') || document.body).cloneNode(true);
      clone.querySelectorAll('[class*="msg-conversations"]').forEach((n) => n.remove());
      text = clone.innerText;
    }
  } else {
    text = (document.querySelector('main') || document.body).innerText;
  }

  text = text.replace(/\n{3,}/g, '\n\n');
  return {
    url: location.href.split('?')[0],
    title: document.title,
    participant: participant,                       // strong hint for the AI
    // Threads: keep the NEWEST messages (end of text). Profiles: keep the start.
    page_text: isMessaging ? text.slice(-9000) : text.slice(0, 9000),
  };
}

async function getSettings() {
  return chrome.storage.sync.get({ webhookBase: 'http://localhost:5678', secret: '' });
}

function setStatus(msg) { $('status').textContent = msg; }

async function postJson(path, bodyObj) {
  const settings = await getSettings();
  const res = await fetch(settings.webhookBase + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: settings.secret, ...bodyObj }),
  });
  return res.json();
}

// ---------------- Capture ----------------
async function capture(kind) {
  const settings = await getSettings();
  if (!settings.secret) {
    setStatus('⚠️ Right-click the LinkUp icon → Options → set your secret first.');
    return;
  }
  $('captureProfile').disabled = true;
  $('captureThread').disabled = true;
  setStatus('Reading the page…');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [{ result: page }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPage,
  });

  setStatus(kind === 'profile'
    ? '🤖 Drafting in your voice… (10–15s)'
    : '🤖 Summarizing conversation… (5–10s)');

  let data;
  try {
    data = await postJson(
      kind === 'profile' ? '/webhook/linkup-profile' : '/webhook/linkup-thread',
      page
    );
  } catch (e) {
    setStatus('❌ Could not reach n8n. Docker running? Workflow Active?');
    resetButtons(); return;
  }
  if (!data || data.ok === false) {
    setStatus('❌ ' + ((data && data.error) || 'Check n8n → Executions for details.'));
    resetButtons(); return;
  }
  showResult(kind, data);
  resetButtons();
}

function resetButtons() {
  $('captureProfile').disabled = false;
  $('captureThread').disabled = false;
}

function showResult(kind, data) {
  $('result').hidden = false;
  lastKind = kind;
  if (kind === 'profile') {
    lastExampleId = data.example_id || null;
    lastOriginalDraft = data.message || '';
    setStatus('✅ Draft ready. Edit if needed, then pick a feedback button — that trains the system.');
    $('resultTitle').textContent = 'Cold outreach draft (editable):';
    $('draft').value = data.message || '';
    $('feedback').hidden = false;
    $('copy').hidden = true;
    const c = data.classification || {};
    const readAs = 'Read as: ' + [
      c.is_bits_alum ? 'BITSian' : 'non-BITSian',
      c.seniority_tier, c.side, c.track_match + ' track',
    ].join(' · ');
    $('extra').textContent = readAs;
    lastRefineContext = 'This is a cold outreach message. ' + readAs;
    $('refine').hidden = false;
  } else if (data.reply) {
    // Conversation captured AND a reply was drafted
    lastExampleId = data.example_id || null;
    lastOriginalDraft = data.reply;
    setStatus('✅ CRM updated. Suggested reply below — edit, then pick a feedback button.');
    $('resultTitle').textContent = 'Suggested reply (editable):';
    $('draft').value = data.reply;
    $('feedback').hidden = false;
    $('copy').hidden = true;
    const items = (data.action_items || []).map((x) => '• ' + x).join('\n');
    $('extra').textContent = 'Summary: ' + (data.summary || '') +
      (items ? '\n\nYour action items:\n' + items : '') +
      (data.next_follow_up ? '\nNext follow-up: ' + data.next_follow_up : '');
    lastRefineContext = 'This is a reply in an ongoing LinkedIn conversation. ' +
      'Conversation so far: ' + (data.summary || '');
    $('refine').hidden = false;
  } else {
    $('refine').hidden = true;
    setStatus('✅ Conversation saved & CRM updated.');
    $('resultTitle').textContent = 'AI summary:';
    $('draft').value = data.summary || '';
    $('feedback').hidden = true;
    $('copy').hidden = false;
    const items = (data.action_items || []).map((x) => '• ' + x).join('\n');
    $('extra').textContent =
      (items ? 'Your action items:\n' + items + '\n\n' : '') +
      (data.next_follow_up ? 'Next follow-up: ' + data.next_follow_up : '');
  }
}

// ---------------- Feedback ----------------
async function sendFeedback(action) {
  const finalText = $('draft').value;
  // Copy first (except discard) so your flow is never blocked by the network.
  if (action !== 'discarded') await navigator.clipboard.writeText(finalText);

  // Honest feedback: if you clicked "used as-is" but the text changed, it's an edit.
  let realAction = action;
  if (action === 'used' && finalText.trim() !== lastOriginalDraft.trim()) realAction = 'edited';

  setStatus(action === 'discarded' ? 'Recording discard…' : '📋 Copied! Recording feedback…');
  try {
    await postJson('/webhook/linkup-feedback', {
      example_id: lastExampleId,
      action: realAction,               // 'used' | 'edited' | 'discarded'
      final_text: finalText,
    });
    setStatus(action === 'discarded'
      ? '🗑️ Discarded — the system learns from this too.'
      : '📋 Copied & learned. Paste it into LinkedIn and send.');
  } catch (e) {
    setStatus('📋 Copied. (Feedback not recorded — n8n unreachable, not critical.)');
  }
  if (action === 'discarded') { $('result').hidden = true; }
}

// ---------------- AI refine ----------------
// Type a plain-English change; the current draft is rewritten in place.
async function refine() {
  const instruction = $('refineInput').value.trim();
  const draft = $('draft').value;
  if (!instruction) { setStatus('✏️ Type the change you want, then press ↻.'); return; }
  if (!draft.trim()) { setStatus('Nothing to refine yet.'); return; }

  $('refineBtn').disabled = true;
  $('refineInput').disabled = true;
  setStatus('🤖 Applying your change… (3–6s)');

  let data;
  try {
    data = await postJson('/webhook/linkup-refine', {
      draft,
      instruction,
      context: lastRefineContext,
      kind: lastKind,
    });
  } catch (e) {
    setStatus('❌ Could not reach n8n for the refine. Docker running?');
    $('refineBtn').disabled = false; $('refineInput').disabled = false; return;
  }

  if (!data || data.ok === false || !data.message) {
    setStatus('❌ ' + ((data && data.error) || 'Refine failed — try rephrasing.'));
    $('refineBtn').disabled = false; $('refineInput').disabled = false; return;
  }

  $('draft').value = data.message;          // rewrite shown in place
  $('refineInput').value = '';
  $('refineBtn').disabled = false;
  $('refineInput').disabled = false;
  setStatus('✅ Updated. Refine again, or edit & pick a feedback button.');
}

// ---------------- Wire up ----------------
async function init() {
  $('captureProfile').addEventListener('click', () => capture('profile'));
  $('captureThread').addEventListener('click', () => capture('thread'));
  $('fbUsed').addEventListener('click', () => sendFeedback('used'));
  $('fbEdited').addEventListener('click', () => sendFeedback('edited'));
  $('fbDiscard').addEventListener('click', () => sendFeedback('discarded'));
  $('refineBtn').addEventListener('click', refine);
  $('refineInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); refine(); }
  });
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('draft').value);
    $('copy').textContent = '✅ Copied!';
    setTimeout(() => ($('copy').textContent = '📋 Copy to clipboard'), 1500);
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url ? tab.url : '';
  if (url.includes('linkedin.com/in/')) {
    $('captureProfile').hidden = false;
    setStatus('Profile page detected.');
  } else if (url.includes('linkedin.com/messaging')) {
    $('captureThread').hidden = false;
    setStatus('Conversation detected. Open the thread, then capture.');
  } else {
    setStatus('Open a LinkedIn profile or conversation, then click LinkUp again.');
  }
}

init();
