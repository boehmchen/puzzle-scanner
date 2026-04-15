"use client";

import { useEffect, useRef, useState } from "react";

const BASE_PATH = "/puzzle-scanner";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRTUVWXYZ".split("");
const CHAR_TO_IDX: Record<string, number> = {};
ALPHABET.forEach((c, i) => (CHAR_TO_IDX[c] = i));

const DETECT_MAX_WIDTH = 960;

function idToCode(id: number): string {
  if (id < 0 || id >= 1024) return "??";
  return ALPHABET[Math.floor(id / 32)] + ALPHABET[id % 32];
}

function codeToId(code: string): number {
  if (!code || code.length !== 2) return -1;
  const c1 = code[0].toUpperCase();
  const c2 = code[1].toUpperCase();
  if (!(c1 in CHAR_TO_IDX) || !(c2 in CHAR_TO_IDX)) return -1;
  return CHAR_TO_IDX[c1] * 32 + CHAR_TO_IDX[c2];
}

type Detected = { id: number; code: string };

type ArMarker = { id: number; corners: { x: number; y: number }[] };
type ArDetector = {
  detectImage: (w: number, h: number, data: Uint8ClampedArray) => ArMarker[];
};
type ArGlobal = {
  Detector: new (config: { dictionaryName: string }) => ArDetector;
};

