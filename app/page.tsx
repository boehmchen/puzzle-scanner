"use client";

import { useEffect, useRef, useState } from "react";

const BASE_PATH = "/puzzle-scanner";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRTUVWXYZ".split("");
const CHAR_TO_IDX: Record<string, number> = {};
ALPHABET.forEach((c, i) => (CHAR_TO_IDX[c] = i));

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

declare global {
  interface Window {
    cv?: CvGlobal;
  }
}

type CvMat = {
  rows: number;
  cols: number;
  intAt: (r: number, c: number) => number;
  floatAt: (r: number, c: number) => number;
  delete: () => void;
};
type CvMatVector = { get: (i: number) => CvMat; delete: () => void };
type ArucoParams = {
  adaptiveThreshWinSizeMin: number;
  adaptiveThreshWinSizeMax: number;
  adaptiveThreshWinSizeStep: number;
  adaptiveThreshConstant: number;
  minMarkerPerimeterRate: number;
  maxMarkerPerimeterRate: number;
  polygonalApproxAccuracyRate: number;
  minCornerDistanceRate: number;
  minDistanceToBorder: number;
  cornerRefinementMethod: number;
};
type CvGlobal = {
  aruco: {
    getPredefinedDictionary: (n: number) => unknown;
    DICT_4X4_1000: number;
    DetectorParameters: new () => ArucoParams;
    CORNER_REFINE_SUBPIX: number;
    detectMarkers: (
      gray: CvMat,
      dict: unknown,
      corners: CvMatVector,
      ids: CvMat,
      params: ArucoParams,
    ) => void;
  };
  Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
  MatVector: new () => CvMatVector;
  Size: new (w: number, h: number) => unknown;
  CLAHE: new (
    clip: number,
    tileSize: unknown,
  ) => { apply: (src: CvMat, dst: CvMat) => void; delete: () => void };
  VideoCapture: new (v: HTMLVideoElement) => { read: (mat: CvMat) => void };
  cvtColor: (src: CvMat, dst: CvMat, code: number) => void;
  COLOR_RGBA2GRAY: number;
  CV_8UC4: number;
  getBuildInformation?: () => string;
  onRuntimeInitialized?: () => void;
};

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [targetCode, setTargetCode] = useState("");
  const [searchIdText, setSearchIdText] = useState("type a code...");
  const [detected, setDetected] = useState<Detected[]>([]);
  const [totalScanned, setTotalScanned] = useState(0);
  const [fps, setFps] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadingText, setLoadingText] = useState("Loading OpenCV.js...");
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
    let arucoDict: unknown = null;
    let arucoParams: ArucoParams | null = null;
    let cap: { read: (mat: CvMat) => void } | null = null;
    let srcMat: CvMat | null = null;
    let grayMat: CvMat | null = null;
    let frameCount = 0;
    let lastFpsTime = performance.now();

    const initDetector = () => {
      const cv = window.cv!;
      arucoDict = cv.aruco.getPredefinedDictionary(cv.aruco.DICT_4X4_1000);
      arucoParams = new cv.aruco.DetectorParameters();
      arucoParams.adaptiveThreshWinSizeMin = 3;
      arucoParams.adaptiveThreshWinSizeMax = 30;
      arucoParams.adaptiveThreshWinSizeStep = 5;
      arucoParams.adaptiveThreshConstant = 7;
      arucoParams.minMarkerPerimeterRate = 0.01;
      arucoParams.maxMarkerPerimeterRate = 4.0;
      arucoParams.polygonalApproxAccuracyRate = 0.05;
      arucoParams.minCornerDistanceRate = 0.05;
      arucoParams.minDistanceToBorder = 1;
      arucoParams.cornerRefinementMethod = cv.aruco.CORNER_REFINE_SUBPIX;
      cap = new cv.VideoCapture(video);
    };

    const detectLoop = () => {
      if (cancelled) return;
      if (!window.cv || video.readyState < 2) {
        rafId = requestAnimationFrame(detectLoop);
        return;
      }
      const cv = window.cv;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      if (!srcMat || srcMat.rows !== h || srcMat.cols !== w) {
        srcMat?.delete();
        grayMat?.delete();
        srcMat = new cv.Mat(h, w, cv.CV_8UC4);
        grayMat = new cv.Mat();
      }

      const corners = new cv.MatVector();
      const ids = new cv.Mat();

      try {
        cap!.read(srcMat);
        cv.cvtColor(srcMat, grayMat!, cv.COLOR_RGBA2GRAY);
        const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
        clahe.apply(grayMat!, grayMat!);
        clahe.delete();
        cv.aruco.detectMarkers(
          grayMat!,
          arucoDict,
          corners,
          ids,
          arucoParams!,
        );

        ctx.clearRect(0, 0, w, h);

        const frameDetected: Detected[] = [];
        const numMarkers = ids.rows;
        const targetId = targetIdRef.current;
        const target = targetCodeRef.current;

        for (let i = 0; i < numMarkers; i++) {
          const markerId = ids.intAt(i, 0);
          const code = idToCode(markerId);
          frameDetected.push({ id: markerId, code });
          scannedSetRef.current.add(markerId);

          const c = corners.get(i);
          const pts: { x: number; y: number }[] = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: c.floatAt(0, j * 2), y: c.floatAt(0, j * 2 + 1) });
          }

          const isTarget = target.length === 2 && markerId === targetId;

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
          const fontSize = Math.max(14, Math.abs(pts[1].x - pts[0].x) * 0.5);
          ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          const metrics = ctx.measureText(code);
          const pw = metrics.width + 12;
          const ph = fontSize + 8;
          const labelY = pts[0].y - ph - 4;

          ctx.fillStyle = isTarget ? "#22c55e" : "rgba(10,10,12,0.85)";
          ctx.beginPath();
          ctx.roundRect(cx - pw / 2, labelY - ph / 2, pw, ph, 4);
          ctx.fill();

          ctx.fillStyle = isTarget ? "#000" : "#fff";
          ctx.fillText(code, cx, labelY);

          c.delete();
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

      corners.delete();
      ids.delete();

      rafId = requestAnimationFrame(detectLoop);
    };

    const onOpenCvReady = () => {
      if (cancelled) return;
      initDetector();
      setReady(true);
      detectLoop();
    };

    const startCamera = async () => {
      setLoadingText("Starting camera...");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        video.srcObject = stream;
        await video.play();
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      } catch (err) {
        setLoadingText("Camera access denied. Please allow camera.");
        console.error(err);
      }
    };

    const loadOpenCv = () => {
      setLoadingText("Loading OpenCV.js (may take a moment)...");
      const script = document.createElement("script");
      script.src = `${BASE_PATH}/opencv.js`;
      script.async = true;
      script.onload = () => {
        const cv = window.cv;
        if (!cv) {
          setLoadingText("OpenCV.js loaded but cv is undefined.");
          return;
        }
        if (cv.getBuildInformation) {
          onOpenCvReady();
        } else {
          cv.onRuntimeInitialized = onOpenCvReady;
        }
      };
      script.onerror = () => setLoadingText("Failed to load OpenCV.js.");
      document.head.appendChild(script);
    };

    (async () => {
      await startCamera();
      if (!cancelled) loadOpenCv();
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      srcMat?.delete();
      grayMat?.delete();
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
