import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';

export default function Page() {
  return (
    <>
      <PageHeader title="Detection Settings" description="Configure how detected events are confirmed and alerted." />
      <EmptyState icon="sliders" title="Not configured" body="Detection options are still being defined by the team." />
    </>
  );
}
