/**
 * SMS / WhatsApp delivery via Twilio — configured entirely through Worker
 * secrets, so nothing here is hardcoded to an account:
 *
 *   npx wrangler secret put TWILIO_ACCOUNT_SID
 *   npx wrangler secret put TWILIO_AUTH_TOKEN
 *   npx wrangler secret put TWILIO_FROM            # e.g. +16045551234 (enables "text me")
 *   npx wrangler secret put TWILIO_WHATSAPP_FROM   # e.g. +14155238886 (enables WhatsApp)
 *   npx wrangler secret put REMINDER_PHONE         # your phone, e.g. +17785550000
 *
 * A channel only shows up in the reminder sheet once its secrets exist.
 */

export function smsConfig(env) {
  const base = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.REMINDER_PHONE);
  return {
    sms: base && !!env.TWILIO_FROM,
    whatsapp: base && !!env.TWILIO_WHATSAPP_FROM,
  };
}

/** Send one message. channel = "sms" | "whatsapp". Returns true on success. */
export async function sendTwilio(env, channel, body) {
  try {
    const wa = channel === "whatsapp";
    const from = wa ? `whatsapp:${String(env.TWILIO_WHATSAPP_FROM).replace(/^whatsapp:/, "")}` : env.TWILIO_FROM;
    const to = wa ? `whatsapp:${String(env.REMINDER_PHONE).replace(/^whatsapp:/, "")}` : env.REMINDER_PHONE;
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
      }
    );
    return r.ok;
  } catch {
    return false;
  }
}
