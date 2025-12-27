// ============================================================================
// SIMULATION ENGINE - Core physics and vehicle behavior
// ============================================================================

import {
  Vehicle,
  VehicleState,
  SimulationState,
  Topology,
  SimConfig,
  SPEEDS,
  PHYSICS,
  CAR_LENGTH,
  CAR_WIDTH,
  LANE_WIDTH,
  GRID_CELL_SIZE,
  COLORS,
  DEFAULT_CONFIG,
  DEFAULT_BEHAVIOR_FLAGS,
} from './types';

import {
  generateEntryPath,
  generateExitPath,
  findRandomSpot,
  getSpeedLimitAtPosition,
  getLaneY,
  distance,
  angleTo,
  normalizeAngle,
} from './topology';

// ----------------------------------------------------------------------------
// SIMULATION CLASS
// ----------------------------------------------------------------------------

export class Simulation {
  state: SimulationState;
  topology: Topology;
  config: SimConfig;

  private spatialGrid: Map<string, Vehicle[]> = new Map();
  private nextVehicleId = 0;
  private nextRoadVehicleId = 0;
  private exitTimes: number[] = [];

  constructor(topology: Topology, config: SimConfig = DEFAULT_CONFIG) {
    this.topology = topology;
    this.config = config;

    this.state = {
      time: 0,
      phase: 'IDLE',
      vehicles: [],
      roadVehicles: [],
      totalSpawned: 0,
      parkedCount: 0,
      exitedCount: 0,
      avgExitTime: null,
      throughput: 0,
    };
  }

  // --------------------------------------------------------------------------
  // MAIN SIMULATION LOOP
  // --------------------------------------------------------------------------

  step(dt: number): void {
    // Update spatial grid for efficient neighbor lookups
    this.updateSpatialGrid();

    // Spawn road traffic
    this.updateRoadTraffic(dt);

    // Update all vehicles
    for (const vehicle of this.state.vehicles) {
      if (vehicle.state !== 'PARKED' && vehicle.state !== 'EXITED') {
        this.updateVehicle(vehicle, dt);
      }
    }

    // Resolve any collisions
    this.resolveCollisions();

    // Update counters
    this.updateCounters();

    // Update time
    this.state.time += dt;

    // Check phase transitions
    this.checkPhaseTransitions();
  }

  // --------------------------------------------------------------------------
  // SPATIAL GRID (O(1) neighbor lookups)
  // --------------------------------------------------------------------------

  private updateSpatialGrid(): void {
    this.spatialGrid.clear();

    for (const vehicle of this.state.vehicles) {
      if (vehicle.state === 'EXITED') continue;

      const cellKey = this.getCellKey(vehicle.x, vehicle.y);
      const cell = this.spatialGrid.get(cellKey) || [];
      cell.push(vehicle);
      this.spatialGrid.set(cellKey, cell);
    }
  }

  private getCellKey(x: number, y: number): string {
    const cx = Math.floor(x / GRID_CELL_SIZE);
    const cy = Math.floor(y / GRID_CELL_SIZE);
    return `${cx},${cy}`;
  }

