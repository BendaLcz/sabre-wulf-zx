import { INITIAL_ORCHID_STATES } from "../data/rooms";

export const NUM_ACTORS = 25;

// Fixed actor indices matching $9702..$982D
export const SLOT_PLAYER = 0;
export const SLOT_RHINO_FIRST = 1; // 1..4
export const SLOT_TRIBESMAN_FIRST = 5; // 5..7
export const SLOT_FLAME = 8;
export const SLOT_WULF = 9;
export const SLOT_HIPPO = 10;
export const SLOT_GUARDIAN = 11;
export const SLOT_NASTIE_FIRST = 12; // 12..17 (6 nastie slots)
export const SLOT_ORCHID = 18;
export const SLOT_OBJECT_1 = 19;
export const SLOT_OBJECT_2 = 20;
export const SLOT_AMULET_FIRST = 21; // 21..24 (4 amulet piece slots)

/**
 * 12-byte Actor Record matching $9702..$982D + screen XOR tracking for 100% ghost-free XOR rendering.
 */
export interface Actor {
  spriteId: number; // +00
  room: number; // +01
  state: number; // +02: hitDir (Player), pause (Hippo), dirTimer (Flame/Nastie), pounceTimer (Wulf), growthDir (Orchid)
  x: number; // +03: 0..255
  y: number; // +04: 0..191 (bottom pixel row!)
  colour: number; // +05: ZX attribute byte
  vx: number; // +06: signed 8-bit velocity (stored as 0..255) OR low byte of timer/objIndex
  vy: number; // +07: signed 8-bit velocity (stored as 0..255) OR high byte of timer/objIndex
  extra8: number; // +08: lifetime (Flame) / offscreen timer (Nasties)
  amuletFlags: number; // +0B on Player ($970D): bits 0..3 = pieces collected, bit 7 = show amulet flag

  // Exact XOR screen tracking so XOR sprites can never leave stray pixels
  drawnOnScreen: boolean;
  drawnSpriteId: number;
  drawnX: number;
  drawnY: number;
}

export function createEmptyActor(): Actor {
  return {
    spriteId: 0,
    room: 0,
    state: 0,
    x: 0,
    y: 0,
    colour: 0x47,
    vx: 0,
    vy: 0,
    extra8: 0,
    amuletFlags: 0,
    drawnOnScreen: false,
    drawnSpriteId: 0,
    drawnX: 0,
    drawnY: 0,
  };
}

/** Per-player game world state ($96BC..$96DE + $DDEC + $9702 + orchid states) */
export interface PlayerWorldState {
  lives: number; // $96BD (starts at 5, consumes 1 on first spawn => 4 spare shown)
  nastieLimit: number; // $96BE (3)
  facingRight: boolean; // Preserves horizontal facing across vertical movement
  visitedRooms: Uint8Array; // $96BF..$96DE (32 bytes = 256 bits)
  roomObjects: Uint8Array; // $DDEC..$DFEB (512 bytes = 256 rooms * 2 objects)
  orchidStates: Uint8Array; // 96 bytes (48 layouts * 2 bytes, initialized from INITIAL_ORCHID_STATES)
  actors: Actor[]; // 25 actors
  scoreBcd: [number, number, number]; // 3 BCD bytes
}

export function createBlankPlayerWorld(): PlayerWorldState {
  const actors: Actor[] = [];
  for (let i = 0; i < NUM_ACTORS; i++) {
    actors.push(createEmptyActor());
  }
  return {
    lives: 0,
    nastieLimit: 3,
    facingRight: false,
    visitedRooms: new Uint8Array(32),
    roomObjects: new Uint8Array(512),
    orchidStates: new Uint8Array(INITIAL_ORCHID_STATES),
    actors,
    scoreBcd: [0, 0, 0],
  };
}

export type GamePhase =
  | "LOADING"
  | "MENU"
  | "HALL_OF_FAME"
  | "STARTUP_TUNE"
  | "PLAYING"
  | "SHOW_AMULET"
  | "GAME_COMPLETE"
  | "GAME_OVER"
  | "ENTER_INITIALS";

export interface MapSnapshot {
  readonly isPlaying: boolean;
  readonly phase: GamePhase;
  readonly activePlayer: 1 | 2;
  readonly playerRoom: number;
  readonly visitedRooms: Uint8Array;
  readonly amuletMask: number;
  readonly amuletRooms: readonly { room: number; collected: boolean }[];
  readonly percentage: number;
  readonly orchidColour: number;
  readonly orchidTimer: number;
}
