import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** One shared Socket.IO connection to the same origin (Vite proxies it in dev). */
export function getSocket(): Socket {
  if (!socket) socket = io({ transports: ['websocket', 'polling'] });
  return socket;
}

/** emit with an ack, as a promise. */
export function request<T>(event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    getSocket()
      .timeout(8000)
      .emit(event, payload, (err: Error | null, res: { ok: true; data: T } | { ok: false; error: string }) => {
        if (err) return reject(new Error('The server did not answer. Check your connection.'));
        if (res.ok) resolve(res.data);
        else reject(new Error(res.error));
      });
  });
}
