import {
  FLAME_VELOCITIES,
  JUNGLE_LAYOUT,
  NASTIE_COLOURS,
  NASTIE_TYPES,
  OBJECT_COLOURS,
  OBJECT_LOCATIONS,
  ORCHID_COLOURS,
  ORCHID_POSITIONS,
  ROOM_ENTRY_X,
  TRIBESMAN_VELOCITIES,
  WANDERING_VELOCITIES,
} from "../data/rooms";
import { getSprite } from "../data/sprites";
import { ZXBeeper } from "../zx/beeper";
import {
  CTRL_DOWN,
  CTRL_FIRE,
  CTRL_LEFT,
  CTRL_RIGHT,
  CTRL_UP,
} from "../zx/input";
import { ZXScreen } from "../zx/zxScreen";
import {
  addBcdScore,
  calculateBoundedPosition,
  getWholePixels,
  limitVelocity,
  overlapsRoomObjects,
  reduceVelocity,
  slideActorPastObjects,
  testActorHurtingPlayer,
  testPlayerSwordTouchingActor,
  testPlayerTouchingActor,
  toByte,
  toSigned8,
} from "./physics";
import {
  Actor,
  NUM_ACTORS,
  PlayerWorldState,
  SLOT_AMULET_FIRST,
  SLOT_FLAME,
  SLOT_NASTIE_FIRST,
  SLOT_OBJECT_1,
  SLOT_OBJECT_2,
  SLOT_ORCHID,
  SLOT_PLAYER,
} from "./types";

export interface WorldCallbacks {
  readonly screen: ZXScreen;
  readonly beeper: ZXBeeper;
  getFrames(): number;
  getGameTimer(): number;
  nextRandom(): number;
  peekRandom(): number;
  readControls(): number;
  getGameDelayTimer(): number;
  setGameDelayTimer(val: number): void;
  getOrchidTimer(): number;
  setOrchidTimer(val: number): void;
  getNastieSpawnDelay(): number;
  setNastieSpawnDelay(val: number): void;
  getFlameSpawnDelay(): number;
  setFlameSpawnDelay(val: number): void;
  getActivePlayerIndex(): 0 | 1;
  onScoreChanged(): void;
  onLivesChanged(): void;
  onShowAmulet(): void;
  onGameComplete(): void;
  onPlayerTurnEnded(): void;
  drawCurrentRoom(previousRoom: number | null): void;
}

/** Erase actor's XOR bitmap if currently drawn on screen */
export function eraseActor(screen: ZXScreen, actor: Actor): void {
  if (!actor.drawnOnScreen) return;
  const spr = getSprite(actor.drawnSpriteId);
  screen.xorSprite(spr, actor.drawnX, actor.drawnY);
  actor.drawnOnScreen = false;
}

/** Sync actor's XOR bitmap & colour attributes on the ZX screen ($AD46 / $B9A9 / $BB24) */
export function syncActorDisplay(
  screen: ZXScreen,
  actor: Actor,
  playerRoom: number,
  overrideColour?: number,
  forcePickupBox = false,
): void {
  if (actor.spriteId === 0 || actor.room !== playerRoom) {
    eraseActor(screen, actor);
    return;
  }

  const newSpr = getSprite(actor.spriteId);
  if (actor.drawnOnScreen) {
    const oldSpr = getSprite(actor.drawnSpriteId);
    screen.xorSprite(oldSpr, actor.drawnX, actor.drawnY);
  }
  screen.xorSprite(newSpr, actor.x, actor.y);
  actor.drawnOnScreen = true;
  actor.drawnSpriteId = actor.spriteId;
  actor.drawnX = actor.x;
  actor.drawnY = actor.y;

  const colAttr = overrideColour ?? actor.colour;
  if (forcePickupBox) {
    // $A31A ColourPickup: height = 16, cols = 2
    screen.colourEntity(actor.x, actor.y, 2, 16, colAttr, 2);
  } else {
    screen.colourEntity(
      actor.x,
      actor.y,
      newSpr.widthBytes,
      newSpr.heightPixels,
      colAttr,
    );
  }
}

/** Sync Orchid's XOR bitmap + green stem ($44) & coloured blossom ($A6A6-$A6D1) */
export function syncOrchidDisplay(
  screen: ZXScreen,
  orchid: Actor,
  playerRoom: number,
): void {
  if (orchid.spriteId === 0 || orchid.room !== playerRoom || orchid.y === 0) {
    eraseActor(screen, orchid);
    return;
  }
  const newSpr = getSprite(orchid.spriteId);
  if (orchid.drawnOnScreen) {
    const oldSpr = getSprite(orchid.drawnSpriteId);
    screen.xorSprite(oldSpr, orchid.drawnX, orchid.drawnY);
  }
  screen.xorSprite(newSpr, orchid.x, orchid.y);
  orchid.drawnOnScreen = true;
  orchid.drawnSpriteId = orchid.spriteId;
  orchid.drawnX = orchid.x;
  orchid.drawnY = orchid.y;

  const stage = orchid.spriteId & 0x07;
  const cols = stage === 7 ? 3 : 2;
  const startCol = (orchid.x & 0xff) >> 3;
  const startRow = (orchid.y & 0xff) >> 3;

  // Stem row in bright green ($44)
  screen.colourRows(startCol, startRow, cols, 1, 0x44);
  if (stage !== 0) {
    // Blossom row directly above stem
    screen.colourRows(startCol, startRow - 1, cols, 1, orchid.colour);
  }
}

/** Mark room visited in 256-bit bitmap ($9D23 VisitRoom) */
export function markRoomVisited(world: PlayerWorldState, room: number): void {
  const r = room & 0xff;
  world.visitedRooms[r >> 3] |= 1 << (r & 7);
}

/** Save current room's orchid state into per-layout table ($A79F SaveOrchid) */
export function saveOrchidState(world: PlayerWorldState, room: number): void {
  const layoutIdx = JUNGLE_LAYOUT[room & 0xff];
  const orchid = world.actors[SLOT_ORCHID];
  const stage = orchid.spriteId & 0x07;
  const dir = orchid.state & 0x08;
  const timerHi = (orchid.vy & 0x0f) << 4;
  world.orchidStates[layoutIdx * 2] = timerHi | dir | stage;
  world.orchidStates[layoutIdx * 2 + 1] =
    (orchid.vx & 0xf8) | (orchid.colour & 0x07);
}

/** Load new room's orchid from per-layout table ($A763 LoadOrchid) */
export function loadOrchidForRoom(world: PlayerWorldState, room: number): void {
  const layoutIdx = JUNGLE_LAYOUT[room & 0xff];
  const orchid = world.actors[SLOT_ORCHID];
  const b0 = world.orchidStates[layoutIdx * 2];
  const b1 = world.orchidStates[layoutIdx * 2 + 1];
  const ox = ORCHID_POSITIONS[layoutIdx * 2];
  const oy = ORCHID_POSITIONS[layoutIdx * 2 + 1];

  orchid.drawnOnScreen = false;
  if (ox === 0 && oy === 0) {
    orchid.spriteId = 0;
    orchid.room = room & 0xff;
    return;
  }
  orchid.spriteId = 0x48 | (b0 & 0x07);
  orchid.room = room & 0xff;
  orchid.state = b0 & 0x08;
  orchid.x = ox;
  orchid.y = oy;
  orchid.colour = 0x40 | (b1 & 0x07);
  orchid.vx = b1 & 0xf8; // timer low byte
  orchid.vy = (b0 >>> 4) & 0x0f; // timer high byte
}

/** Populate slots 19 & 20 from `world.roomObjects` ($A33B SetUpRoomObjects) */
export function setUpRoomObjects(world: PlayerWorldState, room: number): void {
  const r = room & 0xff;
  const layoutIdx = JUNGLE_LAYOUT[r];
  for (let i = 0; i < 2; i++) {
    const slotIdx = i === 0 ? SLOT_OBJECT_1 : SLOT_OBJECT_2;
    const objActor = world.actors[slotIdx];
    objActor.drawnOnScreen = false;
    const tableIdx = r * 2 + i;
    const entry = world.roomObjects[tableIdx];
    if (entry === 0) {
      objActor.spriteId = 0;
      continue;
    }
    const objType = entry & 0x0f;
    const posIndex = (entry >>> 6) & 0x03;
    const locOff = layoutIdx * 8 + posIndex * 2;
    objActor.spriteId = 0x80 + objType;
    objActor.room = r;
    objActor.state = 0;
    objActor.x = OBJECT_LOCATIONS[locOff];
    objActor.y = OBJECT_LOCATIONS[locOff + 1];
    objActor.colour = OBJECT_COLOURS[objType];
    objActor.vx = tableIdx & 0xff;
    objActor.vy = (tableIdx >>> 8) & 0xff;
  }
}

/**
 * $AFE8 MoveActor: moves actor by (vx, vy) across room boundaries!
 * If the actor is Sabreman ($10..$2F) and changes rooms, redraws the new room immediately ($B148).
 */
