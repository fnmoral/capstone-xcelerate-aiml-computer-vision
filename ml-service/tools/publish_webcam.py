"""Publish this PC's webcam as an RTSP camera, so it goes through the real pipeline
(gateway-back -> stream-hub -> ml-service) like an IP camera.

Needs an RTSP server that accepts publishing, e.g. the test-camera service:
    docker compose --profile test-camera up -d test-camera
Then:
    python tools/publish_webcam.py                    # webcam 0 -> rtsp://localhost:8554/webcam
    python tools/publish_webcam.py --index 1 --show   # second webcam, with a local preview
and add rtsp://test-camera:8554/webcam as a camera in gateway-back.
"""

import argparse
import sys
import time

import av
import cv2


def open_webcam(index: int, width: int, height: int, fps: int) -> cv2.VideoCapture:
    backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
    cap = cv2.VideoCapture(index, backend)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, fps)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", type=int, default=0, help="webcam number (0 = first)")
    parser.add_argument("--url", default="rtsp://localhost:8554/webcam", help="RTSP address to publish to")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=int, default=15)
    parser.add_argument("--show", action="store_true", help="show what is being sent (press q to stop)")
    args = parser.parse_args()

    cap = open_webcam(args.index, args.width, args.height, args.fps)
    ok, frame = cap.read()
    if not ok:
        sys.exit(f"cannot read webcam {args.index}")
    height, width = frame.shape[:2]
    width, height = width - width % 2, height - height % 2  # H.264 needs even sizes
    if frame.mean() < 10:
        print(f"warning: webcam {args.index} looks black (privacy shutter closed?); try --index 1")

    try:
        out = av.open(args.url, mode="w", format="rtsp", options={"rtsp_transport": "tcp"})
    except av.FFmpegError as e:
        sys.exit(f"cannot publish to {args.url}: {e}\nIs the test-camera service running?")
    stream = out.add_stream("libx264", rate=args.fps)
    stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
    # Keyframe every 2 s so a receiver that joins late starts decoding quickly.
    stream.options = {"preset": "ultrafast", "tune": "zerolatency", "g": str(args.fps * 2), "bf": "0"}

    print(f"publishing webcam {args.index} ({width}x{height} @ {args.fps} fps) to {args.url}  (Ctrl+C to stop)")
    start = time.monotonic()
    last_pts = -1
    sent = 0
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                print("webcam stopped delivering frames")
                break
            # Timestamps from the wall clock, so a webcam that runs slower than --fps stays in sync.
            pts = max(int((time.monotonic() - start) * args.fps), last_pts + 1)
            last_pts = pts
            vf = av.VideoFrame.from_ndarray(bgr[:height, :width], format="bgr24").reformat(format="yuv420p")
            vf.pts = pts
            out.mux(stream.encode(vf))
            sent += 1
            if sent % (args.fps * 10) == 0:
                print(f"  {sent} frames sent")
            if args.show:
                cv2.imshow("publish_webcam (q to stop)", bgr)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    except KeyboardInterrupt:
        pass
    except av.FFmpegError as e:
        print(f"connection to {args.url} lost: {e}")
    finally:
        try:
            out.mux(stream.encode(None))
            out.close()
        except av.FFmpegError:
            pass
        cap.release()
        cv2.destroyAllWindows()
        print(f"stopped after {sent} frames")


if __name__ == "__main__":
    main()
