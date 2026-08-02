// 광고성 · 피싱 부분 하이라이트

(() => {
  if (/^(www\.)?google\.[a-z.]+$/.test(location.hostname) && location.pathname.startsWith('/search')) return;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'MARK']);
  const BLOCK =
    'p,div,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,section,article,header,footer,main,figcaption,dt,dd,tr,ul,ol,table,form,br';
  const CLICKABLE = 'a,button,summary,label,select,option,[onclick],[role="button"],[role="link"],[role="tab"]';

  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  function textNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.nodeValue || !parent) return NodeFilter.FILTER_REJECT;
        if (SKIP.has(parent.tagName) || parent.closest('.ft-banner')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const list = [];
    let node;
    while ((node = walker.nextNode())) list.push(node);
    return list;
  }

  // 페이지 글자 이어붙이기
  function buildIndex() {
    let text = '';
    const where = [];
    let lastBlock = null;

    const put = (ch, node, offset) => {
      text += ch;
      where.push(node ? { node, offset } : null);
    };

    for (const node of textNodes()) {
      const block = node.parentElement.closest(BLOCK) || document.body;
      if (lastBlock && block !== lastBlock && !text.endsWith(' ')) put(' ', null, 0);
      lastBlock = block;

      const value = node.nodeValue;
      for (let i = 0; i < value.length; i++) {
        if (/\s/.test(value[i])) {
          if (text === '' || text.endsWith(' ')) continue;
          put(' ', node, i);
        } else {
          put(value[i], node, i);
        }
      }
    }

    return { text, where };
  }

  // 한 구간 칠하기
  function paint(node, start, end, kind, label) {
    const clickable = node.parentElement.closest(CLICKABLE);
    if (clickable) {
      clickable.classList.add(`ft-hl-on-${kind}`);
      if (!clickable.title) clickable.title = label;
      return true;
    }

    const mark = document.createElement('mark');
    mark.className = `ft-hl ft-hl-${kind}`;
    mark.title = label;

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);

    try {
      range.surroundContents(mark);
      return true;
    } catch {
      return false;
    }
  }

  // 노드에 걸친 구간 칠하기
  function paintRange(where, from, to, kind, label) {
    const perNode = new Map();

    for (let i = from; i <= to; i++) {
      const spot = where[i];
      if (!spot) continue;
      const seen = perNode.get(spot.node);
      if (seen) {
        seen[0] = Math.min(seen[0], spot.offset);
        seen[1] = Math.max(seen[1], spot.offset);
      } else {
        perNode.set(spot.node, [spot.offset, spot.offset]);
      }
    }

    let painted = 0;
    for (const [node, [a, b]] of perNode) {
      if (!node.parentElement) continue;
      if (!node.nodeValue.slice(a, b + 1).trim()) continue;
      if (paint(node, a, b + 1, kind, label)) painted++;
    }
    return painted;
  }

  function findAndPaint(text, kind, label) {
    const needle = squash(text);
    if (needle.length < 6) return false;

    const { text: hay, where } = buildIndex();
    const at = hay.indexOf(needle);
    if (at === -1) return false;

    return paintRange(where, at, at + needle.length - 1, kind, label) > 0;
  }

  // 문장 하나 찾아서 칠하기
  function highlight(span) {
    const label = span.reason || (span.kind === 'phishing' ? '피싱 의심 문구' : '광고성 문구');
    if (findAndPaint(span.text, span.kind, label)) return 1;

    const bare = squash(span.text).replace(/^[^0-9a-zA-Z가-힣]+|[^0-9a-zA-Z가-힣]+$/g, '');
    if (bare !== squash(span.text) && findAndPaint(bare, span.kind, label)) return 1;

    const parts = squash(span.text)
      .split(/(?<=[.!?。」”])\s+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 12);

    if (parts.length < 2) return 0;
    return parts.filter((p) => findAndPaint(p, span.kind, label)).length;
  }

  // 문장 목록 칠하기 (재시도 포함)
  async function paintSpans(spans) {
    let left = [...spans];
    let found = 0;

    for (let i = 0; i < 12 && left.length; i++) {
      const still = [];
      for (const span of left) {
        const n = highlight(span);
        if (n) found += n;
        else still.push(span);
      }
      left = still;
      if (left.length) await sleep(1000);
    }

    return found;
  }

  function showBanner({ labels, reason, summary }) {
    const names = { phishing: '피싱 의심', ad: '광고성', login: '로그인 필요' };
    const worst = labels.includes('phishing') ? 'phishing' : 'ad';

    const bar = document.createElement('div');
    bar.className = `ft-banner ft-banner-${worst}`;

    const main = document.createElement('div');
    main.className = 'ft-banner-main';
    const tag = document.createElement('strong');
    tag.textContent = labels.map((l) => names[l] || l).join(' · ');
    const note = document.createElement('span');
    note.textContent = [reason, summary].filter(Boolean).join(' — ');
    main.append(tag, note);

    const side = document.createElement('div');
    side.className = 'ft-banner-side';
    const count = document.createElement('span');
    count.className = 'ft-banner-count';
    count.textContent = '의심 문구 찾는 중';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ft-banner-close';
    close.textContent = '닫기';
    side.append(count, close);

    bar.append(main, side);
    close.addEventListener('click', () => {
      bar.remove();
      document.documentElement.style.removeProperty('margin-top');
    });

    document.body.appendChild(bar);
    document.documentElement.style.marginTop = bar.offsetHeight + 'px';

    return {
      setCount(found) {
        count.textContent = found ? `의심 문구 ${found}곳` : '이 화면에서는 해당 문구를 찾지 못했습니다';
      },
    };
  }

  // 실행 - 배너 표시 후 하이라이트
  async function run() {
    let info = await send({ type: 'GET_MARKS', url: location.href });
    if (!info || info.off || info.error) return;

    if (info.needsLive) {
      await sleep(1500);
      const text = document.body?.innerText || '';
      if (text.length < 200) return;

      info = await send({ type: 'ANALYZE_LIVE', url: location.href, text });
      if (!info?.risky) return;
    }

    if (!info.risky) return;

    const banner = showBanner({
      labels: info.labels || [],
      reason: info.reason || '',
      summary: info.summary || '',
    });

    for (let i = 0; i < 90 && info.preparing; i++) {
      await sleep(1000);
      const next = await send({ type: 'GET_MARKS', url: location.href });
      if (next && !next.off && !next.error) info = { ...info, ...next };
    }

    let found = await paintSpans(info.spans || []);

    if (!found) {
      const text = document.body?.innerText || '';
      if (text.length >= 200) {
        const again = await send({ type: 'RESPAN', url: location.href, text });
        if (again?.spans?.length) found = await paintSpans(again.spans);
      }
    }

    banner.setCount(found);
  }

  chrome.storage.local.get('enabled', ({ enabled }) => {
    if (enabled !== false) run();
  });
})();
