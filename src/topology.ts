// ============================================================================
// PARKING LOT TOPOLOGY - Layout Generation and Pathfinding
// ============================================================================

import {
  Topology,
  Aisle,
  ParkingSpot,
  RoadSegment,
  Point,
  TrafficLight,
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

  // Traffic lights (empty for standard lot - can be added for complex topologies)
  const trafficLights: TrafficLight[] = [];

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
    trafficLights,
  };
}

// ----------------------------------------------------------------------------
// LANE UTILITIES
// ----------------------------------------------------------------------------

/**
 * Get the y-coordinate for a specific lane on a road segment.
 * Lane 0 is the topmost (northernmost) lane.
 */
export function getLaneY(road: RoadSegment, lane: number): number {
  const laneWidth = road.width / road.lanes;
  // For horizontal roads: y is the center, lanes are distributed north to south
  return road.y - road.width / 2 + laneWidth / 2 + lane * laneWidth;
}

/**
 * Get the lane number for a given y-coordinate on a road.
 * Returns null if not on the road.
 */
export function getLaneAtY(road: RoadSegment, y: number): number | null {
  const laneWidth = road.width / road.lanes;
  const roadTop = road.y + road.width / 2;
  const roadBottom = road.y - road.width / 2;

  if (y < roadBottom || y > roadTop) {
    return null; // Not on this road
  }

  // Calculate which lane
  const distFromTop = roadTop - y;
  const lane = Math.floor(distFromTop / laneWidth);
  return Math.min(lane, road.lanes - 1);
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
 *
 * NOTE: The first waypoint uses a placeholder y-value (0) because the vehicle's
 * actual y-position on the main road is controlled by lane change logic, not pathfinding.
 * The simulation overrides y-position based on currentLane while on the main road.
 */
export function generateEntryPath(
  topology: Topology,
  spot: ParkingSpot,
  spawnLane: number = 0
): Point[] {
  const path: Point[] = [];
  const { mainRoad, entryRoad, entryPoint, lot } = topology;

  // Calculate y-positions for main road lanes
  const mainLaneWidth = mainRoad.width / mainRoad.lanes;
  const spawnLaneY = mainRoad.y - mainRoad.width / 2 + mainLaneWidth / 2 + spawnLane * mainLaneWidth;
  const bottomLaneY = mainRoad.y - mainRoad.width / 2 + mainLaneWidth / 2; // Lane 0

  // Calculate x-position for entry road lane
  // Entry road has 2 lanes - randomly assign to left or right lane
  const entryLaneWidth = entryRoad.width / entryRoad.lanes;
  const entryLane = Math.floor(Math.random() * entryRoad.lanes);
  // For vertical road: lane 0 is left (west), lane 1 is right (east)
  const entryLaneX = entryRoad.x - entryRoad.width / 2 + entryLaneWidth / 2 + entryLane * entryLaneWidth;

  // Start on main road in spawn lane (y will be updated by lane change logic)
  path.push({ x: mainRoad.x + mainRoad.length, y: spawnLaneY });

  // Drive west on main road until reaching entry road x-position (staying in lane 0)
  // This waypoint ensures car is at the correct x before turning
  path.push({ x: entryLaneX, y: bottomLaneY });

  // Turn south onto entry road - first waypoint just below main road
  // This creates a proper right turn instead of diagonal cut
  const mainRoadBottom = mainRoad.y - mainRoad.width / 2;
  path.push({ x: entryLaneX, y: mainRoadBottom - 5 });

  // Drive down entry road to lot
  path.push({ x: entryLaneX, y: entryPoint.y });

  // Find the aisle for this spot
  const aisle = topology.aisles.find((a) => a.id === spot.aisleId)!;

  // Direct path approach: minimize travel distance while staying on drivable paths
  //
  // Strategy: Use different entry points to the vertical corridor based on
  // which aisle the car is going to. This spreads traffic across the lot
  // and reduces the chance of one blocked car stopping all traffic.
  //
  // - For spots closer to the entry (near top), enter corridor early
  // - For spots further from entry (near bottom), travel horizontally first
  //   then use a more direct diagonal approach to the aisle

  const rightCorridorX = lot.x + lot.width - 15; // Right side corridor

  // Calculate an x-position that's between the spot and the right corridor
  // This creates slightly different paths for different spots
  const approachX = Math.min(spot.x + 30, rightCorridorX);

  // Step 1: Enter the lot from entry road
  path.push({ x: entryLaneX, y: lot.y + lot.height - 10 });

  // Step 2: Move toward an approach point above the target aisle
  // Using spot.x influence means cars heading to different spots diverge here
  path.push({ x: approachX, y: lot.y + lot.height - 10 });

  // Step 3: Go down to the aisle level via the approach corridor
  path.push({ x: approachX, y: aisle.y });

  // Step 4: Travel through aisle to the spot's x position (if needed)
  if (Math.abs(approachX - spot.x) > 5) {
    path.push({ x: spot.x, y: aisle.y });
  }

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

  // Calculate bottom lane y-position (lane 0 is closest to lot for merging onto road)
  // Lane 0 = south/bottom, cars merge here and can then change lanes if needed
  const mainLane = 0; // Bottom lane on main road
  const mainLaneWidth = mainRoad.width / mainRoad.lanes;
  const laneY = mainRoad.y - mainRoad.width / 2 + mainLaneWidth / 2 + mainLane * mainLaneWidth;

  // Calculate x-position for exit road lane
  // Exit road has 2 lanes - randomly assign to left or right lane
  const exitLaneWidth = exitRoad.width / exitRoad.lanes;
  const exitLane = Math.floor(Math.random() * exitRoad.lanes);
  // For vertical road: lane 0 is left (west), lane 1 is right (east)
  const exitLaneX = exitRoad.x - exitRoad.width / 2 + exitLaneWidth / 2 + exitLane * exitLaneWidth;

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

  // Go to exit point (use the assigned exit lane)
  path.push({ x: exitLaneX, y: exitPoint.y });

  // Drive up exit road to main road level (bottom lane)
  path.push({ x: exitLaneX, y: laneY });

  // Merge onto main road in bottom lane (turn left/west since road is westbound)
  path.push({ x: mainRoad.x, y: laneY });

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
