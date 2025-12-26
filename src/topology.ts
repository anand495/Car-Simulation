// ============================================================================
// PARKING LOT TOPOLOGY - Layout Generation and Pathfinding
// ============================================================================

import {
  Topology,
  Aisle,
  ParkingSpot,
  RoadSegment,
  Point,
  PARKING_SPOT_LENGTH,
  PARKING_SPOT_WIDTH,
  AISLE_WIDTH,
  LANE_WIDTH,
  SPEEDS,
} from './types';

// ----------------------------------------------------------------------------
// TOPOLOGY CREATION
// ----------------------------------------------------------------------------

/**
 * Creates a standard parking lot topology.
 *
 * Layout (looking from above, north is up):
 *
 *     ←←←←←←←←←←← Main Road (3 lanes, westbound) ←←←←←←←←←←←
 *                    ↑              │
 *                    │              ↓
 *                Exit Road      Entry Road
 *                (2 lanes)      (2 lanes)
 *                    ↑              ↓
 *              ┌─────┴──────────────┴─────┐
 *              │                          │
 *              │      Parking Lot         │
 *              │    ══════════════════    │ ← aisles
 *              │    ══════════════════    │
 *              │                          │
 *              └──────────────────────────┘
 */
export function createStandardLot(
  numSpots: number = 500
): Topology {
  // Calculate lot dimensions based on number of spots
  const spotsPerAisleSide = 25; // 25 spots on each side of an aisle
  const spotsPerAisle = spotsPerAisleSide * 2; // 50 spots per aisle (both sides)
  const numAisles = Math.ceil(numSpots / spotsPerAisle);

  // Dimensions
  const lotWidth = spotsPerAisleSide * PARKING_SPOT_WIDTH + 40; // margins
  const rowHeight = PARKING_SPOT_LENGTH * 2 + AISLE_WIDTH;
  const lotHeight = numAisles * rowHeight + 60; // extra space for internal roads

  // Position the lot - centered horizontally
  const lotX = 100;
  const lotY = 50;

  // Main road at top
  const mainRoadY = lotY + lotHeight + 80;
  const mainRoadLength = lotWidth + 200;

  // Entry road position (right side of lot)
  const entryRoadX = lotX + lotWidth - 40;

  // Exit road position (left side of lot)
  const exitRoadX = lotX + 40;

  // Road heights
  const entryExitRoadLength = mainRoadY - (lotY + lotHeight);

  // Create aisles with speed limits
  const aisles: Aisle[] = [];
  for (let i = 0; i < numAisles; i++) {
    const aisleY = lotY + 30 + PARKING_SPOT_LENGTH + i * rowHeight + AISLE_WIDTH / 2;
    aisles.push({
      id: i,
      y: aisleY,
      xStart: lotX + 10,
      xEnd: lotX + lotWidth - 10,
      direction: i % 2 === 0 ? 'east' : 'west',
      speedLimit: SPEEDS.AISLE,
    });
  }

  // Create parking spots (removed 'facing' property)
  const spots: ParkingSpot[] = [];
  let spotId = 0;

  for (let aisleIdx = 0; aisleIdx < aisles.length && spotId < numSpots; aisleIdx++) {
    const aisle = aisles[aisleIdx];

    // Spots on north side of aisle
    for (let j = 0; j < spotsPerAisleSide && spotId < numSpots; j++) {
      spots.push({
        id: spotId++,
        x: lotX + 20 + j * PARKING_SPOT_WIDTH + PARKING_SPOT_WIDTH / 2,
        y: aisle.y + AISLE_WIDTH / 2 + PARKING_SPOT_LENGTH / 2,
        aisleId: aisle.id,
        occupied: false,
        vehicleId: null,
      });
    }

    // Spots on south side of aisle
    for (let j = 0; j < spotsPerAisleSide && spotId < numSpots; j++) {
      spots.push({
        id: spotId++,
        x: lotX + 20 + j * PARKING_SPOT_WIDTH + PARKING_SPOT_WIDTH / 2,
        y: aisle.y - AISLE_WIDTH / 2 - PARKING_SPOT_LENGTH / 2,
        aisleId: aisle.id,
        occupied: false,
        vehicleId: null,
      });
    }
  }

  // Main road (3 lanes, westbound - traffic flows from right to left)
  const mainRoad: RoadSegment = {
    id: 'main',
    x: lotX - 100,
    y: mainRoadY,
    length: mainRoadLength,
    width: LANE_WIDTH * 3,
    lanes: 3,
    orientation: 'horizontal',
    direction: 'west',
    speedLimit: SPEEDS.MAIN_ROAD,
  };

  // Entry road (2 lanes, southbound - from main road down into lot)
  const entryRoad: RoadSegment = {
    id: 'entry',
    x: entryRoadX,
    y: lotY + lotHeight,
    length: entryExitRoadLength,
    width: LANE_WIDTH * 2,
    lanes: 2,
    orientation: 'vertical',
    direction: 'south',
    speedLimit: SPEEDS.PARKING_LOT,
  };

  // Exit road (2 lanes, northbound - from lot up to main road)
  const exitRoad: RoadSegment = {
    id: 'exit',
    x: exitRoadX,
    y: lotY + lotHeight,
    length: entryExitRoadLength,
    width: LANE_WIDTH * 2,
    lanes: 2,
    orientation: 'vertical',
    direction: 'north',
    speedLimit: SPEEDS.EXIT_APPROACH,
  };

  // Entry point - where entry road meets lot (bottom of entry road)
  const entryPoint: Point = {
    x: entryRoadX,
    y: lotY + lotHeight,
  };

  // Exit point - where exit road leaves lot (bottom of exit road)
  const exitPoint: Point = {
    x: exitRoadX,
    y: lotY + lotHeight,
  };

  return {
    mainRoad,
    entryRoad,
    exitRoad,
    lot: {
      x: lotX,
      y: lotY,
      width: lotWidth,
      height: lotHeight,
      speedLimit: SPEEDS.PARKING_LOT,
    },
    entryPoint,
    exitPoint,
    aisles,
    spots,
  };
}

