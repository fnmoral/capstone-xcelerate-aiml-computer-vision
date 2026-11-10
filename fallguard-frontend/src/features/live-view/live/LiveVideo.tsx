import { useEffect, useRef, useState } from "react";
import { LABEL_TEXT } from "../../../lib/format";
import { LiveStream, supportsLiveStream, type LiveStatus } from "./LiveStream";
import type { ResultMessage } from "./protocol";

/**
 * How long each frame waits for its detections before being shown. The ml-service needs
 * roughly 100-200 ms (decode + inference + network); a bit more absorbs jitter.
 */
const DISPLAY_DELAY_MS = 300;

const labelText = (label: string) => LABEL_TEXT[label] ?? label;

/** Live camera video with the fall-detection boxes drawn on it. */
export function LiveVideo({
  url,
  label,
  onResult,
}: {
  url: string;
  label: string;
  onResult?: (message: ResultMessage) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const supported = supportsLiveStream();
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !supported) return;
    const stream = new LiveStream({
      url,
      canvas,
      delayMs: DISPLAY_DELAY_MS,
      labelText,
      onResult: (message) => onResultRef.current?.(message),
      onStatus: setStatus,
    });
    stream.start();
    return () => stream.stop();
  }, [url, supported]);

  if (!supported) {
    // Browsers only offer the video decoder on https:// or localhost. Opening the app as
    // http://<ip-address> from another device hides it even in an up-to-date browser.
    return (
      <p className="cam-tile__placeholder">
        {typeof window !== "undefined" && !window.isSecureContext
          ? "Live video needs a secure address. Open the app as http://localhost on this computer, or set up https:// to watch from other devices."
          : "This browser can’t play live video. Use a recent Chrome, Edge, Safari or Firefox."}
      </p>
    );
  }

  const notice =
    status === "stalled"
      ? "No video for 5+ seconds. The picture is frozen. Reconnecting…"
      : status === "connecting"
        ? "Connecting to video…"
        : null;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          opacity: status === "stalled" ? 0.4 : 1,
        }}
      />
      {notice && (
        <p
          className="cam-tile__placeholder"
          role="status"
          style={{
            position: "absolute",
            inset: 0,
            margin: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: status === "stalled" ? "rgba(127, 29, 29, 0.55)" : "transparent",
            fontWeight: status === "stalled" ? 600 : undefined,
          }}
        >
          {notice}
        </p>
      )}
    </div>
  );
}
