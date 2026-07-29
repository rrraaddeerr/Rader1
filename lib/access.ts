export type AccessRole = "guest" | "operator";
export type AccessEntry = { label: string; role: AccessRole };

// Codes come from two env vars:
//   ACCESS_CODES   — comma list of code:Label or code:Label:op (":op" marks operator)
//   OPERATOR_CODES — comma list of code:Label, always operator-role
// No fallback: with neither var set, no code works (fail closed).
export function codeMap(): Map<string, AccessEntry> {
  const map = new Map<string, AccessEntry>();
  const add = (raw: string, forcedRole?: AccessRole) => {
    for (const part of raw.split(",")) {
      if (!part.trim()) continue;
      const [code, label, roleRaw] = part.split(":").map((s) => s?.trim() ?? "");
      if (!code) continue;
      const marked = roleRaw?.toLowerCase();
      const role: AccessRole =
        forcedRole ?? (marked === "op" || marked === "operator" ? "operator" : "guest");
      map.set(code.toLowerCase(), { label: label || (role === "operator" ? "Operator" : "Guest"), role });
    }
  };
  add(process.env.ACCESS_CODES ?? "");
  add(process.env.OPERATOR_CODES ?? "", "operator");
  return map;
}

export const ACCESS_COOKIE = "rentco_access";
export const GUEST_COOKIE = "rentco_guest";
export const ROLE_COOKIE = "rentco_role";

// Paths that require the operator role (pages and APIs).
export const OPERATOR_PREFIXES = ["/sets", "/ops", "/curate", "/api/sets"];
