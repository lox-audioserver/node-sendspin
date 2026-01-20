import type { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import WebSocket from 'ws';

import {
  ConnectionReason,
  PlaybackStateType,
  ServerCommandPayload,
  SourceSignalType,
  SourceStateType,
  type RoleName,
} from '../types.js';
import { SendspinSession, type SendspinSessionHooks, type SendspinPcmFrame, type SendspinConnectionMeta, type PlayerFormat } from './session.js';

/**
 * Core Sendspin session manager: tracks WebSocket sessions and routes server-driven messages.
 */
export class SendspinCore {
  private readonly sessionsBySocket = new Map<WebSocket, SendspinSession>();
  private readonly hooksByClientId = new Map<
    string,
    { hooks: SendspinSessionHooks; context?: SendspinConnectionMeta }
  >();
  private readonly leadStatsByClientId = new Map<
    string,
    { leadUs: number; targetLeadUs: number; bufferedBytes?: number; updatedAt: number }
  >();

  handleConnection(
    ws: WebSocket,
    req?: IncomingMessage | null,
    connectionReason: ConnectionReason = ConnectionReason.DISCOVERY,
  ): void {
    const meta = this.extractConnectionMetadata(req);
    const session = new SendspinSession(ws, req ?? null, connectionReason, {
      zoneId: meta.zoneId,
      playerId: meta.playerId,
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
    context?: SendspinConnectionMeta,
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

  listClients(): Array<{
    clientId: string | null;
    name: string | null;
    roles: RoleName[];
    playbackState: PlaybackStateType;
    remote: string | null;
    sourceState: SourceStateType | null;
    sourceSignal: SourceSignalType | null;
  }> {
    const items: Array<{
      clientId: string | null;
      name: string | null;
      roles: RoleName[];
      playbackState: PlaybackStateType;
      remote: string | null;
      sourceState: SourceStateType | null;
      sourceSignal: SourceSignalType | null;
    }> = [];
    for (const session of this.sessionsBySocket.values()) {
      const sourceStatus = session.getSourceStatus();
      items.push({
        clientId: session.getClientId(),
        name: session.getClientName(),
        roles: session.getRoles(),
        remote: session.getRemoteAddress(),
        playbackState: session.getDescriptor().playbackState,
        sourceState: sourceStatus.state ?? null,
        sourceSignal: sourceStatus.signal ?? null,
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
    playbackState: PlaybackStateType,
    groupId?: string,
    groupName?: string,
  ): void {
    this.getSession(clientId)?.sendGroupUpdate(playbackState, groupId, groupName);
  }

  sendMetadata(clientId: string, payload: Parameters<SendspinSession['sendMetadata']>[0]): void {
    this.getSession(clientId)?.sendMetadata(payload);
  }

  setClientMetadata(clientId: string, payload: Parameters<SendspinSession['sendMetadata']>[0]): void {
    this.sendMetadata(clientId, payload);
  }

  sendServerCommand(
    clientId: string,
    payload: Parameters<SendspinSession['sendServerCommand']>[0] | ServerCommandPayload,
  ): void {
    this.getSession(clientId)?.sendServerCommand(payload as ServerCommandPayload);
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

  setClientControllerState(clientId: string, payload: Parameters<SendspinSession['sendControllerState']>[0]): void {
    this.sendControllerState(clientId, payload);
  }

  setClientPlaybackState(
    clientId: string,
    playbackState: PlaybackStateType,
    groupId?: string,
    groupName?: string,
  ): void {
    this.sendGroupUpdate(clientId, playbackState, groupId, groupName);
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

  setLeadStats(
    clientId: string,
    stats: { leadUs: number; targetLeadUs: number; bufferedBytes?: number },
  ): void {
    if (!clientId) return;
    this.leadStatsByClientId.set(clientId, {
      leadUs: stats.leadUs,
      targetLeadUs: stats.targetLeadUs,
      bufferedBytes: stats.bufferedBytes,
      updatedAt: Date.now(),
    });
  }

  clearLeadStats(clientId: string): void {
    if (!clientId) return;
    this.leadStatsByClientId.delete(clientId);
  }

  getLeadStats(
    clientId: string,
  ): { leadUs: number; targetLeadUs: number; bufferedBytes?: number; updatedAt: number } | null {
    return this.leadStatsByClientId.get(clientId) ?? null;
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
    let preferred: SendspinSession | undefined;
    let fallback: SendspinSession | undefined;
    for (const session of this.sessionsBySocket.values()) {
      if (session.getClientId() === clientId) {
        if (session.getConnectionReason() === ConnectionReason.PLAYBACK && !preferred) {
          preferred = session;
        } else if (!fallback) {
          fallback = session;
        }
      }
    }
    return preferred ?? fallback;
  }

  private extractConnectionMetadata(
    req?: IncomingMessage | null,
  ): {
    zoneId?: number;
    playerId?: string;
  } {
    if (!req?.url) {
      return {};
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const zoneStr = url.searchParams.get('zone');
      const zoneId = zoneStr && Number.isFinite(Number(zoneStr)) ? Number(zoneStr) : undefined;
      const playerId = url.searchParams.get('player') ?? undefined;
      return { zoneId, playerId };
    } catch {
      return {};
    }
  }
}
