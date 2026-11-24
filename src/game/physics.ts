import { BACKGROUNDS } from '../data/backgrounds';
import { JUNGLE_LAYOUT, ROOM_TEMPLATES } from '../data/rooms';
import { Actor } from './types';

/** Convert unsigned byte (0..255) to signed (-128..127) */
export function toSigned8(v: number): number {
  const b = v & 0xff;
  return b >= 0x80 ? b - 0x100 : b;
}

/** Convert signed number to unsigned 8-bit byte (0..255) */
export function toByte(v: number): number {
  return v & 0xff;
}

/** $B031 GetWholePixels: signed 8-bit velocity in 1/16ths px, truncated toward zero */
export function getWholePixels(velByte: number): number {
  const s = toSigned8(velByte);
  if (s >= 0) {
    return (s >> 4) & 0x0f;
  }
  return -(((-s) >> 4) & 0x0f);
}

/** $AFD0 LimitVelocity: clamp signed 8-bit velocity magnitude to `maxMag` */
export function limitVelocity(velByte: number, maxMag: number): number {
  const s = toSigned8(velByte);
  if (s >= 0) {
    return toByte(Math.min(s, maxMag));
  }
  return toByte(-Math.min(-s, maxMag));
}

/** $B047 ReduceVelocity: reduce signed 8-bit velocity magnitude toward zero by `amount` */
export function reduceVelocity(velByte: number, amount: number): number {
  const s = toSigned8(velByte);
  if (s === 0) return 0;
  if (s > 0) {
    return toByte(Math.max(0, s - amount));
  }
  return toByte(Math.min(0, s + amount));
}

/**
 * $B873 TestRoomCollision: test whether actor box (x, y, width=boxW, height=boxH)
 * overlaps any background stamp in `room` (note: y is bottom of actor, stamps have y=top!).
 * Exact match to Z80 $B873-$B8AC:
 * - X overlaps iff newX < objX ? (objX - newX - 1) < boxW : (newX - objX) < objW
 *   <=> (newX + boxW > objX) && (newX < objX + objW)
 * - Y overlaps iff let dy = newY - objH - objY; dy < 0 ? (-dy - 1) < objH : dy < boxH
 *   <=> (newY >= objY) && (newY < objY + objH + boxH)
 */
export function overlapsRoomObjects(
  room: number,
  newX: number,
  newY: number,
  boxH: number,
  boxW: number
): boolean {
  const layoutIdx = JUNGLE_LAYOUT[room & 0xff];
  const stamps = ROOM_TEMPLATES[layoutIdx];
  if (!stamps) return false;

  const x = newX & 0xff;
  const y = newY & 0xff;

  for (let i = 0; i < stamps.length; i++) {
    const st = stamps[i];
    const bg = BACKGROUNDS[st.bg];
    const objX = st.x;
    const objY = st.y;
    const objW = bg.widthBytes * 8;
    const objH = bg.heightPixels;

    // X overlap ($B889-$B89A)
    const xOverlap = x < objX ? objX - x - 1 < boxW : x - objX < objW;
    if (!xOverlap) continue;

    // Y overlap ($B89B-$B8AB)
    const dy = y - objH - objY;
    const yOverlap = dy < 0 ? -dy - 1 < objH : dy < boxH;
    if (yOverlap) {
      return true;
    }
  }
  return false;
}

/**
 * $B81C SlideActorPastObjects:
 * Tests (targetX, targetY); if blocked, independently tests horizontal (targetX, oldY)
 * and vertical (oldX, targetY) so Sabreman and enemies smoothly slide along jungle walls!
 */
export function slideActorPastObjects(
  room: number,
  oldX: number,
  oldY: number,
  targetX: number,
  targetY: number,
  boxH: number,
  boxW: number
): { x: number; y: number; collided: boolean } {
  if (!overlapsRoomObjects(room, targetX, targetY, boxH, boxW)) {
    return { x: targetX & 0xff, y: targetY & 0xff, collided: false };
  }

  const resX = overlapsRoomObjects(room, targetX, oldY, boxH, boxW) ? oldX & 0xff : targetX & 0xff;
  const resY = overlapsRoomObjects(room, oldX, targetY, boxH, boxW) ? oldY & 0xff : targetY & 0xff;
  return { x: resX, y: resY, collided: true };
}

/**
 * $A44B CalculateNewPosition:
 * Moves actor within a single room (for Nasties & Bushfire), clamping against screen edges
 * X: 0 .. (256 - actorWidth), Y: 0x27 .. 0xBF and returning edgeFlags (bit 0 = X, bit 1 = Y).
 */
