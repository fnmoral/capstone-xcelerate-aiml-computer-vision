import { Link } from 'react-router-dom';
import { EmptyState } from '../../components/ui/EmptyState';

export function NotFoundPage() {
  return (
    <>
      <EmptyState icon="alert" title="Page not found" body="The page you requested does not exist." />
      <p style={{ textAlign: 'center' }}><Link to="/live" className="btn">Go to Live View</Link></p>
    </>
  );
}
