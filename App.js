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
      // setFromResponse accepte un vrai en-tête Set-Cookie et conserve
      // notamment HttpOnly, Secure et l’expiration de PHPSESSID.
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

// Aviso affiche les tâches sous la forme de spans link_ads_start_<id>.
// Le MutationObserver permet de mettre à jour le compteur après un chargement AJAX.
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

// Assistance à l'exécution : prépare la tâche la plus courte, la centre et
// informe l'application de son état. Le lancement de la tâche et la validation
// restent visibles et contrôlables par l'utilisateur dans Aviso.
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
        send({ type: 'avisoAssistant', status: 'empty', message: 'Aucune tâche disponible pour le moment.' });
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

export default function App() {
  const [splitMode, setSplitMode] = useState(false);
  const [automationPaused, setAutomationPaused] = useState(true);
  const [cookieText, setCookieText] = useState('');
  const [savedCookieText, setSavedCookieText] = useState('');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [avisoTaskCount, setAvisoTaskCount] = useState(null);
  const [assistantStatus, setAssistantStatus] = useState('Prêt');
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
    Alert.alert('Cookies enregistrés', `${parsedCount} cookie(s) seront utilisés pour Aviso et le site sélectionné.`);
  };

  const openSite = async () => {
    // Toujours relire SecureStore : un texte modifié mais non enregistré ne doit pas être utilisé.
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
    setSplitMode(true);
  };

  const handleWebMessage = (event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      if (message.type === 'avisoTaskCount') setAvisoTaskCount(Number(message.count) || 0);
      if (message.type === 'avisoAssistant') {
        if (message.status === 'ready') {
          setAssistantStatus(`Tâche ${message.id} prête · ${message.seconds >= 999 ? 'durée inconnue' : `${message.seconds}s`} · ${message.total} disponible(s)`);
        } else if (message.status === 'confirm') {
          setAssistantStatus(`Tâche ${message.id} prête à être validée dans Aviso`);
        } else if (message.status === 'empty') {
          setAssistantStatus(message.message);
        }
      }
    } catch (_) {}
  };

  const runAssistant = () => {
    setAutomationPaused(false);
    setAssistantStatus('Recherche de la prochaine tâche…');
    avisoWebview.current?.injectJavaScript(avisoTaskAssistantScript);
  };

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
            <Text style={styles.taskBadge}>{avisoTaskCount === null ? 'Tâches : …' : `${avisoTaskCount} tâche${avisoTaskCount === 1 ? '' : 's'}`}</Text>
          </View>
          <Pressable onPress={runAssistant} style={styles.reloadButton}>
            <Text style={styles.reloadText}>{automationPaused ? 'Préparer' : 'Rechercher'}</Text>
          </Pressable>
        </View>
        <Text style={styles.assistantStatus}>{assistantStatus}</Text>
        <View style={styles.avisoPane}>
          <Text style={styles.paneLabel}>AVISO — assistance aux tâches</Text>
          <WebView
            ref={avisoWebview}
            source={{ uri: SITES.aviso.url }}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            injectedJavaScriptBeforeContentLoaded={cookieScript(savedCookieText, SITES.aviso.url)}
            injectedJavaScript={`${avisoTaskCounterScript}\n${avisoTaskAssistantScript}`}
            onMessage={handleWebMessage}
            onLoadEnd={() => avisoWebview.current?.injectJavaScript(`${avisoTaskCounterScript}\n${avisoTaskAssistantScript}`)}
            onError={() => Alert.alert('Erreur Aviso', 'Aviso n’a pas pu être chargé. Vérifiez votre connexion.')}
            startInLoadingState
            renderLoading={() => <View style={styles.center}><ActivityIndicator color="#64d2ff" /></View>}
          />
        </View>
        <View style={styles.youtubePane}>
          <Text style={styles.paneLabel}>YOUTUBE — ouverture manuelle du lien choisi</Text>
          <WebView
            ref={youtubeWebview}
            source={{ uri: SITES.youtube.url }}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            onError={() => Alert.alert('Erreur YouTube', 'YouTube n’a pas pu être chargé. Vérifiez votre connexion.')}
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
          <Text style={styles.kicker}>PROTOYPE ANDROID</Text>
          <Text style={styles.title}>Ouvrir un site</Text>
          <Text style={styles.subtitle}>Les cookies enregistrés sont réutilisés automatiquement à l’ouverture d’Aviso.</Text>

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
            <Text style={styles.panelHint}>Collez ici le texte copié depuis votre navigateur. Il reste stocké localement et sera utilisé à la prochaine ouverture.</Text>
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
  avisoPane: { flex: 1.1, minHeight: 0, borderBottomWidth: 2, borderBottomColor: '#263452' },
  youtubePane: { flex: 0.9, minHeight: 0 },
  paneLabel: { color: '#9ba8be', backgroundColor: '#11192b', paddingHorizontal: 10, paddingVertical: 5, fontSize: 11, fontWeight: '700' },
});
