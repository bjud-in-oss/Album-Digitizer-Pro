import React, { useState, useEffect, useRef } from 'react';
import { Camera, Disc, MonitorPlay, Cpu, Mic, Video } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { saveSnapshotTool } from './lib/gemini-tools';

type AppPhase = 'idle' | 'briefing' | 'director';

export default function App() {
  const [sourceMode, setSourceMode] = useState<'mobile' | 'dvd'>('mobile');
  const [appPhase, setAppPhase] = useState<AppPhase>('idle');
  const [briefingContext, setBriefingContext] = useState<string>('');
  const [currentFrameForGemini, setCurrentFrameForGemini] = useState<string | null>(null);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const sessionRef = useRef<any>(null);
  const bridgeWsRef = useRef<WebSocket | null>(null);

  // Audio Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);

  // 1. Anslut till Python-bryggan via WebSocket
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8089/ws');
    ws.onopen = () => {
      console.log('✅ Ansluten till Python Bridge WS');
      setBridgeConnected(true);
    };
    ws.onmessage = (msg) => console.log('📩 Svar från Bridge:', msg.data);
    ws.onclose = () => {
      console.log('❌ Bridge WS Stängd');
      setBridgeConnected(false);
    };
    ws.onerror = (err) => {
      console.error('❌ Bridge WS Error:', err);
      setBridgeConnected(false);
    };
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
            video: { facingMode: 'environment', width: { ideal: 4000 }, height: { ideal: 3000 } }
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

  // 3. "The Virtual Camera" - Skickar 1 FPS video ENDAST i Director Mode
  useEffect(() => {
    if (appPhase !== 'director') return;

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

        if (sessionRef.current) {
          const base64Data = base64DataUrl.split(',')[1];
          sessionRef.current.sendRealtimeInput({
            video: { mimeType: 'image/jpeg', data: base64Data }
          });
        }
      }
    }, 1000); 

    return () => clearInterval(intervalId);
  }, [sourceMode, appPhase]);

  // Rensa ljud och session
  const cleanupGemini = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(t => t.stop());
      audioStreamRef.current = null;
    }
    if (playbackContextRef.current) {
      playbackContextRef.current.close();
      playbackContextRef.current = null;
    }
  };

  // Starta ljudinspelning (Mic eller Systemljud)
  const startAudioCapture = async (mode: 'mobile' | 'dvd', sessionPromise: Promise<any>) => {
    try {
      let stream: MediaStream;
      if (mode === 'mobile' || appPhase === 'briefing') {
        // I Briefing använder vi alltid micken. I mobile-läge använder vi också micken.
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        // DVD Director Mode: Fånga systemljud
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
          console.warn("Inget ljudspår hittades i skärmdelningen! Se till att kryssa i 'Dela systemljud'.");
        }
        stream = new MediaStream(audioTracks);
        displayStream.getVideoTracks().forEach(t => t.stop()); // Stäng videospåret direkt
      }

      audioStreamRef.current = stream;
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        sessionPromise.then(session => {
          if (session) {
            session.sendRealtimeInput({
              audio: { mimeType: 'audio/pcm;rate=16000', data: base64 }
            });
          }
        }).catch(() => {});
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
    } catch (err) {
      console.error("Kunde inte starta ljudinspelning:", err);
    }
  };

  // Spela upp ljud från Gemini (24kHz PCM)
  const playGeminiAudio = (base64Data: string) => {
    if (!playbackContextRef.current) {
      playbackContextRef.current = new AudioContext({ sampleRate: 24000 });
      nextPlayTimeRef.current = playbackContextRef.current.currentTime;
    }
    const ctx = playbackContextRef.current;
    
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }
    
    const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);
    
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    
    const startTime = Math.max(nextPlayTimeRef.current, ctx.currentTime);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
  };

  // FAS 1: Starta Briefing
  const startBriefing = async () => {
    cleanupGemini();
    setAppPhase('briefing');
    setBriefingContext('');

    try {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey: apiKey as string });
      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
          onopen: () => console.log("✅ Briefing Session Startad"),
          onmessage: (message: LiveServerMessage) => {
            // Spara textkontext
            if (message.serverContent?.modelTurn?.parts) {
              const textParts = message.serverContent.modelTurn.parts.filter(p => p.text).map(p => p.text);
              if (textParts.length > 0) {
                setBriefingContext(prev => prev + " " + textParts.join(" "));
              }
              
              // Spela upp ljud (Endast i Briefing)
              const audioPart = message.serverContent.modelTurn.parts.find(p => p.inlineData?.data);
              if (audioPart?.inlineData?.data) {
                playGeminiAudio(audioPart.inlineData.data);
              }
            }
          },
          onclose: () => setAppPhase('idle'),
          onerror: (err) => console.error("Briefing Error:", err)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [{ text: "Du är en hjälpsam arkivarie. Fråga användaren vad ni ska digitalisera idag (t.ex. en specifik DVD, vilka personer som är med, vad du ska leta efter). Var kortfattad. När användaren säger att de är redo, gör en mycket kort text-sammanfattning av vad du ska leta efter och spara i ditt minne." }]
          }
        }
      });

      sessionRef.current = await sessionPromise;
      startAudioCapture('mobile', sessionPromise); // Använd alltid mick för briefing
    } catch (err) {
      console.error("Kunde inte starta Briefing:", err);
      setAppPhase('idle');
    }
  };

  // FAS 2: Starta Director Mode
  const startDirector = async () => {
    cleanupGemini();
    setAppPhase('director');

    try {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey: apiKey as string });
      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
          onopen: () => console.log("🎬 Director Mode Startad"),
          onmessage: async (message: LiveServerMessage) => {
            // Ignorera inkommande ljud medvetet (Tyst regissör)
            
            if (message.toolCall) {
              const call = message.toolCall.functionCalls[0];
              if (call.name === 'save_snapshot') {
                const args = call.args as any;
                console.log(`📸 Snapshot! Handling: ${args.running_summary}`);
                
                if (bridgeWsRef.current && bridgeWsRef.current.readyState === WebSocket.OPEN) {
                  bridgeWsRef.current.send(JSON.stringify({
                    action: 'save_snapshot',
                    description: args.description,
                    timestamp_offset: args.timestamp_offset,
                    running_summary: args.running_summary,
                    characters_detected: args.characters_detected
                  }));
                }

                sessionPromise.then((session) => {
                  session.sendToolResponse({
                    functionResponses: [{
                      id: call.id,
                      name: call.name,
                      response: { result: "Success! Snapshot saved." }
                    }]
                  });
                });
              }
            }
          },
          onclose: () => setAppPhase('idle'),
          onerror: (err) => console.error("Director Error:", err)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          // Stäng av VAD för att inte avbrytas av filmljudet
          ...({ realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } as any),
          systemInstruction: {
            parts: [{ text: `Du är nu en tyst och osynlig AI-regissör. Du analyserar video och ljud. Du får ALDRIG svara med röstanrop eller generera text/ljud. Din ENDA uppgift är att anropa verktyget save_snapshot när något viktigt eller intressant händer. Uppdatera alltid 'running_summary' och 'characters_detected' i verktyget så att en röd tråd bevaras. Här är instruktionerna och kontexten från vår tidigare briefing: [${briefingContext}]. Agera nu på videoströmmen utifrån detta.` }]
          },
          tools: [{ functionDeclarations: [saveSnapshotTool] }]
        }
      });

      sessionRef.current = await sessionPromise;
      startAudioCapture(sourceMode, sessionPromise); // Fånga mick eller systemljud
    } catch (err) {
      console.error("Kunde inte starta Director:", err);
      setAppPhase('idle');
    }
  };

  const stopAll = () => {
    cleanupGemini();
    setAppPhase('idle');
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
              src="http://localhost:8089/video_feed" 
              alt="DVD Stream"
              className="w-full h-full object-contain"
              onError={() => console.error("Kunde inte ladda DVD-strömmen.")}
            />
          )}
          
          <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full text-xs font-mono text-zinc-300 border border-white/10 flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full animate-pulse ${
              appPhase === 'director' ? 'bg-red-500' : 
              appPhase === 'briefing' ? 'bg-blue-500' : 
              'bg-emerald-500'
            }`} />
            {appPhase === 'director' ? 'REC: Director Mode' : 
             appPhase === 'briefing' ? 'Briefing Mode' : 
             sourceMode === 'mobile' ? 'Kamera Aktiv' : 'DVD Ström Aktiv'}
          </div>
        </div>

        {/* Sidebar / State Machine Controls */}
        <div className="w-full lg:w-80 flex flex-col gap-4">
          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                <Cpu className="w-4 h-4" /> AI State Machine
              </h2>
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${bridgeConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
                <span className="text-[10px] text-zinc-500 font-medium">Bridge</span>
              </div>
            </div>
            
            <div className="flex flex-col gap-3">
              {appPhase === 'idle' && (
                <button 
                  onClick={startBriefing}
                  className="w-full py-3 rounded-lg font-medium text-sm transition-all flex justify-center items-center gap-2 bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-900/20"
                >
                  <Mic className="w-4 h-4" /> 1. Starta Briefing
                </button>
              )}

              {appPhase === 'briefing' && (
                <>
                  <div className="p-3 bg-blue-950/30 border border-blue-900/50 rounded-lg text-xs text-blue-200 mb-2">
                    <span className="font-semibold block mb-1">Briefing pågår...</span>
                    Prata med AI:n och berätta vad ni ska digitalisera.
                  </div>
                  <button 
                    onClick={startDirector}
                    className="w-full py-3 rounded-lg font-medium text-sm transition-all flex justify-center items-center gap-2 bg-red-600 text-white hover:bg-red-700 shadow-lg shadow-red-900/20"
                  >
                    <Video className="w-4 h-4" /> 2. Starta Inspelning (Director)
                  </button>
                </>
              )}

              {(appPhase === 'briefing' || appPhase === 'director') && (
                <button 
                  onClick={stopAll}
                  className="w-full py-2 rounded-lg font-medium text-sm transition-all flex justify-center items-center gap-2 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700"
                >
                  Avbryt
                </button>
              )}
            </div>

            {/* Briefing Context Display */}
            <div className="mt-4">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase mb-2">Briefing Minne</h3>
              <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800 h-32 overflow-y-auto text-xs text-zinc-400 font-mono">
                {briefingContext || 'Inget minne sparat ännu...'}
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Virtual Camera</h2>
            <div className="aspect-video bg-black rounded-lg border border-zinc-700 overflow-hidden flex items-center justify-center">
              {currentFrameForGemini && appPhase === 'director' ? (
                <img src={currentFrameForGemini} alt="Gemini Vision" className="w-full h-full object-contain" />
              ) : (
                <span className="text-xs text-zinc-600">{appPhase === 'director' ? 'Väntar på bild...' : 'Kamera pausad'}</span>
              )}
            </div>
          </div>
        </div>
      </main>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