function moveActorAcrossRooms(
  world: PlayerWorldState,
  actor: Actor,
  actorWidth: number,
  cb: WorldCallbacks,
): { x: number; y: number; roomChanged: boolean } {
  const prevRoom = actor.room;
  const dx = getWholePixels(actor.vx);
  let newX = actor.x + dx;
  let newY = actor.y;
  let newRoom = actor.room;

  if (dx >= 0) {
    if (newX + actorWidth > 255) {
      // Right exit ($B19F)
      newX = 0;
      newRoom = (newRoom & 0xf0) | ((newRoom + 1) & 0x0f);
      return finishRoomMove(world, actor, prevRoom, newRoom, newX, newY, cb);
    }
  } else {
    if (newX < 0) {
      // Left exit ($B187)
      newX = (256 - actorWidth - 1) & 0xff;
      newRoom = (newRoom & 0xf0) | ((newRoom - 1) & 0x0f);
      return finishRoomMove(world, actor, prevRoom, newRoom, newX, newY, cb);
    }
  }

  const dy = getWholePixels(actor.vy);
  newY = actor.y + dy;
  if (dy >= 0) {
    if (newY >= 0xc0) {
      // Bottom exit ($B12F): X snaps to ROOM_ENTRY_X of new room!
      newY = 0x27;
      newRoom = (newRoom + 0x10) & 0xff;
      const layoutIdx = JUNGLE_LAYOUT[newRoom];
      newX = ROOM_ENTRY_X[layoutIdx];
      return finishRoomMove(world, actor, prevRoom, newRoom, newX, newY, cb);
    }
  } else {
    if (newY < 0x28) {
      // Top exit ($B1AB)
      newY = 0xbf;
      newRoom = (newRoom - 0x10) & 0xff;
      return finishRoomMove(world, actor, prevRoom, newRoom, newX, newY, cb);
    }
  }

  return { x: newX & 0xff, y: newY & 0xff, roomChanged: false };
}

function finishRoomMove(
  world: PlayerWorldState,
  actor: Actor,
  prevRoom: number,
  newRoom: number,
  newX: number,
  newY: number,
  cb: WorldCallbacks,
): { x: number; y: number; roomChanged: boolean } {
  actor.room = newRoom & 0xff;
  const isPlayer = actor === world.actors[SLOT_PLAYER];
  if (isPlayer) {
    actor.x = newX & 0xff;
    actor.y = newY & 0xff;
    cb.drawCurrentRoom(prevRoom);
    syncActorDisplay(cb.screen, actor, actor.room);
    markRoomVisited(world, actor.room);
    cb.setFlameSpawnDelay(0x80);
  }
  return { x: newX & 0xff, y: newY & 0xff, roomChanged: true };
}

/** $A630 BringActorCloser: relocates Tribesmen & sleeping Hippo/Warthog if >= 2 rows away */
function bringActorCloser(
  world: PlayerWorldState,
  actor: Actor,
  cb: WorldCallbacks,
): boolean {
  const playerRoom = world.actors[SLOT_PLAYER].room;
  if (actor.room === playerRoom) return false;
  const playerRow = (playerRoom >>> 4) & 0x0f;
  const actorRow = (actor.room >>> 4) & 0x0f;
  if (Math.abs(actorRow - playerRow) < 2) return false;

  let targetBase: number;
  if ((cb.peekRandom() & 0x01) !== 0) {
    // Row below
    const below = playerRoom + 0x10;
    targetBase = below > 0xff ? playerRoom : below;
  } else {
    // Row above
    const above = playerRoom - 0x10;
    targetBase = above < 0 ? playerRoom : above;
  }

  const candidateRoom = (targetBase & 0xfc) | (actor.room & 0x03);
  if (candidateRoom === playerRoom) return false;

  actor.room = candidateRoom;
  const layoutIdx = JUNGLE_LAYOUT[candidateRoom];
  const ox = ORCHID_POSITIONS[layoutIdx * 2];
  const oy = ORCHID_POSITIONS[layoutIdx * 2 + 1];
  actor.x = ox !== 0 ? ox : 0x78;
  actor.y = oy !== 0 ? oy : 0x7f;
  return true;
}

/** Count collected amulet pieces (0..4) */
export function countAmuletPieces(amuletFlags: number): number {
  let c = 0;
  let f = amuletFlags & 0x0f;
  for (let i = 0; i < 4; i++) {
    if ((f & 1) !== 0) c++;
    f >>>= 1;
  }
  return c;
}

/** Dispatch a single actor slot according to Sabre Wulf's $9B3E JumpTable */
export function stepActorSlot(
  world: PlayerWorldState,
  slotIdx: number,
  cb: WorldCallbacks,
): void {
  const actor = world.actors[slotIdx];
  const id = actor.spriteId;
  if (id === 0) return;

  if (id >= 0x01 && id <= 0x05) {
    handleAppearingNastie(world, actor, cb);
  } else if (id === 0x06) {
    handleChooseNastie(world, actor, cb);
  } else if (id >= 0x08 && id <= 0x0c) {
    handleDyingNastie(world, actor, cb);
  } else if (id === 0x0d) {
    handleRemoveNastie(world, actor, cb);
  } else if (id >= 0x10 && id <= 0x1f) {
    handleWalkingPlayer(world, actor, cb);
  } else if (id >= 0x20 && id <= 0x2f) {
    handleAttackingPlayer(world, actor, cb);
  } else if (id >= 0x30 && id <= 0x33) {
    handleRhino(world, actor, cb);
  } else if (id >= 0x34 && id <= 0x37) {
    handleFlame(world, actor, cb);
  } else if (id >= 0x38 && id <= 0x3f) {
    handleTribesman(world, actor, cb);
  } else if (id === 0x40 || id === 0x44) {
    handleFlyingPlayer(world, actor, cb);
  } else if (id === 0x41 || id === 0x42 || id === 0x45 || id === 0x46) {
    handleSittingPlayer(world, actor, cb);
  } else if (id === 0x43 || id === 0x47) {
    handleYellowOrchidPlayer(world, actor, cb);
  } else if (id >= 0x48 && id <= 0x4f) {
    handleOrchid(world, actor, cb);
  } else if (id >= 0x50 && id <= 0x57) {
    handleWulf(world, actor, cb);
  } else if (id === 0x58 || id === 0x5c) {
    handleWulfPouncing(world, actor, cb);
  } else if (id === 0x59 || id === 0x5d) {
    handleWulfLanding(world, actor, cb);
  } else if ((id >= 0x68 && id <= 0x6b) || (id >= 0x74 && id <= 0x7b)) {
    handleChasingNastie(world, actor, cb);
  } else if (
    (id >= 0x60 && id <= 0x67) ||
    (id >= 0x6c && id <= 0x73) ||
    (id >= 0x98 && id <= 0x9f) ||
    (id >= 0xb0 && id <= 0xc3)
  ) {
    handleWanderingNastie(world, actor, cb);
  } else if (id === 0x85) {
    handleExtraLife(world, actor, cb);
  } else if (id >= 0x80 && id <= 0x8f) {
    handlePickup(world, actor, cb);
  } else if (id >= 0x90 && id <= 0x93) {
    handleAmuletPiece(world, actor, cb);
  } else if (id === 0x94 || id === 0x95) {
    handleGuardian(world, actor, cb);
  } else if ((id >= 0xa0 && id <= 0xa3) || (id >= 0xa8 && id <= 0xab)) {
    handleWalkingHippo(world, actor, cb);
  } else if ((id >= 0xa4 && id <= 0xa7) || (id >= 0xac && id <= 0xaf)) {
    handleSleepingHippo(world, actor, cb);
  }
}

// ============================================================================
// PLAYER HANDLERS ($AECF, $ADD0, $A9BE, $AA0D, $A61B)
// ============================================================================

function checkPlayerProgress(player: Actor, cb: WorldCallbacks): boolean {
  // Room $88 cave exit in top half ($A18C)
  if (player.room === 0x88 && player.y < 0x80) {
    cb.onGameComplete();
    return true;
  }
  if ((player.amuletFlags & 0x80) !== 0) {
    player.amuletFlags &= 0x7f;
    cb.onShowAmulet();
    return true;
  }
  return false;
}

function tickOrchidEffectTimer(player: Actor, cb: WorldCallbacks): number {
  if ((cb.getFrames() & 1) !== 0) return cb.getOrchidTimer();
  let t = cb.getOrchidTimer();
  if (t === 0) return 0;
  t--;
  cb.setOrchidTimer(t);
  if (t === 0) {
    player.colour = 0x47;
  }
  return t;
}

function displayPlayerWithOrchidFlash(player: Actor, cb: WorldCallbacks): void {
  const t = cb.getOrchidTimer();
  let overrideCol: number | undefined;
  if (t > 0 && t < 0x2f) {
    if ((t & 0x0f) < 0x08) {
      if ((t & 0x07) === 0) cb.beeper.playOrchidFlashBeep();
      overrideCol = 0x47;
    } else {
      if ((t & 0x07) === 0) cb.beeper.playOrchidFlashBeep();
    }
  }
  syncActorDisplay(cb.screen, player, player.room, overrideCol);
}

