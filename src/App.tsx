import React, { useState, useEffect, useRef } from 'react';
import { Camera, Disc, MonitorPlay } from 'lucide-react';

export default function App() {
  const [sourceMode, setSourceMode] = useState<'mobile' | 'dvd'>('mobile');
  const [currentFrameForGemini, setCurrentFrameForGemini] = useState<string | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Hantera mobilkamera-ström
  useEffect(() => {
    let stream: MediaStream | null = null;
    
    const startCamera = async () => {
      if (sourceMode === 'mobile') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'environment', // Använd bakre kameran
              width: { ideal: 4000 },    // Försök få högsta möjliga upplösning
              height: { ideal: 3000 }
            }
          });
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        } catch (err) {
          console.error("Kunde inte starta kameran:", err);
        }
      }
    };

    startCamera();

    // Städa upp kameran när vi byter läge eller stänger appen
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [sourceMode]);

  // "The Virtual Camera" - 1 FPS Capture Loop för Gemini
  useEffect(() => {
    const intervalId = setInterval(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      let sourceElement: HTMLVideoElement | HTMLImageElement | null = null;
      let width = 0;
      let height = 0;

      // Hämta källa beroende på aktivt läge
      if (sourceMode === 'mobile' && videoRef.current && videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
        sourceElement = videoRef.current;
        width = videoRef.current.videoWidth;
        height = videoRef.current.videoHeight;
      } else if (sourceMode === 'dvd' && imgRef.current && imgRef.current.complete) {
        sourceElement = imgRef.current;
        width = imgRef.current.naturalWidth;
        height = imgRef.current.naturalHeight;
      }

      if (sourceElement && width > 0 && height > 0) {
        // Skala ner något för Gemini för att spara bandbredd/tokens (t.ex. max 1080p)
        const maxDim = 1080;
        let drawWidth = width;
        let drawHeight = height;
        
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          drawWidth = width * ratio;
          drawHeight = height * ratio;
        }

        canvas.width = drawWidth;
        canvas.height = drawHeight;
        
        // Rita av videon/bilden till canvasen
        ctx.drawImage(sourceElement, 0, 0, drawWidth, drawHeight);
        
        // Konvertera till base64 JPEG (kvalitet 0.8)
        const base64Frame = canvas.toDataURL('image/jpeg', 0.8);
        setCurrentFrameForGemini(base64Frame);
      }
    }, 1000); // Kör exakt 1 gång per sekund (1 FPS)

    return () => clearInterval(intervalId);
  }, [sourceMode]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      {/* Header & Toggle */}
      <header className="p-4 border-b border-zinc-800 flex flex-col sm:flex-row items-center justify-between gap-4 bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <MonitorPlay className="w-6 h-6 text-blue-400" />
          <h1 className="text-xl font-semibold tracking-tight">Album Digitizer Pro</h1>
        </div>
        
        <div className="flex bg-zinc-800 p-1 rounded-lg">
          <button
            onClick={() => setSourceMode('mobile')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              sourceMode === 'mobile' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Camera className="w-4 h-4" />
            Mobilkamera
          </button>
          <button
            onClick={() => setSourceMode('dvd')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              sourceMode === 'dvd' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Disc className="w-4 h-4" />
            Lokal DVD (Brygga)
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 flex flex-col lg:flex-row gap-4">
        {/* Viewport */}
        <div className="flex-1 bg-black rounded-xl border border-zinc-800 overflow-hidden relative flex items-center justify-center min-h-[50vh]">
          {sourceMode === 'mobile' ? (
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="w-full h-full object-contain"
            />
          ) : (
            <img 
              ref={imgRef}
              crossOrigin="anonymous"
              src="http://localhost:8080/video_feed" 
              alt="DVD Stream"
              className="w-full h-full object-contain"
              onError={(e) => {
                console.error("Kunde inte ladda DVD-strömmen. Är bridge.py igång?");
              }}
            />
          )}
          
          {/* Status Overlay */}
          <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full text-xs font-mono text-zinc-300 border border-white/10 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            {sourceMode === 'mobile' ? 'Kamera Aktiv' : 'DVD Ström Aktiv'}
          </div>
        </div>

        {/* Sidebar / Debug Info */}
        <div className="w-full lg:w-80 flex flex-col gap-4">
          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Gemini Virtual Camera</h2>
            <p className="text-xs text-zinc-500 mb-4">
              Denna dolda canvas fångar 1 bildruta per sekund (1 FPS) och konverterar den till base64 för Gemini Live API.
            </p>
            
            {/* Preview of what Gemini sees */}
            <div className="aspect-video bg-black rounded-lg border border-zinc-700 overflow-hidden flex items-center justify-center">
              {currentFrameForGemini ? (
                <img src={currentFrameForGemini} alt="Gemini Vision" className="w-full h-full object-contain" />
              ) : (
                <span className="text-xs text-zinc-600">Väntar på bild...</span>
              )}
            </div>
            <div className="mt-2 text-[10px] font-mono text-zinc-500 truncate">
              {currentFrameForGemini ? `Base64: ${currentFrameForGemini.substring(0, 40)}...` : 'Ingen data'}
            </div>
          </div>
        </div>
      </main>

      {/* Hidden Canvas for Gemini */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
