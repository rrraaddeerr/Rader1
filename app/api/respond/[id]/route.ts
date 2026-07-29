import { NextResponse } from "next/server";

// Public same-origin proxy for client proposal responses.
// Exists because (a) the site CSP is connect-src 'self', so the browser cannot
// POST cross-origin to the worker, and (b) it lets us validate and cap the
// payload before it touches storage.
const WORKER = process.env.RENTCO_SETS_URL ?? "";
const DECISIONS = new Set(["approve", "maybe", "pass"]);
const MAX_DECISION_KEYS = 500;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
    return NextResponse.json({ ok: false, error: "Bad id." }, { status: 400 });
  }
  if (!WORKER) {
    return NextResponse.json(
      { ok: false, error: "Response service not configured." },
      { status: 503 }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad payload." }, { status: 400 });
  }

  const decisions: Record<string, string> = {};
  if (body.decisions && typeof body.decisions === "object") {
    let n = 0;
    for (const [k, v] of Object.entries(body.decisions as Record<string, unknown>)) {
      if (typeof v !== "string" || !DECISIONS.has(v)) continue;
      if (typeof k !== "string" || k.length > 120) continue;
      decisions[k] = v;
      if (++n >= MAX_DECISION_KEYS) break;
    }
  }

  const payload = {
    visitor:
      typeof body.visitor === "string" ? body.visitor.slice(0, 64) : undefined,
    name: typeof body.name === "string" ? body.name.slice(0, 80) : "",
    note: typeof body.note === "string" ? body.note.slice(0, 2000) : "",
    decisions,
    done: body.done === true ? true : undefined,
  };

  try {
    const res = await fetch(`${WORKER}/response/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) {
      return NextResponse.json(
        { ok: false, error: json?.error ?? "Save failed." },
        { status: res.status >= 400 && res.status < 500 ? res.status : 502 }
      );
    }
    return NextResponse.json({ ok: true, visitor: json.visitor });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not reach the response service." },
      { status: 502 }
    );
  }
}
