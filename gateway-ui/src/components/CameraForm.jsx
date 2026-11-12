import { useState } from "react";

export default function CameraForm({ onClose, onCameraAdded }) {
  const [name, setName] = useState("");
  const [rtspUrl, setRtspUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Submit new camera data (POST)
  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/gateway/actions/cameras", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          rtsp_url: rtspUrl,
          username,
          password,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || "Failed to save camera");
      }

      onCameraAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-blue-50/40 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 p-5 rounded-2xl space-y-4 transition-colors">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-300">
          Register New Camera
        </h3>
        <button
          onClick={onClose}
          className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
        >
          ✕ Cancel
        </button>
      </div>

      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400 bg-rose-100 dark:bg-rose-950/40 p-2.5 rounded-xl border border-rose-200 dark:border-rose-900/50">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Camera Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Entrance Camera"
              className="w-full text-xs px-3.5 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-800 dark:text-slate-100 transition"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              RTSP URL
            </label>
            <input
              type="text"
              required
              value={rtspUrl}
              onChange={(e) => setRtspUrl(e.target.value)}
              placeholder="rtsp://192.168.0.196:8554/"
              className="w-full text-xs px-3.5 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-slate-800 dark:text-slate-100 transition"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Username (Optional)
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g., admin"
              className="w-full text-xs px-3.5 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-800 dark:text-slate-100 transition"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Password (Optional)
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full text-xs px-3.5 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-800 dark:text-slate-100 transition"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer font-medium transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-xs bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition cursor-pointer disabled:opacity-50 font-medium shadow-sm"
          >
            {submitting ? "Saving..." : "Save Camera"}
          </button>
        </div>
      </form>
    </div>
  );
}
