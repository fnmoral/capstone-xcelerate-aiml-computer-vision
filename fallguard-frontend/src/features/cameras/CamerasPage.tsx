import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';

export default function Page() {
  return (
    <>
      <PageHeader title="Cameras" description="Add, name and configure the IP cameras monitored by the system." />
      <EmptyState icon="camera" title="No cameras registered" body="Camera registration (address, name, location, analysis frame rate) is planned for a later sprint." />
    </>
  );
}
