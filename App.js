import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { WebView } from 'react-native-webview';
import CookieManager from '@react-native-cookies/cookies';

const COOKIE_KEY = 'pasted_browser_cookie_text_v1';
const DELAY_KEY = 'watch_delay_seconds_v1';
const SITES = {
  youtube: { label: 'YouTube', url: 'https://www.youtube.com/' },
  aviso: { label: 'Aviso', url: 'https://aviso.bz/tasks-youtube' },
};

// ============================================================================
// HELPERS COOKIES
// ============================================================================

function cookiePairs(raw) {
  const text = (raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed.cookies;
      if (Array.isArray(list)) {
        return list
          .filter((c) => c?.name && c?.value !== undefined)
          .map((c) => [c.name, String(c.value)]);
      }
    } catch (_) {}
  }
  const pairs = [];
  text.split(/\r?\n|;/).forEach((line) => {
    const value = line.trim();
    if (!value || value.startsWith('#') || value.startsWith('//')) return;
    const first = value.indexOf('=');
    if (first <= 0) return;
    const name = value.slice(0, first).trim();
    const cookieValue = value.slice(first + 1).trim();
    if (/^[\w!#$%&'*+.^`|~-]+$/.test(name)) pairs.push([name, cookieValue]);
  });
  return pairs;
}

function cookieRecords(raw) {
  const text = (raw || '').trim();
  if (!text || (!text.startsWith('[') && !text.startsWith('{'))) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.cookies;
    return Array.isArray(list) ? list.filter((cookie) => cookie?.name && cookie?.value !== undefined) : [];
  } catch (_) {
    return [];
  }
}

function cookieHeader(cookie) {
  const attributes = [`${cookie.name}=${String(cookie.value)}`, `Path=${cookie.path || '/'}`];
  if (cookie.domain) attributes.push(`Domain=${cookie.domain}`);
  if (cookie.secure) attributes.push('Secure');
  if (cookie.httpOnly) attributes.push('HttpOnly');
  if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
    const sameSite = String(cookie.sameSite).toLowerCase();
    attributes.push(`SameSite=${sameSite === 'no_restriction' ? 'None' : sameSite[0].toUpperCase() + sameSite.slice(1)}`);
  }
  const expires = cookie.expirationDate || cookie.expires;
  if (expires && Number(expires) > 0) attributes.push(`Expires=${new Date(Number(expires) * 1000).toUTCString()}`);
  return attributes.join('; ');
}

async function restoreNativeCookies(raw, url) {
  const records = cookieRecords(raw);
  if (!records.length) return false;
  for (const cookie of records) {
    try {
      await CookieManager.setFromResponse(url, cookieHeader(cookie));
    } catch (_) {
      try {
        await CookieManager.set(url, {
          name: cookie.name,
          value: String(cookie.value),
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: Boolean(cookie.secure),
          expires: (cookie.expirationDate || cookie.expires)
            ? new Date(Number(cookie.expirationDate || cookie.expires) * 1000).toISOString()
            : undefined,
        });
      } catch (_) {}
    }
  }
  try { await CookieManager.flush(); } catch (_) {}
  return true;
}

function cookieScript(raw, url) {
  const host = new URL(url).hostname;
  const pairs = cookiePairs(raw);
  const statements = pairs.map(([name, value]) =>
    `document.cookie=${JSON.stringify(`${name}=${value}; path=/; domain=${host}`)};`
  );
  return `${statements.join('')}true;`;
}

// ============================================================================
// HELPERS YOUTUBE
// ============================================================================

function extractVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
    }
    if (u.hostname === 'youtu.be') {
      return u.pathname.replace(/^\/+/, '').split(/[?#]/)[0];
    }
    if (u.hostname.includes('youtube.com') && u.pathname.includes('/embed/')) {
      const m = u.pathname.match(/\/embed\/([^/?]+)/);
      if (m && m[1]) return m[1];
    }
  } catch (_) {}
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ============================================================================
// SCRIPTS INJECTÉS
// ============================================================================

const avisoTaskCounterScript = `
(function() {
  if (window.__avisoTaskCounterInstalled) {
    window.__avisoSendTaskCount && window.__avisoSendTaskCount();
    true;
  } else {
    window.__avisoTaskCounterInstalled = true;
    window.__avisoSendTaskCount = function() {
      var nodes = Array.from(document.querySelectorAll('span[id^="link_ads_start_"]'));
      var visible = nodes.filter(function(node) {
        var style = window.getComputedStyle(node);
        return node.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
      });
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'avisoTaskCount',
        count: visible.length
      }));
    };
    var observer = new MutationObserver(function() { window.__avisoSendTaskCount(); });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    window.__avisoSendTaskCount();
    true;
  }
})();
true;
`;

const avisoOpenHookScript = `
(function() {
  if (window.__avisoOpenHooked) return true;
  window.__avisoOpenHooked = true;

  function isRelevant(url) {
    if (!url) return false;
    return url.indexOf('/go/') !== -1
        || url.indexOf('youtube.com') !== -1
        || url.indexOf('youtu.be') !== -1;
  }

  function report(url, source) {
    try {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'redirectCaptured',
        url: url,
        source: source
      }));
    } catch(e) {}
  }

  var originalOpen = window.open;
  window.open = function(url, target, features) {
    if (isRelevant(url)) {
      report(url, 'window.open');
      return null;
    }
    return originalOpen.apply(window, arguments);
  };

  document.addEventListener('click', function(ev) {
    var el = ev.target;
    while (el && el !== document.body) {
      if (el.tagName === 'A' && el.href && isRelevant(el.href)) {
        report(el.href, 'a-click');
        ev.preventDefault();
        ev.stopPropagation();
        return false;
      }
      el = el.parentElement;
    }
  }, true);

  document.addEventListener('submit', function(ev) {
    var action = ev.target && ev.target.action;
    if (isRelevant(action)) {
      report(action, 'form-submit');
      ev.preventDefault();
      return false;
    }
  }, true);

  true;
})();
true;
`;

const avisoAutoClickScript = `
(function() {
  function extractTime(taskElement) {
    var id = taskElement.id.replace('link_ads_start_', '');
    var timerInput = document.getElementById('ads_timer_' + id);
    if (timerInput && timerInput.value) {
      var val = parseInt(timerInput.value, 10);
      if (!isNaN(val) && val > 0) return val;
    }
    var onclickAttr = taskElement.getAttribute('onclick');
    if (onclickAttr) {
      var match = onclickAttr.match(/, ['"](\\d+)['"]/);
      if (match && match[1]) {
        var v = parseInt(match[1], 10);
        if (!isNaN(v) && v > 0) return v;
      }
    }
    try {
      var row = taskElement.closest('tr');
      if (row) {
        var timeSpan = row.querySelector('span.serf-text');
        if (timeSpan) {
          var tm = timeSpan.innerText.match(/(\\d+)\\s*сек/);
          if (tm && tm[1]) {
            var t = parseInt(tm[1], 10);
            if (!isNaN(t) && t > 0) return t;
          }
        }
      }
    } catch(e) {}
    return 999;
  }

  function send(message) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  window.__avisoAutoClick = function() {
    try {
      var tasks = document.querySelectorAll('span[id^="link_ads_start_"]');
      var visible = Array.from(tasks).filter(function(t) { return t.offsetParent !== null; });
      if (visible.length === 0) {
        send({ type: 'autoClickResult', status: 'empty', message: 'Aucune tâche disponible' });
        return;
      }
      var withTime = visible.map(function(t) {
        return {
          el: t,
          id: t.id.replace('link_ads_start_', ''),
          time: extractTime(t)
        };
      });
      withTime.sort(function(a, b) { return a.time - b.time; });
      var chosen = withTime[0];

      document.querySelectorAll('[data-aviso-assistant="selected"]').forEach(function(el) {
        el.style.outline = '';
        el.removeAttribute('data-aviso-assistant');
      });
      chosen.el.setAttribute('data-aviso-assistant', 'selected');
      chosen.el.style.outline = '3px solid #64d2ff';
      try { chosen.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}

      send({
        type: 'autoClickResult',
        status: 'clicked',
        id: chosen.id,
        time: chosen.time,
        total: withTime.length
      });

      chosen.el.click();
    } catch(e) {
      send({ type: 'autoClickResult', status: 'error', message: e.message });
    }
  };

  true;
})();
true;
`;

const rewardWatcherScript = `
(function() {
  if (window.__rewardWatcherInstalled) return true;
  window.__rewardWatcherInstalled = true;

  function send(message) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  var lastReportedId = null;

  setInterval(function() {
    try {
      var confirmBtns = document.querySelectorAll('span[id^="ads_btn_confirm_"]');
      var visible = Array.from(confirmBtns).filter(function(b) {
        return b.offsetParent !== null;
      });
      if (visible.length > 0) {
        var id = visible[0].id.replace('ads_btn_confirm_', '');
        if (id !== lastReportedId) {
          lastReportedId = id;
          send({ type: 'rewardAvailable', id: id });
        }
      } else {
        lastReportedId = null;
      }

      var bodyText = (document.body.innerText || '').toLowerCase();
      if (bodyText.indexOf('задача выполнена') !== -1 ||
          bodyText.indexOf('начислено') !== -1 ||
          bodyText.indexOf('успешно') !== -1) {
        send({ type: 'rewardSuccess' });
      }

      if (bodyText.indexOf('площадка не найдена') !== -1) {
        send({ type: 'taskNotFound' });
      }
    } catch(e) {}
  }, 2000);

  true;
})();
true;
`;

const startWatchingClickerScript = `
(function() {
  if (window.__startWatchingClickerInstalled) return true;
  window.__startWatchingClickerInstalled = true;

  function send(message) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function findStartButton() {
    var el = document.getElementById('youtube_views-channel-link');
    if (el && el.offsetParent !== null) return el;

    var alt = document.querySelector('a.youtube_views-channel-button');
    if (alt && alt.offsetParent !== null) return alt;

    var candidates = document.querySelectorAll('a, button, span[role="button"], div[role="button"]');
    for (var i = 0; i < candidates.length; i++) {
      var btn = candidates[i];
      if (btn.offsetParent === null) continue;
      var text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      if (text.indexOf('начать просмотр') !== -1 ||
          text.indexOf('start watching') !== -1 ||
          text.indexOf('start viewing') !== -1 ||
          text.indexOf('продолжить') !== -1 ||
          text.indexOf('continue') !== -1) {
        return btn;
      }
    }
    return null;
  }

  function dispatchFullClick(el) {
    try {
      var rect = el.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;

      el.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
      el.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
      el.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
      }));
      el.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
      }));
      el.click();

      if (typeof PointerEvent !== 'undefined') {
        el.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          pointerId: 1, button: 0, buttons: 1, isPrimary: true, pointerType: 'mouse'
        }));
        el.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          pointerId: 1, button: 0, buttons: 0, isPrimary: true, pointerType: 'mouse'
        }));
      }
      return true;
    } catch(e) { return false; }
  }

  var lastClickTime = 0;
  var lastHref = '';

  setInterval(function() {
    try {
      var btn = findStartButton();
      if (!btn) return;

      var now = Date.now();
      var href = btn.getAttribute('href') || '';
      if (now - lastClickTime < 3000 && href === lastHref) return;

      lastClickTime = now;
      lastHref = href;

      var clicked = dispatchFullClick(btn);
      if (clicked) {
        send({
          type: 'startWatchingClicked',
          text: (btn.innerText || '').substring(0, 40),
          href: href.substring(0, 100)
        });
      }
    } catch(e) {}
  }, 1000);

  true;
})();
true;
`;

const adSkipperScript = `
(function() {
  if (window.__adSkipperInstalled) return true;
  window.__adSkipperInstalled = true;

  var adsSkipped = 0;
  var lastSkipAttempt = 0;

  function send(message) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function skipAds() {
    var now = Date.now();
    var skipSelectors = [
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button-text',
      'button[aria-label*="Skip"]',
      'button[aria-label*="Ignorer"]',
      'button[aria-label*="Passer"]',
      '.ytp-ad-skip-button-container',
      '.ytp-skip-ad'
    ];

    var skipped = false;
    for (var i = 0; i < skipSelectors.length; i++) {
      try {
        var buttons = document.querySelectorAll(skipSelectors[i]);
        for (var j = 0; j < buttons.length; j++) {
          var btn = buttons[j];
          if (btn && btn.offsetParent !== null && !btn.disabled) {
            var rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              btn.click();
              adsSkipped++;
              skipped = true;
              lastSkipAttempt = now;
              if (adsSkipped === 1) {
                send({ type: 'adSkipped', count: adsSkipped });
              }
              break;
            }
          }
        }
        if (skipped) break;
      } catch(e) {}
    }

    if (!skipped && now - lastSkipAttempt > 2000) {
      var allButtons = document.querySelectorAll('button, .ytp-ad-skip-button, [role="button"]');
      for (var k = 0; k < allButtons.length; k++) {
        var b = allButtons[k];
        if (b && b.offsetParent !== null) {
          var text = b.innerText || b.textContent || '';
          var ariaLabel = b.getAttribute('aria-label') || '';
          if (text.indexOf('Ignorer') !== -1 ||
              text.indexOf('Skip') !== -1 ||
              text.indexOf('Passer') !== -1 ||
              ariaLabel.indexOf('Skip') !== -1 ||
              ariaLabel.indexOf('Ignorer') !== -1 ||
              ariaLabel.indexOf('Passer') !== -1) {
            b.click();
            adsSkipped++;
            skipped = true;
            lastSkipAttempt = now;
            break;
          }
        }
      }
    }

    return skipped;
  }

  setInterval(skipAds, 500);
  true;
})();
true;
`;

const youtubeWatcherScript = `
(function() {
  if (window.__ytWatcherInstalled) return true;
  window.__ytWatcherInstalled = true;
  function send(message) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  send({ type: 'bottomNav', url: window.location.href, stage: 'loaded' });
  true;
})();
true;
`;

const videoMonitorScript = `
(function() {
  if (window.__videoMonitorInstalled) return true;
  window.__videoMonitorInstalled = true;

  function send(message) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  setInterval(function() {
    try {
      var video = document.querySelector('video');
      var player = document.querySelector('#movie_player');
      if (!video || !player) {
        send({ type: 'videoProgress', found: false });
        return;
      }
      var isAd = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
      send({
        type: 'videoProgress',
        found: true,
        current: video.currentTime || 0,
        duration: video.duration || 0,
        paused: video.paused,
        ended: video.ended,
        isAd: isAd
      });
    } catch(e) {
      send({ type: 'videoProgress', found: false, error: e.message });
    }
  }, 1000);

  true;
})();
true;
`;

// ============================================================================
// COMPOSANT PRINCIPAL
// ============================================================================

export default function App() {
  const [splitMode, setSplitMode] = useState(false);
  const [automationPaused, setAutomationPaused] = useState(true);
  const [cookieText, setCookieText] = useState('');
  const [savedCookieText, setSavedCookieText] = useState('');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [avisoTaskCount, setAvisoTaskCount] = useState(null);
  const [assistantStatus, setAssistantStatus] = useState('Prêt');
  const [bottomUrl, setBottomUrl] = useState(SITES.youtube.url);
  const [bottomTitle, setBottomTitle] = useState('YOUTUBE — accueil');
  const [lastClickedTask, setLastClickedTask] = useState(null);

  // ---- États du minuteur et récompense ----
  const [currentTaskTime, setCurrentTaskTime] = useState(0);
  const [currentTaskId, setCurrentTaskId] = useState(null);
  const [videoProgress, setVideoProgress] = useState({ current: 0, duration: 0, isAd: false });
  const [watchDelay, setWatchDelay] = useState(3); // 3s par défaut
  const [videoWatchedEnough, setVideoWatchedEnough] = useState(false);
  const [successCount, setSuccessCount] = useState(0);

  const avisoWebview = useRef(null);
  const bottomWebview = useRef(null);

  // ==========================================================================
  // CHARGEMENT INITIAL (cookies + délai)
  // ==========================================================================
  useEffect(() => {
    Promise.all([
      SecureStore.getItemAsync(COOKIE_KEY),
      SecureStore.getItemAsync(DELAY_KEY),
    ]).then(([cookieValue, delayValue]) => {
      if (cookieValue) {
        setCookieText(cookieValue);
        setSavedCookieText(cookieValue);
        setSaved(true);
      }
      if (delayValue) {
        const num = parseInt(delayValue, 10);
        if (!isNaN(num) && num >= 0) {
          setWatchDelay(num);
        }
      }
      setLoading(false);
    });
  }, []);

  const parsedCount = useMemo(() => cookiePairs(cookieText).length, [cookieText]);

  // ==========================================================================
  // SAUVEGARDE DÉLAI
  // ==========================================================================
  const updateWatchDelay = (value) => {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 0) {
      setWatchDelay(num);
      SecureStore.setItemAsync(DELAY_KEY, String(num));
    }
  };

  // ==========================================================================
  // RECHERCHE TÂCHE SUIVANTE (boucle)
  // ==========================================================================
  const runNextTask = () => {
    if (automationPaused) {
      setAssistantStatus('⏸️ Automatisation en pause');
      return;
    }
    setAssistantStatus('🔄 Recherche de la tâche suivante…');

    avisoWebview.current?.injectJavaScript(`
      (function() {
        ${avisoOpenHookScript}
        ${avisoAutoClickScript}
        ${rewardWatcherScript}
        if (window.__avisoAutoClick) {
          window.__avisoAutoClick();
        } else {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'autoClickResult',
            status: 'error',
            message: 'Script auto-click non disponible'
          }));
        }
      })();
      true;
    `);
  };

  // ==========================================================================
  // HANDLE VIDEO WATCHED ENOUGH
  // ==========================================================================
  const handleVideoWatchedEnough = () => {
    if (videoWatchedEnough || !currentTaskId) return;
    setVideoWatchedEnough(true);
    setAssistantStatus(`Vidéo visionnée (${currentTaskTime}s) · attente ${watchDelay}s…`);

    setTimeout(() => {
      setAssistantStatus(`Demande de validation de la récompense…`);

      avisoWebview.current?.injectJavaScript(`
        (function() {
          try {
            var btn = document.getElementById('ads_btn_confirm_${currentTaskId}');
            if (btn && btn.offsetParent !== null) {
              btn.click();
              window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'rewardClicked',
                id: '${currentTaskId}'
              }));
            } else {
              window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'rewardNotFound',
                id: '${currentTaskId}'
              }));
            }
          } catch(e) {
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'rewardNotFound',
              id: '${currentTaskId}',
              error: e.message
            }));
          }
          true;
        })();
        true;
      `);
    }, watchDelay * 1000);
  };

  // ==========================================================================
  // HANDLER MESSAGES WEBVIEW
  // ==========================================================================
  const handleWebMessage = (event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);

      if (message.type === 'avisoTaskCount') {
        setAvisoTaskCount(Number(message.count) || 0);
      }

      if (message.type === 'autoClickResult') {
        if (message.status === 'clicked') {
          setLastClickedTask({ id: message.id, time: message.time });
          setCurrentTaskTime(message.time);
          setCurrentTaskId(message.id);
          setVideoWatchedEnough(false);
          setVideoProgress({ current: 0, duration: 0, isAd: false });
          setAssistantStatus(`Tâche ${message.id} cliquée (${message.time}s) · attente de la redirection…`);
        } else if (message.status === 'empty') {
          // Aucune tâche → attendre et réessayer
          setAssistantStatus('⏳ Aucune tâche · nouvel essai dans 10s…');
          if (!automationPaused) {
            setTimeout(() => {
              if (!automationPaused) runNextTask();
            }, 10000);
          }
        } else if (message.status === 'error') {
          setAssistantStatus(`Erreur clic : ${message.message}`);
        }
      }

      if (message.type === 'redirectCaptured') {
        console.log('[AUTO] Redirect capturé:', message.source, message.url);
        const absolute = message.url.startsWith('http')
          ? message.url
          : new URL(message.url, SITES.aviso.url).toString();
        setBottomUrl(absolute);
        setBottomTitle(`REDIRECTION — ${absolute.substring(0, 60)}…`);
        setAssistantStatus(`Chargement pane bas : ${absolute.substring(0, 80)}…`);
      }

      if (message.type === 'bottomNav') {
        console.log('[BOTTOM] Navigation:', message.url);
        const u = message.url || '';
        const vid = extractVideoId(u);
        if (vid) {
          setBottomTitle(`YOUTUBE — ${vid}`);
          setAssistantStatus(`YouTube chargé · ${vid}`);
        } else if (u.includes('aviso.bz')) {
          setBottomTitle(`AVISO /go — ${u.substring(0, 60)}…`);
        } else {
          setBottomTitle(`PAGE — ${u.substring(0, 60)}…`);
        }
      }

      if (message.type === 'videoProgress') {
        if (!message.found) {
          setVideoProgress({ current: 0, duration: 0, isAd: false });
          return;
        }

        setVideoProgress({
          current: message.current,
          duration: message.duration,
          isAd: message.isAd
        });

        if (message.isAd) return;

        if (currentTaskTime > 0 && !videoWatchedEnough) {
          const effective = (message.duration > 0 && message.duration < currentTaskTime)
            ? message.duration
            : currentTaskTime;

          const remaining = Math.max(0, effective - message.current);
          if (remaining > 0.5) {
            setAssistantStatus(`Visionnage : ${message.current.toFixed(1)}s / ${effective.toFixed(0)}s · reste ${remaining.toFixed(0)}s`);
          }

          if (message.current >= effective) {
            handleVideoWatchedEnough();
          } else if (message.ended) {
            handleVideoWatchedEnough();
          }
        }
      }

      if (message.type === 'startWatchingClicked') {
        console.log('[AUTO] Start Watching cliqué:', message.text);
        setAssistantStatus(`▶️ "${message.text}" cliqué · chargement…`);
      }

      if (message.type === 'adSkipped') {
        console.log('[AUTO] Pub skippée:', message.count);
        setAssistantStatus(`⏭️ Publicité ignorée (${message.count})`);
      }

      if (message.type === 'rewardAvailable') {
        console.log('[AUTO] Reward disponible:', message.id);
        if (videoWatchedEnough) {
          avisoWebview.current?.injectJavaScript(`
            var btn = document.getElementById('ads_btn_confirm_${message.id}');
            if (btn && btn.offsetParent !== null) {
              btn.click();
              window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'rewardClicked',
                id: '${message.id}'
              }));
            }
            true;
          `);
        }
      }

      if (message.type === 'rewardClicked') {
        setAssistantStatus(`Récompense validée · vérification…`);
      }

      if (message.type === 'rewardSuccess') {
        const newCount = successCount + 1;
        setSuccessCount(newCount);
        setAssistantStatus(`✅ Récompense confirmée ! Total : ${newCount}`);

        setCurrentTaskTime(0);
        setCurrentTaskId(null);
        setVideoWatchedEnough(false);
        setVideoProgress({ current: 0, duration: 0, isAd: false });

        // ⚡ Lancer la tâche suivante
        if (!automationPaused) {
          setTimeout(() => {
            if (!automationPaused) runNextTask();
          }, 2000 + Math.random() * 2000);
        }
      }

      if (message.type === 'rewardNotFound') {
        setAssistantStatus(`⚠️ Bouton validation non trouvé · réessai dans 5s…`);
        setTimeout(() => {
          if (currentTaskId) {
            avisoWebview.current?.injectJavaScript(`
              try {
                var btn = document.getElementById('ads_btn_confirm_${currentTaskId}');
                if (btn && btn.offsetParent !== null) btn.click();
              } catch(e) {}
              true;
            `);
          }
          // Après 5s de plus, on force le passage à la suivante
          setTimeout(() => {
            if (!automationPaused && currentTaskId) {
              setAssistantStatus('⚠️ Validation impossible · passage à la suivante');
              setCurrentTaskTime(0);
              setCurrentTaskId(null);
              setVideoWatchedEnough(false);
              setVideoProgress({ current: 0, duration: 0, isAd: false });
              runNextTask();
            }
          }, 5000);
        }, 5000);
      }

      if (message.type === 'taskNotFound') {
        setAssistantStatus(`❌ Tâche introuvable · passage à la suivante`);
        setCurrentTaskTime(0);
        setCurrentTaskId(null);
        setVideoWatchedEnough(false);
        setVideoProgress({ current: 0, duration: 0, isAd: false });

        if (!automationPaused) {
          setTimeout(() => {
            if (!automationPaused) runNextTask();
          }, 2000 + Math.random() * 2000);
        }
      }
    } catch (err) {
      console.log('[AUTO] Erreur handler message:', err.message);
    }
  };

  // ==========================================================================
  // ACTIONS UI
  // ==========================================================================
  const runAutoClick = () => {
    if (currentTaskTime > 0 && !videoWatchedEnough) {
      Alert.alert('Tâche en cours', 'Une vidéo est déjà en cours. Attendez la fin.');
      return;
    }
    setAutomationPaused(false);
    setAssistantStatus('🚀 Démarrage de la boucle automatique…');
    runNextTask();
  };

  const togglePause = () => {
    if (automationPaused) {
      setAutomationPaused(false);
      setAssistantStatus('▶️ Reprise de la boucle…');
      runNextTask();
    } else {
      setAutomationPaused(true);
      setAssistantStatus('⏸️ Boucle en pause');
    }
  };

  const resetBottom = () => {
    setBottomUrl(SITES.youtube.url);
    setBottomTitle('YOUTUBE — accueil');
    setAssistantStatus('Prêt');
    setLastClickedTask(null);
    setCurrentTaskTime(0);
    setCurrentTaskId(null);
    setVideoWatchedEnough(false);
    setVideoProgress({ current: 0, duration: 0, isAd: false });
  };

  // ==========================================================================
  // FONCTIONS ACCUEIL
  // ==========================================================================
  const saveCookies = async () => {
    if (!cookieText.trim()) {
      Alert.alert('Cookies manquants', 'Collez d’abord le texte des cookies.');
      return;
    }
    if (!parsedCount) {
      Alert.alert('Format non reconnu', 'Utilisez par exemple : nom=valeur; autre=valeur, ou un tableau JSON de cookies.');
      return;
    }
    await SecureStore.setItemAsync(COOKIE_KEY, cookieText);
    setSavedCookieText(cookieText);
    setSaved(true);
    Alert.alert('Cookies enregistrés', `${parsedCount} cookie(s) seront utilisés.`);
  };

  const openSite = async () => {
    const stored = await SecureStore.getItemAsync(COOKIE_KEY);
    if (stored) {
      setCookieText(stored);
      setSavedCookieText(stored);
      setSaved(true);
    } else {
      Alert.alert('Cookies non enregistrés', 'Enregistrez d’abord les cookies pour les utiliser sur Aviso.');
      return;
    }
    let restored = false;
    try {
      restored = await restoreNativeCookies(stored, SITES.aviso.url);
    } catch (_) {
      restored = false;
    }
    if (!restored && cookiePairs(stored).length === 0) {
      Alert.alert('Cookies non reconnus', 'Collez le fichier JSON complet exporté par Electron.');
      return;
    }
    setAvisoTaskCount(null);
    setAutomationPaused(true);
    setBottomUrl(SITES.youtube.url);
    setBottomTitle('YOUTUBE — accueil');
    setLastClickedTask(null);
    setCurrentTaskTime(0);
    setCurrentTaskId(null);
    setVideoWatchedEnough(false);
    setVideoProgress({ current: 0, duration: 0, isAd: false });
    setSplitMode(true);
  };

  // ==========================================================================
  // RENDU
  // ==========================================================================
  if (loading) {
    return <SafeAreaView style={styles.center}><ActivityIndicator color="#64d2ff" /></SafeAreaView>;
  }

  if (splitMode) {
    return (
      <SafeAreaView style={styles.webContainer}>
        {/* Header */}
        <View style={styles.webHeader}>
          <Pressable onPress={() => setSplitMode(false)} style={styles.backButton}>
            <Text style={styles.backText}>‹ Retour</Text>
          </Pressable>
          <View style={styles.webTitleBlock}>
            <Text style={styles.webTitle}>Aviso + Bas</Text>
            <Text style={styles.taskBadge}>
              {avisoTaskCount === null ? 'Tâches : …' : `${avisoTaskCount} tâche${avisoTaskCount === 1 ? '' : 's'}`}
              {successCount > 0 && ` · ✅ ${successCount}`}
            </Text>
          </View>
          <Pressable
            onPress={automationPaused ? runAutoClick : togglePause}
            style={[styles.reloadButton, !automationPaused && styles.pauseButton]}
          >
            <Text style={styles.reloadText}>
              {automationPaused ? '▶ Auto' : '⏸ Pause'}
            </Text>
          </Pressable>
        </View>

        {/* Statut */}
        <Text style={styles.assistantStatus} numberOfLines={2}>{assistantStatus}</Text>

        {/* Pane AVISO */}
        <View style={styles.avisoPane}>
          <Text style={styles.paneLabel}>AVISO — clic auto</Text>
          <WebView
            ref={avisoWebview}
            source={{ uri: SITES.aviso.url }}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            setSupportMultipleWindows={false}
            injectedJavaScriptBeforeContentLoaded={`${cookieScript(savedCookieText, SITES.aviso.url)}\n${avisoOpenHookScript}`}
            injectedJavaScript={`${avisoTaskCounterScript}\n${avisoOpenHookScript}\n${avisoAutoClickScript}\n${rewardWatcherScript}\n${startWatchingClickerScript}`}
            onMessage={handleWebMessage}
            onLoadEnd={() => {
              avisoWebview.current?.injectJavaScript(
                `${avisoTaskCounterScript}\n${avisoOpenHookScript}\n${avisoAutoClickScript}\n${rewardWatcherScript}\n${startWatchingClickerScript}`
              );
            }}
            onShouldStartLoadWithRequest={(req) => {
              const u = req.url || '';
              if (u.includes('/go/') || u.includes('youtube.com') || u.includes('youtu.be')) {
                console.log('[AUTO] Aviso → interception nav:', u);
                const absolute = u.startsWith('http') ? u : new URL(u, SITES.aviso.url).toString();
                setBottomUrl(absolute);
                setBottomTitle(`REDIRECTION — ${absolute.substring(0, 60)}…`);
                setAssistantStatus(`Chargement pane bas : ${absolute.substring(0, 80)}…`);
                return false;
              }
              return true;
            }}
            onError={() => Alert.alert('Erreur Aviso', 'Aviso n’a pas pu être chargé.')}
            startInLoadingState
            renderLoading={() => <View style={styles.center}><ActivityIndicator color="#64d2ff" /></View>}
          />
        </View>

        {/* Pane BAS */}
        <View style={styles.bottomPane}>
          <View style={styles.bottomHeader}>
            <Text style={styles.paneLabel} numberOfLines={1}>{bottomTitle}</Text>
            {currentTaskTime > 0 && (
              <Text style={styles.videoTimer}>
                {videoProgress.isAd
                  ? '⏭️ PUB'
                  : `${Math.min(videoProgress.current, currentTaskTime).toFixed(0)}/${currentTaskTime}s`}
              </Text>
            )}
            <Pressable onPress={resetBottom} style={styles.resetButton}>
              <Text style={styles.resetText}>↺ Reset</Text>
            </Pressable>
          </View>
          <WebView
            ref={bottomWebview}
            source={{ uri: bottomUrl }}
            key={bottomUrl}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            setSupportMultipleWindows={false}
            injectedJavaScriptBeforeContentLoaded={`${youtubeWatcherScript}\n${startWatchingClickerScript}\n${adSkipperScript}`}
            injectedJavaScript={`${youtubeWatcherScript}\n${videoMonitorScript}\n${startWatchingClickerScript}\n${adSkipperScript}`}
            onMessage={handleWebMessage}
            onLoadEnd={() => {
              bottomWebview.current?.injectJavaScript(
                `${youtubeWatcherScript}\n${videoMonitorScript}\n${startWatchingClickerScript}\n${adSkipperScript}`
              );
            }}
            onNavigationStateChange={(navState) => {
              if (!navState.loading && navState.url) {
                const u = navState.url;
                console.log('[BOTTOM] navState:', u);
                const vid = extractVideoId(u);
                if (vid) {
                  setBottomTitle(`YOUTUBE — ${vid}`);
                } else if (u.includes('aviso.bz')) {
                  setBottomTitle(`AVISO /go — ${u.substring(0, 60)}…`);
                } else {
                  setBottomTitle(`PAGE — ${u.substring(0, 60)}…`);
                }
              }
            }}
            onShouldStartLoadWithRequest={() => true}
            onError={() => Alert.alert('Erreur pane bas', 'Chargement impossible.')}
            startInLoadingState
            renderLoading={() => <View style={styles.center}><ActivityIndicator color="#ff5c7a" /></View>}
          />
        </View>
      </SafeAreaView>
    );
  }

  // ==========================================================================
  // ACCUEIL
  // ==========================================================================
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.kicker}>PROTOTYPE ANDROID</Text>
          <Text style={styles.title}>Ouvrir un site</Text>
          <Text style={styles.subtitle}>
            Les cookies enregistrés sont réutilisés automatiquement à l’ouverture d’Aviso.
          </Text>

          <View style={styles.choiceRow}>
            {Object.entries(SITES).map(([key, item]) => (
              <Pressable key={key} onPress={openSite} style={({ pressed }) => [styles.siteCard, pressed && styles.pressed]}>
                <Text style={styles.siteIcon}>{key === 'youtube' ? '▶' : 'A'}</Text>
                <Text style={styles.siteName}>{item.label}</Text>
                <Text style={styles.siteAction}>{key === 'aviso' ? 'Ouvrir les tâches' : 'Ouvrir'}</Text>
              </Pressable>
            ))}
          </View>

          {/* Délai après visionnage */}
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Délai après visionnage</Text>
            <Text style={styles.panelHint}>
              Temps d'attente (en secondes) avant de passer à la tâche suivante après avoir regardé une vidéo. 3s par défaut.
            </Text>
            <View style={styles.delayRow}>
              <TextInput
                value={String(watchDelay)}
                onChangeText={updateWatchDelay}
                keyboardType="numeric"
                style={styles.delayInput}
                maxLength={3}
              />
              <Text style={styles.delayUnit}>secondes</Text>
            </View>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Importer un cookie</Text>
            <Text style={styles.panelHint}>
              Collez ici le texte copié depuis votre navigateur. Il reste stocké localement et sera utilisé à la prochaine ouverture.
            </Text>
            <TextInput
              value={cookieText}
              onChangeText={(value) => { setCookieText(value); setSaved(false); }}
              placeholder="nom=valeur; autre_cookie=valeur"
              placeholderTextColor="#70809b"
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="none"
              style={styles.cookieInput}
              secureTextEntry
            />
            <View style={styles.cookieFooter}>
              <Text style={styles.count}>{parsedCount} cookie(s) détecté(s){saved ? ' · enregistré' : ''}</Text>
              <Pressable onPress={saveCookies} style={({ pressed }) => [styles.saveButton, pressed && styles.pressed]}>
                <Text style={styles.saveText}>Enregistrer</Text>
              </Pressable>
            </View>
            <Text style={styles.warning}>Ne partagez jamais vos cookies : ils peuvent donner accès à votre session.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ============================================================================
