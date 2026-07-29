import { NextResponse } from "next/server";
import { codeMap, ACCESS_COOKIE, GUEST_COOKIE, ROLE_COOKIE } from "@/lib/access";

export async function POST(req: Request) {
  let body: { code?: unknown; from?: unknown } = {};
  try {
    body = await req.json();
  } catch {}
  const code =
    typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
  if (!code) {
    return NextResponse.json(
      { ok: false, error: "Enter an invite code." },
      { status: 400 }
    );
  }
  const entry = codeMap().get(code);
  if (!entry) {
    return NextResponse.json(
      { ok: false, error: "That code isn't on the list." },
      { status: 401 }
    );
  }
  const from =
    typeof body.from === "string" &&
    body.from.startsWith("/") &&
    !body.from.startsWith("/access") &&
    !body.from.startsWith("/api/")
      ? body.from
      : "/";
  const res = NextResponse.json({ ok: true, label: entry.label, redirect: from });
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 60,
  };
  res.cookies.set(ACCESS_COOKIE, code, opts);
  res.cookies.set(GUEST_COOKIE, entry.label, { ...opts, httpOnly: false });
  res.cookies.set(ROLE_COOKIE, entry.role, { ...opts, httpOnly: false });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(GUEST_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(ROLE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
