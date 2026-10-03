# Capstone Xcelerate — AI/ML Computer Vision Platform

A multi-tenant, real-time computer vision platform that ingests video through a 
gateway, processes it with GPU-accelerated AI modules, and lets users query 
video content through a natural-language prompt interface.

---

## Architecture Overview

```mermaid
flowchart TD
    CAM[Camera] --> GW[Video Gateway]
    GW --> RTSP[RTSP Connection]
    RTSP --> M3[Module 3<br/>Streaming & Keyframe Extraction]
    M3 --> HLS[HLS / WebRTC]
    M3 --> MB[Message Broker]

    USER[User] --> M1[Module 1<br/>Front-end Prompt Input]
    M1 --> API[WebSocket / REST]
    API --> M2[Module 2<br/>Core Back-end<br/>Multi-tenant Auth & Orchestration]

    MB <--> M2
    M2 --> AI[AI Processing]
    M2 --> CACHE[(Cache & State)]
    M2 --> DB1[(DB1<br/>Users, Tenants, Configs)]
    M2 --> DB2[(DB2<br/>Logs, Alerts, Events)]

    subgraph AIBOX [AI Processing]
        M4[Module 4<br/>GPU Workers / Vision AI] --> M5[Module 5<br/>Vector Engine]
    end

    M4 --> OBJ[(Object Storage)]
    M5 --> VDB[(Vector DB)]
    M5 --> DB2

