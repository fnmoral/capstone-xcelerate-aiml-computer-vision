import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { DEFAULT_OVERLAY, useUiStore, type LiveOverlay } from "../../store/uiStore";

const OPTIONS: { key: keyof LiveOverlay; label: string; hint: string }[] = [
  { key: "boxes", label: "Bounding boxes", hint: "A box around each person, coloured by status" },
  { key: "label", label: "Status", hint: "Upright, Falling, Lying or Unclear" },
  { key: "track", label: "Person number", hint: "The tracker's number for each person (#3)" },
  { key: "confidence", label: "Confidence score", hint: "How sure the model is that it is a person" },
  { key: "skeleton", label: "Skeleton lines", hint: "Lines joining the body points the fall rules use" },
  { key: "keypoints", label: "Body points", hint: "The 17 points: eyes, shoulders, hips, knees, ankles..." },
  { key: "center", label: "Center point", hint: "The middle of each person's box" },
  { key: "grid", label: "Grid lines", hint: "An 8 × 8 grid over the picture, to judge positions and camera angle" },
];

const same = (a: LiveOverlay, b: LiveOverlay) =>
  (Object.keys(DEFAULT_OVERLAY) as (keyof LiveOverlay)[]).every((k) => a[k] === b[k]);

/** "Overlays" button: what is drawn over the live video, and the default used each time. */
export function OverlayMenu() {
  const { liveOverlay, overlayDefault, setLiveOverlay, setOverlayDefault } = useUiStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const shown = OPTIONS.filter((o) => liveOverlay[o.key]).length;
  const isDefault = same(liveOverlay, overlayDefault);

  return (
    <div className="ovp" ref={ref}>
      <button type="button" className="ovp__btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}
        title="Choose what is drawn over the video">
        <Icon name="layers" size={15} />
        <span>Overlays</span>
        <span className="ovp__count">{shown}</span>
      </button>
      {open && (
        <div className="ovp__panel" role="group" aria-label="Video overlays">
          <div className="ovp__head">Show on video</div>
          <ul className="ovp__list">
            {OPTIONS.map((o) => (
              <li key={o.key}>
                <label className="ovp__item" title={o.hint}>
                  <span>{o.label}</span>
                  <input type="checkbox" role="switch" className="ovp__switch" checked={liveOverlay[o.key]}
                    onChange={(e) => setLiveOverlay({ ...liveOverlay, [o.key]: e.target.checked })} />
                </label>
              </li>
            ))}
            <li>
              <label className="ovp__item ovp__item--off"
                title="Not available: the pose model finds boxes and body points, not outlines (needs a segmentation model)">
                <span>Segmentation mask</span>
                <input type="checkbox" role="switch" className="ovp__switch" disabled />
              </label>
            </li>
          </ul>
          {!isDefault && (
            <div className="ovp__foot">
              <button type="button" className="ovp__link" onClick={() => setLiveOverlay(overlayDefault)}>Reset</button>
              <button type="button" className="ovp__link ovp__link--primary" onClick={() => setOverlayDefault(liveOverlay)}
                title="Used every time Live View opens in this browser">Make my default</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