function knockPlayerBack(
  player: Actor,
  hitDir: number,
  cb: WorldCallbacks,
): void {
  player.state = 0x20; // flying sound pitch counter
  if ((hitDir & 0x80) !== 0) {
    // Cave guardian pushes Sabreman straight down ($A9AB)
    player.spriteId = 0x40;
    player.vx = 0;
    player.vy = 4;
    player.x = 0x78;
  } else if (hitDir === 2) {
    player.spriteId = 0x44;
    player.vx = toByte(-3);
    player.vy = 0;
  } else {
    player.spriteId = 0x40;
    player.vx = 3;
    player.vy = 0;
  }
  syncActorDisplay(cb.screen, player, player.room);
}

function setLabelFlash(
  screen: ZXScreen,
  playerIdx: 0 | 1,
  flash: boolean,
): void {
  const startCol = playerIdx === 0 ? 0x10 >> 3 : 0xd8 >> 3;
  for (let i = 0; i < 3; i++) {
    if (flash) screen.attrs[startCol + i] |= 0x80;
    else screen.attrs[startCol + i] &= 0x7f;
  }
}

function handleWalkingPlayer(
  world: PlayerWorldState,
  player: Actor,
  cb: WorldCallbacks,
): void {
  // Start-of-turn flashing delay ($AECF)
  let delay = cb.getGameDelayTimer();
  if (delay > 0) {
    delay--;
    cb.setGameDelayTimer(delay);
    if (delay > 0) {
      if ((delay & 0x0f) === 0) cb.beeper.playLowTone();
      setLabelFlash(cb.screen, cb.getActivePlayerIndex(), true);
      return;
    }
    setLabelFlash(cb.screen, cb.getActivePlayerIndex(), false);
    syncActorDisplay(cb.screen, player, player.room);
  }

  if (checkPlayerProgress(player, cb)) return;

  // Yellow orchid stun ($AE8F)
  if (player.colour === 0x46) {
    player.spriteId = 0x43 | (player.spriteId & 0x04);
    cb.setOrchidTimer(0x60);
    tickOrchidEffectTimer(player, cb);
    displayPlayerWithOrchidFlash(player, cb);
    return;
  }

  tickOrchidEffectTimer(player, cb);

  if (player.state !== 0) {
    knockPlayerBack(player, player.state, cb);
    return;
  }

  let controls = cb.readControls();
  if (player.colour === 0x43) {
    // Magenta orchid reverses directions! ($AF19)
    controls ^= 0x0f;
  }

  walkPlayerWithControls(world, player, controls, cb);
}

/**
 * Determine whether Sabreman should swing Right (`true`) or Left (`false`) when attacking.
 * Obeys explicit Left/Right input first; if neither is pressed (e.g. moving purely Up/Down or standing still),
 * auto-faces a close threat in the current room if one is nearby (with a small deadzone when `alreadyAttacking`
 * to prevent frame-by-frame flip jitter), otherwise preserves `world.facingRight`.
 */
function chooseAttackDirection(
  world: PlayerWorldState,
  player: Actor,
  controls: number,
  alreadyAttacking = false,
): boolean {
  const left = (controls & CTRL_LEFT) !== 0;
  const right = (controls & CTRL_RIGHT) !== 0;
  if (left && !right) return false;
  if (right && !left) return true;

  const refCenterX = alreadyAttacking ? player.x + 10 : player.x + 8;
  let bestDist = Infinity;
  let bestEnemyCenterX: number | null = null;

  for (let i = 1; i < NUM_ACTORS; i++) {
    const a = world.actors[i];
    const id = a.spriteId;
    if (id === 0 || a.room !== player.room) continue;

    // Threats that can be fought, knocked back, or held at bay (Wulf)
    let halfW = 0;
    if (id >= 0x01 && id <= 0x06) halfW = 12;
    else if (id >= 0x30 && id <= 0x33)
      halfW = 16; // Rhino
    else if (id >= 0x38 && id <= 0x3f)
      halfW = 8; // Tribesman
    else if (id >= 0x50 && id <= 0x5d)
      halfW = 16; // Wulf
    else if (
      (id >= 0x60 && id <= 0x7b) ||
      (id >= 0x98 && id <= 0x9f) ||
      (id >= 0xb0 && id <= 0xc3)
    )
      halfW = 12; // Nastie
    else if (id >= 0xa0 && id <= 0xaf)
      halfW = 16; // Hippo / Warthog
    else continue;

    const dy = Math.abs(a.y - player.y);
    if (dy > 0x28) continue;
    const enemyCenterX = a.x + halfW;
    const dx = Math.abs(enemyCenterX - refCenterX);
    if (dx > 0x38) continue;

    const dist = dx + dy;
    if (dist < bestDist) {
      bestDist = dist;
      bestEnemyCenterX = enemyCenterX;
    }
  }

  if (bestEnemyCenterX === null) {
    return world.facingRight;
  }
  if (alreadyAttacking && Math.abs(bestEnemyCenterX - refCenterX) <= 3) {
    return world.facingRight;
  }
  return bestEnemyCenterX >= refCenterX;
}

/** Max perpendicular distance (px) the player is eased to line up with a gap. */
const OPENING_ASSIST_RANGE = 8;

/**
 * Corner correction: when the player pushes along a single axis and is blocked,
 * but a free gap lies within a few pixels sideways, ease him toward it (2px/frame).
 */
function assistIntoOpening(
  player: Actor,
  moved: { x: number; y: number },
  slid: { x: number; y: number },
  inX: number,
  inY: number,
): { x: number; y: number } {
  if ((inX !== 0) === (inY !== 0)) return slid; // need exactly one axis
  const horizontal = inX !== 0;
  const blocked = horizontal
    ? moved.x !== player.x && slid.x === player.x && slid.y === player.y
    : moved.y !== player.y && slid.y === player.y && slid.x === player.x;
  if (!blocked) return slid;

  for (let k = 1; k <= OPENING_ASSIST_RANGE; k++) {
    for (const dir of [-1, 1]) {
      const side = (horizontal ? player.y : player.x) + dir * k;
      if (horizontal ? side < 0x28 || side >= 0xc0 : side < 0 || side > 0xf0) {
        continue;
      }
      const gapFree = horizontal
        ? !overlapsRoomObjects(player.room, moved.x, side, 0x16, 0x0e)
        : !overlapsRoomObjects(player.room, side, moved.y, 0x16, 0x0e);
      if (!gapFree) continue;

      for (const step of [Math.min(2, k), 1]) {
        const nudge = (horizontal ? player.y : player.x) + dir * step;
        const pathFree = horizontal
          ? !overlapsRoomObjects(player.room, player.x, nudge, 0x16, 0x0e)
          : !overlapsRoomObjects(player.room, nudge, player.y, 0x16, 0x0e);
        if (pathFree) {
          return horizontal ? { x: slid.x, y: nudge } : { x: nudge, y: slid.y };
        }
      }
      return slid;
    }
  }
  return slid;
}

function axisInput(controls: number): { x: number; y: number } {
  return {
    x:
      ((controls & CTRL_RIGHT) !== 0 ? 1 : 0) -
      ((controls & CTRL_LEFT) !== 0 ? 1 : 0),
    y:
      ((controls & CTRL_DOWN) !== 0 ? 1 : 0) -
      ((controls & CTRL_UP) !== 0 ? 1 : 0),
  };
}

function walkPlayerWithControls(
  world: PlayerWorldState,
  player: Actor,
  controls: number,
  cb: WorldCallbacks,
): void {
  let ax = 0;
  let ay = 0;
  const left = (controls & CTRL_LEFT) !== 0;
  const right = (controls & CTRL_RIGHT) !== 0;
  if (right) ax += 7;
  if (left) ax -= 7;
  if ((controls & CTRL_DOWN) !== 0) ay += 7;
  if ((controls & CTRL_UP) !== 0) ay -= 7;

  if (left && !right) world.facingRight = false;
  else if (right && !left) world.facingRight = true;

  const maxSpeed =
    player.colour === 0x42 ? 0x20 : player.colour === 0x45 ? 0x40 : 0x30;
  const curVx = toSigned8(player.vx);
  const curVy = toSigned8(player.vy);
  const effAx = ax !== 0 && curVx * ax < 0 ? ax * 2 : ax;
  const effAy = ay !== 0 && curVy * ay < 0 ? ay * 2 : ay;
  player.vx = limitVelocity(toByte(curVx + effAx), maxSpeed);
  player.vy = limitVelocity(toByte(curVy + effAy), maxSpeed);

  const moved = moveActorAcrossRooms(world, player, 0x10, cb);
  const slid = slideActorPastObjects(
    player.room,
    player.x,
    player.y,
    moved.x,
    moved.y,
    0x16,
    0x0e,
  );

  // Animate & update facing ($B053)
  const didMove = slid.x !== player.x || slid.y !== player.y;
  if (didMove && (cb.getFrames() & 1) === 0) {
    player.spriteId = (player.spriteId & 0xfc) | ((player.spriteId + 1) & 0x03);
  }
  if (slid.y !== player.y) {
    if (slid.y < player.y) {
      player.spriteId = (player.spriteId & 0xf3) | 0x08; // Up ($18..$1B)
    } else {
      player.spriteId |= 0x0c; // Down ($1C..$1F)
    }
  }
  if (slid.x !== player.x) {
    if (slid.x < player.x) {
      player.spriteId &= 0xf3; // Left ($10..$13)
      world.facingRight = false;
    } else {
      player.spriteId = (player.spriteId & 0xf3) | 0x04; // Right ($14..$17)
      world.facingRight = true;
    }
  }

  const walkInput = axisInput(controls);
  const aided = moved.roomChanged
    ? slid
    : assistIntoOpening(player, moved, slid, walkInput.x, walkInput.y);
  player.x = aided.x;
  player.y = aided.y;

  if (didMove) {
    cb.beeper.playFootstepSound(player.colour);
  }

  // Start sword attack if white ($47) and Fire pressed ($AF55-$AF65)
  if (player.colour === 0x47 && (controls & CTRL_FIRE) !== 0) {
    const attackRight = chooseAttackDirection(world, player, controls);
    world.facingRight = attackRight;
    const swingFrame = (player.spriteId << 1) & 0x07;
    player.spriteId = 0x20 | (attackRight ? 0x08 : 0x00) | swingFrame;
  }

  // Tight braking when an axis is released (~6px stop over 4 frames vs 48px coast in 1984)
  player.vx = reduceVelocity(player.vx, ax === 0 ? 8 : 1);
  player.vy = reduceVelocity(player.vy, ay === 0 ? 8 : 1);

  displayPlayerWithOrchidFlash(player, cb);
}

