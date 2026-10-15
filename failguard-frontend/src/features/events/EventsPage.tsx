import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';

export default function Page() {
  return (
    <>
      <PageHeader title="Fall Events" description="Detected events with incident notes and recorded clips for review." />
      <EmptyState icon="alert" title="No events yet" body="Detected events will appear here once the detection pipeline is connected." />
    </>
  );
}
