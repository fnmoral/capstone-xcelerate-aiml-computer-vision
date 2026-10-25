import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { Icon } from "../../components/ui/Icon";
import { api } from "../../services/api/fallguard";
import { usePolling } from "../../services/api/usePolling";
import { STATUS_TEXT } from "../../lib/format";
import { useUiStore, type LiveLayout } from "../../store/uiStore";
import type { Camera } from "../../types/domain";
import { CameraGrid, CameraTile, useFitHeight } from "./CameraGrid";

const LAYOUTS: { value: LiveLayout; label: string; title: string }[] = [
  { value: "auto", label: "Auto", title: "Every camera; scroll for more" },
  {
    value: "1",
    label: "1",
    title: "One camera per page, fitted to the window",
  },
  {
    value: "2",
    label: "2",
    title: "Two cameras per page, fitted to the window",
  },
  {
    value: "4",
    label: "4",
    title: "Four cameras per page (2 × 2), fitted to the window",
  },
  {
    value: "8",
    label: "8",
    title: "Eight cameras per page (4 × 2), fitted to the window",
  },
  { value: "fit", label: "Fit all", title: "All cameras fitted to the window" },
];

/** One camera, as large as the window allows, with chips to switch camera. */
function FocusView({
  cam,
  cameras,
  onSelect,
  onBack,
}: {
  cam: Camera;
  cameras: Camera[];
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  const { ref, height } = useFitHeight<HTMLUListElement>();
  return (
    <>
      <div className="live-toolbar">
        <button className="btn btn--sm" onClick={onBack}>
          <Icon name="back" size={14} /> All cameras
        </button>
        <div className="live-chips" role="group" aria-label="Switch camera">
          {cameras.map((c) => (
            <button
              key={c.id}
              className="live-chip"
              aria-pressed={c.id === cam.id}
              onClick={() => onSelect(c.id)}
              title={STATUS_TEXT[c.health] ?? c.health}
            >
              <span
                className={`live-chip__dot live-chip__dot--${c.active_incidents ? "alert" : c.health}`}
                aria-hidden="true"
              />
              {c.name}
              <span className="visually-hidden">
                (
                {c.active_incidents
                  ? "fall detected"
                  : (STATUS_TEXT[c.health] ?? c.health)}
                )
              </span>
            </button>
          ))}
        </div>
      </div>
      <ul
        ref={ref}
        className="live-focus"
        style={{ height }}
        aria-label={`${cam.name}, enlarged`}
      >
        <CameraTile cam={cam} fill onSelect={onBack} />
      </ul>
    </>
  );
}

export default function LiveViewPage() {
  const { data, error, loading } = usePolling(() => api.cameras(), 2000);
  console.log("DATA LIEV PAGE ----", data);
  const { liveLayout, setLiveLayout } = useUiStore();
  const [layout, setLayout] = useState<LiveLayout>(liveLayout);
  const [page, setPage] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const cameras = (data?.cameras ?? []).filter((c) => c.on_gateway);
  const active = cameras.reduce((n, c) => n + c.active_incidents, 0);
  const broken = cameras.filter(
    (c) => c.health === "not_working" && c.alert_offline,
  );
  const focusCam = cameras.find((c) => c.id === focused);

  const perPage =
    layout === "auto" || layout === "fit"
      ? cameras.length || 1
      : Number(layout);
  const pages = Math.max(1, Math.ceil(cameras.length / perPage));
  const current = Math.min(page, pages - 1);
  const visible = cameras.slice(current * perPage, current * perPage + perPage);

  useEffect(() => {
    if (!focused) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFocused(null);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [focused]);

  const choose = (l: LiveLayout) => {
    setLayout(l);
    setPage(0);
  };

  return (
    <>
      <PageHeader
        title="Live View"
        description="Live video from every camera, with each person's position as the detector sees it. Click a camera to enlarge it."
        actions={
          <Link to="/cameras" className="btn btn--primary">
            Manage cameras
          </Link>
        }
      />
      {error && <p className="notice notice--error">{error}</p>}
      {data?.gateway_error && (
        <p className="notice notice--error">
          Gateway unavailable: {data.gateway_error}
        </p>
      )}
      {active > 0 && (
        <p className="notice notice--error" role="alert">
          <strong>
            {active} active fall incident{active > 1 ? "s" : ""}.
          </strong>{" "}
          <Link to="/events?status=active">Review now →</Link>
        </p>
      )}
      {broken.length > 0 && (
        <p className="notice notice--error" role="alert">
          <strong>
            {broken.length === 1
              ? `${broken[0].name} is not working`
              : `${broken.length} cameras are not working`}
          </strong>{" "}
          (no video, so falls there can't be detected).{" "}
          <Link to="/camera-logs">Camera logs →</Link>
        </p>
      )}
      {loading && !data ? (
        <p className="muted">Loading cameras…</p>
      ) : cameras.length === 0 ? (
        <EmptyState
          icon="video"
          title="No cameras connected"
          body="Add an IP camera in Cameras. Its video appears here as soon as the gateway is streaming it."
        />
      ) : focusCam ? (
        <FocusView
          cam={focusCam}
          cameras={cameras}
          onSelect={setFocused}
          onBack={() => setFocused(null)}
        />
      ) : (
        <>
          <div className="live-toolbar">
            <div className="live-toolbar__group">
              <span className="muted">Layout</span>
              <div className="tabs" role="group" aria-label="Layout">
                {LAYOUTS.map((l) => (
                  <button
                    key={l.value}
                    className="tab"
                    aria-pressed={layout === l.value}
                    title={l.title}
                    onClick={() => choose(l.value)}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              {layout === liveLayout ? (
                <span className="muted">Default</span>
              ) : (
                <button
                  className="btn btn--sm"
                  onClick={() => setLiveLayout(layout)}
                >
                  Set as default
                </button>
              )}
            </div>
            {pages > 1 && (
              <div className="live-toolbar__group" aria-label="Pages">
                <button
                  className="btn btn--sm"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                  aria-label="Previous page"
                >
                  <Icon name="collapse" size={14} />
                </button>
                <span>
                  Page {current + 1} of {pages}
                </span>
                <button
                  className="btn btn--sm"
                  disabled={current >= pages - 1}
                  onClick={() => setPage(current + 1)}
                  aria-label="Next page"
                >
                  <Icon name="expand" size={14} />
                </button>
              </div>
            )}
          </div>
          <CameraGrid
            cameras={visible}
            slots={layout === "auto" ? undefined : perPage}
            onSelect={setFocused}
          />
        </>
      )}
    </>
  );
}
