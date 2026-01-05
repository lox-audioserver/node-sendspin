import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';

import { packBinaryHeaderRaw } from '../binary.js';
import {
  AudioCodec,
  BinaryMessageType,
  ClientCommandMessage,
  ClientInboundMessage,
  ClientGoodbyeMessage,
  ClientStateMessage,
  ClientStateType,
  ClientTimeMessage,
  ConnectionReason,
  ControllerStatePayload,
  GoodbyeReason,
  MediaCommand,
  PlayerCommand,
  RoleName,
  Roles,
  ServerCommandMessage,
  ServerCommandPayload,
  ServerHelloMessage,
  ServerHelloPayload,
  ServerStateMessage,
  ServerStatePayload,
  ServerTimeMessage,
  StreamClearMessage,
  StreamEndMessage,
  StreamRequestFormatMessage,
  StreamRequestFormatPayload,
  StreamStartMessage,
  StreamStartPayload,
  StreamStartPlayer,
} from '../types.js';
import { serverNowUs } from './clock.js';

export type SendspinConnectionMeta = {
  zoneId?: number;
  playerId?: string;
  tunnel?: string | null;
  remote?: string | null;
};

export interface SendspinPcmFrame {
  data: Buffer;
  timestampUs?: number;
}

export interface PlayerFormat {
  codec: AudioCodec;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  codecHeader?: string;
}

export interface SendspinPlayerStateUpdate {
  clientId: string | null;
  roles: RoleName[];
  state?: ClientStateType;
  volume?: number;
  muted?: boolean;
}

export interface SendspinGroupCommand {
  clientId: string | null;
  roles: RoleName[];
  command: MediaCommand;
  volume?: number;
  mute?: boolean;
}

export interface SendspinSessionHooks {
  onPlayerState?: (session: SendspinSession, update: SendspinPlayerStateUpdate) => void;
  onGroupCommand?: (session: SendspinSession, command: SendspinGroupCommand) => void;
  onIdentified?: (session: SendspinSession, req: IncomingMessage | null) => void;
  onDisconnected?: (session: SendspinSession) => void;
  onFormatChanged?: (session: SendspinSession, format: PlayerFormat) => void;
  onGoodbye?: (session: SendspinSession, reason: GoodbyeReason) => void;
  onUnsupportedRoles?: (session: SendspinSession, roles: RoleName[]) => void;
}

/**
 * Per-connection Sendspin session. Handles handshake, time sync, player/controller state,
 * and sending stream/metadata/commands to the client.
 */
export class SendspinSession {
  private ready = false;
  private clientId: string | null = null;
  private roles: RoleName[] = [];
  private playerSupport: any = null;
  private artworkChannels: Array<{
    source: 'album' | 'artist' | 'none';
    format: 'jpeg' | 'png' | 'bmp';
    width: number;
    height: number;
  }> = [];
  private expectVolume = false;
  private expectMute = false;
  private playbackState: 'playing' | 'paused' | 'stopped' = 'stopped';
  private lastStateSignature: string | null = null;

  private hooks: SendspinSessionHooks = {};
  private hooksAttached = false;
  private activeStream = false;
  private streamFormat: PlayerFormat = {
    codec: AudioCodec.PCM,
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
  };
  private lastGoodbyeReason: GoodbyeReason | null = null;

  private readonly maxBufferedSend = 1024 * 512; // ~512KB backpressure guard
  private backpressureDrops = 0;
  private lastBackpressureBytes = 0;
  private lastBackpressureTs = 0;
  private backpressureEvents: number[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly req: IncomingMessage | null,
    private connectionReason: ConnectionReason | 'cast-tunnel' = ConnectionReason.DISCOVERY,
    private readonly connectionMeta: SendspinConnectionMeta = {},
    hooks: SendspinSessionHooks = {},
  ) {
    this.hooks = hooks;
  }

  setHooks(
    hooks: SendspinSessionHooks,
    context?: SendspinConnectionMeta & { reason?: ConnectionReason | 'cast-tunnel' },
  ): void {
    this.hooks = hooks;
    this.hooksAttached = true;
    if (context?.reason) this.connectionReason = context.reason;
    if (context) Object.assign(this.connectionMeta, context);
    if (this.ready && this.hooks.onIdentified) {
      this.hooks.onIdentified(this, this.req);
    }
  }