// ----------------------------------------------------------------------------
// SPEED LIMIT LOOKUP
// ----------------------------------------------------------------------------

/**
 * Get the speed limit at a given position based on topology.
 * Car behavior uses this to respect speed limits.
 */
export function getSpeedLimitAtPosition(pos: Point, topology: Topology): number {
  const { mainRoad, entryRoad, exitRoad, lot, aisles } = topology;

  // Check if on main road (horizontal road at top)
  if (isOnRoadSegment(pos, mainRoad)) {
    return mainRoad.speedLimit;
  }

  // Check if on entry road (vertical road on right)
  if (isOnRoadSegment(pos, entryRoad)) {
    return entryRoad.speedLimit;
  }

  // Check if on exit road (vertical road on left)
  if (isOnRoadSegment(pos, exitRoad)) {
    return exitRoad.speedLimit;
  }

  // Check if in an aisle
  for (const aisle of aisles) {
    if (isInAisle(pos, aisle)) {
      return aisle.speedLimit;
    }
  }

  // Default: lot speed limit
  if (isInLot(pos, lot)) {
    return lot.speedLimit;
  }

  // Outside everything - use lot speed as default
  return lot.speedLimit;
}

/**
 * Check if position is on a road segment.
 */
function isOnRoadSegment(pos: Point, road: RoadSegment): boolean {
  const halfWidth = road.width / 2;

  if (road.orientation === 'horizontal') {
    // Horizontal road: check y within width, x within length
    return (
      pos.y >= road.y - halfWidth &&
      pos.y <= road.y + halfWidth &&
      pos.x >= road.x &&
      pos.x <= road.x + road.length
    );
  } else {
    // Vertical road: check x within width, y within length
    return (
      pos.x >= road.x - halfWidth &&
      pos.x <= road.x + halfWidth &&
      pos.y >= road.y &&
      pos.y <= road.y + road.length
    );
  }
}

/**
 * Check if position is in an aisle.
 */
