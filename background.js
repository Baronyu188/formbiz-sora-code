const FORM_BIZ_TARGET_URL = 'https://formbiz.biz/';
const FORM_BIZ_URL_PATTERNS = ['https://formbiz.biz/*', 'https://www.formbiz.biz/*'];
const SORA_TARGET_URL = 'https://sora.chatgpt.com/explore';
const SORA_URL_PATTERNS = ['https://sora.chatgpt.com/*'];

let automationState = {
  active: false,
  formbizTabId: null,
  soraTabId: null,
  currentStep: 'idle',
  lastCode: '',
  codeSource: '',
  lastCodeTimestamp: 0,
  attempts: 0,
  error: null
};

let automationLoopPromise = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function snapshotState() {
  return JSON.parse(JSON.stringify(automationState));
}

function notifyState() {
  try {
    chrome.runtime.sendMessage({ action: 'stateUpdate', state: snapshotState() }).catch(() => {});
  } catch (error) {
    // 忽略没有监听者时的异常
  }
}

function pushState(patch = {}) {
  Object.assign(automationState, patch);
  notifyState();
}

async function getOrCreateTab(targetUrl, matchPatterns) {
  const patterns = Array.isArray(matchPatterns) && matchPatterns.length ? matchPatterns : [`${targetUrl.replace(/\/*$/, '')}/*`];
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch (error) {
    tabs = [];
  }

  if (tabs && tabs.length > 0) {
    const tab = tabs[0];
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    return tab.id;
  }

  const created = await chrome.tabs.create({ url: targetUrl, active: true });
  return created.id;
}

async function focusTab(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab?.id === 'number') {
      await chrome.tabs.update(tab.id, { active: true });
    }
    if (typeof tab?.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (error) {
    console.warn('无法聚焦标签页', error?.message || error);
  }
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        return true;
      }
    } catch (error) {
      return false;
    }
    await delay(300);
  }
  return false;
}

async function callContentScript(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (chrome.runtime.lastError) {
      console.warn('内容脚本未准备好:', chrome.runtime.lastError.message);
    }
    return null;
  }
}

async function waitForFormbizCode(tabId, previousCode = '', previousTimestamp = 0) {
  const timeoutMs = 8000;
  const start = Date.now();
  while (automationState.active && Date.now() - start < timeoutMs) {
    const response = await callContentScript(tabId, { action: 'getLatestFormbizCode' });
    const code = response?.code ? String(response.code).trim().toUpperCase() : '';
    const timestamp = Number(response?.copiedAt || 0);
    if (code && (code !== previousCode || timestamp > previousTimestamp)) {
      return { code, source: response?.source || 'unknown', timestamp };
    }
    await delay(250);
  }
  return { code: '', source: 'timeout', timestamp: 0 };
}

async function elementExists(tabId, descriptors) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (options) => {
      const element = locateElement(options);
      return !!element;

      function locateElement(opts) {
        if (!opts || typeof opts !== 'object') {
          return null;
        }
        const list = [];
        if (Array.isArray(opts.selectors)) {
          for (const selector of opts.selectors) {
            try {
              const found = document.querySelector(selector);
              if (found) {
                list.push(found);
              }
            } catch (err) {}
          }
        }
        if (Array.isArray(opts.xpaths)) {
          for (const path of opts.xpaths) {
            try {
              const evaluated = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
              if (evaluated) {
                list.push(evaluated);
              }
            } catch (err) {}
          }
        }
        if (Array.isArray(opts.textMatches) && opts.textMatches.length) {
          const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
          for (const button of buttons) {
            const text = (button.innerText || button.textContent || '').trim().toLowerCase();
            const aria = (button.getAttribute('aria-label') || '').trim().toLowerCase();
            if (!text && !aria) continue;
            for (const keyword of opts.textMatches) {
              if ((text && text.includes(keyword)) || (aria && aria.includes(keyword))) {
                list.push(button);
                break;
              }
            }
          }
        }
        return list.find(el => el && typeof el.click === 'function' && isVisible(el)) || list[0] || null;
      }

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
    },
    args: [descriptors]
  });
  return !!results[0]?.result;
}