  hasHooksAttached(): boolean {
    return this.hooksAttached;
  }

  getClientId(): string | null {
    return this.clientId;
  }

  getRoles(): RoleName[] {
    return this.roles;
  }

  getInfo(): { id: string | null; roles: RoleName[]; playbackState: string } {
    return {
      id: this.clientId,
      roles: [...this.roles],
      playbackState: this.playbackState,
    };
  }

  getDescriptor(): {
    clientId: string | null;
    roles: RoleName[];
    playbackState: 'playing' | 'paused' | 'stopped';
    remote: string | null;
  } {
    return {
      clientId: this.clientId,
      roles: [...this.roles],
      playbackState: this.playbackState,
      remote: this.getRemoteAddress(),
    };
  }

  getConnectionReason(): ConnectionReason | 'cast-tunnel' {
    return this.connectionReason;
  }

  getRemoteAddress(): string | null {
    return this.connectionMeta.remote ?? this.req?.socket?.remoteAddress ?? null;
  }

  getStreamFormat(): PlayerFormat {
    return { ...this.streamFormat };
  }

  getBackpressureStats(): { drops: number; lastBytes: number; lastDropTs: number | null; recentDrops: number } {
    const cutoff = Date.now() - 5 * 60 * 1000;
    this.backpressureEvents = this.backpressureEvents.filter((ts) => ts >= cutoff);
    return {
      drops: this.backpressureDrops,
      lastBytes: this.lastBackpressureBytes,
      lastDropTs: this.lastBackpressureTs || null,
      recentDrops: this.backpressureEvents.length,
    };
  }

  getPlayerBufferCapacity(): number {
    const cap = this.playerSupport?.buffer_capacity;
    return typeof cap === 'number' && cap > 0 ? cap : 0;
  }

  getArtworkChannels(): SendspinSession['artworkChannels'] {
    return [...this.artworkChannels];
  }

  destroy(): void {
    if (this.hooks.onDisconnected) {
      this.hooks.onDisconnected(this);
    }
  }

  handleText(text: string): void {
    let msg: ClientInboundMessage & { type: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!this.ready) {
      if (msg.type !== 'client/hello') {
        return;
      }
      this.handleHello((msg as any).payload);
      return;
    }
    switch (msg.type) {
      case 'client/time':
        this.handleClientTime((msg as ClientTimeMessage).payload);
        break;
      case 'client/state':
        this.handleClientState((msg as ClientStateMessage).payload);
        break;
      case 'client/command':
        this.handleClientCommand((msg as ClientCommandMessage).payload.controller);
        break;
      case 'client/goodbye':
        this.handleClientGoodbye((msg as ClientGoodbyeMessage).payload);
        break;
      case 'stream/request-format':
        this.handleStreamRequestFormat((msg as StreamRequestFormatMessage).payload);
        break;
      default:
        break;
    }
  }

  handleBinary(data: WebSocket.RawData): void {
    // Server does not expect inbound binary; drop.
  }

  private handleHello(payload: any): void {
    this.clientId = payload.client_id ?? null;
    const supportedRoles: RoleName[] = Array.isArray(payload.supported_roles) ? payload.supported_roles : [];
    const { activeRoles, unsupportedRoles } = this.resolveActiveRoles(supportedRoles);
    this.roles = activeRoles;
    this.playerSupport = payload['player@v1_support'] ?? payload.player_support ?? null;
    this.artworkChannels = payload['artwork@v1_support']?.channels ?? [];
    this.expectVolume = (this.playerSupport?.supported_commands ?? []).includes(PlayerCommand.VOLUME);
    this.expectMute = (this.playerSupport?.supported_commands ?? []).includes(PlayerCommand.MUTE);
    this.ready = true;
    this.sendServerHello();
    if (unsupportedRoles.length && this.hooks.onUnsupportedRoles) {
      this.hooks.onUnsupportedRoles(this, unsupportedRoles);
    }
    if (this.hooks.onIdentified) {
      this.hooks.onIdentified(this, this.req);
    }
  }

  private handleClientTime(payload: ClientTimeMessage['payload']): void {
    const nowUs = serverNowUs();
    const message: ServerTimeMessage = {
      type: 'server/time',
      payload: {
        client_transmitted: payload.client_transmitted,
        server_received: nowUs,
        server_transmitted: serverNowUs(),
      },
    };
    this.sendJson(message);
  }

