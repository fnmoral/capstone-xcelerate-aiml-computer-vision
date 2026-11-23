import { useEffect } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { BrandLogo } from './Brand';
import { Icon } from './Icon';

const RELOAD_KEY = 'fallguard-reloaded-for-update';

/** A page's code file is gone: the app was updated while this tab was open (new file names). */
export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(msg);
}

/** Reload once to pick up the new version (not again within a minute, so it can't loop).
 *  target: the page the user was opening, so they land there with the new version. */
export function reloadForUpdate(target?: string): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* storage blocked: still reload once */
  }
  if (target && target !== window.location.pathname + window.location.search) window.location.assign(target);
  else window.location.reload();
  return true;
}

/**
 * Shown instead of React Router's developer screen when a page fails. After a deploy, an open
 * tab asks for page files that no longer exist: then it reloads to the new version by itself.
 */
export function RouteError({ inApp = false }: { inApp?: boolean }) {
  const error = useRouteError();
  const stale = isStaleChunkError(error);
  useEffect(() => { if (stale) reloadForUpdate(); }, [stale]);

  const detail = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}`
    : error instanceof Error ? error.message : String(error ?? '');

  const body = (
    <div className={inApp ? 'empty' : 'auth-card card'} role="alert" style={inApp ? undefined : { textAlign: 'center' }}>
      {!inApp && <div className="auth-brand"><BrandLogo height={40} /></div>}
      <h1 className={inApp ? 'empty__title' : 'auth-title'}>{stale ? 'A new version is available' : 'Something went wrong'}</h1>
      <p className={inApp ? 'empty__body' : 'auth-subtitle'}>
        {stale ? 'FallGuard was just updated. Reload to continue with the new version.'
          : 'This page ran into a problem. Reloading usually fixes it.'}
      </p>
      {!stale && detail && <p className="muted mono" style={{ margin: '0 0 12px', overflowWrap: 'anywhere' }}>{detail}</p>}
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="btn btn--primary" onClick={() => window.location.reload()}><Icon name="play" size={14} /> Reload</button>
        <Link className="btn" to="/" reloadDocument>Go home</Link>
      </div>
    </div>
  );
  return inApp ? body : <main className="auth-page">{body}</main>;
}
