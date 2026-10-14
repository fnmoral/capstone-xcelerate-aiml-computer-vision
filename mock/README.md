# Multi-Camera Video Receiver

A Python server that receives, decodes (H.264), and displays multiple video streams simultaneously in a single dynamic grid window using OpenCV and PyAV.

## Prerequisites

- **Python Version:** 3.12.10

---

## Setup Instructions

### 1. Create a Virtual Environment
Open your terminal in the project directory and run the following command to create a virtual environment named `venv`:

```bash
python -m venv venv
```

### 2. Activate the Virtual Environment
Depending on your operating system, activate the virtual environment using the corresponding command:

Windows (Command Prompt):

    venv\Scripts\activate.bat

Windows (PowerShell):

    .\venv\Scripts\Activate.ps1

Linux / macOS:

    source venv/bin/activate

### 3. Install Dependencies
Ensure your requirements.txt file is in the same directory, then install the required packages:

    pip install -r requirements.txt

(Note: Essential packages include opencv-python, av, and numpy).

### 4. Run the Script
Once the environment is active and dependencies are installed, run the server:

    python receiver.py

Press q inside the video window or use Ctrl + C in the terminal to stop the server.