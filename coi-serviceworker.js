// The previous version of this site registered a service worker under this
// file name. This replacement removes it: once a browser picks it up, the
// worker unregisters itself and reloads the open pages, which then come
// straight from the network.
self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        self.registration.unregister()
            .then(function () { return self.clients.matchAll({ type: 'window' }); })
            .then(function (clients) {
                clients.forEach(function (client) { client.navigate(client.url); });
            })
    );
});
