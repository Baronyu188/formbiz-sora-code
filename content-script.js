(() => {
  const host = location.hostname;
  let lastCopiedCode = '';
  let lastCopiedAt = 0;

  if (host.includes('formbiz.biz')) {
    injectClipboardSniffer();
    window.addEventListener('formbiz-code-copied', (event) => {
      const detail = event.detail || {};
      if (typeof detail.text === 'string') {
        lastCopiedCode = detail.text.trim();
        lastCopiedAt = detail.timestamp || Date.now();
      }
    });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === 'getLatestFormbizCode' && host.includes('formbiz.biz')) {
      const fallback = scrapeCodeFromDom();
      const timestamp = lastCopiedAt || (fallback ? Date.now() : 0);
      sendResponse({
        code: lastCopiedCode || fallback,
        copiedAt: timestamp,
        source: lastCopiedCode ? 'clipboard-hook' : (fallback ? 'dom-scan' : 'none')
      });
      return true;
    }

    if (request?.action === 'pingContentScript') {
      sendResponse({ ok: true, host });
      return true;
    }

    return false;
  });

  function injectClipboardSniffer() {
    const script = document.createElement('script');
    script.textContent = `(() => {
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
          return;
        }
        if (window.__formbizClipboardHookInstalled) {
          return;
        }
        window.__formbizClipboardHookInstalled = true;
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async function(text) {
          window.__formbizLastCopiedCode = text;
          window.dispatchEvent(new CustomEvent('formbiz-code-copied', {
            detail: { text, timestamp: Date.now() }
          }));
          try {
            return await original(text);
          } catch (err) {
            console.warn('Formbiz clipboard write failed', err);
            throw err;
          }
        };
      } catch (error) {
        console.warn('Failed to hook clipboard write', error);
      }
    })();`;
    document.documentElement.appendChild(script);
    script.remove();
  }

  function scrapeCodeFromDom() {
    if (!host.includes('formbiz.biz')) {
      return '';
    }

    const patterns = [
      /\b[A-Z0-9]{6}\b/g,
      /\b[A-Z0-9]{7}\b/g,
      /\b[A-Z0-9]{8}\b/g
    ];

    const seen = new Set();
    const candidates = [];

    const elements = Array.from(document.querySelectorAll('[data-clipboard-text], code, pre, span, button, div, p, h1, h2, h3, h4'));
    for (const element of elements) {
      if (!element) continue;

      const attrText = element.getAttribute('data-clipboard-text');
      if (attrText && attrText.length <= 16) {
        const normalized = attrText.trim().toUpperCase();
        if (/^[A-Z0-9]+$/.test(normalized) && normalized.length >= 6 && normalized.length <= 10) {
          candidates.push(normalized);
          continue;
        }
      }

      const text = element.innerText || element.textContent || '';
      if (!text) continue;

      const upper = text.toUpperCase();
      for (const pattern of patterns) {
        const matches = upper.match(pattern);
        if (!matches) continue;
        for (const match of matches) {
          if (!seen.has(match)) {
            seen.add(match);
            candidates.push(match);
          }
        }
      }
    }

    return candidates.length ? candidates[candidates.length - 1] : '';
  }
})();
