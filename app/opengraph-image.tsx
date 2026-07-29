import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "rent.co — Rental, sourcing, and infrastructure for culture";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Box truck with a lit firecracker mounted on the box — the operator mark.
const TRUCK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none" stroke="#ff5a1f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13h17v12H2z"/><path d="M19 16h6l5 5v4h-11z"/><circle cx="9" cy="27" r="2.5"/><circle cx="24" cy="27" r="2.5"/><rect x="8" y="16" width="5" height="7"/><path d="M8 16l2.5 -2 2.5 2"/><path d="M10.5 14 Q12 12 11 10 Q9.5 8 11 6 Q12.5 4 11 2"/><circle cx="11" cy="2" r="1" fill="#ff5a1f"/></svg>`;
const truckUri = `data:image/svg+xml;base64,${Buffer.from(TRUCK).toString("base64")}`;

export default async function OpengraphImage() {
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
          padding: "68px 78px",
          fontFamily: "Archivo",
          color: "#ededea",
          position: "relative",
        }}
      >
        <img
          src={truckUri}
          width={580}
          height={580}
          style={{ position: "absolute", right: -130, top: 40, opacity: 0.08 }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
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
              fontSize: 94,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.03,
            }}
          >
            Rent the archive.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 94,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.03,
            }}
          >
            <div>Source the</div>
            <div style={{ color: "#ff5a1f", marginLeft: 26 }}>impossible.</div>
          </div>
          <div
            style={{
              fontSize: 29,
              fontWeight: 400,
              color: "#c9c9c4",
              marginTop: 30,
            }}
          >
            Rental, sourcing, and infrastructure for culture.
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
            OPENING SOON — VANCOUVER HQ, INVITE ONLY
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
