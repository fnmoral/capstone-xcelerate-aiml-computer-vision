# Getting started: run FallGuard on your computer

From a fresh computer to the app running in your browser. Follow the steps in order.
Each step has a **Windows** and a **Mac** version where they differ.

When you are done you will have:

| What | Address | What it is for |
|---|---|---|
| **FallGuard app** | http://localhost:3000 | The main app: live view, fall events, analytics, cameras, settings |
| **Gateway** | http://localhost:8080 | Camera connections (add / pause / remove cameras) |
| **Detector viewer** | http://localhost:8000 | Raw video from the AI detector with boxes and labels (for debugging) |

> The first start takes **10–20 minutes** (it downloads and builds everything).
> After that it starts in under a minute.

---

## Step 1. Install Git and Docker Desktop (one time)

### Windows

1. Open **PowerShell** (Start menu → type `PowerShell`) and run:
   ```powershell
   winget install Git.Git Docker.DockerDesktop
   ```
   Accept the prompts. If it asks to enable WSL, say yes.
2. **Restart your computer.**
3. Open **Docker Desktop** from the Start menu. Accept the terms, skip sign-in.
   Wait until the bottom-left corner says **Engine running**.

### Mac

1. Install Git: open **Terminal** (Cmd + Space → type `Terminal`) and run:
   ```bash
   xcode-select --install
   ```
   Click **Install** in the window that pops up. (If it says it is already installed, you're fine.)
2. Download **Docker Desktop** from https://www.docker.com/products/docker-desktop/.
   Choose **Apple Silicon** (M1/M2/M3/M4) or **Intel**: check under  → About This Mac.
3. Open the `.dmg`, drag Docker to Applications, and open it. Accept the terms, skip sign-in.
4. In Docker Desktop → **Settings → Resources**, set **Memory to at least 8 GB**, then
   **Apply & restart**.

**Check it worked** (PowerShell or Terminal):
```
git --version
docker --version
```
Both should print a version number.

---

## Step 2. Download the project (one time)

Put it in a normal folder, **not** inside OneDrive, iCloud or Dropbox (they lock files
while Docker is building).

### Windows (PowerShell)
```powershell
cd $HOME
git clone https://github.com/fnmoral/capstone-xcelerate-aiml-computer-vision.git
cd capstone-xcelerate-aiml-computer-vision
git checkout US_ml_module
```

### Mac (Terminal)
```bash
cd ~
git clone https://github.com/fnmoral/capstone-xcelerate-aiml-computer-vision.git
cd capstone-xcelerate-aiml-computer-vision
git checkout US_ml_module
```

> `US_ml_module` is the branch with the working platform. Skip `git checkout` once it is
> merged into `main`.

If GitHub asks you to sign in, sign in with your GitHub account (you need access to the repo).

---

## Step 3. Create the settings files (one time)

The database passwords live in two files that are never uploaded to GitHub. Copy the
examples:

### Windows (PowerShell)
```powershell
Copy-Item backend-module\.env.example backend-module\.env
Copy-Item ml-service\deploy\.env.example ml-service\deploy\.env
```

### Mac (Terminal)
```bash
cp backend-module/.env.example backend-module/.env
cp ml-service/deploy/.env.example ml-service/deploy/.env
```

**Set the passwords.** The examples (`change-me`) work, but it's better to pick your own.
Open the two files in any text editor (VS Code, Notepad, TextEdit) and change these lines:

`backend-module/.env`:
```
# the database admin password
POSTGRES_PASSWORD=Admin2026pass
# the AI detector's database password
ML_SERVICE_PASSWORD=Detector2026pass
```

`ml-service/deploy/.env`, the **same** detector password goes between `ml_service:` and `@db`:
```
ML_DATABASE_URL=postgresql://ml_service:Detector2026pass@db:5432/fallguard
```

Rules:
- Use **letters and digits only** (no `@ : / # ?` or spaces; they break the address).
- `ML_SERVICE_PASSWORD` and the password in `ML_DATABASE_URL` **must match**, or the detector
  can't save falls to the database.
- Set them **before** the first start (step 4). The database saves the passwords the first
  time it starts; to change them later you have to wipe it (`docker compose down -v`).
- Never upload or share the `.env` files. Git already ignores them; don't paste them in chat.
  Each teammate picks their own passwords for their own computer.

**Demo data or a clean start?** `SEED_DEMO_DATA=true` (in `backend-module/.env`) fills the
app with 3 sample cameras and 4 sample falls, handy to look around. Set it to `false` for an
empty system where you add your own cameras. Like the passwords, it only counts on the very
first start; to change it later, wipe the data with `docker compose down -v`.

---

## Step 4. Start everything

Make sure Docker Desktop is open, then in the project folder run **one** of these:

**Windows PC with an NVIDIA graphics card** (fastest):
```
docker compose up -d --build
```

**Mac, or any computer without an NVIDIA card** (the AI runs on the processor instead):
```
docker compose -f docker-compose.yml -f docker-compose.cpu.yml up -d --build
```

> Not sure if you have NVIDIA? Windows: Task Manager → Performance → GPU. If it doesn't
> say NVIDIA, use the second command.

Wait until it finishes (10–20 minutes the first time). Then check:
```
docker compose ps
```
You should see about 7 services, all **Up** (`db`, `stream-hub` and `api` also say **healthy**).

---

## Step 5. Open the app

Open these in your browser:

1. **FallGuard app**: http://localhost:3000
   Go to **Settings**: every service should say **Running**.
   You will see some demo cameras and sample fall events already.
2. **Gateway**: http://localhost:8080
3. **Detector viewer**: http://localhost:8000 (shows video once a camera is added; step 6)

---

## Step 6. Test with your webcam (optional)

This sends your laptop's webcam into the system like a real security camera.

**a. Start the test camera server:**
```
docker compose --profile test-camera up -d test-camera
```

**b. Install Python** (one time), any version 3.10 or newer:
- Windows: `winget install Python.Python.3.13`, then **close and reopen PowerShell**.
- Mac: download from https://www.python.org/downloads/ and run the installer.

**c. Set up the webcam tool** (one time), in the project folder:

Windows (PowerShell):
```powershell
python -m venv .venv
.venv\Scripts\pip install opencv-python av
```
Mac (Terminal):
```bash
python3 -m venv .venv
.venv/bin/pip install opencv-python av
```

**d. Start sending your webcam** (leave this window open; **Ctrl + C** stops it):

Windows:
```powershell
.venv\Scripts\python ml-service\tools\publish_webcam.py
```
Mac:
```bash
.venv/bin/python ml-service/tools/publish_webcam.py
```
On a Mac, allow **Terminal** to use the camera if asked (or System Settings → Privacy &
Security → Camera → turn on Terminal, then run it again).

**e. Add it as a camera:** in the FallGuard app (http://localhost:3000) → **Cameras** →
**Add camera**:
- Name: `My webcam`
- RTSP URL: `rtsp://test-camera:8554/webcam`
- Leave username and password empty.

**f. Watch it work:** open **Live View**. In a few seconds you see yourself with a box and a
label (**upright**). Lie down in view for about 3 seconds: a fall appears under
**Fall Events** with a photo, and the top bar shows **1 person down**.

---

## Everyday commands

Run these in the project folder.

| I want to... | Command |
|---|---|
| Stop everything (keeps the data) | `docker compose stop` |
| Start again (NVIDIA) | `docker compose up -d` |
| Start again (Mac / no NVIDIA) | `docker compose -f docker-compose.yml -f docker-compose.cpu.yml up -d` |
| Get the latest code | `git pull`, then the start command **with `--build`** at the end |
| See what a service is doing | `docker compose logs -f api` (or `ml-service`, `gateway-back`, ...) |
| Wipe all data and start fresh | `docker compose down -v`, then the start command |

---

## Something went wrong?

| Problem | Fix |
|---|---|
| `docker: command not found` or `cannot connect to the Docker daemon` | Open Docker Desktop and wait for **Engine running** |
| `could not select device driver "nvidia"` | Your computer has no NVIDIA card set up: use the Mac / no NVIDIA command |
| `port is already allocated` | Another program uses that port (often 3000, 5432 or 8080). Close it, or stop other Docker projects |
| `set ML_DATABASE_URL in .env` | Step 3 was skipped: create the two `.env` files |
| Settings page shows a service **not running** | `docker compose logs <service name>` and send the last lines to the team |
| Changed the passwords after the first start and the app can't reach the database | `docker compose down -v` and start again (this wipes the demo data) |
| Webcam tool says it can't open the camera | Close other apps using the camera (Zoom, Teams). Try `--index 1` at the end of the command |
| Labels lag or the video is choppy on a Mac / no-NVIDIA computer | Normal: the processor is slower than a graphics card, so fewer frames are checked per second. Falls are still detected |

More detail (how the parts connect, Linux servers, WSL without Docker Desktop):
[DOCKER.md](DOCKER.md).