export function calculateBoundedPosition(
  actor: Actor,
  actorWidth: number
): { x: number; y: number; edgeFlags: number } {
  const dx = getWholePixels(actor.vx);
  let newX = actor.x + dx;
  let newY = actor.y;

  if (dx >= 0) {
    if (newX + actorWidth > 255) {
      newX = (256 - actorWidth) & 0xff;
      return { x: newX, y: newY, edgeFlags: 1 };
    }
  } else {
    if (newX < 0) {
      return { x: 0, y: newY, edgeFlags: 1 };
    }
  }

  const dy = getWholePixels(actor.vy);
  newY = actor.y + dy;
  if (dy >= 0) {
    if (newY >= 0xbf) {
      return { x: newX & 0xff, y: 0xbf, edgeFlags: 2 };
    }
  } else {
    if (newY < 0x27) {
      return { x: newX & 0xff, y: 0x27, edgeFlags: 2 };
    }
  }

  return { x: newX & 0xff, y: newY & 0xff, edgeFlags: 0 };
}

/**
 * $AB01 TestPlayerTouchingActor:
 * Checks hitbox overlap between Sabreman's body and `actor` with `reachAbove = B`, `reachRight = C`.
 * Accounts for the +8px body offset in 24px left-attacking sprites ($20..$27) without inflating
 * Sabreman's hurtbox by his extended sword blade against fire, Wulf, or enemies behind him.
 */
export function testPlayerTouchingActor(
  player: Actor,
  actor: Actor,
  gameDelayTimer: number,
  reachAbove: number,
  reachRight: number,
  ignoreAliveCheck = false
): boolean {
  if (!ignoreAliveCheck) {
    if (gameDelayTimer !== 0) return false;
    if (player.spriteId < 0x10 || player.spriteId >= 0x30) return false;
  }

  const isAttackingLeft = player.spriteId >= 0x20 && player.spriteId < 0x28;
  const bodyX = isAttackingLeft ? player.x + 8 : player.x;
  const reachBelow = 0x0f;
  const bodyWidth = 0x0c;

  // Horizontal body check
  if (bodyX >= actor.x) {
    if (bodyX - actor.x >= reachRight) return false;
  } else {
    if (actor.x - bodyX >= bodyWidth) return false;
  }

  // Vertical check ($AB27-$AB35)
  if (player.y >= actor.y) {
    if (player.y - actor.y >= reachBelow) return false;
  } else {
    if (actor.y - player.y >= reachAbove) return false;
  }

  return true;
}

/**
 * Checks whether an attacking Sabreman's extended sword hitbox reaches `actor` on the swung side
 * (used e.g. for slashing materializing Nastie clouds).
 */
export function testPlayerSwordTouchingActor(
  player: Actor,
  actor: Actor,
  gameDelayTimer: number,
  reachAbove: number,
  reachRight: number
): boolean {
  if (gameDelayTimer !== 0) return false;
  if (player.spriteId < 0x20 || player.spriteId >= 0x30) return false;

  const attackingRight = (player.spriteId & 0x08) !== 0;
  const bodyX = attackingRight ? player.x : player.x + 8;
  const reachBelow = 0x0f;

  // Vertical overlap
  if (player.y >= actor.y) {
    if (player.y - actor.y >= reachBelow) return false;
  } else {
    if (actor.y - player.y >= reachAbove) return false;
  }

  const sy = toSigned8(player.vy);
  const verticalLungeHit =
    (sy < 0 && actor.y <= player.y + 4) || (sy > 0 && actor.y >= player.y - 4);

  const actorCenterX = actor.x + (reachRight >> 1);
  if (attackingRight) {
    if (bodyX >= actor.x) {
      if (bodyX - actor.x >= reachRight) return false;
    } else {
      if (actor.x - bodyX >= 0x1c) return false; // 12px body + 16px right sword reach
    }
    return verticalLungeHit || actorCenterX >= bodyX;
  } else {
    if (bodyX >= actor.x) {
      if (bodyX - actor.x >= reachRight + 0x14) return false; // +12px past left sprite edge
    } else {
      if (actor.x - bodyX >= 0x0c) return false;
    }
    return verticalLungeHit || actorCenterX <= bodyX + 0x0c;
  }
}

/**
 * $AB36 TestActorHurtingPlayer (with symmetrical sword reach, head-on grace & vertical lunge protection):
 * - Returns false if Sabreman is under an orchid effect (colour !== 0x47), in another room, or not overlapping.
 * - When Sabreman is attacking ($20..$2F), extends sword reach in the swung direction (both Left and Right!)
 *   and awards a sword hit whenever the enemy's center is in front of Sabreman's back edge OR Sabreman is
 *   actively lunging vertically (Up into an enemy above, or Down into an enemy below).
 * - Otherwise sets player.state (hitDir = 1 or 2) and returns true (actor hurt player!).
 */
