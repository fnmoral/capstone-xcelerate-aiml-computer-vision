import { useState, useEffect } from 'react';

export default function ConfigPanel() {
  const [config, setConfig] = useState({
    cloud_address: '',
    server_port: '',
    tenant_id: ''
  });
  const [originalConfig, setOriginalConfig] = useState({});
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  // Fetch configuration (GET)
  const fetchConfig = async () => {
    try {
      setLoading(true);
      const response = await fetch('/gateway/actions/config', { method: 'GET' });
      if (!response.ok) throw new Error('Failed to retrieve configuration');
      const data = await response.json();
      setConfig(data);
      setOriginalConfig(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  // Cancel editing and revert to original values
  const handleCancel = () => {
    setConfig(originalConfig);
    setIsEditing(false);
    setError(null);
  };

  // Save configuration (PUT)
  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const response = await fetch('/gateway/actions/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to update configuration');
      }

      setOriginalConfig(config);
      setIsEditing(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 4000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setConfig((prev) => ({ ...prev, [name]: value }));
  };

  if (loading) {
    return (
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200/80 flex items-center justify-center h-full">
        <p className="text-xs text-slate-400 font-medium animate-pulse">Loading system configuration...</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200/80 space-y-5 flex flex-col justify-between">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 gap-3">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">System</span>
          <h2 className="text-sm font-bold text-slate-900 mt-0.5">Gateway Configuration</h2>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200/60 px-3 py-1.5 rounded-xl">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Tenant:</span>
            <span className="text-xs font-mono font-semibold text-slate-700">{config.tenant_id || 'N/A'}</span>
          </div>

          {!isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              className="px-3 py-1.5 text-xs bg-white hover:bg-slate-50 text-slate-700 font-semibold rounded-xl border border-slate-200 shadow-2xs transition cursor-pointer"
            >
              Modify
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 p-3 rounded-xl">{error}</p>}
      {success && <p className="text-xs text-emerald-600 bg-emerald-50 border border-emerald-100 p-3 rounded-xl">Configuration updated successfully!</p>}

      {/* VIEW 1: READ-ONLY MODE */}
      {!isEditing ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-1">
          <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100">
            <span className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider">Cloud Address</span>
            <span className="text-xs font-mono font-semibold text-slate-800 mt-1 block">{config.cloud_address || 'N/A'}</span>
          </div>
          <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100">
            <span className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider">Server Port</span>
            <span className="text-xs font-mono font-semibold text-slate-800 mt-1 block">{config.server_port || 'N/A'}</span>
          </div>
        </div>
      ) : (
        /* VIEW 2: EDITING MODE */
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Cloud Address</label>
              <input
                type="text"
                name="cloud_address"
                required
                value={config.cloud_address}
                onChange={handleChange}
                className="w-full text-xs px-3.5 py-2.5 bg-slate-50/50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-slate-800 transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Server Port</label>
              <input
                type="text"
                name="server_port"
                required
                value={config.server_port}
                onChange={handleChange}
                className="w-full text-xs px-3.5 py-2.5 bg-slate-50/50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-slate-800 transition"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Tenant ID</label>
            <input
              type="text"
              name="tenant_id"
              required
              value={config.tenant_id}
              onChange={handleChange}
              className="w-full text-xs px-3.5 py-2.5 bg-slate-50/50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-slate-800 transition"
            />
          </div>

          <div className="flex justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 text-xs bg-white border border-slate-200 text-slate-600 font-semibold rounded-xl hover:bg-slate-50 transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-md shadow-blue-500/20 transition cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Saving changes...' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}