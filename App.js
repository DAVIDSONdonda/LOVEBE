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
// HELPERS COOKIES (inchangés)
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
// HELPERS YOUTUBE (nouveaux)
// ============================================================================

// Extrait l'ID vidéo YouTube depuis une URL
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
    if (u.hostname.includes('google.com') && u.searchParams.has('url')) {
      return extractVideoId(u.searchParams.get('url'));
    }
  } catch (_) {}
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Résout une URL Aviso /go/ en URL YouTube finale
function resolveAvisoGoUrl(url, baseUrl = 'https://aviso.bz') {
  if (!url) return null;

  // Si déjà YouTube → ok
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    // Clean possible encodage double
    try {
      const decoded = decodeURIComponent(url);
      if (decoded.includes('youtube.com') || decoded.includes('youtu.be')) return decoded;
    } catch (_) {}
    return url;
  }

  // Chercher go_url= dans les query params
  try {
    const fullUrl = url.startsWith('http') ? url : new URL(url, baseUrl).toString();
    const u = new URL(fullUrl);
    const goUrl = u.searchParams.get('go_url');
    if (goUrl) {
      try {
        const decoded = decodeURIComponent(goUrl);
        if (decoded.includes('youtube.com') || decoded.includes('youtu.be')) return decoded;
        return decoded;
      } catch (_) {
        return goUrl;
      }
    }
  } catch (_) {}
  return null;
}

// ============================================================================
// SCRIPTS INJECTÉS
// ============================================================================

// Compteur de tâches (inchangé)
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

// Assistant manuel (inchangé, conservé pour compatibilité)
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

// Hook window.open : capture les redirections YouTube (injecté AVANT chargement)
const avisoOpenHookScript = `
(function() {
  if (window.__avisoOpenHooked) return true;
  window.__avisoOpenHooked = true;

  function report(url, source) {
    try {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'youtubeRedirect',
        url: url,
        source: source
      }));
    } catch(e) {}
  }

  // --- Cas 1 : window.open ---
  var originalOpen = window.open;
  window.open = function(url, target, features) {
    if (url && (url.indexOf('youtube.com') !== -1 || url.indexOf('youtu.be') !== -1 || url.indexOf('/go/') !== -1)) {
      report(url, 'window.open');
      return null;
    }
    return originalOpen.apply(window, arguments);
  };

  // --- Cas 2 : clic sur <a> vers YouTube ou /go/ ---
  document.addEventListener('click', function(ev) {
    var el = ev.target;
    while (el && el !== document.body) {
      if (el.tagName === 'A' && el.href) {
        var h = el.href;
        if (h.indexOf('youtube.com') !== -1 || h.indexOf('youtu.be') !== -1) {
          report(h, 'a-click');
          ev.preventDefault();
          ev.stopPropagation();
          return false;
        }
        if (h.indexOf('/go/') !== -1 && h.indexOf('aviso.bz') !== -1) {
          report(h, 'a-click-go');
          ev.preventDefault();
          ev.stopPropagation();
          return false;
        }
      }
      el = el.parentElement;
    }
  }, true);

  // --- Cas 3 : form submit ---
  document.addEventListener('submit', function(ev) {
    var action = ev.target && ev.target.action;
    if (action && (action.indexOf('youtube.com') !== -1 || action.indexOf('/go/') !== -1)) {
      report(action, 'form-submit');
      ev.preventDefault();
      return false;
    }
  }, true);

  true;
})();
true;
`;

