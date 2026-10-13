import { useState, useEffect } from 'react';

export default function CloudStatus() {
  const [isOnline, setIsOnline] = useState(false);
  const [loading, setLoading] = useState(true);

  // Check cloud/gateway health status
  const checkCloudStatus = async () => {
    setLoading(true);
    try {
        const response = await fetch('/gateway/actions/health');
        if (response.ok) {
            setIsOnline(true);
        } else {
            setIsOnline(false);
        }
    } catch (error) {
        console.error(error);
        setIsOnline(false);
    } finally {
        setLoading(false);
    }
  };

  useEffect(() => {
    checkCloudStatus();
    // Auto-check every 10 seconds
    const interval = setInterval(checkCloudStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200/80 flex flex-col justify-between h-full hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Status</span>
          <h2 className="text-sm font-bold text-slate-900 mt-0.5">Cloud Server</h2>
        </div>
        <button 
          onClick={checkCloudStatus}
          disabled={loading}
          className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition cursor-pointer"
          title="Refresh status"
        >
          <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <div className="my-6 flex items-center gap-3">
        <div className={`w-3.5 h-3.5 rounded-full flex items-center justify-center ${isOnline ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'}`}>
          <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500 animate-ping' : 'bg-rose-500'}`} />
        </div>
        <div>
          <p className={`text-sm font-semibold ${isOnline ? 'text-emerald-700' : 'text-rose-700'}`}>
            {loading ? 'Checking...' : isOnline ? 'Connected & Active' : 'Disconnected'}
          </p>
          <p className="text-[11px] text-slate-400">Real-time connection monitoring</p>
        </div>
      </div>

      <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400 font-medium">
        <span>Auto-check enabled</span>
        <span>Every 10s</span>
      </div>
    </div>
  );
}