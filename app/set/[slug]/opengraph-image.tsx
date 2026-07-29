import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { listSets, setsConfigured, deriveStage, SET_STAGE_LABELS } from "@/lib/sets";

export const alt = "rent.co — operator proposal";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TRUCK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none" stroke="#ff5a1f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13h17v12H2z"/><path d="M19 16h6l5 5v4h-11z"/><circle cx="9" cy="27" r="2.5"/><circle cx="24" cy="27" r="2.5"/><rect x="8" y="16" width="5" height="7"/><path d="M8 16l2.5 -2 2.5 2"/><path d="M10.5 14 Q12 12 11 10 Q9.5 8 11 6 Q12.5 4 11 2"/><circle cx="11" cy="2" r="1" fill="#ff5a1f"/></svg>`;
const truckUri = `data:image/svg+xml;base64,${Buffer.from(TRUCK).toString("base64")}`;

export default async function SetOpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const [regular, bold] = await Promise.all([
    readFile(join(process.cwd(), "app/fonts/Archivo-Regular.ttf")),
    readFile(join(process.cwd(), "app/fonts/Archivo-ExtraBold.ttf")),
  ]);

  let name = "Operator proposal";
  let client = "";
  let groupCount = 0;
  let itemCount = 0;
  let status = "OPEN";
  let locked = false;

  if (setsConfigured()) {
    try {
      const sets = await listSets();
      const set = sets.find((s) => s.slug === slug);
      if (set) {
        name = set.name || name;
        client = set.client ?? "";
        groupCount = set.groups?.length ?? 0;
        itemCount = set.groups?.reduce((n, g) => n + g.items.length, 0) ?? 0;
        status = SET_STAGE_LABELS[deriveStage(set)].short;
        locked = Boolean(set.locked);
      }
    } catch {
      // worker unreachable — render generic
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0c0c0d",
          padding: "62px 72px",
          fontFamily: "Archivo",
          color: "#ededea",
          position: "relative",
        }}
      >
        {/* Slate header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "10px 16px",
            border: "1px solid #ff5a1f",
            alignSelf: "flex-start",
            fontSize: 19,
            fontWeight: 800,
            letterSpacing: 4,
            color: "#ededea",
          }}
        >
          {`RENT.CO  //  OPERATOR PROPOSAL  //  ${status}`}
        </div>

        <img
          src={truckUri}
          width={520}
          height={520}
          style={{ position: "absolute", right: -110, top: 60, opacity: 0.08 }}
        />

        <div style={{ display: "flex", flexDirection: "column" }}>
          {client ? (
            <div
              style={{
                display: "flex",
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: 4,
                color: "#ff5a1f",
                textTransform: "uppercase",
                marginBottom: 14,
              }}
            >
              {`FOR ${client.toUpperCase()}`}
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              fontSize: 76,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.02,
              maxWidth: 980,
            }}
          >
            {name}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 24,
              fontWeight: 400,
              color: "#c9c9c4",
              marginTop: 26,
            }}
          >
            {`${groupCount} groups · ${itemCount} objects · ${locked ? "Closed" : "Open for review"}`}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <img src={truckUri} width={44} height={44} />
          <div style={{ display: "flex", fontSize: 28, fontWeight: 800 }}>rent.co</div>
          <div style={{ display: "flex", fontSize: 16, letterSpacing: 3, color: "#9a9a92", marginLeft: 12 }}>
            OPERATED BY RADERENT · VANCOUVER HQ
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Archivo", data: regular, weight: 400, style: "normal" },
        { name: "Archivo", data: bold, weight: 800, style: "normal" },
      ],
    }
  );
}
