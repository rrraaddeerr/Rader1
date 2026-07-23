// The notification service worker, served at GET /sw.js?k=<subKey>.
// Pushes are payload-less: on wake it pulls its pending notifications using
// the subKey baked into its own registration URL (the capability).
export const SW_JS = /* js */ `
const K = new URL(self.location.href).searchParams.get("k") || "";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));

self.addEventListener("push", (e) => e.waitUntil(showPending()));

async function showPending() {
  let shown = 0;
  try {
    const r = await fetch("/api/push/pending?k=" + encodeURIComponent(K));
    if (r.ok) {
      const d = await r.json();
      for (const n of d.notifications || []) {
        await self.registration.showNotification(n.title || "🧠 Big Brain", {
          body: n.body || "",
          tag: n.id || undefined,
          icon: "/icon.svg",
          data: { url: n.url || "/browse" },
        });
        shown++;
      }
    }
  } catch (e) {}
  // A push event must always show something, even if the fetch failed.
  if (!shown) {
    await self.registration.showNotification("🧠 Big Brain", {
      body: "You have a reminder.",
      icon: "/icon.svg",
      data: { url: "/browse" },
    });
  }
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/browse";
  e.waitUntil(clients.openWindow(url));
});
`;
