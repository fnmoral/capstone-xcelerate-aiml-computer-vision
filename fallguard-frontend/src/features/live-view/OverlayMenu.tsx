import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { DEFAULT_OVERLAY, useUiStore, type LiveOverlay } from "../../store/uiStore";

const OPTIONS: { key: keyof LiveOverlay; label: string; hint: string }[] = [
  { key: "boxes", label: "Bounding boxes", hint: "A box around each person, coloured by status" },
  { key: "label", label: "Status", hint: "Upright, Falling, Lying or Unclear" },
  { key: "track", label: "Person number", hint: "The tracker's number for each person (#3)" },
  { key: "confidence", label: "Confidence score", hint: "How sure the model is that it is a person" },
  { key: "center", label: "Center point", hint: "The middle of each person's box" },
  { key: "skeleton", label: "Skeleton lines", hint: "Lines joining the body points the fall rules use" },
  { key: "keypoints", label: "Body points", hint: "The 17 points: eyes, shoulders, hips, knees, ankles..." },
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
    <div className="overlay-menu" ref={ref}>
      <button className="btn btn--sm" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}
        title="Choose what is drawn over the video">
        <Icon name="layers" size={14} /> Overlays <span className="muted">({shown})</span>
      </button>
      {open && (
        <div className="overlay-menu__panel card" role="group" aria-label="Video overlays">
          {OPTIONS.map((o) => (
            <label key={o.key} className="overlay-menu__option" title={o.hint}>
              <input type="checkbox" checked={liveOverlay[o.key]}
                onChange={(e) => setLiveOverlay({ ...liveOverlay, [o.key]: e.target.checked })} />
              <span>{o.label}<small>{o.hint}</small></span>
            </label>
          ))}
          <label className="overlay-menu__option overlay-menu__option--off"
            title="Needs a segmentation model; the pose model finds boxes and body points, not outlines">
            <input type="checkbox" disabled />
            <span>Segmentation mask<small>Not available: the pose model finds boxes and body points, not outlines</small></span>
          </label>
          <div className="overlay-menu__actions">
            {isDefault ? (
              <span className="muted">These are your defaults</span>
            ) : (
              <>
                <button className="btn btn--sm btn--primary" onClick={() => setOverlayDefault(liveOverlay)}>
                  Set as default
                </button>
                <button className="btn btn--sm" onClick={() => setLiveOverlay(overlayDefault)}>Back to default</button>
              </>
            )}
          </div>
          <p className="muted overlay-menu__note">Defaults are saved in this browser and used every time Live View opens.</p>
        </div>
      )}
    </div>
  );
}