/**
 * Prevent attacking Sabreman from walking past the center of an immortal pushable creature
 * (Rhino, Hippo/Warthog, Tribesman) when it is pinned against an obstacle or mid-knockback,
 * holding Sabreman at sword-clash distance instead of letting him cross into its back hurtbox.
 */
function clampAttackStepAgainstCreatures(
  world: PlayerWorldState,
  player: Actor,
  targetX: number,
  targetY: number,
  attackingRight: boolean,
): { x: number; y: number } {
  let x = targetX;
  let y = targetY;

  for (let i = 1; i <= 10; i++) {
    const c = world.actors[i];
    const id = c.spriteId;
    if (id === 0 || c.room !== player.room) continue;

    let reachRight = 0;
    if ((id >= 0x30 && id <= 0x33) || (id >= 0xa0 && id <= 0xaf)) {
      reachRight = 0x1c; // Rhino / Hippo / Warthog (32px sprite)
    } else {
      // Tribesmen are knockback actors, not pinned obstacles.  Applying the
      // sword-clash clamp to them can freeze Sabreman on top of them.
      continue;
    }

    const halfW = reachRight >> 1;

    // Only hold the sword-clash position while this creature is actually in
    // sword knockback and can still move in that direction. A creature pinned
    // against a wall, corridor, or another obstacle must never become a hard
    // 2-axis lock for Sabreman.
    const knockbackRight = attackingRight && c.vx === 0x70;
    const knockbackLeft = !attackingRight && c.vx === 0x90;
    if (!knockbackRight && !knockbackLeft) continue;

    const creatureWidth = reachRight;
    const nextCreatureX = c.x + getWholePixels(c.vx);
    const creatureCanMove =
      nextCreatureX >= 0 &&
      nextCreatureX + creatureWidth <= 255 &&
      !overlapsRoomObjects(c.room, nextCreatureX, c.y, 0x17, creatureWidth);
    if (!creatureCanMove) continue;

    // Only clamp horizontally if vertically overlapping.
    const vertOverlapAtTarget = y >= c.y ? y - c.y < 0x0f : c.y - y < 0x0f;
    if (!vertOverlapAtTarget) continue;

    if (knockbackRight && x > player.x) {
      const maxPlayerX = c.x + halfW - 6;
      if (player.x <= maxPlayerX + 2 && x > maxPlayerX && x + 0x1c > c.x) {
        x = Math.max(player.x, maxPlayerX);
      }
    } else if (knockbackLeft && x < player.x) {
      const minPlayerX = c.x + halfW - 14;
      if (
        player.x >= minPlayerX - 2 &&
        x < minPlayerX &&
        x + 8 - c.x < reachRight + 0x14
      ) {
        x = Math.min(player.x, minPlayerX);
      }
    }
  }

  return { x: x & 0xff, y: y & 0xff };
}

function handleAttackingPlayer(
  world: PlayerWorldState,
  player: Actor,
  cb: WorldCallbacks,
): void {
  if (checkPlayerProgress(player, cb)) return;

  if (player.state !== 0) {
    knockPlayerBack(player, player.state, cb);
    return;
  }

  const controls = cb.readControls();
  if (player.colour !== 0x47 || (controls & CTRL_FIRE) === 0) {
    // Stop attacking ($AE34)
    const wasAttackingRight = (player.spriteId & 0x08) !== 0;
    world.facingRight = wasAttackingRight;
    player.spriteId = wasAttackingRight ? 0x14 : 0x10;
    walkPlayerWithControls(
      world,
      player,
      player.colour === 0x43 ? controls ^ 0x0f : controls,
      cb,
    );
    return;
  }

  let vx = 0;
  let vy = 0;
  if ((controls & CTRL_RIGHT) !== 0) vx += 0x20;
  if ((controls & CTRL_LEFT) !== 0) vx -= 0x20;
  if ((controls & CTRL_UP) !== 0) vy -= 0x20;
  if ((controls & CTRL_DOWN) !== 0) vy += 0x20;

  player.vx = toByte(vx);
  player.vy = toByte(vy);

  const moved = moveActorAcrossRooms(world, player, 0x10, cb);
  const slid = slideActorPastObjects(
    player.room,
    player.x,
    player.y,
    moved.x,
    moved.y,
    0x16,
    0x0e,
  );

  // Animate sword swings & auto-face close threats when moving purely vertically ($AE4B)
  const sx = toSigned8(player.vx);
  if (sx > 0) {
    player.spriteId |= 0x08;
    world.facingRight = true;
  } else if (sx < 0) {
    player.spriteId &= 0xf7;
    world.facingRight = false;
  } else {
    const attackRight = chooseAttackDirection(world, player, controls, true);
    if (attackRight) {
      player.spriteId |= 0x08;
    } else {
      player.spriteId &= 0xf7;
    }
    world.facingRight = attackRight;
  }

  const attackingRight = (player.spriteId & 0x08) !== 0;
  const attackInput = axisInput(controls);
  const aided = moved.roomChanged
    ? slid
    : assistIntoOpening(player, moved, slid, attackInput.x, attackInput.y);
  const finalPos = moved.roomChanged
    ? slid
    : clampAttackStepAgainstCreatures(
        world,
        player,
        aided.x,
        aided.y,
        attackingRight,
      );

  if ((cb.getFrames() & 0x03) === 0) {
    player.spriteId = (player.spriteId & 0xf8) | (cb.nextRandom() & 0x07);
  }

  const didMove = finalPos.x !== player.x || finalPos.y !== player.y;
  player.x = finalPos.x;
  player.y = finalPos.y;
  if (didMove) {
    cb.beeper.playFootstepSound(player.colour);
  }

  syncActorDisplay(cb.screen, player, player.room);
}

function handleFlyingPlayer(
  _world: PlayerWorldState,
  player: Actor,
  cb: WorldCallbacks,
): void {
  const newX = player.x + toSigned8(player.vx);
  const newY = player.y + toSigned8(player.vy);

  if (
    newX < 0x04 ||
    newX >= 0xec ||
    newY < 0x28 ||
    newY >= 0xc0 ||
    overlapsRoomObjects(player.room, newX, newY, 0x17, 0x0f)
  ) {
    // Land on jungle floor ($AA00)
    player.spriteId = (player.spriteId + 1) & 0xff;
    player.state = 0x3f;
    syncActorDisplay(cb.screen, player, player.room);
    cb.beeper.playNoiseSound();
    return;
  }

  const slid = slideActorPastObjects(
    player.room,
    player.x,
    player.y,
    newX,
    newY,
    0x17,
    0x0f,
  );
  if (slid.x === player.x && slid.y === player.y) {
    player.spriteId = (player.spriteId + 1) & 0xff;
    player.state = 0x3f;
    syncActorDisplay(cb.screen, player, player.room);
    cb.beeper.playNoiseSound();
    return;
  }

  player.x = slid.x;
  player.y = slid.y;
  syncActorDisplay(cb.screen, player, player.room);
  player.state = (player.state + 1) & 0xff;
  cb.beeper.playSquareWave(player.state, 0x04);
}

function handleSittingPlayer(
  world: PlayerWorldState,
  player: Actor,
  cb: WorldCallbacks,
): void {
  player.state = (player.state - 1) & 0xff;
  if (player.state === 0) {
    // HandlePlayerDeath ($AA27)
    cb.onPlayerTurnEnded();
    return;
  }
  if (world.lives === 0 && player.state === 0x30) {
    // Lie flat dead ($AA22)
    player.spriteId = (player.spriteId + 1) & 0xff;
  }
  syncActorDisplay(cb.screen, player, player.room);
}

function handleYellowOrchidPlayer(
  world: PlayerWorldState,
  player: Actor,
  cb: WorldCallbacks,
): void {
  const rem = tickOrchidEffectTimer(player, cb);
  if (rem === 0) {
    player.spriteId = 0x10 | (world.facingRight ? 0x04 : 0x00);
    player.state = 0;
  }
  displayPlayerWithOrchidFlash(player, cb);
}