declare global {
  interface Window {
    AR?: ArGlobal;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [targetCode, setTargetCode] = useState("");
  const [searchIdText, setSearchIdText] = useState("type a code...");
  const [detected, setDetected] = useState<Detected[]>([]);
  const [totalScanned, setTotalScanned] = useState(0);
  const [fps, setFps] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadingText, setLoadingText] = useState("Loading detector...");
  const [foundActive, setFoundActive] = useState(false);

  const targetIdRef = useRef(-1);
  const targetCodeRef = useRef("");
  const scannedSetRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    targetCodeRef.current = targetCode;
    targetIdRef.current = codeToId(targetCode);
  }, [targetCode]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    let rafId = 0;
    let detector: ArDetector | null = null;
    const detectCanvas = document.createElement("canvas");
    const detectCtx = detectCanvas.getContext("2d", {
      willReadFrequently: true,
    })!;
    let frameCount = 0;
    let lastFpsTime = performance.now();

    const detectLoop = () => {
      if (cancelled) return;
      if (!detector || video.readyState < 2) {
        rafId = requestAnimationFrame(detectLoop);
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (canvas.width !== vw) canvas.width = vw;
      if (canvas.height !== vh) canvas.height = vh;

      const scale = vw > DETECT_MAX_WIDTH ? DETECT_MAX_WIDTH / vw : 1;
      const dw = Math.round(vw * scale);
      const dh = Math.round(vh * scale);
      if (detectCanvas.width !== dw) detectCanvas.width = dw;
      if (detectCanvas.height !== dh) detectCanvas.height = dh;

      try {
        detectCtx.drawImage(video, 0, 0, dw, dh);
        const img = detectCtx.getImageData(0, 0, dw, dh);
        const markers = detector.detectImage(dw, dh, img.data);

        ctx.clearRect(0, 0, vw, vh);

        const frameDetected: Detected[] = [];
        const targetId = targetIdRef.current;
        const target = targetCodeRef.current;
        const invScale = 1 / scale;

        for (const m of markers) {
          const code = idToCode(m.id);
          frameDetected.push({ id: m.id, code });
          scannedSetRef.current.add(m.id);

          const pts = m.corners.map((c) => ({
            x: c.x * invScale,
            y: c.y * invScale,
          }));
          const isTarget = target.length === 2 && m.id === targetId;

          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let j = 1; j < 4; j++) ctx.lineTo(pts[j].x, pts[j].y);
          ctx.closePath();
          ctx.lineWidth = isTarget ? 4 : 2;
          ctx.strokeStyle = isTarget ? "#22c55e" : "#ff3b3b";
          ctx.stroke();

          if (isTarget) {
            ctx.fillStyle = "rgba(34,197,94,0.15)";
            ctx.fill();
          }

          const cx = (pts[0].x + pts[2].x) / 2;
          const edge = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          const fontSize = Math.max(14, edge * 0.5);
          ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          const metrics = ctx.measureText(code);
          const pw = metrics.width + 12;
          const ph = fontSize + 8;
          const minY = Math.min(pts[0].y, pts[1].y, pts[2].y, pts[3].y);
          const labelY = minY - ph - 4;

          ctx.fillStyle = isTarget ? "#22c55e" : "rgba(10,10,12,0.85)";
          ctx.beginPath();
          ctx.roundRect(cx - pw / 2, labelY - ph / 2, pw, ph, 4);
          ctx.fill();

          ctx.fillStyle = isTarget ? "#000" : "#fff";
          ctx.fillText(code, cx, labelY);
        }

        setDetected(frameDetected);
        setTotalScanned(scannedSetRef.current.size);
        setFoundActive(
          target.length === 2 && frameDetected.some((d) => d.id === targetId),
        );

        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
          setFps(frameCount);
          frameCount = 0;
          lastFpsTime = now;
        }
      } catch (e) {
        console.error("Detection error:", e);
      }

      rafId = requestAnimationFrame(detectLoop);
    };

    const startCamera = async () => {
      setLoadingText("Starting camera...");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      video.srcObject = stream;
      await video.play();
    };

    const loadDetector = async () => {
      setLoadingText("Loading detector...");
      await loadScript(`${BASE_PATH}/js-aruco2/cv.js`);
      await loadScript(`${BASE_PATH}/js-aruco2/aruco.js`);
      await loadScript(`${BASE_PATH}/js-aruco2/dictionaries/aruco_4x4_1000.js`);
      if (!window.AR) throw new Error("AR global missing after load");
      detector = new window.AR.Detector({ dictionaryName: "ARUCO_4X4_1000" });
    };

    (async () => {
      try {
        await startCamera();
        if (cancelled) return;
        await loadDetector();
        if (cancelled) return;
        setReady(true);
        detectLoop();
      } catch (err) {
        console.error(err);
        setLoadingText(
          err instanceof Error ? err.message : "Failed to initialize.",
        );
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      const stream = video.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
      .toUpperCase()
      .replace(/[^123456789ABCDEFGHJKLMNPQRTUVWXYZ]/g, "");
    setTargetCode(val);
    const id = codeToId(val);
    if (val.length === 2 && id >= 0) setSearchIdText(`ArUco ID: ${id}`);
    else if (val.length === 1) setSearchIdText(`row ${val}...`);
    else setSearchIdText("type a code...");
  };

  const targetId = codeToId(targetCode);
  const isTargetDetected =
    targetCode.length === 2 && detected.some((d) => d.id === targetId);

  const sortedDetected = [...detected].sort((a, b) => {
    if (a.id === targetId) return -1;
    if (b.id === targetId) return 1;
    return a.id - b.id;
  });

  return (
    <>
      <div className="header">
        <h1>
          <span>▦</span> puzzle scanner
        </h1>
        <div className={`status-dot${ready ? " ready" : ""}`} />
      </div>

      <div className="search-bar">
        <input
          type="text"
          className={`search-input${isTargetDetected ? " found" : ""}`}
          placeholder="K7"
          maxLength={2}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={targetCode}
          onChange={handleInput}
        />
        <div className="search-info">
          <div className="search-label">Searching for</div>
          <div className="search-id">{searchIdText}</div>
        </div>
      </div>

      <div className="camera-container">
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} />
        <div className={`found-flash${foundActive ? " active" : ""}`} />
        <div className="detection-banner">
          <div className="detected-codes">
            {sortedDetected.length === 0 ? (
              <span className="detected-placeholder">
                Point camera at markers...
              </span>
            ) : (
              sortedDetected.map((d) => {
                const isTarget = targetCode.length === 2 && d.id === targetId;
                return (
                  <div
                    key={d.id}
                    className={`code-chip${isTarget ? " target" : ""}`}
                  >
                    {d.code}
                    <span className="chip-id">#{d.id}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className={`loading-overlay${ready ? " hidden" : ""}`}>
          <div className="loader" />
          <div className="loading-text">{loadingText}</div>
        </div>
      </div>

      <div className="stats-bar">
        <span>{ready ? `${fps} fps` : "-- fps"}</span>
        <span>{detected.length} detected</span>
        <span>{totalScanned} scanned</span>
      </div>

      <div className="alpha-ref">
        1 2 3 4 5 6 7 8 9 A B C D E F G H J K L M N P Q R T U V W X Y Z
      </div>
    </>
  );
}
