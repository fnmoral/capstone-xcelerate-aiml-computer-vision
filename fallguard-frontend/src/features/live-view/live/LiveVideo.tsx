import { useEffect, useRef } from "react";
import { LABEL_TEXT } from "../../../lib/format";
import { LiveStream, supportsLiveStream } from "./LiveStream";
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !supported) return;
    const stream = new LiveStream({
      url,
      canvas,
      delayMs: DISPLAY_DELAY_MS,
      labelText,
      onResult: (message) => onResultRef.current?.(message),
    });
    stream.start();
    return () => stream.stop();
  }, [url, supported]);

  if (!supported) {
    return (
      <p className="cam-tile__placeholder">
        This browser can’t play live video. Use a recent Chrome, Edge, Safari or
        Firefox.
      </p>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}
