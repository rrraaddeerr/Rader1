/**
 * Web Push with VAPID, implemented on WebCrypto — no dependencies.
 *
 * We send *payload-less* pushes (no message body), which sidesteps the whole
 * aes128gcm payload-encryption dance. The service worker wakes on push and
 * pulls its pending notifications from `/api/push/pending?k=<subKey>`, where
 * the random subKey is the capability (same model as /blob/<key>).
 *
 * The VAPID keypair is generated once on first use and kept in KV under
 * `push:vapid` — nothing to configure.
 */

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function getVapid(env) {
  let stored = await env.REFS_KV.get("push:vapid", "json");
  if (!stored) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
    stored = { priv, pub: b64url(pubRaw) };
    await env.REFS_KV.put("push:vapid", JSON.stringify(stored));
  }
  return stored;
}

async function vapidJwt(vapid, audience) {
  const key = await crypto.subtle.importKey(
    "jwk",
    vapid.priv,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data =
    enc({ typ: "JWT", alg: "ES256" }) +
    "." +
    enc({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:bigbrain@workers.dev" });
  // WebCrypto ECDSA emits the raw r||s form JWTs want — no DER wrangling.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(data));
  return data + "." + b64url(sig);
}

/**
 * Fire a payload-less push at one subscription.
 * Returns "ok", "gone" (subscription dead — delete it), or "error".
 */
export async function sendPush(env, subscription) {
  try {
    const ep = new URL(subscription.endpoint);
    const vapid = await getVapid(env);
    const jwt = await vapidJwt(vapid, ep.origin);
    const r = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        TTL: "86400",
        Urgency: "high",
        Authorization: `vapid t=${jwt}, k=${vapid.pub}`,
      },
    });
    if (r.status === 404 || r.status === 410) return "gone";
    return r.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}