// Clic auto sur la tâche la plus courte (appelé depuis RN)
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

      // Marquage visuel
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

      // Clic (déclenche le hook window.open)
      chosen.el.click();
    } catch(e) {
      send({ type: 'autoClickResult', status: 'error', message: e.message });
    }
  };

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
  const [youtubeUrl, setYoutubeUrl] = useState(SITES.youtube.url);
  const [lastClickedTask, setLastClickedTask] = useState(null);
  const avisoWebview = useRef(null);
  const youtubeWebview = useRef(null);

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
    setYoutubeUrl(SITES.youtube.url);
    setLastClickedTask(null);
    setSplitMode(true);
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
        } else if (message.status === 'confirm') {
          setAssistantStatus(`Tâche ${message.id} prête à être validée dans Aviso`);
        } else if (message.status === 'empty') {
          setAssistantStatus(message.message);
        }
      }

      if (message.type === 'autoClickResult') {
        if (message.status === 'clicked') {
          setLastClickedTask({ id: message.id, time: message.time });
          setAssistantStatus(`Tâche ${message.id} cliquée (${message.time}s) · attente de la redirection…`);
        } else if (message.status === 'empty') {
          setAssistantStatus('Aucune tâche disponible');
        } else if (message.status === 'error') {
          setAssistantStatus(`Erreur clic : ${message.message}`);
        }
      }

      if (message.type === 'youtubeRedirect') {
        console.log('[AUTO] Redirect capturé:', message.source, message.url);
        const finalUrl = resolveAvisoGoUrl(message.url, SITES.aviso.url);
        console.log('[AUTO] URL finale résolue:', finalUrl);

        if (finalUrl) {
          const videoId = extractVideoId(finalUrl);
          console.log('[AUTO] Video ID:', videoId);
          setYoutubeUrl(finalUrl);
          setAssistantStatus(`YouTube lancé${videoId ? ` · ${videoId}` : ''}`);
        } else {
          // Fallback : suivre le redirect via fetch
          console.log('[AUTO] Pas de go_url, tentative fetch redirect…');
          const absolute = message.url.startsWith('http')
            ? message.url
            : new URL(message.url, SITES.aviso.url).toString();

          fetch(absolute, {
            method: 'GET',
            redirect: 'follow',
            headers: { 'Accept': 'text/html' },
          })
            .then((res) => {
              const resolved = res.url;
              console.log('[AUTO] Après redirect:', resolved);
              const videoId = extractVideoId(resolved);
              if (videoId || resolved.includes('youtube.com') || resolved.includes('youtu.be')) {
                setYoutubeUrl(resolved);
                setAssistantStatus(`YouTube lancé · ${videoId || 'URL directe'}`);
              } else {
                setAssistantStatus(`Redirect inattendu : ${resolved}`);
              }
            })
            .catch((err) => {
              console.log('[AUTO] Erreur fetch:', err.message);
              setAssistantStatus(`Impossible de résoudre l'URL: ${err.message}`);
            });
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
    setAutomationPaused(false);
    setAssistantStatus('Recherche de la tâche la plus courte…');
    const script = `${avisoOpenHookScript}\n${avisoAutoClickScript}\nwindow.__avisoAutoClick();true;`;
    avisoWebview.current?.injectJavaScript(script);
  };

  const runAssistant = () => {
    setAutomationPaused(false);
    setAssistantStatus('Recherche de la prochaine tâche…');
    avisoWebview.current?.injectJavaScript(avisoTaskAssistantScript);
  };

  const resetYoutube = () => {
    setYoutubeUrl(SITES.youtube.url);
    setLastClickedTask(null);
    setAssistantStatus('Prêt');
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
            <Text style={styles.webTitle}>Aviso + YouTube</Text>
            <Text style={styles.taskBadge}>
              {avisoTaskCount === null ? 'Tâches : …' : `${avisoTaskCount} tâche${avisoTaskCount === 1 ? '' : 's'}`}
            </Text>
          </View>
          <Pressable onPress={runAutoClick} style={styles.reloadButton}>
            <Text style={styles.reloadText}>▶ Auto</Text>
          </Pressable>
        </View>
        <Text style={styles.assistantStatus}>{assistantStatus}</Text>
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
            injectedJavaScript={`${avisoTaskCounterScript}\n${avisoTaskAssistantScript}\n${avisoOpenHookScript}\n${avisoAutoClickScript}`}
            onMessage={handleWebMessage}
            onLoadEnd={() => {
              // Réinjection de sécurité après chaque chargement
              avisoWebview.current?.injectJavaScript(
                `${avisoTaskCounterScript}\n${avisoTaskAssistantScript}\n${avisoOpenHookScript}\n${avisoAutoClickScript}`
              );
            }}
            onShouldStartLoadWithRequest={(req) => {
              const u = req.url || '';

              // Navigation directe vers YouTube → bloquer + rediriger pane bas
              if (u.includes('youtube.com') || u.includes('youtu.be')) {
                console.log('[AUTO] onShouldStartLoadWithRequest → YouTube bloqué:', u);
                const videoId = extractVideoId(u);
                setYoutubeUrl(u);
                setAssistantStatus(`YouTube lancé${videoId ? ` · ${videoId}` : ''}`);
                return false;
              }

              // /go/ Aviso → bloqué (déjà capturé par hook JS)
              if (u.includes('/go/') && u.includes('aviso.bz')) {
                console.log('[AUTO] onShouldStartLoadWithRequest → /go/ bloqué:', u);
                const finalUrl = resolveAvisoGoUrl(u, SITES.aviso.url);
                if (finalUrl) {
                  const videoId = extractVideoId(finalUrl);
                  setYoutubeUrl(finalUrl);
                  setAssistantStatus(`YouTube lancé${videoId ? ` · ${videoId}` : ''}`);
                }
                return false;
              }

              return true;
            }}
            onError={() => Alert.alert('Erreur Aviso', 'Aviso n’a pas pu être chargé. Vérifiez votre connexion.')}
            startInLoadingState
            renderLoading={() => <View style={styles.center}><ActivityIndicator color="#64d2ff" /></View>}
          />
        </View>
        <View style={styles.youtubePane}>
          <View style={styles.youtubeHeader}>
            <Text style={styles.paneLabel}>YOUTUBE — vidéo chargée</Text>
            <Pressable onPress={resetYoutube} style={styles.resetButton}>
              <Text style={styles.resetText}>↺ Reset</Text>
            </Pressable>
          </View>
          <WebView
            ref={youtubeWebview}
            source={{ uri: youtubeUrl }}
            key={youtubeUrl}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            onError={() => Alert.alert('Erreur YouTube', 'YouTube n’a pas pu être chargé.')}
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
  backButton: { paddingVertical: 8, paddingRight: 12, minWidth: 78 },
  backText: { color: '#64d2ff', fontSize: 15, fontWeight: '700' },
  webTitleBlock: { alignItems: 'center', flex: 1 },
  webTitle: { color: '#f4f7fb', fontWeight: '800', fontSize: 16 },
  taskBadge: { color: '#07101e', backgroundColor: '#64d2ff', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3, marginTop: 3, fontSize: 12, fontWeight: '800' },
  reloadButton: { paddingVertical: 8, paddingLeft: 12, minWidth: 78, alignItems: 'flex-end' },
  reloadText: { color: '#9ba8be', fontSize: 13 },
  assistantStatus: { color: '#9ba8be', fontSize: 12, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#11192b' },
  avisoPane: { flex: 1.1, minHeight: 0, borderBottomWidth: 2, borderBottomColor: '#263452' },
  youtubePane: { flex: 0.9, minHeight: 0 },
  youtubeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#11192b' },
  paneLabel: { color: '#9ba8be', backgroundColor: '#11192b', paddingHorizontal: 10, paddingVertical: 5, fontSize: 11, fontWeight: '700' },
  resetButton: { paddingHorizontal: 10, paddingVertical: 4 },
  resetText: { color: '#64d2ff', fontSize: 11, fontWeight: '700' },
});
