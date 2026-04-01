import asyncio
import cv2
import time
import json
import websockets
from collections import deque

# Konfiguration
VLC_STREAM_URL = "http://localhost:8080/stream" # Byt ut mot din VLC-ström
BUFFER_SECONDS = 5
FPS = 30 # Antagen bilduppdateringsfrekvens från VLC
MAX_FRAMES = BUFFER_SECONDS * FPS

# Rullande buffert för att spara de senaste 5 sekunderna
# Lagrar tupler: (timestamp, frame)
frame_buffer = deque(maxlen=MAX_FRAMES)

async def capture_video():
    """Bakgrundsprocess som läser från VLC och uppdaterar RAM-bufferten."""
    print(f"Ansluter till VLC-ström på {VLC_STREAM_URL}...")
    cap = cv2.VideoCapture(VLC_STREAM_URL)
    
    if not cap.isOpened():
        print("Kunde inte ansluta till videoströmmen. Kontrollera att VLC körs.")
        return

    while True:
        ret, frame = cap.read()
        if not ret:
            print("Tappade anslutningen till strömmen, försöker igen...")
            await asyncio.sleep(1)
            cap = cv2.VideoCapture(VLC_STREAM_URL)
            continue
            
        # Spara aktuell tid och bildruta i bufferten
        current_time = time.time()
        frame_buffer.append((current_time, frame))
        
        # Låt andra asynkrona uppgifter köra
        await asyncio.sleep(0.001)

async def handle_client(websocket):
    """Hanterar inkommande WebSocket-anslutningar från React-appen."""
    print("React-appen anslöt till bryggan!")
    try:
        async for message in websocket:
            data = json.loads(message)
            
            if data.get("action") == "save_snapshot":
                description = data.get("description", "Ingen beskrivning")
                offset = data.get("timestamp_offset", 0)
                
                print(f"Gemini begärde snapshot! Beskrivning: {description}, Offset: {offset}s")
                await save_snapshot(description, offset)
                
                # Skicka bekräftelse tillbaka till React-appen
                await websocket.send(json.dumps({"status": "success", "message": "Snapshot sparad"}))
                
    except websockets.exceptions.ConnectionClosed:
        print("React-appen kopplade från.")

async def save_snapshot(description, offset):
    """Hittar rätt bildruta i bufferten och sparar den."""
    if not frame_buffer:
        print("Bufferten är tom, kan inte spara bild.")
        return
        
    target_time = time.time() - offset
    
    # Hitta den bildruta som är närmast target_time
    # (I en produktionsmiljö kan vi optimera detta med binärsökning)
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
        
        # Spara lokalt (Här lägger vi senare till Google Drive API-uppladdning)
        cv2.imwrite(filename, closest_frame)
        print(f"✅ Bild sparad som {filename} (Träffsäkerhet: {min_diff:.2f}s diff)")
        
        # TODO: Implementera Google Drive uppladdning här
        # upload_to_drive(filename, description)

async def main():
    # Starta video-inhämtning i bakgrunden
    asyncio.create_task(capture_video())
    
    # Starta WebSocket-server på port 8765
    print("Startar WebSocket-server på ws://localhost:8765...")
    async with websockets.serve(handle_client, "localhost", 8765):
        await asyncio.Future()  # Kör för evigt

if __name__ == "__main__":
    asyncio.run(main())
