import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import type { Response } from 'express';
import type { RealtimeEvent } from '@projecthub/contracts';
import { Ctx } from './context.js';

type Listener = (e: RealtimeEvent & { userId?: string; reviewSessionId?: string }) => void;

/**
 * Fans out pg_notify('ph_events') messages (written by API and worker inside their transactions)
 * to Server-Sent-Event connections of this API instance. Reconnects automatically.
 */
@Injectable()
export class RealtimeHub implements OnModuleDestroy {
  private client: pg.PoolClient | null = null;
  private readonly listeners = new Set<Listener>();
  private closed = false;

  constructor(private readonly ctx: Ctx) {}

  async start(): Promise<void> {
    try {
      this.client = await this.ctx.pool.connect();
      this.client.on('notification', (msg) => {
        if (!msg.payload) return;
        let e: RealtimeEvent;
        try {
          e = JSON.parse(msg.payload) as RealtimeEvent;
        } catch {
          return;
        }
        for (const l of this.listeners) {
          try {
            l(e);
          } catch {
            /* a broken listener must not affect others */
          }
        }
      });
      this.client.on('error', () => this.reconnect());
      await this.client.query('LISTEN ph_events');
    } catch (e) {
      this.ctx.logger.error({ err: e }, 'realtime LISTEN failed, retrying');
      this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    try {
      this.client?.release(true);
    } catch {
      /* already released */
    }
    this.client = null;
    setTimeout(() => void this.start(), 2_000).unref();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.client) {
      try {
        await this.client.query('UNLISTEN ph_events');
      } catch {
        /* ignore */
      }
      this.client.release();
    }
  }
}

/** Starts an SSE response and returns a writer. Sends a heartbeat comment every 25 s to keep proxies open. */
export function openSse(res: Response, onClose: () => void): (event: string, data: unknown) => void {
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const hb = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(hb);
    onClose();
  });
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}
