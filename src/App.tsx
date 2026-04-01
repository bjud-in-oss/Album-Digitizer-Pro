import React, { useState, useEffect, useRef } from 'react';
import { Camera, Disc, MonitorPlay, Cpu } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { saveSnapshotTool } from './lib/gemini-tools';

export default function App() {
  const [sourceMode, setSourceMode] = useState<'mobile' | 'dvd'>('mobile');
  const [currentFrameForGemini, setCurrentFrameForGemini] = useState<string | null>(null);
  const [isGeminiConnected, setIsGeminiConnected] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const sessionRef = useRef<any>(null);
  const bridgeWsRef = useRef<WebSocket | null>(null);

  // 1. Anslut till Python-bryggan via WebSocket för att skicka kommandon
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8080/ws');
    ws.onopen = () => console.log('✅ Ansluten till Python Bridge WS');
    ws.onmessage = (msg) => console.log('📩 Svar från Bridge:', msg.data);
    ws.onerror = (err) => console.error('❌ Bridge WS Error:', err);
    bridgeWsRef.current = ws;

    return () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, []);

  // 2. Hantera mobilkamera-ström
  useEffect(() => {
    let stream: MediaStream | null = null;
    
    const startCamera = async () => {
      if (sourceMode === 'mobile') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'environment',
              width: { ideal: 4000 },
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

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [sourceMode]);

  // 3. "The Virtual Camera" - Fångar 1 bildruta/sekund och skickar till Gemini
  useEffect(() => {
    const intervalId = setInterval(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      let sourceElement: HTMLVideoElement | HTMLImageElement | null = null;
      let width = 0;
      let height = 0;

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
        
        ctx.drawImage(sourceElement, 0, 0, drawWidth, drawHeight);
        const base64DataUrl = canvas.toDataURL('image/jpeg', 0.8);
        setCurrentFrameForGemini(base64DataUrl);

        // Skicka bildrutan till Gemini om sessionen är aktiv
        if (isGeminiConnected && sessionRef.current) {
          const base64Data = base64DataUrl.split(',')[1];
          // Korrekt format för @google/genai Live API
          sessionRef.current.sendRealtimeInput({
            video: {
              mimeType: 'image/jpeg',
              data: base64Data
            }
          });
        }
      }
    }, 1000); 

    return () => clearInterval(intervalId);
  }, [sourceMode, isGeminiConnected]);

  // 4. Starta och hantera Gemini Live-sessionen
  const toggleGemini = async () => {
    if (isGeminiConnected) {
      sessionRef.current?.close();
      sessionRef.current = null;
      setIsGeminiConnected(false);
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
      
      // Använd callbacks-mönstret för den senaste SDK:n
      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
          onopen: () => {
            console.log("✅ Gemini Live Connected");
            setIsGeminiConnected(true);
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log("🤖 Gemini Server Message:", message);
            
            if (message.toolCall) {
              const call = message.toolCall.functionCalls[0];
              if (call.name === 'save_snapshot') {
                const args = call.args as any;
                console.log(`📸 Gemini anropar save_snapshot! Beskrivning: "${args.description}", Offset: ${args.timestamp_offset}s`);
                
                // Skicka kommando till Python-bryggan för att rädda originalbilden
                if (bridgeWsRef.current && bridgeWsRef.current.readyState === WebSocket.OPEN) {
                  bridgeWsRef.current.send(JSON.stringify({
                    action: 'save_snapshot',
                    description: args.description,
                    timestamp_offset: args.timestamp_offset
                  }));
                }

                // Bekräfta till Gemini att verktyget har körts
                sessionPromise.then((session) => {
                  session.sendToolResponse({
                    functionResponses: [{
                      id: call.id,
                      name: call.name,
                      response: { result: "Success! Snapshot has been saved locally. Continue your analysis." }
                    }]
                  });
                });
              }
            }
          },
          onclose: () => {
            console.log("❌ Gemini Live Closed");
            setIsGeminiConnected(false);
            sessionRef.current = null;
          },
          onerror: (err) => {
            console.error("❌ Gemini Live Error:", err);
            setIsGeminiConnected(false);
            sessionRef.current = null;
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [{ text: "Du är en AI-regissör. Du tittar på en videoström som användaren digitaliserar. Om du ser en viktig, estetisk eller intressant händelse, anropa verktyget save_snapshot för att spara en högupplöst kopia." }]
          },
          tools: [{ functionDeclarations: [saveSnapshotTool] }]
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err) {
      console.error("Kunde inte starta Gemini:", err);
    }
  };

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
              onError={() => console.error("Kunde inte ladda DVD-strömmen. Är bridge.py igång?")}
            />
          )}
          
          <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full text-xs font-mono text-zinc-300 border border-white/10 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            {sourceMode === 'mobile' ? 'Kamera Aktiv' : 'DVD Ström Aktiv'}
          </div>
        </div>

        {/* Sidebar / Debug Info */}
        <div className="w-full lg:w-80 flex flex-col gap-4">
          {/* Gemini Control Panel */}
          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                <Cpu className="w-4 h-4" /> AI Director
              </h2>
            </div>
            
            <button 
              onClick={toggleGemini}
              className={`w-full py-3 rounded-lg font-medium text-sm transition-all flex justify-center items-center gap-2 ${
                isGeminiConnected 
                  ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/50' 
                  : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-900/20'
              }`}
            >
              {isGeminiConnected ? 'Avsluta Gemini Session' : 'Starta Gemini Live'}
            </button>

            {isGeminiConnected && (
              <div className="mt-4 p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                <div className="flex items-center gap-2 text-xs text-emerald-400 mb-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  Streamar video till AI (1 FPS)...
                </div>
              </div>
            )}
          </div>

          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Virtual Camera</h2>
            
            <div className="aspect-video bg-black rounded-lg border border-zinc-700 overflow-hidden flex items-center justify-center">
              {currentFrameForGemini ? (
                <img src={currentFrameForGemini} alt="Gemini Vision" className="w-full h-full object-contain" />
              ) : (
                <span className="text-xs text-zinc-600">Väntar på bild...</span>
              )}
            </div>
            <div className="mt-2 text-[10px] font-mono text-zinc-500 truncate">
              {currentFrameForGemini ? `Skickas: ${currentFrameForGemini.substring(0, 40)}...` : 'Ingen data'}
            </div>
          </div>
        </div>
      </main>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
