# node-sendspin

TypeScript/Node.js implementation of the [Sendspin protocol](https://github.com/Sendspin/spec). It provides both server and client building blocks, tracks the reference implementation (`aiosendspin`), and is used by Sonn core — but is generic enough for other Sendspin deployments.

Runtime dependencies: `ws`. Noise encryption is implemented on `node:crypto`, so there is no crypto dependency to audit.

## Install

```sh
npm install @sonn-audio/node-sendspin
```

## Server

`sendspinCore` is a ready-made session manager: hand it WebSocket connections and it runs the handshake, tracks sessions per client, and gives you the calls to push streams, state, metadata and commands.

```ts
import { sendspinCore, Identity } from '@sonn-audio/node-sendspin';
import { WebSocketServer } from 'ws';

sendspinCore.configureServer({
  // Unique on the network and stable across restarts: a client with more than one
  // server tells them apart by this, so a constant like "server" makes every
  // installation indistinguishable.
  serverId: 'AA:BB:CC:DD:EE:FF',
  name: 'Living Room Audio',
});

const wss = new WebSocketServer({ port: 8927, path: '/sendspin' });
wss.on('connection', (ws, req) => sendspinCore.handleConnection(ws, req));

sendspinCore.registerHooks('client-id', {
  onIdentified: (session) => console.log('client ready', session.getRoles()),
  onPlayerState: (_session, update) => console.log('volume', update.volume),
  onGroupCommand: (_session, command) => console.log('command', command.command),
});
```

Per-session sends go through `SendspinSession` (or the `sendspinCore.*` shortcuts that take a `clientId`): `sendStreamStart`, `sendPcmAudioFrame`, `sendMetadata`, `sendControllerState`, `sendColor`, `sendArtwork`, the `sendVisualizer*` family, and `sendServerCommand`. Backpressure guards and per-client format negotiation are handled for you.

A player must send an initial `client/state` before its session counts as identified.

### Encryption

Optional, and opt-in per connection: a client that opens with `client/hello` keeps the unencrypted (transition-mode) path, one that opens with `client/init` gets Noise.

```ts
import { sendspinCore, Identity } from '@sonn-audio/node-sendspin';

// Persist this. The public half is your `server_id` under encryption, so a new
// identity each boot makes you an unknown server to every client that knew you.
const identity = Identity.fromPrivateB64u(storedKey ?? (storedKey = Identity.generate().privateB64u));
sendspinCore.enableEncryption(identity);
```

With no `PskProvider` every client is admitted with the published **Sentinel PSK**. Be clear-eyed about what that buys: the connection is confidential and tamper-evident against a passive listener, but it authenticates nothing, because the static keys are exchanged in the clear on the same connection. That is what "unpaired access" means in the spec. Pass your own provider to admit clients on stored per-client PSKs instead:

```ts
sendspinCore.enableEncryption(identity, async (clientId) => lookupPairing(clientId));
```

Under encryption `client_id` is the client's static public key (43 chars, base64url), not a name it chose — a hello claiming a different id is refused. Anything keyed on a client id therefore has to hold the key, not a UUID.

**Not implemented:** pairing (dynamic PIN, static PIN, pairing PSK), the trust store, and the `management/*` messages. The `source@v1` role requires a paired connection per spec, so it cannot be used over encryption yet.

## Client

```ts
import { SendspinClient, Roles, AudioCodec, MediaCommand } from '@sonn-audio/node-sendspin';

const client = new SendspinClient('my-client-id', 'My Player', [Roles.PLAYER], {
  playerSupport: {
    supported_formats: [
      { codec: AudioCodec.PCM, channels: 2, sample_rate: 48000, bit_depth: 16 },
    ],
    buffer_capacity: 512 * 1024,
    supported_commands: [],
  },
  staticDelayMs: 75,
});

client.addStreamStartListener(() => console.log('Stream started'));
client.addAudioChunkListener((timestampUs, data, format) => {
  const playAt = client.computePlayTime(timestampUs);
  // schedule playback of `data` at `playAt` microseconds on your clock
});

await client.connect('ws://localhost:8927/sendspin');
await client.sendGroupCommand(MediaCommand.PLAY);
```

To connect over Noise, pass an identity. `client_id` is then the key and the
constructor argument is ignored:

```ts
const client = new SendspinClient('unused', 'My Player', [Roles.PLAYER], {
  playerSupport: { /* ... */ },
  encryption: {
    identity,                    // persist it; it is your client_id
    expectedServerId: storedId,  // omit only if you accept an unauthenticated server
  },
});
await client.connect('wss://server/sendspin');
client.isEncrypted;        // true
client.admittedWith;       // PskCategory.SENTINEL
client.info?.serverId;     // taken from the handshake, not from server/hello
```

`expectedServerId` is what turns encryption into authentication. Without it an active man-in-the-middle can substitute its own keys in both directions; with it, only the server you paired with can complete the handshake.

## Notes

- `SendspinTimeFilter` provides Kalman-filtered clock sync at microsecond precision, and is reused by the client.
- Helpers for packing/unpacking the 9-byte binary header (`packBinaryHeaderRaw`, `unpackBinaryHeader`).
- `SendspinServer` / `ServerClient` are an **older, separate** server implementation, kept for compatibility. They do not speak encryption, do not stamp `server_transmitted`, and reject a `client/init`. Use `sendspinCore` for anything new.
- Noise correctness is pinned by interop tests against `noiseprotocol`, the library the reference server uses — both cipher suites, both roles, comparing handshake hashes and round-tripping transport frames.

## Migrating from 0.3.x

- `ControllerStatePayload` now requires `repeat` and `shuffle` (they moved out of the metadata object) and accepts `seek_max_ms`.
- `stream/start`, `stream/clear` and `stream/end` payloads carry a required `server_transmitted`, stamped at send. It is the start of the window a player's `required_lead_time_ms` is measured over.
- **`Roles.VISUALIZER` now means `visualizer@v1`.** The legacy batched wire is `Roles.VISUALIZER_DRAFT_R1`. `Roles.VISUALIZER_V1` remains as a deprecated alias.
- `MediaCommand.SELECT_SOURCE` is gone; `SEEK` and `SEEK_RELATIVE` were added, carrying `position_ms` / `offset_ms`.
- `source@v1` follows the spec: the format is announced with `client_stream/start` (see the `onSourceStreamStart` hook) rather than in the hello support object, which no longer requires `supported_formats`.
- `client/state.available` supersedes the `state` enum; the session resolves both and exposes `isAvailable()`.

## Building

```sh
npm install
npm run build
```

Compiled artifacts land in `dist/` with type declarations for publishing to npm.
