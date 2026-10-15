import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import type { Camera } from '../../types/domain';
import { CameraGrid } from './CameraGrid';

export default function LiveViewPage() {
  // Populated from the Core Backend once the cameras API exists (Module 2).
  const cameras: Camera[] = [];
  return (
    <>
      <PageHeader title="Live View" description="Live feeds from the cameras registered for this site."
        actions={<Link to="/cameras" className="btn btn--primary">Add camera</Link>} />
      {cameras.length ? <CameraGrid cameras={cameras} /> : (
        <EmptyState icon="video" title="No cameras connected"
          body="Register an IP camera in Cameras to see its feed here. Streaming is not connected in this build." />
      )}
    </>
  );
}
