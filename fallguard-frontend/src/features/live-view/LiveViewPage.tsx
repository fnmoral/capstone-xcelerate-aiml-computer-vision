import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { CameraGrid } from './CameraGrid';

export default function LiveViewPage() {
  const { data, error, loading } = usePolling(() => api.cameras(), 2000);
  const cameras = (data?.cameras ?? []).filter((c) => c.on_gateway);
  const active = cameras.reduce((n, c) => n + c.active_incidents, 0);

  return (
    <>
      <PageHeader title="Live View"
        description="Live video from every camera, with each person's position as the detector sees it."
        actions={<Link to="/cameras" className="btn btn--primary">Manage cameras</Link>} />
      {error && <p className="notice notice--error">{error}</p>}
      {data?.gateway_error && <p className="notice notice--error">Gateway unavailable: {data.gateway_error}</p>}
      {active > 0 && (
        <p className="notice notice--error" role="alert">
          <strong>{active} active fall incident{active > 1 ? 's' : ''}.</strong>{' '}
          <Link to="/events?status=active">Review now →</Link>
        </p>
      )}
      {loading && !data ? <p className="muted">Loading cameras…</p> : cameras.length ? <CameraGrid cameras={cameras} /> : (
        <EmptyState icon="video" title="No cameras connected"
          body="Add an IP camera in Cameras. Its video appears here as soon as the gateway is streaming it." />
      )}
    </>
  );
}