  private handleClientState(payload: ClientStateMessage['payload']): void {
    const roles = [...this.roles];
    const update: SendspinPlayerStateUpdate = {
      clientId: this.clientId,
      roles,
      state: payload.state,
      volume: payload.player?.volume,
      muted: payload.player?.muted,
    };
    if (this.hooks.onPlayerState) {
      this.hooks.onPlayerState(this, update);
    }
  }

  private handleClientCommand(controller?: { command: MediaCommand; volume?: number; mute?: boolean }): void {
    if (!controller) return;
    const roles = [...this.roles];
    const cmd: SendspinGroupCommand = {
      clientId: this.clientId,
      roles,
      command: controller.command,
      volume: controller.volume,
      mute: controller.mute,
    };
    this.hooks.onGroupCommand?.(this, cmd);
  }

  private handleClientGoodbye(payload: ClientGoodbyeMessage['payload']): void {
    const reason = payload?.reason;
    if (reason) {
      this.lastGoodbyeReason = reason;
      this.hooks.onGoodbye?.(this, reason);
    }
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private handleStreamRequestFormat(payload: StreamRequestFormatPayload): void {
    if (payload.player) {
      this.applyPlayerFormatRequest(payload.player);
    }
    if (payload.artwork) {
      this.applyArtworkFormatRequest(payload.artwork);
    }
  }

  private sendServerHello(): void {
    if (!this.roles.length) return;
    const payload: ServerHelloPayload = {
      server_id: 'server',
      name: 'Sendspin Server',
      version: 1,
      active_roles: this.roles.map((r) => r as any),
      connection_reason:
        this.connectionReason === 'cast-tunnel' ? ConnectionReason.PLAYBACK : this.connectionReason,
    };
    const message: ServerHelloMessage = { type: 'server/hello', payload };
    this.sendJson(message);
  }

  sendStreamStart(format?: Partial<PlayerFormat>): void {
    const merged: PlayerFormat = {
      ...this.streamFormat,
      ...format,
    };
    this.streamFormat = merged;
    const player: StreamStartPlayer = {
      codec: merged.codec,
      sample_rate: merged.sampleRate,
      channels: merged.channels,
      bit_depth: merged.bitDepth,
      codec_header: merged.codecHeader,
    };
    const payload: StreamStartPayload = { player };
    const message: StreamStartMessage = { type: 'stream/start', payload };
    this.activeStream = true;
    this.sendJson(message);
    this.hooks.onFormatChanged?.(this, merged);
  }

  sendStreamClear(roles?: RoleName[]): void {
    const payload = { roles: roles as any };
    const message: StreamClearMessage = { type: 'stream/clear', payload };
    this.sendJson(message);
  }

  sendStreamEnd(roles?: RoleName[]): void {
    const payload = { roles: roles as any };
    const message: StreamEndMessage = { type: 'stream/end', payload };
    this.activeStream = false;
    this.sendJson(message);
  }

  sendPcmAudioFrame(frame: SendspinPcmFrame): void {
    if (!this.activeStream) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const buffered = this.ws.bufferedAmount;
    if (buffered > this.maxBufferedSend) {
      this.backpressureDrops += 1;
      this.lastBackpressureBytes = buffered;
      this.lastBackpressureTs = Date.now();
      this.backpressureEvents.push(this.lastBackpressureTs);
      return;
    }
    const ts = frame.timestampUs ?? serverNowUs();
    const header = packBinaryHeaderRaw(BinaryMessageType.AUDIO_CHUNK, ts);
    this.ws.send(Buffer.concat([header, frame.data]));
  }

  sendServerCommand(payload: ServerCommandPayload): void {
    const message: ServerCommandMessage = { type: 'server/command', payload };
    this.sendJson(message);
  }

  sendGroupUpdate(playbackState: 'playing' | 'paused' | 'stopped', groupId?: string, groupName?: string): void {
    this.playbackState = playbackState;
    const message = {
      type: 'group/update',
      payload: {
        playback_state: playbackState,
        group_id: groupId,
        group_name: groupName,
      },
    };
    this.sendJson(message as any);
  }

  sendMetadata(payload: ServerStatePayload): void {
    const message: ServerStateMessage = {
      type: 'server/state',
      payload,
    };
    this.sendJson(message);
  }

  sendControllerState(controller: ControllerStatePayload): void {
    const message: ServerStateMessage = {
      type: 'server/state',
      payload: { controller },
    };
    this.sendJson(message);
  }

  sendArtworkStreamStart(
    channels: Array<{ source: 'album' | 'artist' | 'none'; format: 'jpeg' | 'png' | 'bmp'; width: number; height: number }>,
  ): void {
    this.artworkChannels = channels;
    const message = {
      type: 'stream/start',
      payload: {
        artwork: {
          channels: channels.map((c) => ({
            source: c.source,
            format: c.format,
            width: c.width,
            height: c.height,
          })),
        },
      },
    };
    this.sendJson(message as any);
  }

  sendArtwork(channel: 0 | 1 | 2 | 3, imageData: Buffer | null): void {
    const header = packBinaryHeaderRaw(
      BinaryMessageType.ARTWORK_CHANNEL_0 + channel,
      serverNowUs(),
    );
    const payload = imageData ? Buffer.concat([header, imageData]) : header;
    this.ws.send(payload);
  }

  sendVisualizerStreamStart(config: Record<string, any> = {}): void {
    const message = {
      type: 'stream/start',
      payload: { visualizer: { ...config } },
    };
    this.sendJson(message as any);
  }

  sendVisualizerFrame(data: Buffer, timestampUs?: number): void {
    const ts = timestampUs ?? serverNowUs();
    const header = packBinaryHeaderRaw(BinaryMessageType.VISUALIZATION_DATA, ts);
    this.ws.send(Buffer.concat([header, data]));
  }

  private applyPlayerFormatRequest(request: StreamRequestFormatPayload['player']): void {
    if (!request) return;
    const codec = this.normalizeCodec(request.codec);
    const merged: PlayerFormat = {
      ...this.streamFormat,
      ...(codec ? { codec } : {}),
      ...(typeof request.sample_rate === 'number' ? { sampleRate: request.sample_rate } : {}),
      ...(typeof request.channels === 'number' ? { channels: request.channels } : {}),
      ...(typeof request.bit_depth === 'number' ? { bitDepth: request.bit_depth } : {}),
    };
    this.sendStreamStart(merged);
  }

  private applyArtworkFormatRequest(request: StreamRequestFormatPayload['artwork']): void {
    if (!request || typeof request.channel !== 'number') return;
    const idx = Math.max(0, Math.min(3, Math.floor(request.channel)));
    const current = this.artworkChannels[idx] ?? {
      source: 'album' as const,
      format: 'jpeg' as const,
      width: 800,
      height: 800,
    };
    const next = {
      source: request.source ?? current.source,
      format: request.format ?? current.format,
      width: typeof request.media_width === 'number' ? request.media_width : current.width,
      height: typeof request.media_height === 'number' ? request.media_height : current.height,
    };
    this.artworkChannels[idx] = next;
    this.sendArtworkStreamStart(this.artworkChannels);
  }

  private normalizeCodec(codec?: AudioCodec | string): AudioCodec | undefined {
    if (!codec) return undefined;
    if (codec === AudioCodec.OPUS || codec === 'opus') return AudioCodec.OPUS;
    if (codec === AudioCodec.FLAC || codec === 'flac') return AudioCodec.FLAC;
    if (codec === AudioCodec.PCM || codec === 'pcm') return AudioCodec.PCM;
    return undefined;
  }

  private resolveActiveRoles(
    supportedRoles: RoleName[],
  ): { activeRoles: RoleName[]; unsupportedRoles: RoleName[] } {
    const serverSupported = new Set<RoleName>([
      Roles.PLAYER,
      Roles.CONTROLLER,
      Roles.METADATA,
      Roles.ARTWORK,
      Roles.VISUALIZER,
    ]);
    const activeRoles: RoleName[] = [];
    const unsupportedRoles: RoleName[] = [];
    const seenFamilies = new Set<string>();
    for (const role of supportedRoles) {
      if (typeof role !== 'string') continue;
      const family = role.split('@')[0];
      if (serverSupported.has(role)) {
        if (!seenFamilies.has(family)) {
          activeRoles.push(role);
          seenFamilies.add(family);
        }
        continue;
      }
      if (!role.startsWith('_')) {
        unsupportedRoles.push(role);
      }
    }
    return { activeRoles, unsupportedRoles };
  }

  private sendJson(message: any): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }
}