async function clickElement(tabId, descriptors) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (options) => {
      const element = locateElement(options);
      if (!element) {
        return { clicked: false };
      }
      try {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      } catch (error) {}
      element.click();
      return { clicked: true };

      function locateElement(opts) {
        if (!opts || typeof opts !== 'object') {
          return null;
        }
        const attempts = [];
        if (Array.isArray(opts.selectors)) {
          for (const selector of opts.selectors) {
            try {
              const found = document.querySelector(selector);
              if (found) {
                attempts.push(found);
              }
            } catch (err) {}
          }
        }
        if (Array.isArray(opts.xpaths)) {
          for (const path of opts.xpaths) {
            try {
              const evaluated = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
              if (evaluated) {
                attempts.push(evaluated);
              }
            } catch (err) {}
          }
        }
        if (Array.isArray(opts.textMatches) && opts.textMatches.length) {
          const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
          for (const node of nodes) {
            const text = (node.innerText || node.textContent || '').trim().toLowerCase();
            const aria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
            if (!text && !aria) continue;
            for (const keyword of opts.textMatches) {
              if ((text && text.includes(keyword)) || (aria && aria.includes(keyword))) {
                attempts.push(node);
                break;
              }
            }
          }
        }
        return attempts.find(el => el && typeof el.click === 'function' && isVisible(el)) || attempts[0] || null;
      }

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
    },
    args: [descriptors]
  });
  return !!results[0]?.result?.clicked;
}

const FORM_BUTTONS = {
  fetch: {
    xpaths: [
      '/html/body/div[2]/div[2]/div/div[1]/section[1]/div/div/div[3]/button'
    ],
    selectors: [
      'button[data-role="generate-code"]',
      'button.generate-code'
    ],
    textMatches: ['获取', '刷新', 'generate', 'new code', '立即获取', 'click']
  },
  copy: {
    xpaths: [
      '/html/body/div[2]/div[2]/div/div[1]/section[1]/div/div[2]/button'
    ],
    selectors: [
      'button[data-role="copy-code"]',
      'button.copy-code',
      'button.copy-btn'
    ],
    textMatches: ['复制', 'copy', '获取邀请码', '领取', 'copy code']
  },
  mark: {
    xpaths: [
      '/html/body/div[2]/div[2]/div/div[1]/section[1]/div/div[2]/div/button[2]'
    ],
    selectors: [
      'button[data-role="next-code"]',
      'button.next-code'
    ],
    textMatches: ['无效', '下一', '下一个', '继续', '失败', 'next', 'another']
  }
};

async function acquireCodeFromFormbiz() {
  const tabId = automationState.formbizTabId;
  if (!tabId) {
    return { success: false, reason: 'formbiz-tab-missing' };
  }

  const maxClicks = 10;
  for (let i = 0; i < maxClicks && automationState.active; i++) {
    const hasSecond = await elementExists(tabId, FORM_BUTTONS.copy);
    if (hasSecond) {
      break;
    }
    await clickElement(tabId, FORM_BUTTONS.fetch);
    await delay(1500);
  }

  const secondAvailable = await elementExists(tabId, FORM_BUTTONS.copy);
  if (!secondAvailable) {
    return { success: false, reason: 'second-button-not-found' };
  }

  await clickElement(tabId, FORM_BUTTONS.copy);
  await delay(400);

  const { code, source, timestamp } = await waitForFormbizCode(
    tabId,
    automationState.lastCode || '',
    automationState.lastCodeTimestamp || 0
  );
  if (!code) {
    return { success: false, reason: 'code-not-captured' };
  }

  return { success: true, code, source, timestamp };
}

async function markCodeAsFailed() {
  const tabId = automationState.formbizTabId;
  if (!tabId) return;
  await clickElement(tabId, FORM_BUTTONS.mark);
}

function checkSoraDisconnectedScript() {
  const text = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
  if (!text) {
    return false;
  }
  return text.includes('断开') || text.includes('disconnected') || text.includes('connection lost');
}

async function ensureSoraConnected(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: checkSoraDisconnectedScript
  });
  if (result) {
    await chrome.tabs.reload(tabId);
    await delay(4000);
    await waitForTabComplete(tabId, 20000);
    await delay(1000);
    return true;
  }
  return false;
}

async function attemptSubmitInvite(tabId, code) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: submitInviteCodeScript,
      args: [code]
    });
    return result || { success: false, error: 'submit-failed' };
  } catch (error) {
    console.error('执行邀请码提交脚本失败', error);
    return { success: false, error: error?.message || 'submit-script-error' };
  }
}

async function analyzeSoraOutcome(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: analyzeSoraResultScript
    });
    return result || { status: 'unknown' };
  } catch (error) {
    console.error('分析 Sora 结果失败', error);
    return { status: 'unknown', error: error?.message || 'analyze-failed' };
  }
}