function isInAisle(pos: Point, aisle: Aisle): boolean {
  const halfWidth = AISLE_WIDTH / 2;
  return (
    pos.x >= aisle.xStart &&
    pos.x <= aisle.xEnd &&
    pos.y >= aisle.y - halfWidth &&
    pos.y <= aisle.y + halfWidth
  );
}

/**
 * Check if position is inside the parking lot bounds.
 */
function isInLot(pos: Point, lot: { x: number; y: number; width: number; height: number }): boolean {
  return (
    pos.x >= lot.x &&
    pos.x <= lot.x + lot.width &&
    pos.y >= lot.y &&
    pos.y <= lot.y + lot.height
  );
}

// ----------------------------------------------------------------------------
// PATHFINDING
// ----------------------------------------------------------------------------

/**
 * Generate path from main road through entry road to a parking spot.
 */
export function generateEntryPath(
  topology: Topology,
  spot: ParkingSpot
): Point[] {
  const path: Point[] = [];
  const { mainRoad, entryRoad, entryPoint, lot } = topology;

  // Start on main road (coming from east since road is westbound)
  path.push({ x: mainRoad.x + mainRoad.length, y: mainRoad.y });

  // Turn off main road onto entry road
  path.push({ x: entryRoad.x, y: mainRoad.y });

  // Drive down entry road to lot
  path.push({ x: entryRoad.x, y: entryPoint.y });

  // Enter the lot
  path.push({ x: entryRoad.x, y: lot.y + lot.height - 10 });

  // Find the aisle for this spot
  const aisle = topology.aisles.find((a) => a.id === spot.aisleId)!;

  // Navigate to the aisle - drive along the right side corridor
  const corridorX = lot.x + lot.width - 15;
  path.push({ x: corridorX, y: lot.y + lot.height - 10 });
  path.push({ x: corridorX, y: aisle.y });

  // Turn into the aisle and go to spot's x position
  path.push({ x: spot.x, y: aisle.y });

  // Pull into the spot
  path.push({ x: spot.x, y: spot.y });

  return path;
}

/**
 * Generate path from parking spot through exit road to main road.
 */
export function generateExitPath(
  topology: Topology,
  spot: ParkingSpot
): Point[] {
  const path: Point[] = [];
  const { mainRoad, exitRoad, exitPoint, lot } = topology;

  // Start at spot
  path.push({ x: spot.x, y: spot.y });

  // Back out into aisle
  const aisle = topology.aisles.find((a) => a.id === spot.aisleId)!;
  path.push({ x: spot.x, y: aisle.y });

  // Drive through aisle toward exit side (left side of lot)
  const exitCorridorX = lot.x + 15;
  path.push({ x: exitCorridorX, y: aisle.y });

  // Navigate to top of lot along left corridor
  path.push({ x: exitCorridorX, y: lot.y + lot.height - 10 });

  // Go to exit point
  path.push({ x: exitPoint.x, y: exitPoint.y });

  // Drive up exit road
  path.push({ x: exitRoad.x, y: mainRoad.y });

  // Merge onto main road (turn left/west since road is westbound)
  path.push({ x: mainRoad.x, y: mainRoad.y });

  return path;
}

/**
 * Get available (unoccupied) parking spots.
 */
export function getAvailableSpots(topology: Topology): ParkingSpot[] {
  return topology.spots.filter((s) => !s.occupied);
}

/**
 * Find a random available spot.
 */
export function findRandomSpot(topology: Topology): ParkingSpot | null {
  const available = getAvailableSpots(topology);
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Calculate distance between two points.
 */
export function distance(a: Point, b: Point): number {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

/**
 * Calculate angle from point a to point b.
 */
export function angleTo(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/**
 * Normalize angle to [-π, π].
 */
export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/**
 * Get the bounds of the entire simulation world.
 */
export function getWorldBounds(topology: Topology): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const { mainRoad, lot } = topology;
  return {
    minX: Math.min(mainRoad.x, lot.x) - 50,
    maxX: Math.max(mainRoad.x + mainRoad.length, lot.x + lot.width) + 50,
    minY: lot.y - 50,
    maxY: mainRoad.y + mainRoad.width + 50,
  };
}
