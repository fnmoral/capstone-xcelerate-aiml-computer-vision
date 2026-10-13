import CloudStatus from './components/CloudStatus';
import ConfigPanel from './components/ConfigPanel';
import CameraList from './components/CameraList';

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50/50 text-slate-800 antialiased selection:bg-blue-500 selection:text-white">
      
      {/* Top Navigation Bar */}
      <nav className="border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 bg-blue-600 rounded-xl flex items-center justify-center shadow-md shadow-blue-500/20 text-white font-bold text-sm">
              GW
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-900 tracking-tight">Gateway Control Center</h1>
              <p className="text-[11px] text-slate-500 font-medium">RTSP Stream & System Management</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60">
              <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              System Online
            </span>
          </div>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        
        {/* Top Section: Cloud Status & Configuration */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <CloudStatus />
          </div>
          <div className="lg:col-span-2">
            <ConfigPanel />
          </div>
        </div>

        {/* Bottom Section: Cameras Management */}
        <section>
          <CameraList />
        </section>

      </main>
    </div>
  );
}