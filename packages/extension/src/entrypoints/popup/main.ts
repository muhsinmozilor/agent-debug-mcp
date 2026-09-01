import { DEFAULT_RELAY_BASE, LOOPBACK_HTTP_RE, type UiRequest, type UiStatus } from '../../lib/constants';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const send = <T>(req: UiRequest): Promise<T> => chrome.runtime.sendMessage(req) as Promise<T>;

/** The pair form is only (re)built when the paired state flips, so the 2 s refresh never clobbers what the user types. */
let pairFormFor: boolean | null = null;

async function render(): Promise<void> {
  const s = await send<UiStatus>({ kind: 'getStatus' });
  $('ver').textContent = `v${s.extVersion}`;
  const dot = $('dot');
  dot.className = `dot ${s.relayConnected ? 'on' : s.paired ? 'off' : ''}`;
  const err = s.lastError && !s.relayConnected ? ` <span class="muted">(${escapeHtml(s.lastError)})</span>` : '';
  $('status').innerHTML = s.paired
    ? s.relayConnected
      ? `Connected to relay at <code>${escapeHtml(s.relayUrl ?? '')}</code>`
      : `Paired with <code>${escapeHtml(s.relayUrl ?? '')}</code> — relay not reachable.${err}<br/>Start it with <code>npx agent-debug-mcp</code>.`
    : `Not paired — looking for a relay on <code>${DEFAULT_RELAY_BASE}</code> every few seconds.${err}<br/>Start it with <code>npx agent-debug-mcp</code>, or enter another relay URL below.`;

  $('pending').innerHTML = s.pendingPair
    ? `<div class="row">A relay at <code>${escapeHtml(s.pendingPair.relayUrl)}</code> wants to pair. <button id="confirm">Accept</button></div>`
    : '';
  document.getElementById('confirm')?.addEventListener('click', async () => {
    await send({ kind: 'confirmPendingPair' });
    await render();
  });

  if (pairFormFor !== s.paired) {
    pairFormFor = s.paired;
    $('pair').innerHTML = s.paired
      ? ''
      : `<div class="row"><input id="url" placeholder="${DEFAULT_RELAY_BASE}" value="${DEFAULT_RELAY_BASE}" /><button id="doPair">Pair</button></div><div id="pairErr" class="muted"></div>`;
    document.getElementById('doPair')?.addEventListener('click', async () => {
      const baseUrl = ($('url') as HTMLInputElement).value.trim().replace(/\/+$/, '');
      const errEl = $('pairErr');
      if (!LOOPBACK_HTTP_RE.test(baseUrl)) {
        errEl.textContent = 'Enter the relay as http://127.0.0.1:<port> (loopback only).';
        return;
      }
      errEl.textContent = 'Pairing…';
      const r = await send<{ ok: boolean; error?: string }>({ kind: 'discover', baseUrl });
      errEl.textContent = r.ok ? '' : r.error ?? 'Pairing failed';
      await render();
    });
  }

  // --- "debug only this tab" for the tab the popup is on ---
  const connectedCount = s.tabs.filter((t) => !t.standby).length;
  const cur = s.tabs.find((t) => t.tabId === s.currentTabId);
  const othersConnected = s.tabs.filter((t) => !t.standby && t.tabId !== s.currentTabId).length;
  $('current').innerHTML = !cur
    ? ''
    : cur.standby
      ? `<div class="row"><button class="tabBtn" data-tab="${cur.tabId}">Connect this tab for debugging</button>${othersConnected ? `<span class="muted">disconnects ${othersConnected} other tab(s)</span>` : ''}</div>`
      : othersConnected
        ? `<div class="row"><button class="tabBtn" data-tab="${cur.tabId}">Debug only this tab</button><span class="muted">disconnects ${othersConnected} other tab(s)</span></div>`
        : '';

  $('tabs').innerHTML = s.tabs.length
    ? s.tabs
        .map(
          (t, i) =>
            `<li><a href="#" class="tabLink" data-tab="${t.tabId}" title="Go to this tab"><strong>${t.tab}</strong></a> <span class="muted ${t.standby ? '' : 'ok'}">${t.standby ? 'standby' : t.state}</span>` +
            (t.standby
              ? ` <button class="tabBtn small" data-tab="${t.tabId}">Connect</button>`
              : connectedCount > 1
                ? ` <button class="tabBtn small" data-tab="${t.tabId}">Debug only</button>`
                : '') +
            `<br/><span class="muted">${escapeHtml(t.title || t.url)}</span>` +
            `<div class="caps">${t.capabilities.map((c) => `<span>${c}</span>`).join('')}</div>` +
            `<label class="row"><input type="checkbox" data-origin="${escapeHtml(t.origin)}" id="mut-${i}" ${t.mutationsAllowed ? 'checked' : ''}/> Allow mutations on ${escapeHtml(t.origin)}</label></li>`,
        )
        .join('')
    : '<li class="muted">No attached tabs. Open a localhost app.</li>';
  document.querySelectorAll<HTMLInputElement>('input[data-origin]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      await send({ kind: 'setMutations', origin: cb.dataset.origin as string, allowed: cb.checked });
      await render();
    });
  });
  document.querySelectorAll<HTMLAnchorElement>('a.tabLink').forEach((a) => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      await send({ kind: 'focusTab', tabId: Number(a.dataset.tab) });
      window.close();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('button.tabBtn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await send({ kind: 'debugTab', tabId: Number(btn.dataset.tab) });
      await render();
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

$('reconnect').addEventListener('click', async () => {
  await send({ kind: 'reconnect' });
  setTimeout(render, 500);
});
$('unpair').addEventListener('click', async () => {
  await send({ kind: 'unpair' });
  await render();
});
void render();
setInterval(render, 2000);
