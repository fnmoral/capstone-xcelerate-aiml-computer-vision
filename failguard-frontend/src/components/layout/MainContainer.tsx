import type { ReactNode } from 'react';
import './MainContainer.css';

/** Content region next to the navigation. Holds the routed page. */
export function MainContainer({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" className="main" tabIndex={-1}>
      <div className="main__inner">{children}</div>
    </main>
  );
}
