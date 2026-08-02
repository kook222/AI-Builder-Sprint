// 검색 결과에 광고성 · 피싱 · 로그인 필요 표시

(() => {
  if (!/^(www\.)?google\.[a-z.]+$/.test(location.hostname)) return;
  if (!location.pathname.startsWith('/search')) return;

  const SEEN = 'ftSeen';

  const MARKS = {
    phishing: { text: '피싱 의심', cls: 'ft-phishing' },
    ad: { text: '광고성', cls: 'ft-ad' },
    login: { text: '로그인 필요', cls: 'ft-login' },
  };

  let tip = null;

  // 마우스오버 설명 표시
  function showTip(anchor, kind, verdict) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ft-tip';
      document.body.appendChild(tip);
    }

    const head = document.createElement('div');
    head.className = `ft-tip-head ft-tip-${kind}`;
    head.textContent = MARKS[kind].text;

    const body = document.createElement('div');
    body.className = 'ft-tip-body';
    body.textContent = verdict.reason || '자세한 근거를 받지 못했습니다.';

    const pieces = [head, body];

    if (verdict.parts?.length) {
      const label = document.createElement('div');
      label.className = 'ft-tip-label';
      label.textContent = '의심되는 부분';

      const list = document.createElement('ul');
      list.className = 'ft-tip-parts';
      for (const part of verdict.parts) {
        const li = document.createElement('li');
        li.textContent = part;
        list.appendChild(li);
      }
      pieces.push(label, list);
    }

    tip.replaceChildren(...pieces);
    tip.style.visibility = 'hidden';
    tip.style.display = 'block';

    const box = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left), window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = left + window.scrollX + 'px';
    tip.style.top = box.bottom + window.scrollY + 6 + 'px';
    tip.style.visibility = 'visible';
  }

  function hideTip() {
    if (tip) tip.style.display = 'none';
  }

  function makeMark(kind, verdict) {
    const el = document.createElement('span');
    el.className = `ft-mark ${MARKS[kind].cls}`;
    el.textContent = MARKS[kind].text;

    el.addEventListener('mouseenter', () => showTip(el, kind, verdict));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    return el;
  }

  function clearMarks(h3) {
    hideTip();
    h3.querySelectorAll('.ft-mark').forEach((el) => el.remove());
  }

  function showPending(h3) {
    clearMarks(h3);
    const el = document.createElement('span');
    el.className = 'ft-mark ft-pending';
    el.textContent = '검사 중';
    h3.appendChild(el);
  }

  function showVerdict(h3, verdict) {
    clearMarks(h3);
    if (!verdict?.labels?.length) return;

    for (const kind of verdict.labels) {
      if (MARKS[kind]) h3.appendChild(makeMark(kind, verdict));
    }
  }

  // 결과 요약문 추출
  function snippetOf(h3, title) {
    const block = h3.closest('div[data-hveid]') || h3.closest('div.g') || h3.parentElement;
    if (!block) return '';

    return block.innerText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== title)
      .filter((line) => !/^https?:\/\//.test(line) && !line.includes(' › ') && line !== '웹 검색결과')
      .join(' ')
      .slice(0, 300);
  }

  // 검색 결과 수집
  function collect() {
    const root = document.querySelector('#search') || document.querySelector('#rso');
    if (!root) return [];

    const items = [];

    for (const h3 of root.querySelectorAll('h3')) {
      if (h3.dataset[SEEN]) continue;

      const link = h3.closest('a[href]');
      if (!link) continue;

      const url = link.href;
      if (!/^https?:/.test(url)) continue;
      if (/^https?:\/\/[^/]*google\.[^/]+\//.test(url)) continue;

      h3.dataset[SEEN] = '1';

      const title = h3.innerText.trim();
      items.push({ id: 'r' + items.length + Date.now().toString(36), title, url, snippet: snippetOf(h3, title), h3, link });
    }

    return items;
  }

  async function run() {
    const query = new URLSearchParams(location.search).get('q');
    if (!query) return;

    const items = collect();
    if (!items.length) return;

    items.forEach((it) => showPending(it.h3));

    for (const { link, url } of items) {
      link.addEventListener('mousedown', () => {
        chrome.runtime.sendMessage({ type: 'CLICKED', url, query }).catch(() => {});
      });
    }

    await Promise.all(
      items.map(async ({ id, title, url, snippet, h3 }) => {
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'ANALYZE_RESULT',
            query,
            result: { id, title, url, snippet },
          });

          if (!res || res.off || res.error) clearMarks(h3);
          else showVerdict(h3, res.verdict);
        } catch {
          clearMarks(h3);
        }
      })
    );
  }

  // 목록 변화 감시
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 600);
  };

  chrome.storage.local.get('enabled', ({ enabled }) => {
    if (enabled === false) return;
    later();
    new MutationObserver(later).observe(document.querySelector('#search') || document.body, {
      childList: true,
      subtree: true,
    });
  });
})();
