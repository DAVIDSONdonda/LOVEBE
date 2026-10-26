# Aviso YouTube Launcher

Prototype Android Expo destiné à être compilé par Codemagic.

## Fonctionnement

- L’écran d’accueil propose **YouTube** ou **Aviso**.
- Le bouton Aviso ouvre directement `https://aviso.bz/tasks-youtube`.
- Le cookie enregistré dans `expo-secure-store` est relu à chaque ouverture et injecté dans la WebView avant le chargement du site.
- Le compteur **X tâche(s)** apparaît dans l’en-tête d’Aviso.
- Le compteur surveille les mises à jour dynamiques de la page et se rafraîchit automatiquement.
- Le champ cookies accepte `nom=valeur; autre=valeur`, des lignes séparées ou un tableau JSON de cookies.
- Les cookies collés sont enregistrés localement avec `expo-secure-store` et ne sont pas écrits dans les journaux.

## Compilation

Codemagic utilise `codemagic.yaml` pour générer un APK Android.

## Limite importante

Les cookies marqués `HttpOnly` ne peuvent pas être créés par JavaScript dans une WebView Android. Pour une session qui dépend de tels cookies, il faudra utiliser une importation native des cookies ou effectuer la connexion directement dans la WebView.
