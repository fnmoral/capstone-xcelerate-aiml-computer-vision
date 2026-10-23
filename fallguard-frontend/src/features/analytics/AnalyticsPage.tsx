import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';

export default function Page() {
  return (
    <>
      <PageHeader title="Analytics" description="Event trends and system activity over a selected time range." />
      <EmptyState icon="chart" title="No data to show" body="Analytics will be available once events are being recorded." />
    </>
  );
}
