import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  codeMap,
  ACCESS_COOKIE,
  GUEST_COOKIE,
  ROLE_COOKIE,
  OPERATOR_PREFIXES,
  type AccessEntry,
} from "./lib/access";

function setAccessCookies(res: NextResponse, code: string, entry: AccessEntry) {
  const opts = {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 60,
  };
  res.cookies.set(ACCESS_COOKIE, code, { ...opts, httpOnly: true });
  res.cookies.set(GUEST_COOKIE, entry.label, { ...opts, httpOnly: false });
  res.cookies.set(ROLE_COOKIE, entry.role, { ...opts, httpOnly: false });
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Personal invite link: /i/<code> -> set cookie, drop visitor on homepage.
  const inviteMatch = pathname.match(/^\/i\/([A-Za-z0-9_-]+)\/?$/);
  if (inviteMatch) {
    const code = inviteMatch[1].toLowerCase();
    const entry = codeMap().get(code);
    if (entry) {
      const dest = req.nextUrl.clone();
      dest.pathname = "/";
      dest.search = "";
      const res = NextResponse.redirect(dest);
      setAccessCookies(res, code, entry);
      return res;
    }
    // Unknown code in link — drop them at the gate with the code prefilled
    // so they can see what they tried and ask for a real one.
    const fallback = req.nextUrl.clone();
    fallback.pathname = "/access";
    fallback.search = "";
    fallback.searchParams.set("code", code);
    return NextResponse.redirect(fallback);
  }

  const cookie = req.cookies.get(ACCESS_COOKIE)?.value?.toLowerCase();
  const entry = cookie ? codeMap().get(cookie) : undefined;

  if (entry) {
    const needsOperator = OPERATOR_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    );
    if (needsOperator && entry.role !== "operator") {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ ok: false, error: "Operator only." }, { status: 403 });
      }
      const home = req.nextUrl.clone();
      home.pathname = "/";
      home.search = "";
      return NextResponse.redirect(home);
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Access required." }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  if (pathname !== "/" && !pathname.startsWith("/access")) {
    url.searchParams.set("from", pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!access|api/access|api/respond|set/|_next/static|_next/image|inventory/|fonts/|favicon.ico|icon.svg|apple-icon|opengraph-image|robots.txt|sitemap.xml|manifest.webmanifest).*)",
  ],
};