export function testActorHurtingPlayer(
  player: Actor,
  actor: Actor,
  gameDelayTimer: number,
  reachAbove: number,
  reachRight: number,
  hitDirBit0: number
): boolean {
  if (player.colour !== 0x47) return false;
  if (player.room !== actor.room) return false;
  if (gameDelayTimer !== 0) return false;
  if (player.spriteId < 0x10 || player.spriteId >= 0x30) return false;

  if (player.spriteId >= 0x20 && player.spriteId < 0x30) {
    const attackingRight = (player.spriteId & 0x08) !== 0;
    const bodyX = attackingRight ? player.x : player.x + 8;
    const reachBelow = 0x0f;

    // Vertical check
    if (player.y >= actor.y) {
      if (player.y - actor.y >= reachBelow) return false;
    } else {
      if (actor.y - player.y >= reachAbove) return false;
    }

    const sy = toSigned8(player.vy);
    const verticalLungeHit =
      (sy < 0 && actor.y <= player.y + 4) || (sy > 0 && actor.y >= player.y - 4);

    // Horizontal check: extend reach ONLY on the sword side, keep tight 12px body on the back side
    if (attackingRight) {
      if (bodyX >= actor.x) {
        if (bodyX - actor.x >= reachRight) return false;
      } else {
        if (actor.x - bodyX >= 0x1c) return false;
      }
      const actorCenterX = actor.x + (reachRight >> 1);
      if (actorCenterX >= bodyX) {
        return true; // Sword hit! (player.state stays 0)
      }
      if (verticalLungeHit) {
        player.spriteId &= 0xf7; // Whip sword left so knockback pushes enemy away
        return true;
      }
    } else {
      if (bodyX >= actor.x) {
        if (bodyX - actor.x >= reachRight + 0x14) return false;
      } else {
        if (actor.x - bodyX >= 0x0c) return false;
      }
      const actorCenterX = actor.x + (reachRight >> 1);
      if (actorCenterX <= bodyX + 0x0c) {
        return true; // Sword hit! (player.state stays 0)
      }
      if (verticalLungeHit) {
        player.spriteId |= 0x08; // Whip sword right so knockback pushes enemy away
        return true;
      }
    }

    // Enemy struck Sabreman from behind!
    player.state = (hitDirBit0 & 0x01) !== 0 ? 1 : 2;
    return true;
  }

  if (!testPlayerTouchingActor(player, actor, gameDelayTimer, reachAbove, reachRight)) {
    return false;
  }

  // Actor hurts non-attacking player! ($AB69-$AB72)
  player.state = (hitDirBit0 & 0x01) !== 0 ? 1 : 2;
  return true;
}

/** Add a 16-bit BCD value (e.g. 0x0150 or 0x7500) to a 3-byte BCD score ($B5B7) */
export function addBcdScore(score: [number, number, number], addBcd16: number): void {
  const addLow = addBcd16 & 0xff;
  const addMid = (addBcd16 >>> 8) & 0xff;

  const r2 = bcdAddByte(score[2], addLow, 0);
  score[2] = r2.val;
  const r1 = bcdAddByte(score[1], addMid, r2.carry);
  score[1] = r1.val;
  const r0 = bcdAddByte(score[0], 0x00, r1.carry);
  score[0] = r0.val;
}

function bcdAddByte(a: number, b: number, carryIn: number): { val: number; carry: number } {
  let lo = (a & 0x0f) + (b & 0x0f) + carryIn;
  let c = 0;
  if (lo >= 10) {
    lo -= 10;
    c = 1;
  }
  let hi = ((a >>> 4) & 0x0f) + ((b >>> 4) & 0x0f) + c;
  let carryOut = 0;
  if (hi >= 10) {
    hi -= 10;
    carryOut = 1;
  }
  return { val: ((hi << 4) | lo) & 0xff, carry: carryOut };
}

/** Compare two 3-byte BCD scores: returns >0 if a > b, <0 if a < b, 0 if equal */
export function compareBcdScores(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function formatBcdScore(score: readonly [number, number, number]): string {
  let s = '';
  for (let i = 0; i < 3; i++) {
    s += ((score[i] >>> 4) & 0x0f).toString();
    s += (score[i] & 0x0f).toString();
  }
  return s;
}

/**
 * Exact Z80 $9CC6 PrintRoomsVisited percentage calculation:
 * Counts visited rooms (0..256) + amulet pieces (0..4) => max 260,
 * multiplies by $6276 in 16-bit HL accumulating overflows in BCD + $0028 rounding => 0..100%!
 */
export function computeAdventurePercentage(visitedRooms: Uint8Array, amuletFlags: number): number {
  let count = 0;
  for (let i = 0; i < 32; i++) {
    let b = visitedRooms[i];
    for (let bit = 0; bit < 8; bit++) {
      if ((b & 1) !== 0) count++;
      b >>>= 1;
    }
  }
  let af = amuletFlags & 0x0f;
  for (let bit = 0; bit < 4; bit++) {
    if ((af & 1) !== 0) count++;
    af >>>= 1;
  }

  if (count <= 0) return 0;

  let hl = 0;
  let pctInt = 0;
  for (let i = 0; i < count; i++) {
    hl += 0x6276;
    if (hl > 0xffff) {
      hl &= 0xffff;
      pctInt++;
    }
  }
  hl += 0x0028;
  if (hl > 0xffff) {
    pctInt++;
  }
  return Math.min(100, pctInt);
}
