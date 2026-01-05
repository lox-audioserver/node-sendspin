import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';

import { ConnectionReason, type RoleName } from '../types.js';
import { SendspinSession, type SendspinSessionHooks, type SendspinPcmFrame, type SendspinConnectionMeta, type PlayerFormat } from './session.js';

/**
 * Core Sendspin session manager: tracks WebSocket sessions and routes server-driven messages.
 */
export class SendspinCore {
  private readonly sessionsBySocket = new Map<WebSocket, SendspinSession>();
  private readonly hooksByClientId = new Map<
    string,
    { hooks: SendspinSessionHooks; context?: SendspinConnectionMeta & { reason?: 'cast-tunnel' } }
  >();

  handleConnection(
    ws: WebSocket,
    req?: IncomingMessage | null,
    connectionReason: ConnectionReason | 'cast-tunnel' = ConnectionReason.DISCOVERY,
  ): void {
    const session = new SendspinSession(ws, req ?? null, connectionReason, {
      remote: req?.socket?.remoteAddress ?? null,
    });
    this.sessionsBySocket.set(ws, session);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        session.handleBinary(data);
      } else {
        session.handleText(data.toString());
        const info = session.getClientId();
        if (info && !session.hasHooksAttached()) {
          const entry = this.hooksByClientId.get(info);
          if (entry) {
            session.setHooks(entry.hooks, entry.context);
          }
        }
      }
    });

    ws.on('close', () => {
      this.sessionsBySocket.delete(ws);
      session.destroy();
    });

    ws.on('error', () => {
      // Ignore; close will clean up.
    });
  }

  registerHooks(
    clientId: string,
    hooks: SendspinSessionHooks,
    context?: SendspinConnectionMeta & { reason?: 'cast-tunnel' },
  ): void {
    this.hooksByClientId.set(clientId, { hooks, context });
    const session = this.getSession(clientId);
    if (session) {
      session.setHooks(hooks, context);
    }
  }

  unregisterHooks(clientId: string): void {
    this.hooksByClientId.delete(clientId);
    const session = this.getSession(clientId);
    if (session) {
      session.setHooks({});
    }
  }

  listClients(): Array<{ clientId: string | null; roles: RoleName[]; remote: string | null }> {
    const items: Array<{ clientId: string | null; roles: RoleName[]; remote: string | null }> = [];
    for (const session of this.sessionsBySocket.values()) {
      items.push({
        clientId: session.getClientId(),
        roles: session.getRoles(),
        remote: null,
      });
    }
    return items;
  }

  listDescriptors(): Array<{
    clientId: string | null;
    roles: RoleName[];
    playbackState: 'playing' | 'paused' | 'stopped';
    remote: string | null;
  }> {
    const items: Array<{
      clientId: string | null;
      roles: RoleName[];
      playbackState: 'playing' | 'paused' | 'stopped';
      remote: string | null;
    }> = [];
    for (const session of this.sessionsBySocket.values()) {
      items.push(session.getDescriptor());
    }
    return items;
  }

  getSessionBySocket(ws: WebSocket): SendspinSession | undefined {
    return this.sessionsBySocket.get(ws);
  }

  getSessions(): Iterable<SendspinSession> {
    return this.sessionsBySocket.values();
  }

  sendPcmFrameToClient(clientId: string, frame: SendspinPcmFrame): void {
    this.getSession(clientId)?.sendPcmAudioFrame(frame);
  }

  sendStreamStart(clientId: string, format?: Partial<PlayerFormat>): void {
    this.getSession(clientId)?.sendStreamStart(format);
  }

  sendStreamClear(clientId: string, roles?: RoleName[]): void {
    this.getSession(clientId)?.sendStreamClear(roles);
  }

  sendStreamEnd(clientId: string, roles?: RoleName[]): void {
    this.getSession(clientId)?.sendStreamEnd(roles);
  }

  sendGroupUpdate(
    clientId: string,
    playbackState: 'playing' | 'paused' | 'stopped',
    groupId?: string,
    groupName?: string,
  ): void {
    this.getSession(clientId)?.sendGroupUpdate(playbackState, groupId, groupName);
  }

  sendMetadata(clientId: string, payload: Parameters<SendspinSession['sendMetadata']>[0]): void {
    this.getSession(clientId)?.sendMetadata(payload);
  }

  sendServerCommand(clientId: string, payload: Parameters<SendspinSession['sendServerCommand']>[0]): void {
    this.getSession(clientId)?.sendServerCommand(payload);
  }

  sendArtworkStreamStart(clientId: string, channels: Parameters<SendspinSession['sendArtworkStreamStart']>[0]): void {
    this.getSession(clientId)?.sendArtworkStreamStart(channels);
  }

  sendArtwork(clientId: string, channel: 0 | 1 | 2 | 3, imageData: Buffer | null): void {
    this.getSession(clientId)?.sendArtwork(channel, imageData);
  }

  sendVisualizerStreamStart(clientId: string, config?: Record<string, any>): void {
    this.getSession(clientId)?.sendVisualizerStreamStart(config);
  }

  sendVisualizerFrame(clientId: string, data: Buffer, timestampUs?: number): void {
    this.getSession(clientId)?.sendVisualizerFrame(data, timestampUs);
  }

  sendControllerState(clientId: string, payload: Parameters<SendspinSession['sendControllerState']>[0]): void {
    this.getSession(clientId)?.sendControllerState(payload);
  }

  getSessionByClientId(clientId: string): SendspinSession | undefined {
    return this.getSession(clientId);
  }

  getStreamFormat(clientId: string): ReturnType<SendspinSession['getStreamFormat']> | null {
    return this.getSession(clientId)?.getStreamFormat() ?? null;
  }

  getPlayerBufferCapacity(clientId: string): number | null {
    const cap = this.getSession(clientId)?.getPlayerBufferCapacity() ?? 0;
    return cap > 0 ? cap : null;
  }

  getArtworkChannels(
    clientId: string,
  ): ReturnType<SendspinSession['getArtworkChannels']> | null {
    return this.getSession(clientId)?.getArtworkChannels() ?? null;
  }

  getBackpressureStats(clientId: string): ReturnType<SendspinSession['getBackpressureStats']> | null {
    return this.getSession(clientId)?.getBackpressureStats() ?? null;
  }

  private getSession(clientId: string): SendspinSession | undefined {
    for (const session of this.sessionsBySocket.values()) {
      if (session.getClientId() === clientId) return session;
    }
    return undefined;
  }
}
