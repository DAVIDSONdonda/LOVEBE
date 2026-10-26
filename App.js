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

const avisoTaskAssistantScript = `
(function() {
  if (window.__avisoAssistantInstalled) {
    window.__avisoAssistantStart && window.__avisoAssistantStart();
    true;
  } else {
    window.__avisoAssistantInstalled = true;
    window.__avisoAssistantRunning = false;
    function visible(el) {
      if (!el) return false;
      var s = getComputedStyle(el);
      return el.offsetParent !== null && s.display !== 'none' && s.visibility !== 'hidden';
    }
    function taskTime(el) {
      var id = (el.id || '').replace('link_ads_start_', '');
      var input = document.getElementById('ads_timer_' + id);
      var value = input && parseInt(input.value, 10);
      if (value > 0) return value;
      var onclick = el.getAttribute('onclick') || '';
      var match = onclick.match(/, ['\"](\\d+)['\"]/);
      if (match) return parseInt(match[1], 10);
      var row = el.closest('tr');
      var text = row ? row.innerText : el.innerText;
      var seconds = (text || '').match(/(\\d+)\\s*(?:сек|sec|s)/i);
      return seconds ? parseInt(seconds[1], 10) : 999;
    }
    function send(message) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
    window.__avisoAssistantStart = function() {
      var nodes = Array.from(document.querySelectorAll('span[id^="link_ads_start_"]')).filter(visible);
      if (!nodes.length) {
        send({ type: 'avisoAssistant', status: 'empty', message: 'Aucune tâche disponible.' });
        return;
      }
      nodes.sort(function(a, b) { return taskTime(a) - taskTime(b); });
      var task = nodes[0];
      var id = task.id.replace('link_ads_start_', '');
      var seconds = taskTime(task);
      document.querySelectorAll('[data-aviso-assistant="selected"]').forEach(function(el) {
        el.style.outline = '';
        el.removeAttribute('data-aviso-assistant');
      });
      task.setAttribute('data-aviso-assistant', 'selected');
      task.style.outline = '3px solid #64d2ff';
      task.scrollIntoView({ behavior: 'smooth', block: 'center' });
      send({ type: 'avisoAssistant', status: 'ready', id: id, seconds: seconds, total: nodes.length });
      window.__avisoAssistantRunning = true;
    };
    window.__avisoAssistantPoll = setInterval(function() {
      if (!window.__avisoAssistantRunning) return;
      var confirm = Array.from(document.querySelectorAll('span[id^="ads_btn_confirm_"]')).find(visible);
      if (confirm) send({ type: 'avisoAssistant', status: 'confirm', id: confirm.id.replace('ads_btn_confirm_', '') });
    }, 1500);
    window.__avisoAssistantStart();
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
          try { visible[0].click(); } catch(e) {}
          send({ type: 'rewardAvailable', id: id, autoClicked: true });
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
  }, 1000);

  true;
})();
true;
`;

