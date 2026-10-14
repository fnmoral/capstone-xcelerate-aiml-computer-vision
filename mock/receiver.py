import socket
import struct
import threading
import cv2
import av
import numpy as np

HOST = '127.0.0.1'
PORT = 9999

# Safe dictionary to store the latest decoded frame of each camera
# Structure: { camera_id: frame_bgr }
active_frames = {}
frames_lock = threading.Lock()

def handle_client(conn, addr):
    """Function running in an independent thread for each connected camera"""
    print(f"New connection established from Go: {addr}")
    camera_id = "Unknown"

    try:
        # 1. READ HANDSHAKE (Camera Identity)
        id_header = conn.recv(4)
        if not id_header or len(id_header) < 4:
            print("Connection closed before receiving the handshake.")
            return
        
        id_len = struct.unpack(">I", id_header)[0]
        camera_id_bytes = bytearray()
        while len(camera_id_bytes) < id_len:
            packet = conn.recv(id_len - len(camera_id_bytes))
            if not packet:
                break
            camera_id_bytes.extend(packet)
            
        camera_id = bytes(camera_id_bytes).decode('utf-8')
        print(f"Handshake received. Active camera: [{camera_id}]")

        # Create an independent H.264 decoder for this camera
        codec = av.CodecContext.create('h264', 'r')
        nalu_count = 0

        while True:
            # 2. Read NALU size (4 bytes BigEndian)
            header = conn.recv(4)
            if not header or len(header) < 4:
                print(f"Connection closed for camera [{camera_id}].")
                break
            
            payload_size = struct.unpack(">I", header)[0]
            
            # 3. Read complete data according to specified size
            data = bytearray()
            while len(data) < payload_size:
                packet = conn.recv(payload_size - len(data))
                if not packet:
                    break
                data.extend(packet)

            if len(data) < payload_size:
                break

            nalu_count += 1
            raw_data = bytes(data)

            # Insert H.264 start delimiter if not present
            if raw_data.startswith(b'\x00\x00\x00\x01') or raw_data.startswith(b'\x00\x00\x01'):
                nalu = raw_data
            else:
                nalu = b'\x00\x00\x00\x01' + raw_data

            # 4. Decode H.264 packet
            try:
                packets = codec.parse(nalu)
                for pkt in packets:
                    frames = codec.decode(pkt)
                    for frame in frames:
                        img = frame.to_ndarray(format='bgr24')
                        
                        # Update frame safely for the main thread
                        with frames_lock:
                            active_frames[camera_id] = img
                            
            except Exception as e:
                print(f"[{camera_id}] Error decoding NALU #{nalu_count}: {e}")
                continue

    except Exception as e:
        print(f"Error in connection with [{camera_id}]: {e}")
    finally:
        conn.close()
        # Remove camera from dictionary on disconnect
        with frames_lock:
            if camera_id in active_frames:
                del active_frames[camera_id]
        print(f"Thread finished for camera [{camera_id}].")

def create_grid(frames_dict):
    """Organizes active cameras into a dynamic grid within a single window"""
    if not frames_dict:
        # Waiting screen if there are no active connections
        blank = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.putText(blank, "Waiting for camera connections...", (60, 240), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 200, 200), 2, cv2.LINE_AA)
        return blank

    # Define standard size for each video thumbnail in the grid
    target_w, target_h = 640, 360
    processed_frames = []
    
    for cam_id, img in frames_dict.items():
        resized = cv2.resize(img, (target_w, target_h))
        # Overlay label with camera ID in top-left corner
        cv2.putText(resized, f"Camera: {cam_id}", (15, 30), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2, cv2.LINE_AA)
        processed_frames.append(resized)

    n = len(processed_frames)
    
    if n == 1:
        return processed_frames[0]
    elif n == 2:
        # 2 cameras side by side
        return np.hstack(processed_frames)
    elif n <= 4:
        # 2x2 grid (pad with black frames if missing)
        while len(processed_frames) < 4:
            processed_frames.append(np.zeros((target_h, target_w, 3), dtype=np.uint8))
        top = np.hstack(processed_frames[:2])
        bottom = np.hstack(processed_frames[2:])
        return np.vstack((top, bottom))
    else:
        # More than 4 cameras: dynamic 3-column grid
        cols = 3
        rows = (n + cols - 1) // cols
        while len(processed_frames) < rows * cols:
            processed_frames.append(np.zeros((target_h, target_w, 3), dtype=np.uint8))
        
        row_images = []
        for r in range(rows):
            row_imgs = processed_frames[r * cols : (r + 1) * cols]
            row_images.append(np.hstack(row_imgs))
        return np.vstack(row_images)

def start_receiver():
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_socket.bind((HOST, PORT))
    server_socket.listen(5)
    
    print(f"Python server listening for multiple cameras on {HOST}:{PORT}...")

    # Secondary thread to accept incoming connections from Go without blocking the main video thread
    def accept_connections():
        while True:
            try:
                conn, addr = server_socket.accept()
                client_thread = threading.Thread(target=handle_client, args=(conn, addr))
                client_thread.daemon = True
                client_thread.start()
            except:
                break

    listener_thread = threading.Thread(target=accept_connections, daemon=True)
    listener_thread.start()

    # Main rendering loop (Executed exclusively in the main thread for OpenCV safety)
    try:
        while True:
            with frames_lock:
                current_frames = dict(active_frames)
            
            grid_img = create_grid(current_frames)
            cv2.imshow("Multi-Camera Dashboard", grid_img)
            
            # Press 'q' to exit the application
            if cv2.waitKey(30) & 0xFF == ord('q'):
                print("\nExiting by user command...")
                break
    except KeyboardInterrupt:
        print("\nServer manually stopped.")
    finally:
        server_socket.close()
        cv2.destroyAllWindows()
        print("Server closed properly.")

if __name__ == "__main__":
    start_receiver()