// STYLES
// ============================================================================
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b1020' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b1020' },
  content: { padding: 24, paddingTop: 48, paddingBottom: 36 },
  kicker: { color: '#64d2ff', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  title: { color: '#f4f7fb', fontSize: 36, fontWeight: '800', marginTop: 10 },
  subtitle: { color: '#99a7bf', fontSize: 16, lineHeight: 24, marginTop: 10, marginBottom: 26 },
  choiceRow: { flexDirection: 'row', gap: 14 },
  siteCard: { flex: 1, backgroundColor: '#151e33', borderRadius: 18, padding: 18, minHeight: 145, borderWidth: 1, borderColor: '#263452' },
  pressed: { opacity: 0.7 },
  siteIcon: { color: '#64d2ff', fontSize: 30, fontWeight: '900' },
  siteName: { color: '#f4f7fb', fontSize: 19, fontWeight: '800', marginTop: 24 },
  siteAction: { color: '#8595b1', marginTop: 6 },
  panel: { backgroundColor: '#11192b', borderRadius: 18, padding: 18, marginTop: 20, borderWidth: 1, borderColor: '#202e49' },
  panelTitle: { color: '#f4f7fb', fontSize: 19, fontWeight: '800' },
  panelHint: { color: '#8998b3', fontSize: 13, lineHeight: 19, marginTop: 8 },
  cookieInput: { color: '#e9effb', backgroundColor: '#0a1020', borderRadius: 12, borderWidth: 1, borderColor: '#2a3a5e', minHeight: 130, marginTop: 16, padding: 14, textAlignVertical: 'top', fontSize: 13 },
  cookieFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  count: { color: '#7e8ca7', fontSize: 12, flex: 1 },
  saveButton: { backgroundColor: '#64d2ff', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11 },
  saveText: { color: '#07101e', fontWeight: '800' },
  warning: { color: '#d29b6c', fontSize: 11, lineHeight: 16, marginTop: 14 },
  delayRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  delayInput: {
    color: '#e9effb',
    backgroundColor: '#0a1020',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a3a5e',
    width: 90,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    textAlign: 'center',
  },
  delayUnit: { color: '#9ba8be', marginLeft: 12, fontSize: 14 },
  webContainer: { flex: 1, backgroundColor: '#0b1020' },
  webHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
  backButton: { paddingVertical: 8, paddingRight: 12, minWidth: 78 },
  backText: { color: '#64d2ff', fontSize: 15, fontWeight: '700' },
  webTitleBlock: { alignItems: 'center', flex: 1 },
  webTitle: { color: '#f4f7fb', fontWeight: '800', fontSize: 16 },
  taskBadge: { color: '#07101e', backgroundColor: '#64d2ff', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3, marginTop: 3, fontSize: 12, fontWeight: '800' },
  reloadButton: { paddingVertical: 8, paddingHorizontal: 12, minWidth: 78, alignItems: 'flex-end' },
  pauseButton: { backgroundColor: '#2a1520', borderRadius: 8 },
  reloadText: { color: '#9ba8be', fontSize: 13, fontWeight: '700' },
  assistantStatus: { color: '#9ba8be', fontSize: 12, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#11192b' },
  avisoPane: { flex: 1.1, minHeight: 0, borderBottomWidth: 2, borderBottomColor: '#263452' },
  bottomPane: { flex: 0.9, minHeight: 0 },
  bottomHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#11192b' },
  paneLabel: { color: '#9ba8be', backgroundColor: '#11192b', paddingHorizontal: 10, paddingVertical: 5, fontSize: 11, fontWeight: '700', flex: 1 },
  videoTimer: {
    color: '#ff5c7a',
    fontSize: 11,
    fontWeight: '800',
    marginHorizontal: 8,
    backgroundColor: '#2a1520',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  resetButton: { paddingHorizontal: 10, paddingVertical: 4 },
  resetText: { color: '#64d2ff', fontSize: 11, fontWeight: '700' },
});