  private getNearbyVehicles(x: number, y: number, radius: number): Vehicle[] {
    const nearby: Vehicle[] = [];
    const cellRadius = Math.ceil(radius / GRID_CELL_SIZE);

    const cx = Math.floor(x / GRID_CELL_SIZE);
    const cy = Math.floor(y / GRID_CELL_SIZE);

    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        const cell = this.spatialGrid.get(key);
        if (cell) {
          for (const v of cell) {
            if (distance({ x, y }, { x: v.x, y: v.y }) <= radius) {
              nearby.push(v);
            }
          }
        }
      }
    }

    return nearby;
  }

  // --------------------------------------------------------------------------
  // VEHICLE UPDATE
  // --------------------------------------------------------------------------

  private updateVehicle(vehicle: Vehicle, dt: number): void {
    // State transitions
    this.updateVehicleState(vehicle);

    // Lane change logic (for vehicles on main road)
    if (vehicle.location === 'ON_MAIN_ROAD') {
      this.updateLaneChange(vehicle, dt);
    }

    // Compute target speed based on state, density, and gaps
    const targetSpeed = this.computeTargetSpeed(vehicle);
    vehicle.targetSpeed = targetSpeed;

    // Apply acceleration toward target speed
    this.applyAcceleration(vehicle, dt);

    // Follow path (skip normal path following during lane change - y is handled separately)
    this.followPath(vehicle, dt);
  }

  private updateVehicleState(vehicle: Vehicle): void {
    const pos = { x: vehicle.x, y: vehicle.y };
    const { mainRoad, entryRoad, lot, exitPoint } = this.topology;

    switch (vehicle.state) {
      case 'APPROACHING':
        // On main road, approaching entry road turn-off
        // Check if within entry road's x-range (accounting for full width of entry road)
        const entryRoadLeft = entryRoad.x - entryRoad.width / 2;
        const entryRoadRight = entryRoad.x + entryRoad.width / 2;
        if (pos.x >= entryRoadLeft - 2 && pos.x <= entryRoadRight + 2) {
          // Also check if we've started turning (y below main road bottom)
          const mainRoadBottom = mainRoad.y - mainRoad.width / 2;
          if (pos.y < mainRoadBottom - 2) {
            vehicle.state = 'ENTERING';
            vehicle.location = 'ON_ENTRY_ROAD';
            vehicle.currentLane = null; // No longer on main road
            vehicle.targetLane = null;
          }
        }
        break;

      case 'ENTERING':
        // Driving down entry road into lot
        if (pos.y <= lot.y + lot.height - 5) {
          vehicle.state = 'NAVIGATING_TO_SPOT';
          vehicle.location = 'IN_LOT';
        }
        break;

      case 'NAVIGATING_TO_SPOT':
        if (vehicle.targetSpotId !== null) {
          const spot = this.topology.spots[vehicle.targetSpotId];
          // Transition to PARKING when we're at the spot's x position and close to the spot
          if (Math.abs(pos.x - spot.x) < 1 && distance(pos, { x: spot.x, y: spot.y }) < 8) {
            vehicle.state = 'PARKING';
          }
        }
        break;

      case 'PARKING':
        if (vehicle.targetSpotId !== null) {
          const spot = this.topology.spots[vehicle.targetSpotId];
          // Snap to spot when within 2 meters (larger threshold to avoid getting stuck)
          if (distance(pos, { x: spot.x, y: spot.y }) < 2) {
            vehicle.state = 'PARKED';
            vehicle.location = 'IN_SPOT';
            vehicle.intent = 'PARKED';
            vehicle.speed = 0;
            // Snap vehicle to exact spot position, keep current heading
            vehicle.x = spot.x;
            vehicle.y = spot.y;
            vehicle.parkTime = this.state.time;
            spot.occupied = true;
            spot.vehicleId = vehicle.id;
          }
        }
        break;

      case 'EXITING_SPOT':
        // Check if we've backed into the aisle (reached the aisle waypoint)
        if (vehicle.pathIndex >= 2) {
          vehicle.state = 'DRIVING_TO_EXIT';
          vehicle.location = 'IN_LOT';
          vehicle.behaviors.isReversing = false; // Now driving forward
        }
        break;

      case 'DRIVING_TO_EXIT':
        // Check if we've reached the exit point (top of lot near exit road)
        if (Math.abs(pos.x - exitPoint.x) < 5 && pos.y >= lot.y + lot.height - 15) {
          vehicle.state = 'IN_EXIT_LANE';
          vehicle.location = 'ON_EXIT_ROAD';
        }
        break;

      case 'IN_EXIT_LANE':
        // Driving up exit road, check if near main road
        if (pos.y >= mainRoad.y - 10) {
          vehicle.state = 'AT_MERGE_POINT';
          vehicle.behaviors.isWaitingToMerge = true;
        }
        break;

      case 'AT_MERGE_POINT':
        // Check if safe to merge onto main road
        if (this.canMerge(vehicle)) {
          vehicle.state = 'MERGING';
          vehicle.behaviors.isWaitingToMerge = false;
          vehicle.behaviors.isMerging = true;
        }
        break;

      case 'MERGING':
        // Check if on main road
        if (Math.abs(pos.y - mainRoad.y) < 2) {
          vehicle.state = 'ON_ROAD';
          vehicle.location = 'ON_MAIN_ROAD';
          vehicle.behaviors.isMerging = false;
          // Set lane to bottom lane (lane 0) after merge - this is where exit road joins
          vehicle.currentLane = 0;
          vehicle.targetLane = null;
        }
        break;

      case 'ON_ROAD':
        // Road is westbound, so check if past left edge
        if (pos.x < mainRoad.x - 20) {
          vehicle.state = 'EXITED';
          vehicle.location = 'EXITED';
          vehicle.exitCompleteTime = this.state.time;
          if (vehicle.exitStartTime !== null) {
            this.exitTimes.push(
              vehicle.exitCompleteTime - vehicle.exitStartTime
            );
          }
        }
        break;
    }
  }

  // --------------------------------------------------------------------------
  // SPEED COMPUTATION (Fluid dynamics + IDM)
  // --------------------------------------------------------------------------

  private computeTargetSpeed(vehicle: Vehicle): number {
    // Get max speed for current state (behavior-based)
    const stateMaxSpeed = this.getMaxSpeedForState(vehicle.state);

    // Get speed limit from topology at current position
    const speedLimit = getSpeedLimitAtPosition({ x: vehicle.x, y: vehicle.y }, this.topology);

    // Use the lower of state max and topology speed limit
    const maxSpeed = Math.min(stateMaxSpeed, speedLimit);

    // Get local density and adjust speed
    const density = this.getLocalDensity(vehicle.x, vehicle.y);
    const densityFactor = Math.max(0.2, 1 - density / PHYSICS.JAM_DENSITY);

    // Get gap to vehicle ahead and compute safe speed
    const gap = this.getGapAhead(vehicle);
    const gapSpeed = this.computeSpeedFromGap(vehicle, gap);

    // Check for waiting at merge
    if (vehicle.state === 'AT_MERGE_POINT') {
      return this.canMerge(vehicle) ? SPEEDS.MERGE : 0;
    }

    // Take minimum of all constraints
    return Math.min(maxSpeed * densityFactor, gapSpeed);
  }

  private getMaxSpeedForState(state: VehicleState): number {
    // This returns the BEHAVIOR-based max speed for each state.
    // The actual speed will be min(this, topology speed limit).
    // Use Infinity to let topology speed limit fully control.
    switch (state) {
      case 'APPROACHING':
        return SPEEDS.MAIN_ROAD;  // On main road, approaching entry
      case 'ENTERING':
        return SPEEDS.PARKING_LOT;  // Turning into entry road, slow down
      case 'NAVIGATING_TO_SPOT':
        return SPEEDS.AISLE;  // In the lot navigating
      case 'PARKING':
        return SPEEDS.CREEP;  // Pulling into spot slowly
      case 'PARKED':
        return 0;
      case 'EXITING_SPOT':
        return SPEEDS.BACKUP;  // Backing out slowly
      case 'DRIVING_TO_EXIT':
        return SPEEDS.AISLE;  // Navigating toward exit
      case 'IN_EXIT_LANE':
        return SPEEDS.EXIT_APPROACH;  // On exit road
      case 'AT_MERGE_POINT':
        return 0;  // Stopped waiting to merge
      case 'MERGING':
        return SPEEDS.MERGE;  // Accelerating onto main road
      case 'ON_ROAD':
        return SPEEDS.MAIN_ROAD;  // Full speed on main road
      default:
        return SPEEDS.PARKING_LOT;
    }
  }

  private getLocalDensity(x: number, y: number): number {
    const radius = 15; // meters
    const nearby = this.getNearbyVehicles(x, y, radius);
    const area = Math.PI * radius * radius;
    return nearby.length / area;
  }

  private getGapAhead(vehicle: Vehicle): number {
    const lookAhead = 20; // meters
    const nearby = this.getNearbyVehicles(vehicle.x, vehicle.y, lookAhead);

    let minGap = Infinity;

    for (const other of nearby) {
      if (other.id === vehicle.id) continue;
      if (other.state === 'PARKED' || other.state === 'EXITED') continue;

      // Check if other vehicle is ahead of us
      const dx = other.x - vehicle.x;
      const dy = other.y - vehicle.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Direction we're facing
      const facingX = Math.cos(vehicle.heading);
      const facingY = Math.sin(vehicle.heading);

      // Dot product to check if ahead
      const ahead = dx * facingX + dy * facingY;

      if (ahead > 0) {
        // Vehicle is ahead
        // Lateral distance
        const lateral = Math.abs(-dx * facingY + dy * facingX);

        // Check if in our lane (within vehicle widths)
        if (lateral < CAR_WIDTH * 1.5) {
          const edgeGap = dist - CAR_LENGTH; // edge-to-edge
          minGap = Math.min(minGap, edgeGap);
        }
      }
    }

    // Also check road vehicles when merging
    if (
      vehicle.state === 'MERGING' ||
      vehicle.state === 'AT_MERGE_POINT' ||
      vehicle.state === 'ON_ROAD'
    ) {
      for (const rv of this.state.roadVehicles) {
        const dx = rv.x - vehicle.x;
        const dy = rv.y - vehicle.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < lookAhead && dx > 0) {
          // Ahead on road
          minGap = Math.min(minGap, dist - CAR_LENGTH);
        }
      }
    }

    return minGap;
  }

  private computeSpeedFromGap(vehicle: Vehicle, gap: number): number {
    if (gap < 0) {
      // Overlap! Emergency stop
      return 0;
    }

    if (gap < PHYSICS.MIN_GAP) {
      // Very close, creep
      return SPEEDS.CREEP * 0.5;
    }

    if (gap < PHYSICS.MIN_GAP * 2) {
      return SPEEDS.CREEP;
    }

    // IDM-style: desired gap = min_gap + v * time_headway
    const desiredGap = PHYSICS.MIN_GAP + vehicle.speed * PHYSICS.SAFE_TIME_HEADWAY;

    if (gap < desiredGap) {
      // Too close, slow down proportionally
      const ratio = gap / desiredGap;
      return vehicle.speed * ratio;
    }

    // Gap is fine, return high value (will be clamped by max speed)
    return Infinity;
  }

  // --------------------------------------------------------------------------
  // ACCELERATION AND MOVEMENT
  // --------------------------------------------------------------------------

  private applyAcceleration(vehicle: Vehicle, dt: number): void {
    const speedDiff = vehicle.targetSpeed - vehicle.speed;

    if (speedDiff > 0) {
      // Accelerate
      vehicle.acceleration = Math.min(speedDiff / dt, PHYSICS.MAX_ACCELERATION);
    } else {
      // Decelerate
      vehicle.acceleration = Math.max(speedDiff / dt, -PHYSICS.MAX_DECELERATION);
    }

    vehicle.speed += vehicle.acceleration * dt;
    vehicle.speed = Math.max(0, vehicle.speed);
  }

  private followPath(vehicle: Vehicle, dt: number): void {
    if (vehicle.path.length === 0 || vehicle.pathIndex >= vehicle.path.length) {
      return;
    }

    const target = vehicle.path[vehicle.pathIndex];
    const { mainRoad, entryRoad } = this.topology;

    // Check if vehicle is at the turn point (at entry road x-position, ready to turn south)
    const entryRoadLeft = entryRoad.x - entryRoad.width / 2;
    const entryRoadRight = entryRoad.x + entryRoad.width / 2;
    const isAtTurnPoint = vehicle.location === 'ON_MAIN_ROAD' &&
                          vehicle.x >= entryRoadLeft - 5 &&
                          vehicle.x <= entryRoadRight + 5 &&
                          vehicle.currentLane === 0; // Must be in bottom lane to turn

    // When at turn point, prepare for the turn:
    // - Skip main road waypoints (pathIndex 0-1) to the turn waypoint (pathIndex 2)
    // - Set heading to south immediately
    //
    // Why this is needed:
    // The path has waypoints: [spawn point, entry road x on main road, just below main road, ...]
    // When isAtTurnPoint triggers, pathIndex may still be 0 or 1, pointing to a waypoint
    // behind or at the car's current position. The angleTo() calculation would then
    // point backward, causing the car to spin in a full circle trying to reach it.
    // By advancing to pathIndex 2 and setting heading south, we skip the stale waypoints.
    if (isAtTurnPoint && vehicle.pathIndex < 2) {
      vehicle.pathIndex = 2; // Jump to the "just below main road" waypoint
      vehicle.heading = -Math.PI / 2; // Face south immediately
    }

    // Special handling for vehicles on main road (but not at turn point):
    // - Only check x-distance for waypoint completion (y is controlled by lane logic)
    // - Drive straight west, don't turn toward waypoint y
    if (vehicle.location === 'ON_MAIN_ROAD' && !vehicle.behaviors.isChangingLane && !isAtTurnPoint) {
      const xDist = Math.abs(vehicle.x - target.x);

      // Check if we've reached the waypoint's x-position
      if (xDist < 5) {
        vehicle.pathIndex++;
        if (vehicle.pathIndex >= vehicle.path.length) {
          return;
        }
      }

      // Drive straight west (heading = π), y is controlled by lane change logic
      vehicle.heading = Math.PI;
      vehicle.x += Math.cos(vehicle.heading) * vehicle.speed * dt;
      // y-position is updated by executeLaneChange or stays in current lane
      // Keep vehicle in its current lane if not changing
      if (vehicle.currentLane !== null) {
        const targetLaneY = getLaneY(mainRoad, vehicle.currentLane);
        vehicle.y = targetLaneY;
      }
    } else {
      // Normal path following for other locations
      const dist = distance({ x: vehicle.x, y: vehicle.y }, target);

      if (dist < 2) {
        // Reached waypoint, move to next
        vehicle.pathIndex++;
        if (vehicle.pathIndex >= vehicle.path.length) {
          return;
        }
      }

      if (vehicle.behaviors.isReversing) {
        // When reversing, move backward (opposite to heading) without turning
        // The car backs up straight toward the target
        vehicle.x -= Math.cos(vehicle.heading) * vehicle.speed * dt;
        vehicle.y -= Math.sin(vehicle.heading) * vehicle.speed * dt;
      } else {
        // Normal forward driving: turn toward target and move forward
        const targetHeading = angleTo({ x: vehicle.x, y: vehicle.y }, target);

        // Smoothly turn toward target
        const headingDiff = normalizeAngle(targetHeading - vehicle.heading);
        const turnRate = 2.0; // radians per second max
        const maxTurn = turnRate * dt;
        const turn = Math.max(-maxTurn, Math.min(maxTurn, headingDiff));
        vehicle.heading = normalizeAngle(vehicle.heading + turn);

        // Move forward
        vehicle.x += Math.cos(vehicle.heading) * vehicle.speed * dt;
        vehicle.y += Math.sin(vehicle.heading) * vehicle.speed * dt;
      }
    }

    // Track wait time
    if (vehicle.speed < 0.1) {
      vehicle.waitTime += dt;
    } else {
      vehicle.waitTime = 0;
    }
  }

  // --------------------------------------------------------------------------
  // LANE CHANGE LOGIC
  // --------------------------------------------------------------------------

  /**
   * Check if vehicle needs to change lanes (e.g., to reach entry road).
   * Returns target lane number or null if no change needed.
   */
  private checkLaneChangeNeed(vehicle: Vehicle): number | null {
    // Only check lane changes on main road
    if (vehicle.location !== 'ON_MAIN_ROAD') return null;
    if (vehicle.currentLane === null) return null;

    const { entryRoad } = this.topology;

    // Vehicles seeking parking need to be in bottom lane (lane 0) to turn right into entry road
    // Lane 0 is at y = road.y - road.width/2 + laneWidth/2, which is the southernmost (bottom) lane
    if (vehicle.intent === 'SEEKING_PARKING') {
      const targetLane = 0; // Bottom lane (lane 0 = south, closest to lot)
      if (vehicle.currentLane !== targetLane) {
        // Check how far we are from the entry point
        const distanceToEntry = vehicle.x - entryRoad.x;

        // Start lane change when approaching entry road (need enough distance)
        if (distanceToEntry > PHYSICS.LANE_CHANGE_LOOK_AHEAD && distanceToEntry < PHYSICS.LANE_CHANGE_LOOK_AHEAD * 3) {
          return targetLane;
        }
      }
    }

    return null;
  }

  /**
   * Check if it's safe to change to the target lane.
   * Uses realistic gap checking both ahead and behind in target lane.
   */
  private canChangeLane(vehicle: Vehicle, targetLane: number): boolean {
    const { mainRoad } = this.topology;
    const targetLaneY = getLaneY(mainRoad, targetLane);

    // Check gap in target lane
    const minGapAhead = PHYSICS.LANE_CHANGE_MIN_GAP;
    const minGapBehind = PHYSICS.LANE_CHANGE_LOOK_BEHIND;

    // Check road vehicles in target lane
    for (const rv of this.state.roadVehicles) {
      if (rv.lane !== targetLane) continue;

      const dx = rv.x - vehicle.x;

      // Vehicle ahead in target lane
      if (dx > 0 && dx < minGapAhead) {
        return false;
      }

      // Vehicle behind in target lane (check relative speed too)
      if (dx < 0 && dx > -minGapBehind) {
        // If vehicle behind is faster, need more gap
        const speedDiff = rv.speed - vehicle.speed;
        const timeToClose = speedDiff > 0 ? Math.abs(dx) / speedDiff : Infinity;
        if (timeToClose < 3) { // Less than 3 seconds to close gap
          return false;
        }
      }
    }

    // Check other vehicles (simulation vehicles) in target lane
    for (const other of this.state.vehicles) {
      if (other.id === vehicle.id) continue;
      if (other.state === 'PARKED' || other.state === 'EXITED') continue;
      if (other.location !== 'ON_MAIN_ROAD') continue;

      // Check if in target lane (by y-position)
      if (Math.abs(other.y - targetLaneY) > LANE_WIDTH / 2) continue;

      const dx = other.x - vehicle.x;

      if (dx > 0 && dx < minGapAhead) {
        return false;
      }
      if (dx < 0 && dx > -minGapBehind) {
        return false;
      }
    }

    return true;
  }

  /**
   * Execute lane change - smoothly interpolate y position.
   */
  private executeLaneChange(vehicle: Vehicle, dt: number): void {
    if (!vehicle.behaviors.isChangingLane || vehicle.targetLane === null) return;

    const { mainRoad } = this.topology;
    const targetLaneY = getLaneY(mainRoad, vehicle.targetLane);

    // Progress through lane change
    vehicle.behaviors.laneChangeProgress += dt / PHYSICS.LANE_CHANGE_TIME;

    if (vehicle.behaviors.laneChangeProgress >= 1) {
      // Lane change complete
      vehicle.y = targetLaneY;
      vehicle.currentLane = vehicle.targetLane;
      vehicle.targetLane = null;
      vehicle.behaviors.isChangingLane = false;
      vehicle.behaviors.laneChangeProgress = 0;
      vehicle.behaviors.laneChangeDirection = null;
      vehicle.laneChangeStartY = null;
    } else {
      // Smooth interpolation using ease-in-out
      const startY = vehicle.laneChangeStartY!;
      const t = vehicle.behaviors.laneChangeProgress;
      const smoothT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
      vehicle.y = startY + (targetLaneY - startY) * smoothT;
    }
  }

  /**
   * Update lane change state for a vehicle.
   */
  private updateLaneChange(vehicle: Vehicle, dt: number): void {
    // If already changing lanes, continue
    if (vehicle.behaviors.isChangingLane) {
      this.executeLaneChange(vehicle, dt);
      return;
    }

    // Check if we need to change lanes
    const neededLane = this.checkLaneChangeNeed(vehicle);
    if (neededLane !== null && neededLane !== vehicle.currentLane) {
      // Check if safe to change
      if (this.canChangeLane(vehicle, neededLane)) {
        // Start lane change
        vehicle.behaviors.isChangingLane = true;
        vehicle.targetLane = neededLane;
        vehicle.laneChangeStartY = vehicle.y;
        vehicle.behaviors.laneChangeProgress = 0;
        vehicle.behaviors.laneChangeDirection =
          neededLane > vehicle.currentLane! ? 'right' : 'left';
      }
    }
  }

  // --------------------------------------------------------------------------
  // MERGING LOGIC
  // --------------------------------------------------------------------------

  private canMerge(vehicle: Vehicle): boolean {
    // Check for safe gap in road traffic
    const mergeX = vehicle.x;

    // Look for vehicles on the road near the merge point
    const safeGapTime = 3; // seconds
    const safeGap = SPEEDS.MAIN_ROAD * safeGapTime;

    for (const rv of this.state.roadVehicles) {
      const dx = rv.x - mergeX;

      // Vehicle is approaching from behind (west) or is ahead but close
      if (dx > -safeGap && dx < safeGap) {
        return false;
      }
    }

    // Also check other merging vehicles
    const nearby = this.getNearbyVehicles(vehicle.x, vehicle.y, safeGap);
    for (const other of nearby) {
      if (other.id === vehicle.id) continue;
      if (other.state === 'MERGING' || other.state === 'ON_ROAD') {
        if (Math.abs(other.x - vehicle.x) < safeGap) {
          return false;
        }
      }
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // COLLISION RESOLUTION
  // --------------------------------------------------------------------------

  private resolveCollisions(): void {
    for (let i = 0; i < this.state.vehicles.length; i++) {
      const v1 = this.state.vehicles[i];
      if (v1.state === 'PARKED' || v1.state === 'EXITED') continue;

      const nearby = this.getNearbyVehicles(v1.x, v1.y, CAR_LENGTH * 2);

      for (const v2 of nearby) {
        if (v2.id <= v1.id) continue; // avoid double-checking pairs
        if (v2.state === 'PARKED' || v2.state === 'EXITED') continue;

        if (this.checkCollision(v1, v2)) {
          // Priority: vehicle closer to exit continues, other stops
          const priority1 = this.getExitPriority(v1);
          const priority2 = this.getExitPriority(v2);

          if (priority1 < priority2) {
            v1.speed = 0;
            v1.targetSpeed = 0;
          } else {
            v2.speed = 0;
            v2.targetSpeed = 0;
          }
        }
      }
    }
  }

  private checkCollision(v1: Vehicle, v2: Vehicle): boolean {
    const dist = distance({ x: v1.x, y: v1.y }, { x: v2.x, y: v2.y });
    const minDist = (CAR_LENGTH + CAR_WIDTH) / 2; // approximate
    return dist < minDist;
  }

  private getExitPriority(vehicle: Vehicle): number {
    // Higher = closer to exiting
    switch (vehicle.state) {
      case 'ON_ROAD':
        return 100 + vehicle.x;
      case 'MERGING':
        return 90;
      case 'AT_MERGE_POINT':
        return 80;
      case 'IN_EXIT_LANE':
        return 70 + vehicle.y;
      case 'DRIVING_TO_EXIT':
        return 60 + vehicle.y;
      case 'EXITING_SPOT':
        return 50;
      default:
        return 0;
    }
  }

  // --------------------------------------------------------------------------
  // ROAD TRAFFIC
  // --------------------------------------------------------------------------

  private updateRoadTraffic(dt: number): void {
    // Spawn new road vehicles
    const spawnRate = this.config.roadTrafficRate / 60; // per second
    if (Math.random() < spawnRate * dt) {
      this.spawnRoadVehicle();
    }

    // Update existing road vehicles (westbound = decreasing x)
    for (const rv of this.state.roadVehicles) {
      rv.x -= rv.speed * dt;
    }

    // Remove vehicles that have exited (left side of road)
    this.state.roadVehicles = this.state.roadVehicles.filter(
      (rv) => rv.x > this.topology.mainRoad.x - 50
    );
  }

  private spawnRoadVehicle(): void {
    const { mainRoad } = this.topology;
    // Road is westbound, so spawn from the right (east) side
    const lane = Math.floor(Math.random() * mainRoad.lanes);
    // Calculate y position based on lane
    const laneY = getLaneY(mainRoad, lane);

    this.state.roadVehicles.push({
      id: this.nextRoadVehicleId++,
      x: mainRoad.x + mainRoad.length + 20,
      y: laneY,
      lane: lane,
      speed: mainRoad.speedLimit * (0.9 + Math.random() * 0.2),
      targetLane: null,
      laneChangeProgress: 0,
    });
  }

  // --------------------------------------------------------------------------
  // VEHICLE SPAWNING
  // --------------------------------------------------------------------------

  spawnVehicle(): Vehicle | null {
    const spot = findRandomSpot(this.topology);
    if (!spot) return null;

    // Spawn on main road (coming from east, road is westbound)
    const { mainRoad } = this.topology;

    // Spawn in a random lane - cars will need to change to bottom lane to enter
    // Lane 0 is at bottom (south, closest to lot), lane 2 is at top (north)
    const spawnLane = Math.floor(Math.random() * mainRoad.lanes);
    const laneY = getLaneY(mainRoad, spawnLane);

    // Generate path with spawn lane info so first waypoint matches spawn position
    const entryPath = generateEntryPath(this.topology, spot, spawnLane);

    const vehicle: Vehicle = {
      id: this.nextVehicleId++,
      x: mainRoad.x + mainRoad.length + 10, // Start just off the right edge of main road
      y: laneY,
      heading: Math.PI, // facing west (direction of traffic)
      speed: SPEEDS.MAIN_ROAD,
      targetSpeed: SPEEDS.MAIN_ROAD,
      acceleration: 0,

      // Layer 1: Location
      location: 'ON_MAIN_ROAD',

      // Layer 2: Intent
      intent: 'SEEKING_PARKING',

      // Layer 3: Behaviors
      behaviors: { ...DEFAULT_BEHAVIOR_FLAGS },

      // Layer 4: Traffic control
      trafficControl: {
        nearestLightId: null,
        lightColor: null,
        distanceToLight: Infinity,
        mustStop: false,
      },

      // Lane tracking
      currentLane: spawnLane,
      targetLane: spawnLane, // Will change to bottom lane if needed
      laneChangeStartY: null,

      // Legacy state (for compatibility)
      state: 'APPROACHING',

      targetSpotId: spot.id,
      exitLaneId: null,
      path: entryPath,
      pathIndex: 0,
      spawnTime: this.state.time,
      parkTime: null,
      exitStartTime: null,
      exitCompleteTime: null,
      waitTime: 0,
      color: COLORS.vehicle.APPROACHING,
    };

    this.state.vehicles.push(vehicle);
    this.state.totalSpawned++;

    return vehicle;
  }

  // --------------------------------------------------------------------------
  // FILL LOT
  // --------------------------------------------------------------------------

  fillLot(count: number): void {
    this.state.phase = 'FILLING';

    // Spawn vehicles with slight randomization
    const toSpawn = Math.min(count, this.topology.spots.length);

    for (let i = 0; i < toSpawn; i++) {
      this.spawnVehicle();
    }
  }

  // --------------------------------------------------------------------------
  // EXODUS
  // --------------------------------------------------------------------------

  startExodus(): void {
    this.state.phase = 'EXODUS';

    const parkedVehicles = this.state.vehicles.filter(
      (v) => v.state === 'PARKED'
    );

    for (let i = 0; i < parkedVehicles.length; i++) {
      const vehicle = parkedVehicles[i];

      // Stagger exit times
      const delay =
        this.config.staggerExitSeconds > 0
          ? (i / parkedVehicles.length) * this.config.staggerExitSeconds
          : 0;

      // Schedule exit
      setTimeout(() => {
        this.startVehicleExit(vehicle);
      }, delay * 1000);
    }
  }

  private startVehicleExit(vehicle: Vehicle): void {
    if (vehicle.state !== 'PARKED') return;

    // Free up the parking spot
    const spot = this.topology.spots[vehicle.targetSpotId!];
    spot.occupied = false;
    spot.vehicleId = null;

    // Generate exit path (no longer needs exit lane assignment - single exit road)
    const exitPath = generateExitPath(this.topology, spot);

    vehicle.state = 'EXITING_SPOT';
    vehicle.location = 'IN_SPOT'; // Still in spot until backed out
    vehicle.intent = 'EXITING_LOT';
    vehicle.exitStartTime = this.state.time;
    vehicle.path = exitPath;
    vehicle.pathIndex = 0;
    vehicle.behaviors.isReversing = true; // Back out of the spot
  }

  // --------------------------------------------------------------------------
  // COUNTERS AND METRICS
  // --------------------------------------------------------------------------

  private updateCounters(): void {
    this.state.parkedCount = this.state.vehicles.filter(
      (v) => v.state === 'PARKED'
    ).length;

    this.state.exitedCount = this.state.vehicles.filter(
      (v) => v.state === 'EXITED'
    ).length;

    // Calculate average exit time
    if (this.exitTimes.length > 0) {
      this.state.avgExitTime =
        this.exitTimes.reduce((a, b) => a + b, 0) / this.exitTimes.length;
    }

    // Calculate throughput (vehicles per minute over last minute)
    const oneMinuteAgo = this.state.time - 60;
    const recentExits = this.state.vehicles.filter(
      (v) =>
        v.state === 'EXITED' &&
        v.exitCompleteTime !== null &&
        v.exitCompleteTime > oneMinuteAgo
    ).length;
    this.state.throughput = recentExits;
  }

  private checkPhaseTransitions(): void {
    if (this.state.phase === 'FILLING') {
      // Check if all vehicles are parked
      const allParked = this.state.vehicles.every(
        (v) => v.state === 'PARKED' || v.state === 'EXITED'
      );
      if (allParked && this.state.parkedCount > 0) {
        this.state.phase = 'WAITING';
      }
    }

    if (this.state.phase === 'EXODUS') {
      // Check if all vehicles have exited
      const allExited = this.state.vehicles.every((v) => v.state === 'EXITED');
      if (allExited && this.state.exitedCount > 0) {
        this.state.phase = 'COMPLETE';
      }
    }
  }

  // --------------------------------------------------------------------------
  // RESET
  // --------------------------------------------------------------------------

  reset(): void {
    this.state = {
      time: 0,
      phase: 'IDLE',
      vehicles: [],
      roadVehicles: [],
      totalSpawned: 0,
      parkedCount: 0,
      exitedCount: 0,
      avgExitTime: null,
      throughput: 0,
    };

    // Reset spots
    for (const spot of this.topology.spots) {
      spot.occupied = false;
      spot.vehicleId = null;
    }

    this.nextVehicleId = 0;
    this.nextRoadVehicleId = 0;
    this.exitTimes = [];
  }
}