// ============================================================================
// ORCHID ($A680)
// ============================================================================

function handleOrchid(
  world: PlayerWorldState,
  orchid: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (orchid.room !== player.room) return;

  let timer = orchid.vx | (orchid.vy << 8);
  if (timer === 0) {
    if ((cb.getGameTimer() & 1) === 0) {
      if ((orchid.state & 0x08) !== 0) {
        // Shrinking ($A6E1)
        orchid.spriteId--;
        if ((orchid.spriteId & 0x07) === 0) {
          orchid.colour = ORCHID_COLOURS[cb.getFrames() & 0x0f];
          orchid.state ^= 0x08;
          timer = (cb.getFrames() & 0x3f) + 0x80;
        }
      } else {
        // Growing ($A70D)
        orchid.spriteId++;
        if ((orchid.spriteId & 0x07) === 0x07) {
          orchid.state ^= 0x08;
          timer = 0x0010; // Bloom time ($A731)
        }
      }
      orchid.vx = timer & 0xff;
      orchid.vy = (timer >>> 8) & 0xff;
    }
  } else {
    const playerAlive = player.spriteId >= 0x10 && player.spriteId < 0x30;
    if (playerAlive && cb.getGameDelayTimer() === 0) {
      timer--;
      orchid.vx = timer & 0xff;
      orchid.vy = (timer >>> 8) & 0xff;
    }
    // Check player touching fully grown orchid ($A737)
    if (
      (orchid.spriteId & 0x07) === 0x07 &&
      testPlayerTouchingActor(
        player,
        orchid,
        cb.getGameDelayTimer(),
        0x0f,
        0x0f,
      )
    ) {
      orchid.vx = 0;
      orchid.vy = 0;
      player.colour = orchid.colour;
      cb.setOrchidTimer(orchid.colour === 0x47 ? 0 : 0xc0);
      cb.beeper.playLowTone();
    }
  }

  syncOrchidDisplay(cb.screen, orchid, player.room);
}

// ============================================================================
// RHINO ($AD07), SABRE WULF ($A858), HIPPO/WARTHOG ($9E72), TRIBESMAN ($AB74), GUARDIAN ($9F16)
// ============================================================================

/**
 * Apply an immediate knockback shove step so sword-pushed tribesmen bounce ahead of
 * Sabreman's 50 Hz sword-walk (~100 px/s) instead of being overtaken between actor passes.
 */
function shoveCreatureStep(
  world: PlayerWorldState,
  creature: Actor,
  actorWidth: number,
  boxH: number,
  boxW: number,
  cb: WorldCallbacks,
): void {
  const moved = moveActorAcrossRooms(world, creature, actorWidth, cb);
  if (moved.roomChanged) {
    creature.x = moved.x;
    creature.y = moved.y;
    return;
  }
  const slid = slideActorPastObjects(
    creature.room,
    creature.x,
    creature.y,
    moved.x,
    moved.y,
    boxH,
    boxW,
  );
  creature.x = slid.x;
  creature.y = slid.y;
}

/**
 * Original sword knockback of Rhino / Hippo / Warthog ($AD69, $9E72): face away from Sabreman and
 * run at +-$70 (7 px per actor pass) until blocked. No extra shove: one move per pass.
 * clampAttackStepAgainstCreatures keys on these exact velocities.
 */
function startCreatureKnockback(creature: Actor, toRight: boolean): void {
  if (toRight) {
    creature.spriteId |= 0x02;
    creature.vx = 0x70;
  } else {
    creature.spriteId &= 0xfd;
    creature.vx = 0x90;
  }
}

/**
 * Room-crossing move for large immortal creatures (Rhino, Hippo/Warthog).
 * If the crossing would drop the creature into Sabreman's room right next to him while he is
 * attacking (e.g. after he pushed it off-screen and is holding the edge with his sword), the
 * crossing is cancelled and the creature turns around at normal speed instead, so it can never
 * pop onto the screen and hit him instantly. An unguarded Sabreman gets no such protection.
 */
function moveLargeCreatureGuarded(
  world: PlayerWorldState,
  creature: Actor,
  cb: WorldCallbacks,
): { x: number; y: number; roomChanged: boolean; blocked: boolean } {
  const player = world.actors[SLOT_PLAYER];
  const prevRoom = creature.room;
  const prevX = creature.x;
  const prevY = creature.y;
  const moved = moveActorAcrossRooms(world, creature, 0x20, cb);
  const playerAttacking = player.spriteId >= 0x20 && player.spriteId < 0x30;
  if (!moved.roomChanged || creature.room !== player.room || !playerAttacking) {
    return { ...moved, blocked: false };
  }

  const safeDx = 0x48; // sprite width + sword reach + margin
  const safeDy = 0x20;
  const tooClose =
    Math.abs(player.x - moved.x) < safeDx &&
    Math.abs(player.y - moved.y) < safeDy;
  if (!tooClose) {
    return { ...moved, blocked: false };
  }

  // Cancel the crossing and retreat at normal speed ($30)
  creature.room = prevRoom;
  creature.x = prevX;
  creature.y = prevY;
  const sign = toSigned8(creature.vx) < 0 ? -1 : 1;
  creature.vx = toByte(-sign * 0x30);
  creature.spriteId ^= 0x02;
  return { x: prevX, y: prevY, roomChanged: false, blocked: true };
}

function handleRhino(
  world: PlayerWorldState,
  rhino: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if ((cb.getGameTimer() & 1) === 0) {
    rhino.spriteId ^= 0x01;
  }
  const moved = moveLargeCreatureGuarded(world, rhino, cb);
  if (moved.blocked) {
    syncActorDisplay(cb.screen, rhino, player.room);
    return;
  }
  const slid = slideActorPastObjects(
    rhino.room,
    rhino.x,
    rhino.y,
    moved.x,
    moved.y,
    0x17,
    0x1f,
  );

  if (!moved.roomChanged && slid.x === rhino.x && slid.y === rhino.y) {
    // Reset to normal speed $30 and reverse ($AD20-$AD25)
    const curSign = toSigned8(rhino.vx) < 0 ? -1 : 1;
    rhino.vx = toByte(-curSign * 0x30);
    rhino.spriteId ^= 0x02;
  } else {
    rhino.x = slid.x;
    rhino.y = slid.y;
  }

  const hitDirBit = (rhino.spriteId >>> 1) & 0x01;
  if (
    testActorHurtingPlayer(
      player,
      rhino,
      cb.getGameDelayTimer(),
      0x0f,
      0x1c,
      hitDirBit,
    )
  ) {
    if (player.state === 0) {
      // Sword knocked back Rhino! ($AD69)
      startCreatureKnockback(rhino, (player.spriteId & 0x08) !== 0);
      cb.beeper.playWarbleSound();
    } else {
      // Rhino hurt player: turn around ($AD43)
      rhino.spriteId ^= 0x02;
      rhino.vx = toByte(-toSigned8(rhino.vx));
    }
  }

  syncActorDisplay(cb.screen, rhino, player.room);
}

function handleWulf(
  world: PlayerWorldState,
  wulf: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  // Animate ($AC0E)
  if ((cb.getGameTimer() & 1) === 0) {
    wulf.spriteId = (wulf.spriteId & 0xfc) | ((wulf.spriteId + 1) & 0x03);
  }

  // ChooseWulfDirection ($A922): chase along map row
  if ((player.room & 0xf0) !== (wulf.room & 0xf0)) {
    wulf.state = 0;
  } else if (wulf.state === 0) {
    wulf.state = 1;
    const goRight =
      player.room === wulf.room ? player.x >= wulf.x : player.room > wulf.room;
    if (goRight) {
      wulf.vx = 0x40;
      wulf.spriteId |= 0x04;
    } else {
      wulf.vx = 0xc0;
      wulf.spriteId &= 0xfb;
    }
  }

  // TestWulfPounce ($A8B2)
  if (player.room === wulf.room && (wulf.state & 0xf0) === 0) {
    const sx = toSigned8(wulf.vx);
    const shouldPounce =
      sx < 0
        ? player.x < wulf.x && player.spriteId >= 0x28 && player.spriteId < 0x30
        : player.x >= wulf.x &&
          player.spriteId >= 0x20 &&
          player.spriteId < 0x28;
    if (shouldPounce) {
      wulf.spriteId = (wulf.spriteId & 0xfc) | 0x08; // $58 or $5C
      wulf.state = 0x0f;
    }
  }

  moveAndCollideWulf(world, wulf, cb);
}

function moveAndCollideWulf(
  world: PlayerWorldState,
  wulf: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  const moved = moveActorAcrossRooms(world, wulf, 0x20, cb);
  const slid = slideActorPastObjects(
    wulf.room,
    wulf.x,
    wulf.y,
    moved.x,
    moved.y,
    0x17,
    0x1f,
  );

  if (!moved.roomChanged && slid.x === wulf.x && slid.y === wulf.y) {
    wulf.spriteId ^= 0x04;
    wulf.vx = toByte(-toSigned8(wulf.vx));
  } else {
    wulf.x = slid.x;
    wulf.y = slid.y;
  }

  checkWulfTouchingPlayer(player, wulf, cb);
  syncActorDisplay(cb.screen, wulf, player.room);
}

