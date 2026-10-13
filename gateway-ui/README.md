# Gateway UI

Web interface for managing and monitoring IP cameras over RTSP. Built with **React + Vite** and styled with **Tailwind CSS**.

## Prerequisites

Before you begin, make sure you have installed:

- **Node.js** `>= 20.x` — [Download](https://nodejs.org/)
- **pnpm** `>= 10.x` — Install with:
  ```bash
  npm install -g pnpm

## Getting Started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start the development server

```bash
pnpm dev
```

The server will start by default at [http://localhost:5173](http://localhost:5173) with **Hot Module Replacement (HMR)** enabled.

## Available Scripts

```bash
# Start the development server with HMR
pnpm dev

# Generate the production build in the dist/ folder
pnpm build

# Serve the production build locally for verification
pnpm preview

# Run ESLint over the source code
pnpm lint
```