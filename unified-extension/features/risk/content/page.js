// 광고성 · 피싱 부분 하이라이트

(() => {
  if (/^(www\.)?google\.[a-z.]+$/.test(location.hostname) && location.pathname.startsWith('/search')) return;
  if (globalThis.__GURAJEGO_RISK_PAGE_LOADED__) return;
  globalThis.__GURAJEGO_RISK_PAGE_LOADED__ = true;

  const SETTINGS_KEY = 'gurajegeoSettings';
  const PENDING_RETRY_DELAY_MS = 30_000;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'MARK']);
  const BLOCK =
    'p,div,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,section,article,header,footer,main,figcaption,dt,dd,tr,ul,ol,table,form,br';
  const CLICKABLE = 'a,button,summary,label,select,option,[onclick],[role="button"],[role="link"],[role="tab"]';
  const ARTICLE_ROOTS = [
    'article',
    'main',
    '[role="main"]',
    '[itemprop="articleBody"]',
    '[class*="article-body" i]',
    '[class*="article_body" i]',
    '[class*="articleBody"]',
    '[class*="post-content" i]',
    '[class*="entry-content" i]',
    '[id*="article" i]',
    '[id*="content" i]',
  ].join(',');
  const FRAME_STYLE = `
    [data-gurajegeo-risk-scope] mark.ft-hl[data-gurajegeo-ui="risk-highlight"] {
      padding: 0; cursor: inherit; user-select: text; -webkit-user-select: text;
    }
    [data-gurajegeo-risk-scope] mark.ft-hl-phishing[data-gurajegeo-ui="risk-highlight"],
    [data-gurajegeo-risk-scope] [data-gurajegeo-risk-highlight="phishing"].ft-hl-on-phishing {
      background: #ff4b4b !important; color: #fff !important;
    }
    [data-gurajegeo-risk-scope] mark.ft-hl-ad[data-gurajegeo-ui="risk-highlight"],
    [data-gurajegeo-risk-scope] [data-gurajegeo-risk-highlight="ad"].ft-hl-on-ad {
      background: #ffd0d0 !important; color: #7a1010 !important;
    }
  `;

  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));
  const send = (msg) => chrome.runtime.sendMessage({ target: 'gj:risk', ...msg }).catch(() => null);
  const isTitleCollectorTab = async () => {
    const response = await chrome.runtime
      .sendMessage({ target: 'gj:title', type: 'IS_COLLECTOR_TAB' })
      .catch(() => null);
    return response?.data?.collector === true || response?.collector === true;
  };
  let isEnabled = false;
  let runGeneration = 0;
  let settingsGeneration = 0;
  let pendingRetryTimer = null;

  /** 최상위 문서와 접근 가능한 동일 출처 iframe 문서를 재귀적으로 찾습니다. */
  function sameOriginDocuments() {
    const found = [];
    const visited = new Set();
    const queue = [{ doc: document, depth: 0 }];

    while (queue.length && found.length < 12) {
      const current = queue.shift();
      if (!current?.doc?.body || visited.has(current.doc)) continue;
      visited.add(current.doc);
      found.push(current);

      for (const frame of current.doc.querySelectorAll('iframe')) {
        try {
          const frameDoc = frame.contentDocument;
          const frameUrl = frameDoc?.location?.href || '';
          const frameOrigin = frameDoc?.location?.origin;
          if (!frameDoc?.body) continue;
          if (frameOrigin !== location.origin && !/^about:(blank|srcdoc)/.test(frameUrl)) continue;
          queue.push({ doc: frameDoc, depth: current.depth + 1 });
        } catch {
          // 다른 출처 iframe은 브라우저 보안 경계 때문에 읽지 않습니다.
        }
      }
    }

    return found;
  }

  function visibleText(element) {
    return squash(element?.innerText || element?.textContent || '');
  }

  /** 문서마다 가장 기사 본문에 가까운 root를 고르고 전체 후보를 점수순으로 돌려줍니다. */
  function analysisContexts() {
    const contexts = [];

    for (const { doc, depth } of sameOriginDocuments()) {
      const roots = [doc.body, ...doc.querySelectorAll(ARTICLE_ROOTS)];
      let best = null;

      for (const root of new Set(roots)) {
        if (!root || root.closest?.('[data-gurajegeo-ui]')) continue;
        const text = visibleText(root);
        if (text.length < 80) continue;

        const linkTextLength = [...root.querySelectorAll('a')]
          .reduce((sum, link) => sum + visibleText(link).length, 0);
        const linkRatio = Math.min(1, linkTextLength / Math.max(1, text.length));
        const paragraphs = root.querySelectorAll('p, blockquote').length;
        const semantic = root !== doc.body ? 1 : 0;
        const score = Math.min(text.length, 12000) + Math.min(paragraphs, 60) * 100 +
          semantic * 4500 - linkRatio * 4000 - (root === doc.body ? 2500 : 0) + depth * 150;

        if (!best || score > best.score) best = { doc, root, score };
      }

      if (best) contexts.push(best);
    }

    return contexts.sort((a, b) => b.score - a.score);
  }

  function ensureScopedHighlightStyle(context) {
    context.root.dataset.gurajegeoRiskScope = '1';
    if (context.doc === document || context.doc.querySelector('[data-gurajegeo-ui="risk-frame-style"]')) return;

    const style = context.doc.createElement('style');
    style.dataset.gurajegeoUi = 'risk-frame-style';
    style.textContent = FRAME_STYLE;
    (context.doc.head || context.doc.documentElement).appendChild(style);
  }

  function textNodes(context) {
    if (!context?.root) return [];
    const filter = context.doc.defaultView?.NodeFilter || NodeFilter;
    const walker = context.doc.createTreeWalker(context.root, filter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.nodeValue || !parent) return filter.FILTER_REJECT;
        if (SKIP.has(parent.tagName) || parent.closest('[data-gurajegeo-ui], script, style, noscript, textarea, code, pre, mark')) {
          return filter.FILTER_REJECT;
        }
        return filter.FILTER_ACCEPT;
      },
    });

    const list = [];
    let node;
    while ((node = walker.nextNode())) list.push(node);
    return list;
  }

  // 페이지 글자 이어붙이기
  function buildIndex(context = analysisContexts()[0]) {
    let text = '';
    const where = [];
    let lastBlock = null;
    if (!context?.root) return { text, where, context: null };

    const put = (ch, node, offset) => {
      text += ch;
      where.push(node ? { node, offset } : null);
    };

    for (const node of textNodes(context)) {
      const block = node.parentElement.closest(BLOCK) || context.root;
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

    return { text, where, context };
  }

  /** 늦게 채워지는 same-origin iframe까지 잠시 기다린 뒤 가장 기사성 높은 본문을 돌려줍니다. */
  async function waitForAnalysisText(generation) {
    let text = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!isCurrentRun(generation)) return '';
      text = buildIndex().text;
      if (text.length >= 200) return text;
      await sleep(500);
    }
    return text;
  }

  // 한 구간 칠하기
  function paint(node, start, end, kind, label) {
    const clickable = node.parentElement.closest(CLICKABLE);
    if (clickable) {
      clickable.classList.add(`ft-hl-on-${kind}`);
      clickable.dataset.gurajegeoRiskHighlight = kind;
      if (!clickable.title) {
        clickable.title = label;
        clickable.dataset.gurajegeoRiskTitleAdded = '1';
      }
      return true;
    }

    const ownerDocument = node.ownerDocument || document;
    const mark = ownerDocument.createElement('mark');
    mark.className = `ft-hl ft-hl-${kind}`;
    mark.dataset.gurajegeoUi = 'risk-highlight';
    mark.title = label;

    const range = ownerDocument.createRange();
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

    for (const context of analysisContexts()) {
      const { text: hay, where } = buildIndex(context);
      const at = hay.indexOf(needle);
      if (at === -1) continue;
      ensureScopedHighlightStyle(context);
      if (paintRange(where, at, at + needle.length - 1, kind, label) > 0) return true;
    }

    return false;
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
  async function paintSpans(spans, generation) {
    let left = [...spans];
    let found = 0;

    for (let i = 0; i < 12 && left.length; i++) {
      if (!isCurrentRun(generation)) return found;
      const still = [];
      for (const span of left) {
        if (!isCurrentRun(generation)) return found;
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
    document.querySelectorAll('[data-gurajegeo-ui="risk-banner"]').forEach((existing) => existing.remove());
    const names = { phishing: '피싱 의심', ad: '광고성', login: '로그인 필요' };
    const worst = labels.includes('phishing') ? 'phishing' : 'ad';

    const bar = document.createElement('div');
    bar.className = `ft-banner ft-banner-${worst}`;
    bar.dataset.gurajegeoUi = 'risk-banner';

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
    });

    document.body.appendChild(bar);

    return {
      setCount(found) {
        count.textContent = found ? `의심 문구 ${found}곳` : '이 화면에서는 해당 문구를 찾지 못했습니다';
      },
    };
  }

  // 실행 - 배너 표시 후 하이라이트
  async function run() {
    if (!isEnabled) return;
    clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
    const generation = ++runGeneration;
    // 제목 기능이 백그라운드 수집에 쓰는 임시 탭에는 어떤 위험 UI도 만들지 않습니다.
    if (await isTitleCollectorTab()) {
      if (isCurrentRun(generation)) clearRiskUi();
      return;
    }
    if (!isCurrentRun(generation)) return;

    let info = await send({ type: 'GET_MARKS', url: location.href });
    if (!isCurrentRun(generation) || !info || info.off || info.error) return;

    // 검색 결과의 AI 판정이 끝나기 전에 기사를 먼저 연 경우 최대 90초 동안
    // session 메타데이터만 재조회합니다. 본문 분석 요청을 중복 호출하지 않습니다.
    for (let i = 0; i < 90 && info.pending; i++) {
      await sleep(1000);
      if (!isCurrentRun(generation)) return;
      info = await send({ type: 'GET_MARKS', url: location.href });
      if (!info || info.off || info.error) return;
    }
    if (info.pending) {
      // Solar 재시도까지 포함하면 90초를 넘길 수 있습니다. 여기서 영구 종료하지
      // 않고, 현재 실행이 그대로일 때만 나중에 GET_MARKS 조회를 한 번 더 시작합니다.
      schedulePendingRetry(generation);
      return;
    }

    if (info.needsLive) {
      const text = await waitForAnalysisText(generation);
      if (text.length < 200) return;

      info = await send({ type: 'ANALYZE_LIVE', url: location.href, text });
      if (!isCurrentRun(generation) || !info?.risky) return;
    }

    if (!info.risky) return;

    const banner = showBanner({
      labels: info.labels || [],
      reason: info.reason || '',
      summary: info.summary || '',
    });

    for (let i = 0; i < 90 && info.preparing; i++) {
      await sleep(1000);
      if (!isCurrentRun(generation)) return;
      const next = await send({ type: 'GET_MARKS', url: location.href });
      if (next && !next.off && !next.error) info = { ...info, ...next };
    }

    let found = await paintSpans(info.spans || [], generation);
    if (!isCurrentRun(generation)) return;

    if (!found) {
      const text = buildIndex().text;
      if (text.length >= 200) {
        const again = await send({ type: 'RESPAN', url: location.href, text });
        if (!isCurrentRun(generation)) return;
        if (again?.spans?.length) found = await paintSpans(again.spans, generation);
      }
    }

    if (isCurrentRun(generation)) banner.setCount(found);
  }

  const initialSettingsGeneration = settingsGeneration;
  chrome.storage.local.get(SETTINGS_KEY, (stored) => {
    if (settingsGeneration === initialSettingsGeneration) {
      setEnabled(isRiskReady(stored[SETTINGS_KEY]));
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
    const settingChange = changes[SETTINGS_KEY];
    if (riskSettingsSignature(settingChange.oldValue) === riskSettingsSignature(settingChange.newValue)) return;
    settingsGeneration += 1;
    // 키 교체 시 이전 키로 만든 배너와 하이라이트를 즉시 지웁니다. 다음 검색
    // 실행에서 생성된 판정만 이후 기사 페이지에 다시 표시합니다.
    runGeneration += 1;
    clearRiskUi();
    isEnabled = isRiskReady(settingChange.newValue);
  });

  function setEnabled(nextEnabled) {
    const wasEnabled = isEnabled;
    isEnabled = nextEnabled;
    if (!isEnabled) {
      runGeneration += 1;
      clearRiskUi();
    } else if (!wasEnabled) {
      run().catch(() => undefined);
    }
  }

  function isCurrentRun(generation) {
    return isEnabled && generation === runGeneration;
  }

  function schedulePendingRetry(generation) {
    if (pendingRetryTimer || !isCurrentRun(generation)) return;
    pendingRetryTimer = setTimeout(() => {
      pendingRetryTimer = null;
      if (!isCurrentRun(generation)) return;
      // 이전 polling이 완전히 끝난 뒤 실행하므로 본문 분석·UI가 중복되지 않습니다.
      run().catch(() => undefined);
    }, PENDING_RETRY_DELAY_MS);
  }

  function isRiskReady(settings) {
    return settings?.features?.risk !== false && Boolean(String(settings?.apiKey || '').trim());
  }

  function riskSettingsSignature(settings) {
    return JSON.stringify({
      apiKey: String(settings?.apiKey || '').trim(),
      enabled: settings?.features?.risk !== false,
    });
  }

  function clearRiskUi() {
    clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
    for (const { doc } of sameOriginDocuments()) {
      doc.querySelectorAll('mark[data-gurajegeo-ui="risk-highlight"]')
        .forEach((mark) => mark.replaceWith(...mark.childNodes));
      doc.querySelectorAll('[data-gurajegeo-risk-highlight]').forEach((element) => {
        element.classList.remove('ft-hl-on-phishing', 'ft-hl-on-ad');
        delete element.dataset.gurajegeoRiskHighlight;
        if (element.dataset.gurajegeoRiskTitleAdded === '1') {
          element.removeAttribute('title');
          delete element.dataset.gurajegeoRiskTitleAdded;
        }
      });
      doc.querySelectorAll('[data-gurajegeo-risk-scope]')
        .forEach((root) => delete root.dataset.gurajegeoRiskScope);
      doc.querySelectorAll('[data-gurajegeo-ui="risk-frame-style"]')
        .forEach((style) => style.remove());
    }
    document.querySelectorAll('[data-gurajegeo-ui="risk-banner"]').forEach((banner) => banner.remove());
  }
})();