const claimAllRewardsScript = `
(function() {
  function send(message) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function claimAll() {
    try {
      var confirmBtns = document.querySelectorAll('span[id^="ads_btn_confirm_"]');
      var visible = Array.from(confirmBtns).filter(function(b) {
        return b.offsetParent !== null;
      });

      if (visible.length > 0) {
        var clickedIds = [];
        visible.forEach(function(btn) {
          try {
            btn.click();
            clickedIds.push(btn.id.replace('ads_btn_confirm_', ''));
          } catch(e) {}
        });
        send({ type: 'claimAllResult', status: 'clicked', count: clickedIds.length, ids: clickedIds });
        setTimeout(claimAll, 1000);
      } else {
        send({ type: 'claimAllResult', status: 'done', count: 0 });
      }
    } catch(e) {
      send({ type: 'claimAllResult', status: 'error', message: e.message });
    }
  }

  claimAll();
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

  // ---- Mode headless ----
  const [headlessMode, setHeadlessMode] = useState(false);

  // ---- États du minuteur ----
  const [currentTaskTime, setCurrentTaskTime] = useState(0);
  const [currentTaskId, setCurrentTaskId] = useState(null);
  const [videoProgress, setVideoProgress] = useState({ current: 0, duration: 0, isAd: false, paused: true });
  const [watchDelay] = useState(3);
  const [videoWatchedEnough, setVideoWatchedEnough] = useState(false);
  const [videoStarted, setVideoStarted] = useState(false);
  const [rewardAlreadyClicked, setRewardAlreadyClicked] = useState(false);
  const [successCount, setSuccessCount] = useState(0);

  const avisoWebview = useRef(null);
  const bottomWebview = useRef(null);

  useEffect(() => {
    SecureStore.getItemAsync(COOKIE_KEY).then((value) => {
      if (value) {
        setCookieText(value);
        setSavedCookieText(value);
        setSaved(true);
      }
      setLoading(false);
    });
  }, []);

  const parsedCount = useMemo(() => cookiePairs(cookieText).length, [cookieText]);

  // ==========================================================================
  // HANDLE VIDEO WATCHED ENOUGH
  // ==========================================================================
  const handleVideoWatchedEnough = () => {
    if (videoWatchedEnough || !currentTaskId) return;
    setVideoWatchedEnough(true);
    setAssistantStatus(`Vidéo visionnée (${currentTaskTime}s) · attente ${watchDelay}s…`);

    setTimeout(() => {
      setAssistantStatus(`🔍 Vérification des récompenses restantes…`);
      avisoWebview.current?.injectJavaScript(claimAllRewardsScript);
    }, watchDelay * 1000);
  };

  // ==========================================================================
  // HANDLE CLAIM ALL RESULT
  // ==========================================================================
  const handleClaimAllResult = (message) => {
    if (message.status === 'clicked') {
      setAssistantStatus(`💰 ${message.count} récompense(s) réclamée(s) · vérification…`);
    } else if (message.status === 'done') {
      setAssistantStatus(`✅ Aucune récompense restante · passage à la tâche suivante…`);

      setCurrentTaskTime(0);
      setCurrentTaskId(null);
      setVideoWatchedEnough(false);
      setVideoStarted(false);
      setRewardAlreadyClicked(false);
      setVideoProgress({ current: 0, duration: 0, isAd: false, paused: true });
      setLastClickedTask(null);

      setAssistantStatus(`Rechargement d'Aviso…`);
      avisoWebview.current?.reload();

      setTimeout(() => {
        if (!automationPaused) {
          setAssistantStatus('Recherche de la tâche suivante…');
          const script = `${avisoOpenHookScript}\n${avisoAutoClickScript}\nwindow.__avisoAutoClick();true;`;
          avisoWebview.current?.injectJavaScript(script);
        }
      }, 3000);
    } else if (message.status === 'error') {
      setAssistantStatus(`⚠️ Erreur vérification récompenses : ${message.message}`);
      setTimeout(() => {
        setCurrentTaskTime(0);
        setCurrentTaskId(null);
        setVideoWatchedEnough(false);
        setVideoStarted(false);
        setRewardAlreadyClicked(false);
        setVideoProgress({ current: 0, duration: 0, isAd: false, paused: true });
        avisoWebview.current?.reload();
      }, 2000);
    }
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

      if (message.type === 'avisoAssistant') {
        if (message.status === 'ready') {
          setAssistantStatus(`Tâche ${message.id} prête · ${message.seconds >= 999 ? 'durée inconnue' : `${message.seconds}s`} · ${message.total} disponible(s)`);
        } else if (message.status === 'empty') {
          setAssistantStatus(message.message);
        }
      }

      if (message.type === 'autoClickResult') {
        if (message.status === 'clicked') {
          setLastClickedTask({ id: message.id, time: message.time });
          setCurrentTaskTime(message.time);
          setCurrentTaskId(message.id);
          setVideoWatchedEnough(false);
          setVideoStarted(false);
          setRewardAlreadyClicked(false);
          setVideoProgress({ current: 0, duration: 0, isAd: false, paused: true });
          setAssistantStatus(`Tâche ${message.id} cliquée (${message.time}s) · attente de la redirection…`);
        } else if (message.status === 'empty') {
          setAssistantStatus('Aucune tâche disponible');
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
          setAssistantStatus(`Page intermédiaire Aviso`);
        } else {
          setBottomTitle(`PAGE — ${u.substring(0, 60)}…`);
        }
      }

      if (message.type === 'videoProgress') {
        if (!message.found) {
          setVideoProgress({ current: 0, duration: 0, isAd: false, paused: true });
          return;
        }

        setVideoProgress({
          current: message.current,
          duration: message.duration,
          isAd: message.isAd,
          paused: message.paused
        });

        if (message.isAd) {
          if (videoStarted) setVideoStarted(false);
          setAssistantStatus(`⏭️ Publicité en cours · le compteur reprendra après`);
          return;
        }

        if (!videoStarted && message.current > 0.5) {
          setVideoStarted(true);
          setAssistantStatus(`▶️ Lecture démarrée · ${currentTaskTime}s à visionner`);
        }

        if (currentTaskTime > 0 && !videoStarted) {
          setAssistantStatus(`En attente de la vidéo YouTube (${currentTaskTime}s requis)…`);
          return;
        }

        if (videoStarted && !message.paused && currentTaskTime > 0 && !videoWatchedEnough) {
          const effective = (message.duration > 0 && message.duration < currentTaskTime)
            ? message.duration
            : currentTaskTime;

          const remaining = Math.max(0, effective - message.current);
          if (remaining > 0.5) {
            setAssistantStatus(`Visionnage : ${message.current.toFixed(1)}s / ${effective.toFixed(0)}s · reste ${remaining.toFixed(0)}s`);
          }

          if (message.current >= effective || message.ended) {
            handleVideoWatchedEnough();
          }
        }
      }

      if (message.type === 'rewardAvailable') {
        if (!rewardAlreadyClicked) {
          setRewardAlreadyClicked(true);
          setAssistantStatus(`💰 Récompense réclamée pour la tâche ${message.id}`);
          console.log('[AUTO] Reward réclamée:', message.id);
        }
      }

      if (message.type === 'rewardSuccess') {
        const newCount = successCount + 1;
        setSuccessCount(newCount);
        if (currentTaskTime > 0) {
          setAssistantStatus(`✅ Récompense confirmée ! Total : ${newCount} · minuteur continue (${videoProgress.current.toFixed(0)}/${currentTaskTime}s)`);
        } else {
          setAssistantStatus(`✅ Récompense confirmée ! Total : ${newCount}`);
        }
      }

      if (message.type === 'claimAllResult') {
        handleClaimAllResult(message);
      }

      if (message.type === 'taskNotFound') {
        setAssistantStatus(`❌ Tâche ${currentTaskId} introuvable · passage à la suivante`);
        setTimeout(() => {
          setCurrentTaskTime(0);
          setCurrentTaskId(null);
          setVideoWatchedEnough(false);
          setVideoStarted(false);
          setRewardAlreadyClicked(false);
          setVideoProgress({ current: 0, duration: 0, isAd: false, paused: true });
          if (!automationPaused) {
            avisoWebview.current?.reload();
            setTimeout(() => {
              const script = `${avisoOpenHookScript}\n${avisoAutoClickScript}\nwindow.__avisoAutoClick();true;`;
              avisoWebview.current?.injectJavaScript(script);
            }, 3000);
          }
        }, 2000);
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
      Alert.alert('Tâche en cours', 'Une vidéo est déjà en cours de visionnage. Attendez la fin.');
      return;
    }
    setAutomationPaused(false);
    setAssistantStatus('Recherche de la tâche la plus courte…');
    const script = `${avisoOpenHookScript}\n${avisoAutoClickScript}\nwindow.__avisoAutoClick();true;`;
    avisoWebview.current?.injectJavaScript(script);
  };

  const toggleHeadless = () => {
    setHeadlessMode(prev => {
      const next = !prev;
      if (!next) {
        // Sortie du headless → réinjection de sécurité
        setTimeout(() => {
          avisoWebview.current?.injectJavaScript(
            `${avisoTaskCounterScript}\n${avisoTaskAssistantScript}\n${avisoOpenHookScript}\n${avisoAutoClickScript}\n${rewardWatcherScript}`
          );
          console.log('[AUTO] Scripts réinjectés après sortie headless');
        }, 300);
      }
      return next;
    });
  };

  const resetBottom = () => {
    setBottomUrl(SITES.youtube.url);
    setBottomTitle('YOUTUBE — accueil');
    setAssistantStatus('Prêt');
    setLastClickedTask(null);
    setCurrentTaskTime(0);
    setCurrentTaskId(null);
    setVideoWatchedEnough(false);
    setVideoStarted(false);
    setRewardAlreadyClicked(false);
    setVideoProgress({ current: 0, duration: 0, isAd: false, paused: true });
    setAutomationPaused(true);
  };

  // ==========================================================================
  // ACCUEIL — fonctions
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
    setVideoStarted(false);
    setRewardAlreadyClicked(false);
    setVideoProgress({ current: 0, duration: 0, isAd: false, paused: true });
    setHeadlessMode(false);
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
        <View style={styles.webHeader}>
          <Pressable onPress={() => setSplitMode(false)} style={styles.backButton}>
            <Text style={styles.backText}>‹ Retour</Text>
          </Pressable>
          <View style={styles.webTitleBlock}>
            <Text style={styles.webTitle}>{headlessMode ? 'Headless' : 'Aviso + Bas'}</Text>
            <Text style={styles.taskBadge}>
              {avisoTaskCount === null ? 'Tâches : …' : `${avisoTaskCount} tâche${avisoTaskCount === 1 ? '' : 's'}`}
            </Text>
          </View>
          <View style={styles.headerRightButtons}>
            <Pressable
              onPress={toggleHeadless}
              style={[styles.headlessButton, headlessMode && styles.headlessButtonActive]}
            >
              <Text style={styles.headlessText}>
                {headlessMode ? '👁️' : '👁️'}
              </Text>
            </Pressable>
            <Pressable onPress={runAutoClick} style={styles.reloadButton}>
              <Text style={styles.reloadText}>▶ Auto</Text>
            </Pressable>
          </View>
        </View>

        <Text style={styles.assistantStatus} numberOfLines={2}>{assistantStatus}</Text>

        {/* Pane AVISO — toujours monté, caché visuellement en headless */}
        <View style={[styles.avisoPane, headlessMode && styles.hiddenPane]}>
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
            injectedJavaScript={`${avisoTaskCounterScript}\n${avisoTaskAssistantScript}\n${avisoOpenHookScript}\n${avisoAutoClickScript}\n${rewardWatcherScript}`}
            onMessage={handleWebMessage}
            onLoadEnd={() => {
              avisoWebview.current?.injectJavaScript(
                `${avisoTaskCounterScript}\n${avisoTaskAssistantScript}\n${avisoOpenHookScript}\n${avisoAutoClickScript}\n${rewardWatcherScript}`
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
            {currentTaskTime > 0 && videoStarted && (
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
            injectedJavaScriptBeforeContentLoaded={youtubeWatcherScript}
            injectedJavaScript={`${youtubeWatcherScript}\n${videoMonitorScript}`}
            onMessage={handleWebMessage}
            onLoadEnd={() => {
              bottomWebview.current?.injectJavaScript(`${youtubeWatcherScript}\n${videoMonitorScript}`);
            }}
            onNavigationStateChange={(navState) => {
              if (!navState.loading && navState.url) {
                const u = navState.url;
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
  panel: { backgroundColor: '#11192b', borderRadius: 18, padding: 18, marginTop: 24, borderWidth: 1, borderColor: '#202e49' },
  panelTitle: { color: '#f4f7fb', fontSize: 19, fontWeight: '800' },
  panelHint: { color: '#8998b3', fontSize: 13, lineHeight: 19, marginTop: 8 },
  cookieInput: { color: '#e9effb', backgroundColor: '#0a1020', borderRadius: 12, borderWidth: 1, borderColor: '#2a3a5e', minHeight: 130, marginTop: 16, padding: 14, textAlignVertical: 'top', fontSize: 13 },
  cookieFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  count: { color: '#7e8ca7', fontSize: 12, flex: 1 },
  saveButton: { backgroundColor: '#64d2ff', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11 },
  saveText: { color: '#07101e', fontWeight: '800' },
  warning: { color: '#d29b6c', fontSize: 11, lineHeight: 16, marginTop: 14 },
  webContainer: { flex: 1, backgroundColor: '#0b1020' },
  webHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
  backButton: { paddingVertical: 8, paddingRight: 12, minWidth: 70 },
  backText: { color: '#64d2ff', fontSize: 15, fontWeight: '700' },
  webTitleBlock: { alignItems: 'center', flex: 1 },
  webTitle: { color: '#f4f7fb', fontWeight: '800', fontSize: 16 },
  taskBadge: { color: '#07101e', backgroundColor: '#64d2ff', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3, marginTop: 3, fontSize: 12, fontWeight: '800' },
  headerRightButtons: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 70, justifyContent: 'flex-end' },
  reloadButton: { paddingVertical: 8, paddingLeft: 8, alignItems: 'flex-end' },
  reloadText: { color: '#9ba8be', fontSize: 13 },
  headlessButton: { paddingVertical: 6, paddingHorizontal: 8, backgroundColor: '#1a2540', borderRadius: 8 },
  headlessButtonActive: { backgroundColor: '#2a4a7a' },
  headlessText: { color: '#64d2ff', fontSize: 14, fontWeight: '700' },
  assistantStatus: { color: '#9ba8be', fontSize: 12, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#11192b' },
  avisoPane: { flex: 1.1, minHeight: 0, borderBottomWidth: 2, borderBottomColor: '#263452' },
  hiddenPane: { display: 'none' },
  bottomPane: { flex: 1, minHeight: 0 },
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