function checkWulfTouchingPlayer(
  player: Actor,
  wulf: Actor,
  cb: WorldCallbacks,
): void {
  if (player.colour !== 0x47 || player.room !== wulf.room) return;
  if (
    !testPlayerTouchingActor(player, wulf, cb.getGameDelayTimer(), 0x0f, 0x1c)
  )
    return;

  // Wulf is immortal — always hurts unguarded Sabreman! ($A897)
  const dir = ((~wulf.spriteId >>> 2) & 0x01) + 1;
  player.state = dir;
  if (player.spriteId < 0x20 || player.spriteId >= 0x30) {
    wulf.spriteId ^= 0x04;
    wulf.vx = toByte(-toSigned8(wulf.vx));
  }
}

function handleWulfPouncing(
  world: PlayerWorldState,
  wulf: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  let holdCrouch = false;
  if (
    player.room === wulf.room &&
    player.spriteId >= 0x20 &&
    player.spriteId < 0x30
  ) {
    const attackBit2 = (player.spriteId >>> 1) & 0x04;
    if (((attackBit2 ^ wulf.spriteId) & 0x04) !== 0) {
      holdCrouch = true;
    }
  }
  if (!holdCrouch) {
    wulf.state = (wulf.state - 1) & 0xff;
    if (wulf.state === 0) {
      wulf.spriteId++; // $59 or $5D (leaping!)
      wulf.state = 0x08;
    }
  }
  checkWulfTouchingPlayer(player, wulf, cb);
  syncActorDisplay(cb.screen, wulf, player.room);
}

function handleWulfLanding(
  world: PlayerWorldState,
  wulf: Actor,
  cb: WorldCallbacks,
): void {
  wulf.state = (wulf.state - 1) & 0xff;
  if (wulf.state === 0) {
    wulf.spriteId &= 0xf7; // Back to running $50..$57
    wulf.state = 0x10;
    const sx = toSigned8(wulf.vx);
    wulf.vx = toByte(sx < 0 ? sx - 0x20 : sx + 0x20);
  }
  moveAndCollideWulf(world, wulf, cb);
}

function knockHippoFromSword(
  world: PlayerWorldState,
  player: Actor,
  hippo: Actor,
  cb: WorldCallbacks,
): void {
  startCreatureKnockback(hippo, (player.spriteId & 0x08) !== 0);
  hippo.state = 0;
  cb.beeper.playWarbleSound();
}

function handleWalkingHippo(
  world: PlayerWorldState,
  hippo: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if ((cb.getGameTimer() & 1) === 0) {
    hippo.spriteId ^= 0x01;
  }
  if (hippo.state !== 0) {
    hippo.state--;
    const hitDirBit = (hippo.spriteId >>> 1) & 0x01;
    if (
      testActorHurtingPlayer(
        player,
        hippo,
        cb.getGameDelayTimer(),
        0x0f,
        0x1c,
        hitDirBit,
      )
    ) {
      if (player.state === 0) {
        knockHippoFromSword(world, player, hippo, cb);
      }
    }
    syncActorDisplay(cb.screen, hippo, player.room);
    return;
  }

  const moved = moveLargeCreatureGuarded(world, hippo, cb);
  if (moved.blocked) {
    syncActorDisplay(cb.screen, hippo, player.room);
    return;
  }
  const slid = slideActorPastObjects(
    hippo.room,
    hippo.x,
    hippo.y,
    moved.x,
    moved.y,
    0x17,
    0x1f,
  );
  if (!moved.roomChanged && slid.x === hippo.x && slid.y === hippo.y) {
    // Hit obstacle -> go to sleep! ($9E92)
    hippo.spriteId |= 0x04;
    syncActorDisplay(cb.screen, hippo, player.room);
    return;
  }

  hippo.x = slid.x;
  hippo.y = slid.y;
  const hitDirBit = (hippo.spriteId >>> 1) & 0x01;
  if (
    testActorHurtingPlayer(
      player,
      hippo,
      cb.getGameDelayTimer(),
      0x0f,
      0x1c,
      hitDirBit,
    )
  ) {
    if (player.state === 0) {
      knockHippoFromSword(world, player, hippo, cb);
    } else {
      hippo.spriteId ^= 0x02;
      hippo.vx = toByte(-toSigned8(hippo.vx));
    }
  }
  syncActorDisplay(cb.screen, hippo, player.room);
}

function handleSleepingHippo(
  world: PlayerWorldState,
  hippo: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (bringActorCloser(world, hippo, cb)) {
    // Wake randomly as Hippo ($A0) or Warthog ($A8) ($9F06)
    hippo.spriteId = (hippo.spriteId & 0xf3) | (cb.nextRandom() & 0x08);
  }
  if (hippo.room !== player.room) {
    eraseActor(cb.screen, hippo);
    return;
  }

  const hitDirBit = (hippo.spriteId >>> 1) & 0x01;
  const playerAlive =
    cb.getGameDelayTimer() === 0 &&
    player.spriteId >= 0x10 &&
    player.spriteId < 0x30;
  const touched = playerAlive
    ? testActorHurtingPlayer(
        player,
        hippo,
        cb.getGameDelayTimer(),
        0x0f,
        0x1c,
        hitDirBit,
      )
    : testPlayerTouchingActor(
        player,
        hippo,
        cb.getGameDelayTimer(),
        0x0f,
        0x1c,
        true,
      );

  if (touched) {
    hippo.spriteId &= 0xfb; // Wake up!
    if (
      playerAlive &&
      player.state === 0 &&
      player.spriteId >= 0x20 &&
      player.spriteId < 0x30
    ) {
      knockHippoFromSword(world, player, hippo, cb);
    } else {
      hippo.spriteId ^= 0x02; // Turn around
      hippo.vx = toByte(-toSigned8(hippo.vx));
      hippo.state = 0x0f;
      cb.beeper.playWarbleSound();
    }
  }
  syncActorDisplay(cb.screen, hippo, player.room);
}

function setTribesmanVel(
  actor: Actor,
  vxByte: number,
  cb: WorldCallbacks,
): void {
  actor.vx = vxByte & 0xff;
  if (toSigned8(actor.vx) < 0) {
    actor.spriteId &= 0xfb;
  } else {
    actor.spriteId |= 0x04;
  }
  actor.vy = TRIBESMAN_VELOCITIES[cb.nextRandom() & 0x03];
}

function findCloseAmuletDistance(
  world: PlayerWorldState,
  actor: Actor,
): number | null {
  for (let i = 0; i < 4; i++) {
    const piece = world.actors[SLOT_AMULET_FIRST + i];
    if (piece.spriteId === 0) continue;
    if ((piece.room & 0x0f) === (actor.room & 0x0f)) {
      const dx = Math.abs(piece.x - actor.x);
      if (dx < 0x10) return dx;
    }
    if ((piece.room & 0xf0) === (actor.room & 0xf0)) {
      const dy = Math.abs(piece.y - actor.y);
      if (dy < 0x10) return dy;
    }
  }
  return null;
}

function handleTribesman(
  world: PlayerWorldState,
  native: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  bringActorCloser(world, native, cb);

  const moved = moveActorAcrossRooms(world, native, 0x10, cb);
  const slid = slideActorPastObjects(
    native.room,
    native.x,
    native.y,
    moved.x,
    moved.y,
    0x17,
    0x0f,
  );
  if (!moved.roomChanged && slid.x === native.x && slid.y === native.y) {
    const vx = TRIBESMAN_VELOCITIES[cb.nextRandom() & 0x03];
    setTribesmanVel(native, vx, cb);
  }
  native.x = slid.x;
  native.y = slid.y;

  if ((cb.getGameTimer() & 1) === 0) {
    native.spriteId = (native.spriteId & 0xfc) | ((native.spriteId + 1) & 0x03);
  }

  const hitDirBit = (native.spriteId >>> 2) & 0x01;
  if (
    testActorHurtingPlayer(
      player,
      native,
      cb.getGameDelayTimer(),
      0x0f,
      0x0c,
      hitDirBit,
    )
  ) {
    if (player.state === 0) {
      const throwVx = (player.spriteId & 0x08) !== 0 ? 0x60 : 0xa0;
      setTribesmanVel(native, throwVx, cb);
      // Knockback gets an independent random vertical velocity; it must not
      // inherit Sabreman's velocity or remain glued to his vertical position.
      shoveCreatureStep(world, native, 0x10, 0x17, 0x0f, cb);
    } else {
      setTribesmanVel(native, toByte(-toSigned8(native.vx)), cb);
    }
    cb.beeper.playWarbleSound();
  }

  const dist = findCloseAmuletDistance(world, native);
  if (dist !== null && native.room === player.room) {
    cb.beeper.playAmuletPieceSound(dist, native.x, native.y);
    syncActorDisplay(cb.screen, native, player.room, 0x46);
  } else {
    syncActorDisplay(cb.screen, native, player.room);
  }
}

