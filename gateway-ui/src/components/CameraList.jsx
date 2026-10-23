import { useState, useEffect } from 'react';
import CameraForm from './CameraForm';

export default function CameraList() {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  // At most max_streaming cameras stream at once; the rest stay saved, paused (standby).
  const [limits, setLimits] = useState({ max_streaming: 5, max_saved: 50 });
  const streaming = cameras.filter((c) => c.status !== 'paused').length;
  const full = cameras.length >= limits.max_saved;

  // Fetch camera list from backend
  const fetchCameras = async () => {
    try {
      setLoading(true);
      const response = await fetch('/gateway/actions/cameras', { method: 'GET' });
      if (!response.ok) throw new Error('Failed to retrieve camera list');
      
      const data = await response.json();
      if (Array.isArray(data)) {
        setCameras(data);
      } else {
        setCameras(data?.cameras || []);
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCameras();
    fetch('/gateway/actions/limits').then((r) => (r.ok ? r.json() : null)).then((l) => l && setLimits(l)).catch(() => {});
  }, []);

  const [busyId, setBusyId] = useState(null);

  // Pause or resume a camera's stream (the camera stays registered)
  const handlePauseResume = async (cam) => {
    const action = cam.status === 'paused' ? 'resume' : 'pause';
    try {
      setBusyId(cam.id);
      const response = await fetch(`/gateway/actions/cameras/${cam.id}/${action}`, { method: 'POST' });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.Error || `Failed to ${action} camera`);
      }
      fetchCameras();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  };

  // Delete camera by ID
  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this camera?')) return;
    
    try {
      const response = await fetch(`/gateway/actions/cameras/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete camera');
      fetchCameras();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200/80 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Streaming</span>
          <div className="flex items-center gap-2 mt-0.5">
            <h2 className="text-base font-bold text-slate-900">Connected Cameras</h2>
            <span className="px-2 py-0.5 text-xs font-semibold bg-slate-100 text-slate-600 rounded-lg">
              {streaming} / {limits.max_streaming} streaming
            </span>
            <span className="px-2 py-0.5 text-xs font-semibold bg-slate-100 text-slate-500 rounded-lg">
              {cameras.length} / {limits.max_saved} saved
            </span>
          </div>
        </div>

        <button
          onClick={() => setShowForm(true)}
          disabled={full}
          className={`px-4 py-2 text-xs font-semibold rounded-xl transition shadow-sm ${
            full
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20 cursor-pointer'
          }`}
        >
          {full ? 'Maximum Limit Reached' : '+ Add Camera'}
        </button>
      </div>

      {showForm && (
        <div className="pt-2">
          <CameraForm 
            onClose={() => setShowForm(false)} 
            onCameraAdded={() => {
              setShowForm(false);
              fetchCameras();
            }} 
          />
        </div>
      )}

      {loading && <p className="text-xs text-slate-400 text-center py-8">Loading cameras...</p>}
      {error && <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 p-3 rounded-xl">{error}</p>}

      {!loading && !error && cameras.length === 0 && (
        <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/30">
          <p className="text-sm font-semibold text-slate-600">No cameras registered</p>
          <p className="text-xs text-slate-400 mt-1">Add your first RTSP source to start monitoring.</p>
        </div>
      )}

      {/* Cameras Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {cameras.map((cam) => {
          const isOnline = cam.status === 'online';
          const isPaused = cam.status === 'paused';
          const badge = isOnline
            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
            : isPaused
              ? 'bg-slate-100 text-slate-600 border border-slate-200'
              : 'bg-amber-50 text-amber-700 border border-amber-200/60';
          const dot = isOnline ? 'bg-emerald-500 animate-pulse' : isPaused ? 'bg-slate-400' : 'bg-amber-500';
          return (
            <div key={cam.id} className="bg-slate-50/40 border border-slate-200/80 rounded-2xl p-5 flex flex-col justify-between space-y-4 hover:border-slate-300 hover:shadow-md transition group">
              
              <div className="space-y-3">
                <div className="flex items-start justify-between">
                  <h3 className="text-sm font-bold text-slate-900 truncate pr-2" title={cam.name}>
                    {cam.name}
                  </h3>
                  <span className={`px-2.5 py-1 text-[11px] font-semibold rounded-full flex items-center gap-1.5 shrink-0 ${badge}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                    {cam.status || 'offline'}
                  </span>
                </div>

                <div className="bg-white p-2.5 rounded-xl border border-slate-200/60 shadow-2xs">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase">RTSP URL</span>
                  <p className="text-xs font-mono text-slate-600 truncate mt-0.5" title={cam.rtsp_url}>
                    {cam.rtsp_url}
                  </p>
                </div>
              </div>

              <div className="space-y-3 pt-2 border-t border-slate-200/60">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span className="font-medium">User: <strong className="font-mono text-slate-700">{cam.username || 'N/A'}</strong></span>
                  <span>{cam.created_at ? new Date(cam.created_at).toLocaleDateString() : ''}</span>
                </div>

                <div className="flex items-center justify-between">
                  <button
                    onClick={() => handlePauseResume(cam)}
                    disabled={busyId === cam.id}
                    title={isPaused ? 'Start streaming this camera again' : 'Stop streaming without deleting the camera'}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
                      isPaused
                        ? 'bg-blue-600 hover:bg-blue-700 text-white border-blue-600'
                        : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200'
                    }`}
                  >
                    {busyId === cam.id ? '…' : isPaused ? '▶ Resume' : '❚❚ Pause'}
                  </button>
                  <button
                    onClick={() => handleDelete(cam.id)}
                    className="text-xs text-rose-600 hover:text-rose-700 font-semibold cursor-pointer transition opacity-80 group-hover:opacity-100"
                  >
                    Delete camera
                  </button>
                </div>
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}