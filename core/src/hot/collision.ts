import type { WorldPosition } from '@mnemosin/contracts';

import type { HotCollisionSegment, HotWorldGeometry } from './geometry.js';

interface CollisionHit {
  readonly time: number;
  readonly normal: WorldPosition;
}

export interface HotMovementResult {
  readonly position: WorldPosition;
  readonly collided: boolean;
}

function dot(a: WorldPosition, b: WorldPosition): number {
  return a.x * b.x + a.y * b.y;
}

function normalise(x: number, y: number, fallback: WorldPosition): WorldPosition {
  const length = Math.hypot(x, y);
  return length === 0 ? fallback : { x: x / length, y: y / length };
}

function closestPoint(position: WorldPosition, segment: HotCollisionSegment): WorldPosition {
  const sx = segment.bx - segment.ax;
  const sy = segment.by - segment.ay;
  const lengthSquared = sx * sx + sy * sy;
  const projection =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((position.x - segment.ax) * sx + (position.y - segment.ay) * sy) / lengthSquared));
  return { x: segment.ax + sx * projection, y: segment.ay + sy * projection };
}

/** Ray versus capsule: две стороны отрезка + два круглых endpoint. */
export function sweepCircleAgainstSegment(
  position: WorldPosition,
  displacement: WorldPosition,
  radius: number,
  epsilon: number,
  segment: HotCollisionSegment,
): CollisionHit | null {
  const sx = segment.bx - segment.ax;
  const sy = segment.by - segment.ay;
  const segmentLength = Math.hypot(sx, sy);
  if (segmentLength === 0) return null;

  const closest = closestPoint(position, segment);
  const startDx = position.x - closest.x;
  const startDy = position.y - closest.y;
  const startDistanceSquared = startDx * startDx + startDy * startDy;
  const radiusSquared = radius * radius;
  const oppositeMotion = normalise(-displacement.x, -displacement.y, { x: 1, y: 0 });
  const startNormal = normalise(startDx, startDy, oppositeMotion);
  const penetrationDistance = Math.max(0, radius - epsilon);

  if (startDistanceSquared < penetrationDistance * penetrationDistance) {
    return { time: 0, normal: startNormal };
  }
  if (startDistanceSquared <= radiusSquared + epsilon && dot(displacement, startNormal) < 0) {
    return { time: 0, normal: startNormal };
  }

  let earliest: CollisionHit | null = null;
  const consider = (time: number, normal: WorldPosition): void => {
    if (time < 0 || time > 1 || dot(displacement, normal) >= 0) return;
    if (earliest === null || time < earliest.time) earliest = { time, normal };
  };

  const tangent = { x: sx / segmentLength, y: sy / segmentLength };
  const normal = { x: -tangent.y, y: tangent.x };
  const relative = { x: position.x - segment.ax, y: position.y - segment.ay };
  const signedDistance = dot(relative, normal);
  const along = dot(relative, tangent);
  const normalSpeed = dot(displacement, normal);
  const tangentSpeed = dot(displacement, tangent);

  if (normalSpeed !== 0) {
    for (const side of [-1, 1] as const) {
      if (side * normalSpeed >= 0) continue;
      const time = (side * radius - signedDistance) / normalSpeed;
      const projected = along + time * tangentSpeed;
      if (projected >= 0 && projected <= segmentLength) {
        consider(time, { x: normal.x * side, y: normal.y * side });
      }
    }
  }

  const displacementSquared = dot(displacement, displacement);
  if (displacementSquared > 0) {
    for (const endpoint of [
      { x: segment.ax, y: segment.ay },
      { x: segment.bx, y: segment.by },
    ]) {
      const relativeX = position.x - endpoint.x;
      const relativeY = position.y - endpoint.y;
      const b = relativeX * displacement.x + relativeY * displacement.y;
      const c = relativeX * relativeX + relativeY * relativeY - radiusSquared;
      const discriminant = b * b - displacementSquared * c;
      if (discriminant < -epsilon) continue;
      const root = Math.sqrt(Math.max(0, discriminant));
      // Для внешней стартовой точки c > 0 эта форма не теряет точность на малых корнях.
      const time = c > 0 ? c / (-b + root) : (-b - root) / displacementSquared;
      const hitX = position.x + displacement.x * time - endpoint.x;
      const hitY = position.y + displacement.y * time - endpoint.y;
      consider(time, normalise(hitX, hitY, oppositeMotion));
    }
  }

  return earliest;
}

function earliestCollision(
  position: WorldPosition,
  displacement: WorldPosition,
  radius: number,
  epsilon: number,
  geometry: HotWorldGeometry,
): CollisionHit | null {
  let earliest: CollisionHit | null = null;
  for (const segment of geometry.segments) {
    const hit = sweepCircleAgainstSegment(position, displacement, radius, epsilon, segment);
    if (hit !== null && (earliest === null || hit.time < earliest.time)) earliest = hit;
  }
  return earliest;
}

/**
 * G3: continuous swept-circle + sliding. Ни один unchecked remainder не применяется:
 * после восьми контактов (стена/угол/вторая стена) остаток безопасно отбрасывается.
 */
export function moveCircleWithCollisions(
  start: WorldPosition,
  displacement: WorldPosition,
  radius: number,
  epsilon: number,
  geometry: HotWorldGeometry,
): HotMovementResult {
  let position = { ...start };
  let remaining = { ...displacement };
  let collided = false;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    if (remaining.x === 0 && remaining.y === 0) break;
    const hit = earliestCollision(position, remaining, radius, epsilon, geometry);
    if (hit === null) {
      position = { x: position.x + remaining.x, y: position.y + remaining.y };
      remaining = { x: 0, y: 0 };
      break;
    }

    collided = true;
    const remainingLength = Math.hypot(remaining.x, remaining.y);
    const travelTime = Math.max(0, hit.time - epsilon / Math.max(remainingLength, epsilon));
    // Отступаем по уже проверенному лучу, а не выталкиваемся в соседнее препятствие.
    position = {
      x: position.x + remaining.x * travelTime,
      y: position.y + remaining.y * travelTime,
    };
    remaining = { x: remaining.x * (1 - travelTime), y: remaining.y * (1 - travelTime) };
    const inward = dot(remaining, hit.normal);
    if (inward < 0) {
      remaining = { x: remaining.x - hit.normal.x * inward, y: remaining.y - hit.normal.y * inward };
    }
  }

  return { position, collided };
}