function handleGuardian(
  world: PlayerWorldState,
  guardian: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (guardian.room !== player.room) return;

  if ((player.amuletFlags & 0x0f) === 0x0f) {
    // Step aside to let Sabreman enter the Underwurlde cavern! ($9F40)
    if ((player.x & 0x80) !== 0) {
      guardian.vx = 0xe0;
      const moved = moveActorAcrossRooms(world, guardian, 0x20, cb);
      if (moved.x >= 0x40) {
        guardian.x = moved.x;
        if ((cb.getGameTimer() & 1) === 0) guardian.spriteId ^= 0x01;
      }
    } else {
      guardian.vx = 0x20;
      const moved = moveActorAcrossRooms(world, guardian, 0x20, cb);
      if (moved.x < 0xc0) {
        guardian.x = moved.x;
        if ((cb.getGameTimer() & 1) === 0) guardian.spriteId ^= 0x01;
      }
    }
    syncActorDisplay(cb.screen, guardian, player.room);
    return;
  }

  if ((cb.getGameTimer() & 1) === 0) {
    guardian.spriteId ^= 0x01;
  }
  if (
    player.room === guardian.room &&
    testPlayerTouchingActor(
      player,
      guardian,
      cb.getGameDelayTimer(),
      0x17,
      0x0f,
    )
  ) {
    player.state = 0x80; // Knock straight down!
    cb.beeper.playWarbleSound();
  }
  syncActorDisplay(cb.screen, guardian, player.room);
}

// ============================================================================
// FLAME ($9D91) & NASTIES ($A3C5-$A54F)
// ============================================================================

function expireOffscreenActor(screen: ZXScreen, actor: Actor): void {
  eraseActor(screen, actor);
  actor.extra8 = (actor.extra8 + 1) & 0xff;
  if (actor.extra8 >= 0x40) {
    actor.spriteId = 0;
  }
}

function blowUpActor(
  world: PlayerWorldState,
  actor: Actor,
  cb: WorldCallbacks,
): void {
  cb.beeper.playExplosionSound(cb.nextRandom(), cb.getGameTimer());
  // Award BCD points: $0165 / $0175 / $0185 / $0195 ($A4B3)
  const ptsLow = (((actor.spriteId << 3) & 0x30) + 0x65) & 0xff;
  addBcdScore(world.scoreBcd, 0x0100 | ptsLow);
  cb.onScoreChanged();
  actor.spriteId = 0x08;
  syncActorDisplay(cb.screen, actor, world.actors[SLOT_PLAYER].room);
}

function chooseFlameDirection(
  world: PlayerWorldState,
  flame: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  flame.state = 0x40;
  if ((cb.getGameTimer() & 1) !== 0) {
    // Aim at player ($9E2F, preserving original $9E4E quirk!)
    flame.vx = player.x < flame.x ? 0xc0 : 0x40;
    if (player.y >= flame.y) {
      flame.vy = 0x40;
    } else {
      flame.vx = 0x40;
    }
  } else {
    flame.vx = FLAME_VELOCITIES[cb.nextRandom() & 0x07];
    flame.vy = (cb.getGameTimer() + cb.nextRandom()) & 0xff;
  }
}

function handleFlame(
  world: PlayerWorldState,
  flame: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (flame.room !== player.room) {
    expireOffscreenActor(cb.screen, flame);
    return;
  }
  if (player.spriteId < 0x10 || player.spriteId >= 0x30) {
    blowUpActor(world, flame, cb);
    return;
  }

  flame.extra8 = (flame.extra8 - 1) & 0xff;
  if (flame.extra8 === 0) {
    cb.setFlameSpawnDelay(0x10);
    blowUpActor(world, flame, cb);
    return;
  }

  flame.state = (flame.state - 1) & 0xff;
  if (flame.state === 0) {
    chooseFlameDirection(world, flame, cb);
  }

  const bounded = calculateBoundedPosition(flame, 0x17);
  if ((bounded.edgeFlags & 1) !== 0) {
    flame.vx = toByte(-toSigned8(flame.vx));
  } else if ((bounded.edgeFlags & 2) !== 0) {
    flame.vy = toByte(-toSigned8(flame.vy));
  }

  const slid = slideActorPastObjects(
    flame.room,
    flame.x,
    flame.y,
    bounded.x,
    bounded.y,
    0x17,
    0x0f,
  );
  if (slid.x === flame.x && slid.y === flame.y) {
    chooseFlameDirection(world, flame, cb);
  }

  const r = cb.nextRandom();
  flame.spriteId = 0x34 | (r & 0x03);
  let col = r & 0x07;
  if (col < 2) col |= 0x06;
  flame.colour = 0x40 | col;
  flame.x = slid.x;
  flame.y = slid.y;

  if (
    player.colour === 0x47 &&
    testPlayerTouchingActor(player, flame, cb.getGameDelayTimer(), 0x13, 0x0f)
  ) {
    player.state = ((player.x >>> 7) & 0x01) + 1;
  }

  syncActorDisplay(cb.screen, flame, player.room);
}

function handleAppearingNastie(
  world: PlayerWorldState,
  nastie: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (nastie.room !== player.room) {
    expireOffscreenActor(cb.screen, nastie);
    return;
  }
  if (
    player.spriteId >= 0x20 &&
    player.spriteId < 0x30 &&
    testPlayerSwordTouchingActor(
      player,
      nastie,
      cb.getGameDelayTimer(),
      0x0c,
      0x10,
    )
  ) {
    blowUpActor(world, nastie, cb);
    return;
  }
  nastie.spriteId++;
  cb.beeper.playAppearingSound(nastie.spriteId);
  syncActorDisplay(cb.screen, nastie, player.room);
}

function chooseWanderingVelocity(nastie: Actor, cb: WorldCallbacks): void {
  if ((nastie.vx | nastie.vy) !== 0) {
    nastie.vx = 0;
    nastie.vy = 0;
    nastie.state = 0x08 | (cb.nextRandom() & 0x07);
    return;
  }
  const vx = WANDERING_VELOCITIES[cb.nextRandom() & 0x07];
  nastie.vx = vx;
  if ((vx & 0x80) !== 0) nastie.spriteId &= 0xfd;
  else nastie.spriteId |= 0x02;
  nastie.vy = WANDERING_VELOCITIES[cb.getFrames() & 0x07];
}

function handleChooseNastie(
  world: PlayerWorldState,
  nastie: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (nastie.room !== player.room) {
    expireOffscreenActor(cb.screen, nastie);
    return;
  }
  const maxTypes = 8 + countAmuletPieces(player.amuletFlags) * 2;
  let t = cb.getGameTimer() & 0x0f;
  if (t >= maxTypes) t &= 0x07;
  nastie.spriteId = NASTIE_TYPES[t];
  nastie.vx = 0;
  nastie.vy = 0;
  chooseWanderingVelocity(nastie, cb);
  syncActorDisplay(cb.screen, nastie, player.room);
}

function handleDyingNastie(
  world: PlayerWorldState,
  nastie: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (nastie.room !== player.room) {
    eraseActor(cb.screen, nastie);
    nastie.spriteId = 0;
    return;
  }
  nastie.spriteId++;
  syncActorDisplay(cb.screen, nastie, player.room);
}

function handleRemoveNastie(
  world: PlayerWorldState,
  nastie: Actor,
  cb: WorldCallbacks,
): void {
  eraseActor(cb.screen, nastie);
  nastie.spriteId = 0;
  if (nastie.room !== world.actors[SLOT_PLAYER].room) return;
}

function handleChasingNastie(
  world: PlayerWorldState,
  nastie: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (nastie.room !== player.room) {
    expireOffscreenActor(cb.screen, nastie);
    return;
  }
  if (player.spriteId < 0x10 || player.spriteId >= 0x30) {
    blowUpActor(world, nastie, cb);
    return;
  }

  if (player.x === nastie.x) {
    nastie.vx = 0;
  } else {
    const step = player.x > nastie.x ? 8 : -8;
    nastie.vx = limitVelocity(toByte(toSigned8(nastie.vx) + step), 0x30);
  }

  if (player.y === nastie.y) {
    nastie.vy = player.y & 0xff; // Authentic $A50F quirk!
  } else {
    const step = player.y > nastie.y ? 8 : -8;
    nastie.vy = limitVelocity(toByte(toSigned8(nastie.vy) + step), 0x30);
  }

  // Face direction ($A4C3)
  const dirBit = ((nastie.vx << 2) >>> 8) & 0x02;
  nastie.spriteId = ((nastie.spriteId & 0xfd) | dirBit) ^ 0x03;

  const bounded = calculateBoundedPosition(nastie, 0x17);
  if ((bounded.edgeFlags & 1) !== 0) {
    nastie.vx = toByte(-toSigned8(nastie.vx));
    nastie.spriteId ^= 0x02;
  } else if ((bounded.edgeFlags & 2) !== 0) {
    nastie.vy = toByte(-toSigned8(nastie.vy));
  }

  const slid = slideActorPastObjects(
    nastie.room,
    nastie.x,
    nastie.y,
    bounded.x,
    bounded.y,
    0x17,
    0x17,
  );
  nastie.x = slid.x;
  nastie.y = slid.y;

  const hitDirBit = slid.y & 0x01;
  if (
    testActorHurtingPlayer(
      player,
      nastie,
      cb.getGameDelayTimer(),
      0x13,
      0x13,
      hitDirBit,
    )
  ) {
    blowUpActor(world, nastie, cb);
    return;
  }
  syncActorDisplay(cb.screen, nastie, player.room);
}

