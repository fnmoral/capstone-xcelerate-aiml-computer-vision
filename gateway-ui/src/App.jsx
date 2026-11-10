import { useState, useEffect } from "react";
import CloudStatus from "./components/CloudStatus";
import ConfigPanel from "./components/ConfigPanel";
import CameraList from "./components/CameraList";

import logoSvg from "/logo.jpeg";

export default function App() {
  const [darkMode, setDarkMode] = useState(() => {
    return (
      localStorage.getItem("theme") === "dark" ||
      (!localStorage.getItem("theme") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
    );
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [darkMode]);

  return (
    <div
      className={`min-h-screen transition-colors duration-300 ${darkMode ? "dark" : ""}`}
    >
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 antialiased selection:bg-blue-500 selection:text-white">
        {/* Top Navigation Bar */}
        <nav className="border-b border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md sticky top-0 z-30 transition-colors">
          <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
            {/* Logo & Title */}
            <img
              src={logoSvg}
              alt="Logo"
              className="h-10 w-50 object-cover rounded-xl shadow-md shadow-blue-500/20 border border-slate-200/60 dark:border-slate-800"
            />
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-sm font-bold tracking-tight text-slate-900 dark:text-white">
                  Gateway Control Center
                </h1>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                  RTSP Stream & System Management
                </p>
              </div>
            </div>

            {/* Right Actions: System Badge & Theme Switcher */}
            <div className="flex items-center gap-3">
              <span className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/60">
                <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                System Online
              </span>

              <button
                onClick={() => setDarkMode(!darkMode)}
                className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-all shadow-sm"
                aria-label="Cambiar tema claro/oscuro"
              >
                {darkMode ? (
                  <svg
                    className="w-4 h-4 text-amber-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 3v1m0 16v1m9-9h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-4 h-4 text-slate-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </nav>

        {/* Main Content Area */}
        <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
          {/* Top Section: Cloud Status & Configuration */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 flex flex-col">
              <CloudStatus />
            </div>
            <div className="lg:col-span-2 flex flex-col">
              <ConfigPanel />
            </div>
          </div>

          <div className="border-t border-slate-200/60 dark:border-slate-800/80"></div>

          {/* Bottom Section: Cameras Management */}
          <section>
            <CameraList />
          </section>
        </main>
      </div>
    </div>
  );
}