function submitInviteCodeScript(code) {
  const INPUT_KEYWORDS = ['invite', '邀请码', 'invitation', 'access code', 'accesscode', 'access-code', 'code'];
  const BUTTON_KEYWORDS = ['继续', '确认', '提交', '兑换', '完成', 'continue', 'submit', 'apply', 'redeem', 'unlock', 'access', 'enter', 'next'];

  function matchesKeyword(value, keywords) {
    if (!value) return false;
    const lower = value.toLowerCase();
    return keywords.some(keyword => lower.includes(keyword));
  }

  function findLabelText(input) {
    if (!input || !input.id) return '';
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (!label) return '';
    return (label.innerText || label.textContent || '').trim();
  }

  function findInviteInput() {
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
    for (const input of inputs) {
      const attributes = [
        input.placeholder,
        input.name,
        input.id,
        input.getAttribute('aria-label'),
        input.getAttribute('data-placeholder'),
        findLabelText(input)
      ];
      if (attributes.some(attr => matchesKeyword(attr, INPUT_KEYWORDS))) {
        return input;
      }
    }
    return null;
  }

  function findSubmitButton(input) {
    const scope = input?.closest('form, section, div, dialog') || document;
    const buttons = Array.from(scope.querySelectorAll('button, [role="button"], input[type="submit"]'));
    for (const button of buttons) {
      const text = (button.innerText || button.textContent || '').trim();
      const aria = (button.getAttribute('aria-label') || '').trim();
      if (matchesKeyword(text, BUTTON_KEYWORDS) || matchesKeyword(aria, BUTTON_KEYWORDS)) {
        return button;
      }
    }
    return null;
  }

  try {
    const input = findInviteInput();
    if (!input) {
      return { success: false, error: 'invite-input-not-found' };
    }

    input.focus();
    input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof input.setSelectionRange === 'function') {
      const end = code.length;
      input.setSelectionRange(end, end);
    }

    const button = findSubmitButton(input);
    if (button) {
      try {
        button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      } catch (error) {}
      button.click();
    }

    const keyboardInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    input.dispatchEvent(new KeyboardEvent('keydown', keyboardInit));
    input.dispatchEvent(new KeyboardEvent('keypress', keyboardInit));
    input.dispatchEvent(new KeyboardEvent('keyup', keyboardInit));

    if (button) {
      return { success: true, method: 'button-and-enter' };
    }

    if (input.form) {
      input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      if (typeof input.form.submit === 'function') {
        input.form.submit();
      }
      return { success: true, method: 'form' };
    }

    return { success: true, method: 'enter-key' };
  } catch (error) {
    return { success: false, error: error?.message || 'submit-failed' };
  }
}

function analyzeSoraResultScript() {
  const INPUT_KEYWORDS = ['invite', '邀请码', 'invitation', 'access code', 'accesscode', 'access-code', 'code'];
  const FAILURE_KEYWORDS = ['无效', '错误', '失败', '已使用', 'invalid', 'incorrect', 'try again', 'error', 'not recognized', 'not valid', 'expired'];
  const SUCCESS_KEYWORDS = ['欢迎', '成功', '开始创作', 'create', 'access granted', 'you now have access', 'enjoy'];

  function matchesKeyword(value, keywords) {
    if (!value) return false;
    const lower = value.toLowerCase();
    return keywords.some(keyword => lower.includes(keyword));
  }

  function findInviteInput() {
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
    for (const input of inputs) {
      const attributes = [
        input.placeholder,
        input.name,
        input.id,
        input.getAttribute('aria-label'),
        input.getAttribute('data-placeholder'),
        (() => {
          if (!input || !input.id) return '';
          const label = document.querySelector(`label[for="${input.id}"]`);
          return (label?.innerText || label?.textContent || '').trim();
        })()
      ];
      if (attributes.some(attr => matchesKeyword(attr, INPUT_KEYWORDS))) {
        return input;
      }
    }
    return null;
  }

  function extractRelevantText() {
    const snippets = [];
    const selectors = ['[role="alert"]', '.text-destructive', '.text-error', '.text-red-500', '.error', '.error-message'];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(node => {
        const text = (node.innerText || node.textContent || '').trim();
        if (text) {
          snippets.push(text);
        }
      });
    }
    if (!snippets.length) {
      const bodyText = (document.body?.innerText || '').trim();
      if (bodyText) {
        snippets.push(bodyText);
      }
    }
    return snippets.join('\n').toLowerCase();
  }

  const input = findInviteInput();
  const text = extractRelevantText();

  if (!input) {
    return { status: 'success', detail: 'invite-input-absent' };
  }

  const failureMatch = FAILURE_KEYWORDS.find(keyword => text.includes(keyword));
  if (failureMatch) {
    return { status: 'failure', detail: failureMatch };
  }

  const successMatch = SUCCESS_KEYWORDS.find(keyword => text.includes(keyword));
  if (successMatch) {
    return { status: 'success', detail: successMatch };
  }

  return { status: 'unknown' };
}