function handleWanderingNastie(
  world: PlayerWorldState,
  nastie: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (nastie.room !== player.room) {
    expireOffscreenActor(cb.screen, nastie);
    return;
  }
  if (player.spriteId < 0x10 || player.spriteId >= 0x30) {
    blowUpActor(world, nastie, cb);
    return;
  }

  nastie.state = (nastie.state - 1) & 0xff;
  if (nastie.state === 0) {
    chooseWanderingVelocity(nastie, cb);
  }

  if ((nastie.vx | nastie.vy) !== 0) {
    const bounded = calculateBoundedPosition(nastie, 0x17);
    if ((bounded.edgeFlags & 1) !== 0) {
      nastie.vx = toByte(-toSigned8(nastie.vx));
      nastie.spriteId ^= 0x02;
    } else if ((bounded.edgeFlags & 2) !== 0) {
      nastie.vy = toByte(-toSigned8(nastie.vy));
    }
    const slid = slideActorPastObjects(
      nastie.room,
      nastie.x,
      nastie.y,
      bounded.x,
      bounded.y,
      0x17,
      0x17,
    );
    if (slid.x === nastie.x && slid.y === nastie.y) {
      chooseWanderingVelocity(nastie, cb);
    }
    nastie.spriteId ^= 0x01;
    nastie.x = slid.x;
    nastie.y = slid.y;
  }

  const hitDirBit = nastie.y & 0x01;
  if (
    testActorHurtingPlayer(
      player,
      nastie,
      cb.getGameDelayTimer(),
      0x13,
      0x13,
      hitDirBit,
    )
  ) {
    blowUpActor(world, nastie, cb);
    return;
  }
  syncActorDisplay(cb.screen, nastie, player.room);
}

// ============================================================================
// PICKUPS ($A312), EXTRA LIFE ($A305), AMULET PIECES ($A1AB) & SPAWNERS ($9A3C/$9ABC)
// ============================================================================

function collectPickupCommon(
  world: PlayerWorldState,
  actor: Actor,
  cb: WorldCallbacks,
): void {
  eraseActor(cb.screen, actor);
  const tableIdx = actor.vx | (actor.vy << 8);
  if (tableIdx >= 0 && tableIdx < world.roomObjects.length) {
    world.roomObjects[tableIdx] = 0;
  }
  actor.spriteId = 0;
  addBcdScore(world.scoreBcd, 0x0150);
  cb.onScoreChanged();
  cb.beeper.playHighTone();
}

function handleExtraLife(
  world: PlayerWorldState,
  actor: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (actor.room !== player.room) return;
  if (
    testPlayerTouchingActor(player, actor, cb.getGameDelayTimer(), 0x0c, 0x0c)
  ) {
    if (world.lives < 9) {
      world.lives++;
      cb.onLivesChanged();
    }
    collectPickupCommon(world, actor, cb);
    return;
  }
  if (!actor.drawnOnScreen) {
    syncActorDisplay(cb.screen, actor, player.room, undefined, true);
  } else {
    cb.screen.colourEntity(actor.x, actor.y, 2, 16, actor.colour, 2);
  }
}

function handlePickup(
  world: PlayerWorldState,
  actor: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (actor.room !== player.room) return;
  if (
    testPlayerTouchingActor(player, actor, cb.getGameDelayTimer(), 0x0c, 0x0c)
  ) {
    collectPickupCommon(world, actor, cb);
    return;
  }
  if (!actor.drawnOnScreen) {
    syncActorDisplay(cb.screen, actor, player.room, undefined, true);
  } else {
    cb.screen.colourEntity(actor.x, actor.y, 2, 16, actor.colour, 2);
  }
}

function handleAmuletPiece(
  world: PlayerWorldState,
  actor: Actor,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (actor.room !== player.room) return;

  if ((cb.getGameTimer() & 1) === 0) {
    actor.colour = 0x44 | ((actor.colour + 1) & 0x03);
  }

  if (
    testPlayerTouchingActor(player, actor, cb.getGameDelayTimer(), 0x0c, 0x0c)
  ) {
    const pieceIdx = (actor.spriteId - 0x90) & 0x03;
    player.amuletFlags |= 0x80 | (1 << pieceIdx);
    eraseActor(cb.screen, actor);
    actor.spriteId = 0;
    addBcdScore(world.scoreBcd, 0x7500);
    cb.onScoreChanged();
    return;
  }

  if (!actor.drawnOnScreen) {
    syncActorDisplay(cb.screen, actor, player.room, undefined, true);
  } else {
    cb.screen.colourEntity(actor.x, actor.y, 2, 16, actor.colour, 2);
  }
}

/** $9A3C SpawnNastie: called once per full 24-slot actor pass */
export function trySpawnNastie(
  world: PlayerWorldState,
  cb: WorldCallbacks,
): void {
  if (cb.getGameDelayTimer() !== 0) return;
  const delay = cb.getNastieSpawnDelay();
  if (delay > 0) {
    cb.setNastieSpawnDelay(delay - 1);
    return;
  }

  const player = world.actors[SLOT_PLAYER];
  if (player.spriteId < 0x10 || player.spriteId >= 0x30) return;

  let freeSlot: Actor | null = null;
  let inRoomCount = 0;
  for (let i = 0; i < 6; i++) {
    const n = world.actors[SLOT_NASTIE_FIRST + i];
    if (n.spriteId === 0) {
      if (!freeSlot) freeSlot = n;
    } else if (n.room === player.room) {
      inRoomCount++;
    }
  }

  if (!freeSlot || inRoomCount >= world.nastieLimit) return;

  const nx = ((cb.nextRandom() & 0x7f) + 0x30) & 0xff;
  const ny = ((cb.getFrames() & 0x7f) + 0x30) & 0xff;
  freeSlot.x = nx;
  freeSlot.y = ny;
  freeSlot.room = player.room;

  if (
    testPlayerTouchingActor(
      player,
      freeSlot,
      cb.getGameDelayTimer(),
      0x17,
      0x17,
    )
  )
    return;
  if (overlapsRoomObjects(player.room, nx, ny, 0x17, 0x17)) return;

  freeSlot.colour = NASTIE_COLOURS[cb.getGameTimer() & 0x03];
  freeSlot.spriteId = 0x01;
  freeSlot.state = 0;
  freeSlot.vx = 0;
  freeSlot.vy = 0;
  freeSlot.extra8 = 0;
  freeSlot.drawnOnScreen = false;
  syncActorDisplay(cb.screen, freeSlot, player.room);
}

/** $9ABC SpawnFlame: called once per full 24-slot actor pass */
export function trySpawnFlame(
  world: PlayerWorldState,
  cb: WorldCallbacks,
): void {
  const player = world.actors[SLOT_PLAYER];
  if (player.spriteId < 0x10 || player.spriteId >= 0x30) return;
  if (cb.getGameDelayTimer() !== 0) return;

  const flame = world.actors[SLOT_FLAME];
  if (flame.spriteId !== 0) return;

  const delay = cb.getFlameSpawnDelay();
  if (delay > 0) {
    cb.setFlameSpawnDelay(delay - 1);
    return;
  }

  let fx: number;
  let fy: number;
  if ((cb.getGameTimer() & 1) !== 0) {
    fy = player.y;
    fx = ((cb.nextRandom() & 0x7f) + 0x30) & 0xff;
  } else {
    fx = player.x;
    fy = ((cb.getFrames() & 0x7f) + 0x30) & 0xff;
  }

  flame.x = fx;
  flame.y = fy;
  flame.room = player.room;
  if (
    testPlayerTouchingActor(player, flame, cb.getGameDelayTimer(), 0x17, 0x17)
  )
    return;
  if (overlapsRoomObjects(player.room, fx, fy, 0x17, 0x17)) return;

  flame.spriteId = 0x34;
  flame.colour = 0x46;
  flame.state = 1;
  flame.vx = 0;
  flame.vy = 0;
  flame.extra8 = 0; // wraps to 255 on first DEC => 256 passes lifetime!
  flame.drawnOnScreen = false;
  syncActorDisplay(cb.screen, flame, player.room);
}

/** Draw all actors currently located in `room` onto a freshly drawn room ($BBDD) */
export function drawActorsInRoom(
  screen: ZXScreen,
  world: PlayerWorldState,
  room: number,
  includePlayer: boolean,
): void {
  for (let i = 0; i < NUM_ACTORS; i++) {
    const a = world.actors[i];
    a.drawnOnScreen = false;
    if (i === SLOT_PLAYER && !includePlayer) continue;
    if (a.spriteId === 0 || a.room !== room) continue;

    if (i === SLOT_ORCHID) {
      syncOrchidDisplay(screen, a, room);
    } else if (i >= SLOT_OBJECT_1 && i <= SLOT_AMULET_FIRST + 3) {
      syncActorDisplay(screen, a, room, undefined, true);
    } else {
      syncActorDisplay(screen, a, room);
    }
  }
}
