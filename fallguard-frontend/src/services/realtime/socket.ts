import { env } from '../../config/env';

type Handler = (payload: unknown) => void;

/**
 * Minimal WebSocket client with topic subscriptions and reconnect backoff.
 * Message shape { topic, payload } is a placeholder. [TEAM CONFIRMATION REQUIRED]
 */
class RealtimeClient {
  private ws?: WebSocket;
  private handlers = new Map<string, Set<Handler>>();
  private retry = 0;

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.ws = new WebSocket(env.wsUrl);
    this.ws.onopen = () => (this.retry = 0);
    this.ws.onmessage = (e) => {
      try {
        const { topic, payload } = JSON.parse(e.data);
        this.handlers.get(topic)?.forEach((h) => h(payload));
      } catch {
        /* ignore malformed messages */
      }
    };
    this.ws.onclose = () => {
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  subscribe(topic: string, handler: Handler) {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic)!.add(handler);
    return () => this.handlers.get(topic)?.delete(handler);
  }
}

export const realtime = new RealtimeClient();