async function submitCodeToSora(code) {
  automationState.soraTabId = await getOrCreateTab(SORA_TARGET_URL, SORA_URL_PATTERNS);
  await waitForTabComplete(automationState.soraTabId, 20000);
  await focusTab(automationState.soraTabId);
  await delay(500);
  await ensureSoraConnected(automationState.soraTabId);

  const submission = await attemptSubmitInvite(automationState.soraTabId, code);
  if (!submission.success) {
    if (submission.error === 'invite-input-not-found') {
      return { status: 'unknown', reason: submission.error };
    }
    return { status: 'failure', reason: submission.error || 'submit-failed' };
  }

  await delay(2000);

  const outcome = await analyzeSoraOutcome(automationState.soraTabId);
  if (!outcome || !outcome.status) {
    return { status: 'unknown' };
  }

  return outcome;
}

async function automationLoop() {
  while (automationState.active) {
    pushState({ currentStep: '正在获取FormBiz邀请码', error: null });

    const codeResult = await acquireCodeFromFormbiz();
    if (!automationState.active) {
      return;
    }

    if (!codeResult.success) {
      pushState({ currentStep: '等待FormBiz按钮', error: codeResult.reason });
      await delay(1500);
      continue;
    }

    automationState.lastCode = codeResult.code;
    automationState.codeSource = codeResult.source;
    automationState.lastCodeTimestamp = codeResult.timestamp || Date.now();
    pushState({
      currentStep: '已获取邀请码',
      lastCode: codeResult.code,
      codeSource: codeResult.source,
      lastCodeTimestamp: automationState.lastCodeTimestamp,
      error: null
    });

    const soraResult = await submitCodeToSora(codeResult.code);
    if (!automationState.active) {
      return;
    }

    if (soraResult.status === 'success') {
      pushState({ currentStep: 'success', error: null });
      stopAutomation({ keepState: true });
      return;
    }

    if (soraResult.status === 'unknown') {
      pushState({
        currentStep: '等待 Sora 响应',
        error: soraResult.reason || 'waiting',
        attempts: automationState.attempts
      });
      await delay(20000);
      continue;
    }

    automationState.attempts += 1;
    pushState({
      currentStep: '邀请码无效，继续尝试',
      attempts: automationState.attempts,
      error: soraResult.reason || 'invalid-code'
    });

    if (automationState.formbizTabId) {
      await focusTab(automationState.formbizTabId);
    }
    await markCodeAsFailed();
    await delay(1200);
  }
}

async function runAutomation() {
  try {
    automationState.formbizTabId = await getOrCreateTab(FORM_BIZ_TARGET_URL, FORM_BIZ_URL_PATTERNS);
    await waitForTabComplete(automationState.formbizTabId, 20000);
    await chrome.tabs.update(automationState.formbizTabId, { active: true });
    pushState({ currentStep: '已定位FormBiz页面' });
    await delay(800);
    await automationLoop();
  } catch (error) {
    console.error('自动化流程异常', error);
    pushState({ error: error?.message || 'automation-failed' });
    stopAutomation();
  }
}

async function startAutomation() {
  if (automationState.active || automationLoopPromise) {
    return;
  }

  automationState.active = true;
  automationState.attempts = 0;
  automationState.error = null;
  automationState.lastCode = '';
  automationState.codeSource = '';
  automationState.lastCodeTimestamp = 0;
  pushState({ currentStep: '初始化中', active: true });

  automationLoopPromise = runAutomation();
  automationLoopPromise.finally(() => {
    automationLoopPromise = null;
  });
}

function stopAutomation(options = {}) {
  automationState.active = false;
  if (options.keepState) {
    notifyState();
    return;
  }
  pushState({
    currentStep: 'idle',
    error: options.error || null,
    active: false,
    lastCode: '',
    lastCodeTimestamp: 0,
    codeSource: ''
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.action) {
    case 'startAutomation':
      startAutomation();
      sendResponse({ success: true });
      return true;
    case 'stopAutomation':
      stopAutomation();
      sendResponse({ success: true });
      return true;
    case 'getState':
      sendResponse({ state: snapshotState() });
      return true;
    default:
      return false;
  }
});

function resetState() {
  automationState = {
    active: false,
    formbizTabId: null,
    soraTabId: null,
    currentStep: 'idle',
    lastCode: '',
    codeSource: '',
    lastCodeTimestamp: 0,
    attempts: 0,
    error: null
  };
  notifyState();
}

chrome.runtime.onInstalled.addListener(resetState);
chrome.runtime.onStartup.addListener(resetState);
