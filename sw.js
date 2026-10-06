const CACHE = 'ft-mobile-v53';
const FILES = ['./index.html', './manifest.json', './icon.svg', './supabase-sync.js'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))));

// Notificación PUSH real: la entrega el navegador/OS, aunque la app
// esté cerrada. Llega desde la Edge Function "send-push" de Supabase.
self.addEventListener('push', event => {
  let data = { title: '🚜 Finanzas Tracto', body: 'Nueva actualización' };
  try { if (event.data) data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'icon.svg',
      badge: 'icon.svg',
      vibrate: [120, 60, 120],
      tag: 'fd-push-' + Date.now()
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('./index.html');
  }));
});

// Si el navegador invalida/rota la suscripción por su cuenta (puede pasar
// con el tiempo), se vuelve a suscribir sola y actualiza push_subscriptions
// directamente por REST (el Service Worker no tiene acceso al cliente JS
// de Supabase de la página, así que usa fetch con la misma anon key).
const SUPABASE_URL = "https://vlcootmevguzdoooshan.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZsY29vdG1ldmd1emRvb29zaGFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3ODkwNDIsImV4cCI6MjA5OTM2NTA0Mn0.8UfYG9NGi7MLyqm44NeZMAry5gY4SGjxrGyuD88llic";
const VAPID_PUBLIC_KEY = "BPxmgIsGk77Li4nnIeJwT-QhVyISDQbCbAKO0wDDdi4HDNY9ihU9DWisN5mzfO7v2aYuO5nyfnYd9wGt80KDiRM";

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
  return arr;
}

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    }).then(sub => {
      const json = sub.toJSON();
      return fetch(SUPABASE_URL + "/rest/v1/push_subscriptions?on_conflict=endpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + SUPABASE_ANON_KEY,
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth })
      });
    }).catch(() => {})
  );
});
