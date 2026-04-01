import asyncio
import cv2
import time
import json
from collections import deque
from aiohttp import web

# Konfiguration
VLC_STREAM_URL = "http://localhost:8088/stream" # Byt ut mot din VLC-ström (eller 0 för webbkamera vid test)
BUFFER_SECONDS = 5
FPS = 30 # Antagen bilduppdateringsfrekvens
MAX_FRAMES = BUFFER_SECONDS * FPS

# Rullande buffert för att spara de senaste 5 sekunderna
frame_buffer = deque(maxlen=MAX_FRAMES)
latest_frame = None # Håller den senaste bilden för MJPEG-strömmen

async def capture_video():
    """Bakgrundsprocess som läser från VLC och uppdaterar RAM-bufferten."""
    global latest_frame
    print(f"Ansluter till videoström på {VLC_STREAM_URL}...")
    cap = cv2.VideoCapture(VLC_STREAM_URL)
    
    while True:
        if not cap.isOpened():
            print("Väntar på videoström...")
            await asyncio.sleep(2)
            cap = cv2.VideoCapture(VLC_STREAM_URL)
            continue

        ret, frame = cap.read()
        if not ret:
            print("Tappade anslutningen till strömmen, försöker igen...")
            await asyncio.sleep(1)
            cap = cv2.VideoCapture(VLC_STREAM_URL)
            continue
            
        # Spara aktuell tid och bildruta i bufferten
        current_time = time.time()
        frame_buffer.append((current_time, frame))
        latest_frame = frame
        
        # Låt andra asynkrona uppgifter köra
        await asyncio.sleep(0.001)

async def video_feed(request):
    """HTTP GET: Returnerar en MJPEG-ström till React-appen."""
    response = web.StreamResponse(
        status=200,
        reason='OK',
        headers={
            'Content-Type': 'multipart/x-mixed-replace;boundary=frame',
            'Access-Control-Allow-Origin': '*' # CORS-header så React kan läsa strömmen
        }
    )
    await response.prepare(request)

    try:
        while True:
            if latest_frame is not None:
                # Skala ner för webbläsaren för att spara bandbredd
                height, width = latest_frame.shape[:2]
                new_width = 1280
                new_height = int((new_width / width) * height)
                resized = cv2.resize(latest_frame, (new_width, new_height))
                
                # Komprimera till JPEG (kvalitet 70)
                ret, buffer = cv2.imencode('.jpg', resized, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
                if ret:
                    frame_bytes = buffer.tobytes()
                    await response.write(b'--frame\r\n')
                    await response.write(b'Content-Type: image/jpeg\r\n\r\n')
                    await response.write(frame_bytes)
                    await response.write(b'\r\n')
            
            # Begränsa MJPEG-strömmen till ca 30 FPS
            await asyncio.sleep(1/30.0)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"Strömavbrott: {e}")
        
    return response

async def websocket_handler(request):
    """WS: Hanterar inkommande WebSocket-anslutningar från React-appen."""
    ws = web.WebSocketResponse(headers={'Access-Control-Allow-Origin': '*'})
    await ws.prepare(request)
    print("React-appen anslöt till bryggan via WebSocket!")

    async for msg in ws:
        if msg.type == web.WSMsgType.TEXT:
            data = json.loads(msg.data)
            
            if data.get("action") == "save_snapshot":
                description = data.get("description", "Ingen beskrivning")
                offset = data.get("timestamp_offset", 0)
                
                print(f"Gemini begärde snapshot! Beskrivning: {description}, Offset: {offset}s")
                await save_snapshot(description, offset)
                
                # Skicka bekräftelse tillbaka till React-appen
                await ws.send_json({"status": "success", "message": "Snapshot sparad"})
                
        elif msg.type == web.WSMsgType.ERROR:
            print(f"WebSocket stängdes med fel: {ws.exception()}")

    print("React-appen kopplade från WebSocket.")
    return ws

async def save_snapshot(description, offset):
    """Hittar rätt originalbildruta i bufferten och sparar den i full kvalitet."""
    if not frame_buffer:
        print("Bufferten är tom, kan inte spara bild.")
        return
        
    target_time = time.time() - offset
    
    closest_frame = None
    min_diff = float('inf')
    
    for timestamp, frame in frame_buffer:
        diff = abs(timestamp - target_time)
        if diff < min_diff:
            min_diff = diff
            closest_frame = frame
            
    if closest_frame is not None:
        # Skapa ett unikt filnamn
        filename = f"snapshot_{int(time.time())}.jpg"
        
        # Spara lokalt i full kvalitet
        cv2.imwrite(filename, closest_frame)
        print(f"✅ Bild sparad som {filename} (Träffsäkerhet: {min_diff:.2f}s diff)")
        # TODO: Implementera Google Drive uppladdning här

async def init_app():
    app = web.Application()
    app.router.add_get('/video_feed', video_feed)
    app.router.add_get('/ws', websocket_handler)
    
    # Starta video-inhämtning i bakgrunden
    asyncio.create_task(capture_video())
    return app

if __name__ == "__main__":
    print("Startar aiohttp-server på http://localhost:8089...")
    web.run_app(init_app(), port=8089)
