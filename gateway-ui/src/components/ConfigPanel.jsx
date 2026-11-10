import { useState, useEffect } from "react";

export default function ConfigPanel() {
  const [config, setConfig] = useState({
    stream_hub_address: "",
    back_end_address: "",
    server_port: "",
    tenant_id: "",
    tenant_name: "",
    gateway_name_id: "",
    gateway_information_updated: false,
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
      const response = await fetch("/gateway/actions/config", {
        method: "GET",
      });
      if (!response.ok) throw new Error("Failed to retrieve configuration");
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      const response = await fetch("/gateway/actions/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream_hub_address: config.stream_hub_address,
          back_end_address: config.back_end_address,
          tenant_name: config.tenant_name,
          gateway_name_id: config.gateway_name_id,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.Error || "Failed to update configuration");
      }

      const resData = await response.json();
      if (resData.config) {
        setConfig(resData.config);
        setOriginalConfig(resData.config);
      }

      setIsEditing(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 4000);

      window.location.reload();
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
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 shadow-sm border border-slate-200/80 dark:border-slate-800 flex items-center justify-center h-full">
        <p className="text-xs text-slate-400 font-medium animate-pulse">
          Loading system configuration...
        </p>
      </div>
    );
  }

  const needsUpdate = !config.gateway_information_updated;

  return (
    <div
      className={`bg-white dark:bg-slate-900 rounded-2xl p-6 shadow-sm border transition-colors ${
        needsUpdate
          ? "border-amber-300 dark:border-amber-600/60 ring-2 ring-amber-100 dark:ring-amber-950/40"
          : "border-slate-200/80 dark:border-slate-800"
      } space-y-5 flex flex-col justify-between`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 gap-3">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            System
          </span>
          <h2 className="text-sm font-bold text-slate-900 dark:text-white mt-0.5">
            Gateway Configuration
          </h2>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700 px-3 py-1.5 rounded-xl">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase">
              Tenant:
            </span>
            <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-200">
              {config.tenant_id || "N/A"}
            </span>
          </div>

          {!isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              className="px-3 py-1.5 text-xs bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xs transition cursor-pointer"
            >
              {needsUpdate ? "Complete Setup" : "Modify"}
            </button>
          )}
        </div>
      </div>

      {needsUpdate && !isEditing && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 p-3.5 rounded-xl text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between gap-3">
          <span>
            Gateway information has not been updated. Please configure your
            hosts, tenant name, and gateway name before adding cameras.
          </span>
          <button
            onClick={() => setIsEditing(true)}
            className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg transition shrink-0"
          >
            Configure Now
          </button>
        </div>
      )}

      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-3 rounded-xl">
          {error}
        </p>
      )}
      {success && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/50 p-3 rounded-xl">
          Configuration updated successfully!
        </p>
      )}

      {/* VIEW 1: READ-ONLY MODE */}
      {!isEditing ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 py-1">
          <div className="bg-slate-50/50 dark:bg-slate-800/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <span className="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              Cloud Address
            </span>
            <span className="text-xs font-mono font-semibold text-slate-800 dark:text-slate-200 mt-1 block truncate">
              {config.stream_hub_address || "N/A"}
            </span>
          </div>
          <div className="bg-slate-50/50 dark:bg-slate-800/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <span className="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              Backend Address
            </span>
            <span className="text-xs font-mono font-semibold text-slate-800 dark:text-slate-200 mt-1 block truncate">
              {config.back_end_address || "N/A"}
            </span>
          </div>
          <div className="bg-slate-50/50 dark:bg-slate-800/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <span className="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              Tenant Name
            </span>
            <span className="text-xs font-mono font-semibold text-slate-800 dark:text-slate-200 mt-1 block truncate">
              {config.tenant_name || "N/A"}
            </span>
          </div>
          <div className="bg-slate-50/50 dark:bg-slate-800/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <span className="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              Gateway Name ID
            </span>
            <span className="text-xs font-mono font-semibold text-slate-800 dark:text-slate-200 mt-1 block truncate">
              {config.gateway_name_id || "N/A"}
            </span>
          </div>
        </div>
      ) : (
        /* VIEW 2: EDITING MODE */
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Stream Hub Address
              </label>
              <input
                type="text"
                name="stream_hub_address"
                required
                value={config.stream_hub_address}
                onChange={handleChange}
                placeholder="127.0.0.1:8090"
                className="w-full text-xs px-3.5 py-2.5 bg-slate-50/50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-slate-800 dark:text-slate-100 transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Backend Address
              </label>
              <input
                type="text"
                name="back_end_address"
                required
                value={config.back_end_address}
                onChange={handleChange}
                placeholder="127.0.0.1:8000"
                className="w-full text-xs px-3.5 py-2.5 bg-slate-50/50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-slate-800 dark:text-slate-100 transition"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Tenant Name (Slug)
              </label>
              <input
                type="text"
                name="tenant_name"
                required
                value={config.tenant_name}
                onChange={handleChange}
                placeholder="e.g., default_tenant_name"
                className="w-full text-xs px-3.5 py-2.5 bg-slate-50/50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-slate-800 dark:text-slate-100 transition"
              />
            </div>
            {/* <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Gateway Name ID
              </label>
              <input
                type="text"
                name="gateway_name_id"
                required
                value={config.gateway_name_id}
                onChange={handleChange}
                placeholder="e.g., default_gateway_name"
                className="w-full text-xs px-3.5 py-2.5 bg-slate-50/50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-slate-800 dark:text-slate-100 transition"
              />
            </div> */}
          </div>

          <div className="flex justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-semibold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-md shadow-blue-500/20 transition cursor-pointer disabled:opacity-50"
            >
              {saving ? "Registering..." : "Save & Register Gateway"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
