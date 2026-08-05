import type { NormalizedPoint, NormalizedPolygon, NormalizedSegment } from "./types";

const ORIENTATION_ERROR_FACTOR = (3 + 16 * Number.EPSILON) * Number.EPSILON;

interface Orientation {
  readonly crossProduct: number;
  readonly isCollinear: boolean;
}

function isNormalizedCoordinate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNormalizedPoint(point: NormalizedPoint): boolean {
  return isNormalizedCoordinate(point.x) && isNormalizedCoordinate(point.y);
}

function polygonAreaTwice(polygon: NormalizedPolygon): number {
  let previous = polygon.at(-1);
  if (!previous) {
    return 0;
  }

  let area = 0;
  for (const current of polygon) {
    area += previous.x * current.y - current.x * previous.y;
    previous = current;
  }
  return area;
}

function assertValidPolygon(polygon: NormalizedPolygon): void {
  if (polygon.length < 3) {
    throw new RangeError("polygon must contain at least three points");
  }
  if (!polygon.every(isNormalizedPoint)) {
    throw new RangeError("polygon coordinates must be finite and normalized");
  }
  if (polygonAreaTwice(polygon) === 0) {
    throw new RangeError("polygon must have non-zero area");
  }
}

function assertValidSegments(segments: readonly NormalizedSegment[]): void {
  if (segments.length === 0) {
    throw new RangeError("segments must not be empty");
  }
  if (
    !segments.every((segment) => isNormalizedPoint(segment.from) && isNormalizedPoint(segment.to))
  ) {
    throw new RangeError("segment coordinates must be finite and normalized");
  }
}

function orientation(
  origin: NormalizedPoint,
  left: NormalizedPoint,
  right: NormalizedPoint,
): Orientation {
  const leftProduct = (left.x - origin.x) * (right.y - origin.y);
  const rightProduct = (left.y - origin.y) * (right.x - origin.x);
  const crossProduct = leftProduct - rightProduct;
  const errorBound = ORIENTATION_ERROR_FACTOR * (Math.abs(leftProduct) + Math.abs(rightProduct));
  return { crossProduct, isCollinear: Math.abs(crossProduct) <= errorBound };
}

function pointOnSegment(point: NormalizedPoint, segment: NormalizedSegment): boolean {
  return (
    orientation(segment.from, segment.to, point).isCollinear &&
    point.x >= Math.min(segment.from.x, segment.to.x) &&
    point.x <= Math.max(segment.from.x, segment.to.x) &&
    point.y >= Math.min(segment.from.y, segment.to.y) &&
    point.y <= Math.max(segment.from.y, segment.to.y)
  );
}

function hasOppositeSigns(left: number, right: number): boolean {
  return (left < 0 && right > 0) || (left > 0 && right < 0);
}

function segmentsIntersect(left: NormalizedSegment, right: NormalizedSegment): boolean {
  const leftFrom = orientation(left.from, left.to, right.from);
  const leftTo = orientation(left.from, left.to, right.to);
  const rightFrom = orientation(right.from, right.to, left.from);
  const rightTo = orientation(right.from, right.to, left.to);

  if (
    hasOppositeSigns(leftFrom.crossProduct, leftTo.crossProduct) &&
    hasOppositeSigns(rightFrom.crossProduct, rightTo.crossProduct)
  ) {
    return true;
  }

  return (
    (leftFrom.isCollinear && pointOnSegment(right.from, left)) ||
    (leftTo.isCollinear && pointOnSegment(right.to, left)) ||
    (rightFrom.isCollinear && pointOnSegment(left.from, right)) ||
    (rightTo.isCollinear && pointOnSegment(left.to, right))
  );
}

function polygonSegments(polygon: NormalizedPolygon): readonly NormalizedSegment[] {
  let previous = polygon.at(-1);
  if (!previous) {
    return [];
  }

  const segments: NormalizedSegment[] = [];
  for (const current of polygon) {
    segments.push({ from: previous, to: current });
    previous = current;
  }
  return segments;
}

function pointToSegmentDistance(point: NormalizedPoint, segment: NormalizedSegment): number {
  const deltaX = segment.to.x - segment.from.x;
  const deltaY = segment.to.y - segment.from.y;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  if (squaredLength === 0) {
    return Math.hypot(point.x - segment.from.x, point.y - segment.from.y);
  }

  const projection =
    ((point.x - segment.from.x) * deltaX + (point.y - segment.from.y) * deltaY) / squaredLength;
  const boundedProjection = Math.min(1, Math.max(0, projection));
  const closestX = segment.from.x + boundedProjection * deltaX;
  const closestY = segment.from.y + boundedProjection * deltaY;
  return Math.hypot(point.x - closestX, point.y - closestY);
}

function segmentDistance(left: NormalizedSegment, right: NormalizedSegment): number {
  if (segmentsIntersect(left, right)) {
    return 0;
  }

  return Math.min(
    pointToSegmentDistance(left.from, right),
    pointToSegmentDistance(left.to, right),
    pointToSegmentDistance(right.from, left),
    pointToSegmentDistance(right.to, left),
  );
}

export function pointInPolygon(point: NormalizedPoint, polygon: NormalizedPolygon): boolean {
  let previous = polygon.at(-1);
  if (!previous) {
    return false;
  }

  let inside = false;
  for (const current of polygon) {
    const edge = { from: previous, to: current };
    if (pointOnSegment(point, edge)) {
      return true;
    }

    if (current.y > point.y !== previous.y > point.y) {
      const intersectionX =
        ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
      if (point.x < intersectionX) {
        inside = !inside;
      }
    }
    previous = current;
  }
  return inside;
}

export function polygonsIntersect(left: NormalizedPolygon, right: NormalizedPolygon): boolean {
  const leftSegments = polygonSegments(left);
  const rightSegments = polygonSegments(right);
  if (
    leftSegments.some((leftSegment) =>
      rightSegments.some((rightSegment) => segmentsIntersect(leftSegment, rightSegment)),
    )
  ) {
    return true;
  }

  return (
    left.some((point) => pointInPolygon(point, right)) ||
    right.some((point) => pointInPolygon(point, left))
  );
}

export function polygonIntersectsSegment(
  polygon: NormalizedPolygon,
  segment: NormalizedSegment,
): boolean {
  return (
    pointInPolygon(segment.from, polygon) ||
    pointInPolygon(segment.to, polygon) ||
    polygonSegments(polygon).some((edge) => segmentsIntersect(edge, segment))
  );
}

export function minimumDistanceToSegments(
  polygon: NormalizedPolygon,
  segments: readonly NormalizedSegment[],
): number {
  assertValidPolygon(polygon);
  assertValidSegments(segments);

  let minimum = Number.POSITIVE_INFINITY;
  for (const polygonSegment of polygonSegments(polygon)) {
    for (const segment of segments) {
      const distance = segmentDistance(polygonSegment, segment);
      if (distance === 0) {
        return 0;
      }
      minimum = Math.min(minimum, distance);
    }
  }
  return minimum;
}
