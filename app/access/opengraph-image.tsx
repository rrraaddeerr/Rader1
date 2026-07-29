import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "rent.co — invite only preview";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TRUCK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none" stroke="#ff5a1f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13h17v12H2z"/><path d="M19 16h6l5 5v4h-11z"/><circle cx="9" cy="27" r="2.5"/><circle cx="24" cy="27" r="2.5"/><rect x="8" y="16" width="5" height="7"/><path d="M8 16l2.5 -2 2.5 2"/><path d="M10.5 14 Q12 12 11 10 Q9.5 8 11 6 Q12.5 4 11 2"/><circle cx="11" cy="2" r="1" fill="#ff5a1f"/></svg>`;
const truckUri = `data:image/svg+xml;base64,${Buffer.from(TRUCK).toString("base64")}`;

export default async function AccessOpengraphImage() {
  const [regular, bold] = await Promise.all([
    readFile(join(process.cwd(), "app/fonts/Archivo-Regular.ttf")),
    readFile(join(process.cwd(), "app/fonts/Archivo-ExtraBold.ttf")),
  ]);

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
          padding: "78px 88px",
          fontFamily: "Archivo",
          color: "#ededea",
          position: "relative",
        }}
      >
        {/* Hot accent corner */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            display: "flex",
            background: "#ff5a1f",
            color: "#0c0c0d",
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: 4,
            padding: "10px 22px",
          }}
        >
          SOFT LAUNCH // INVITE ONLY
        </div>

        <img
          src={truckUri}
          width={520}
          height={520}
          style={{ position: "absolute", right: -110, bottom: 60, opacity: 0.08 }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 32,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <img src={truckUri} width={46} height={46} />
            <div style={{ fontSize: 38, fontWeight: 800, marginLeft: 14 }}>
              rent.co
            </div>
          </div>
          <div style={{ fontSize: 21, letterSpacing: 3, color: "#9a9a92" }}>
            OPERATED BY RADERENT
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 96,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.02,
            }}
          >
            The archive
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 96,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.02,
            }}
          >
            <div>is opening</div>
            <div style={{ color: "#ff5a1f", marginLeft: 22 }}>soon</div>
          </div>
          <div
            style={{
              fontSize: 96,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.02,
            }}
          >
            — invites out.
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 400,
              color: "#c9c9c4",
              marginTop: 28,
            }}
          >
            Enter your invite code at r-ent.co/access
          </div>
        </div>

        <div style={{ display: "flex" }}>
          <div
            style={{
              display: "flex",
              backgroundColor: "#5f8338",
              color: "#131509",
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: 1,
              padding: "13px 24px",
              transform: "rotate(-1.6deg)",
            }}
          >
            HAND-ISSUED INVITES — VANCOUVER HQ
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
