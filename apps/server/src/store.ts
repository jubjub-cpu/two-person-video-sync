import type {
  CommandId,
  ControlMode,
  ParticipantId,
  ParticipantRole,
  PlaybackState,
  PlaybackStatus,
  RoomCode,
  RoomId,
  SessionId,
  VideoState,
} from "@watch-sync/protocol";

export interface ParticipantRecord {
  participantId: ParticipantId;
  role: ParticipantRole;
  sessionId: SessionId;
  reconnectTokenDigest: Uint8Array;
  reconnectTokenExpiresAtMs: number;
  connectionId: string | undefined;
  disconnectedAtMs: number | undefined;
  ready: boolean;
  autoplayUnlocked: boolean;
  playbackStatus: PlaybackStatus;
  video: VideoState | undefined;
  lastClientSequence: number;
  readonly recentCommandIds: Set<CommandId>;
}

export interface RoomRecord {
  readonly roomId: RoomId;
  readonly roomCode: RoomCode;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  lastActivityAtMs: number;
  serverSequence: number;
  controlMode: ControlMode;
  readonly hostParticipantId: ParticipantId;
  authoritativeParticipantId: ParticipantId;
  state: PlaybackState | undefined;
  readonly participants: Map<ParticipantId, ParticipantRecord>;
}

/**
 * Persistence boundary for room metadata. Methods are asynchronous so a future implementation
 * can use Redis without changing the synchronization service. Implementations must make
 * insert() atomic and must not retain deleted room-code indexes.
 */
export interface RoomStore {
  insert(room: RoomRecord): Promise<boolean>;
  getById(roomId: RoomId): Promise<RoomRecord | undefined>;
  getByCode(roomCode: RoomCode): Promise<RoomRecord | undefined>;
  save(room: RoomRecord): Promise<void>;
  delete(roomId: RoomId): Promise<void>;
  list(): Promise<readonly RoomRecord[]>;
  count(): Promise<number>;
}

export class InMemoryRoomStore implements RoomStore {
  readonly #rooms = new Map<RoomId, RoomRecord>();
  readonly #roomIdsByCode = new Map<RoomCode, RoomId>();

  public insert(room: RoomRecord): Promise<boolean> {
    if (this.#rooms.has(room.roomId) || this.#roomIdsByCode.has(room.roomCode)) {
      return Promise.resolve(false);
    }
    this.#rooms.set(room.roomId, room);
    this.#roomIdsByCode.set(room.roomCode, room.roomId);
    return Promise.resolve(true);
  }

  public getById(roomId: RoomId): Promise<RoomRecord | undefined> {
    return Promise.resolve(this.#rooms.get(roomId));
  }

  public getByCode(roomCode: RoomCode): Promise<RoomRecord | undefined> {
    const roomId = this.#roomIdsByCode.get(roomCode);
    return Promise.resolve(roomId === undefined ? undefined : this.#rooms.get(roomId));
  }

  public save(room: RoomRecord): Promise<void> {
    if (!this.#rooms.has(room.roomId)) {
      return Promise.reject(new Error("Cannot save a room that is not in the store"));
    }
    this.#rooms.set(room.roomId, room);
    this.#roomIdsByCode.set(room.roomCode, room.roomId);
    return Promise.resolve();
  }

  public delete(roomId: RoomId): Promise<void> {
    const room = this.#rooms.get(roomId);
    if (room === undefined) {
      return Promise.resolve();
    }
    this.#rooms.delete(roomId);
    this.#roomIdsByCode.delete(room.roomCode);
    return Promise.resolve();
  }

  public list(): Promise<readonly RoomRecord[]> {
    return Promise.resolve([...this.#rooms.values()]);
  }

  public count(): Promise<number> {
    return Promise.resolve(this.#rooms.size);
  }
}
