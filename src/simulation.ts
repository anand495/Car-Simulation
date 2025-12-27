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
  AISLE_WIDTH,
  GRID_CELL_SIZE,
  COLORS,
  DEFAULT_CONFIG,
  DEFAULT_BEHAVIOR_FLAGS,
  SimulationLog,
  VehicleSnapshot,
  SimulationEvent,
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
  private exitTimes: number[] = [];

  // Logging
  private log: SimulationLog;
  private lastLogTime = 0;

  constructor(topology: Topology, config: SimConfig = DEFAULT_CONFIG) {
    this.topology = topology;
    this.config = config;

    // Initialize log
    this.log = {
      startTime: new Date(),
      snapshots: [],
      events: [],
    };

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

    // Process staggered vehicle spawning
    this.processSpawnQueue();

    // Update all vehicles
    for (const vehicle of this.state.vehicles) {
      if (vehicle.state !== 'PARKED' && vehicle.state !== 'EXITED') {
        this.updateVehicle(vehicle, dt);
      }
    }

    // Resolve any collisions
    this.resolveCollisions();

    // Count exited vehicles before removing them
    const newlyExited = this.state.vehicles.filter(v => v.state === 'EXITED').length;
    this.state.exitedCount += newlyExited;

    // Remove exited vehicles to prevent memory buildup
    // Keep only vehicles that haven't exited yet
    this.state.vehicles = this.state.vehicles.filter(v => v.state !== 'EXITED');

    // Update counters (parkedCount, throughput, avgExitTime)
    this.updateCounters();

    // Update time
    this.state.time += dt;

    // Check phase transitions
    this.checkPhaseTransitions();

    // Capture log snapshot at configured interval
    if (this.config.enableLogging) {
      this.captureLogSnapshot();
    }
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
    
    // Track wait time for visual feedback (red color when stuck >3 sec)
    // but don't auto-skip waypoints - let the natural flow resolve
    if (vehicle.speed < 0.1 && vehicle.state !== 'PARKED' && vehicle.state !== 'AT_MERGE_POINT') {
      vehicle.waitTime += dt;
    } else {
      vehicle.waitTime = 0;
    }
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

        // MISSED TURN DETECTION: If car passed entry by more than 50m, remove it
        // This handles cars that couldn't change lanes in time
        const distancePastEntry = entryRoad.x - pos.x;
        if (distancePastEntry > 50) {
          // Car missed its turn - mark as exited (can't turn back on one-way road)
          vehicle.state = 'EXITED';
          vehicle.location = 'EXITED';
          vehicle.speed = 0;

          // Free up the assigned spot so another car can take it
          if (vehicle.targetSpotId !== null) {
            const spot = this.topology.spots[vehicle.targetSpotId];
            spot.occupied = false;
            spot.vehicleId = null;
          }

          // Log the missed turn
          this.logEvent(vehicle.id, 'EXITED', {
            reason: 'missed_turn',
            distancePastEntry,
            lane: vehicle.currentLane,
          });

          // Spawn a replacement vehicle to take the spot
          // This ensures we eventually fill the lot even with missed turns
          if (this.state.phase === 'FILLING') {
            this.spawnQueue++;
          }

          break;
        }

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

            // Log parked event
            this.logEvent(vehicle.id, 'PARKED', {
              spotId: spot.id,
              parkTime: this.state.time - vehicle.spawnTime,
            });
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
        // Driving up exit road, check if near main road merge point
        // Merge point is at the bottom edge of main road (lane 0)
        const mergePointY = mainRoad.y - mainRoad.width / 2 + (mainRoad.width / mainRoad.lanes) / 2;
        if (pos.y >= mergePointY - 5) {
          vehicle.state = 'AT_MERGE_POINT';
          vehicle.behaviors.isWaitingToMerge = true;
          // Stop at merge point until safe to merge
          vehicle.speed = 0;
        }
        break;

      case 'AT_MERGE_POINT':
        // Check if safe to merge onto main road
        if (this.canMerge(vehicle)) {
          vehicle.state = 'MERGING';
          vehicle.behaviors.isWaitingToMerge = false;
          vehicle.behaviors.isMerging = true;
          vehicle.waitTime = 0; // Reset wait time on successful merge
        } else {
          // TIMEOUT PROTECTION: If waiting too long at merge point,
          // find a gap and force merge to prevent infinite waiting
          if (vehicle.waitTime > 10) {
            // After 10 seconds, use less restrictive gap check
            const hasMinimalGap = this.hasMinimalMergeGap(vehicle);
            if (hasMinimalGap) {
              vehicle.state = 'MERGING';
              vehicle.behaviors.isWaitingToMerge = false;
              vehicle.behaviors.isMerging = true;
              vehicle.waitTime = 0;
            }
          }
        }
        break;

      case 'MERGING':
        // Check if vehicle has reached the main road lane 0 (bottom lane)
        // Lane 0 y-position is at mainRoad.y - mainRoad.width/2 + laneWidth/2
        const laneWidth = mainRoad.width / mainRoad.lanes;
        const lane0Y = mainRoad.y - mainRoad.width / 2 + laneWidth / 2;

        // Complete merge when we're close to lane 0 y-position
        if (Math.abs(pos.y - lane0Y) < 2) {
          vehicle.state = 'ON_ROAD';
          vehicle.location = 'ON_MAIN_ROAD';
          vehicle.behaviors.isMerging = false;
          // Set lane to bottom lane (lane 0) after merge - this is where exit road joins
          vehicle.currentLane = 0;
          vehicle.targetLane = null;
          // Snap to lane center for clean driving
          vehicle.y = lane0Y;
          // Face west (direction of traffic)
          vehicle.heading = Math.PI;
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

          // Log exited event
          this.logEvent(vehicle.id, 'EXITED', {
            totalTime: this.state.time - vehicle.spawnTime,
            exitTime: vehicle.exitStartTime !== null
              ? vehicle.exitCompleteTime - vehicle.exitStartTime
              : null,
          });
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

    // --- COOPERATIVE YIELDING LOGIC ---
    // If someone is trying to merge in front of us, we should slow down.
    const yieldSpeed = this.getCooperativeYieldSpeed(vehicle);

    // Check for waiting at merge
    if (vehicle.state === 'AT_MERGE_POINT') {
      return this.canMerge(vehicle) ? SPEEDS.MERGE : 0;
    }

    // Take minimum of all constraints
    return Math.min(maxSpeed * densityFactor, gapSpeed, yieldSpeed);
  }

  /**
   * Checks if any vehicle in an adjacent lane is ahead of us and signaling
   * to merge into our lane. Also implements proactive slowdown near junctions.
   */
  private getCooperativeYieldSpeed(me: Vehicle): number {
    if (me.location !== 'ON_MAIN_ROAD' || me.currentLane === null) return Infinity;

    const lookAhead = 40; // Look ahead for mergers
    const nearby = this.getNearbyVehicles(me.x, me.y, lookAhead);
    let yieldSpeed = Infinity;

    for (const other of nearby) {
      if (other.id === me.id) continue;

      // Is the other car changing lanes into our lane?
      if (other.behaviors.isChangingLane && other.targetLane === me.currentLane) {
        // Is it ahead of me? (Westbound: smaller X is ahead)
        if (other.x < me.x && other.x > me.x - lookAhead) {
           const dist = me.x - other.x;
           yieldSpeed = Math.min(yieldSpeed, this.computeSpeedFromGap(me, dist - CAR_LENGTH * 1.5));
        }
      }

      // Yield to vehicles turning at entry zone (even if they haven't changed location yet)
      if (me.currentLane === 0 && other.location === 'ON_MAIN_ROAD') {
        const { entryRoad } = this.topology;
        const nearEntry = other.x >= entryRoad.x - 10 && other.x <= entryRoad.x + 10;

        if (nearEntry && other.x < me.x) {
          // Check if they're turning or about to turn
          const headingDiff = Math.abs(normalizeAngle(other.heading - Math.PI));
          const isTurning = headingDiff > Math.PI / 8; // Even 22.5° off from west
          const isSlowingDown = other.speed < SPEEDS.MAIN_ROAD * 0.3;

          if (isTurning || isSlowingDown) {
            const dist = me.x - other.x;
            yieldSpeed = Math.min(yieldSpeed, this.computeSpeedFromGap(me, dist - CAR_LENGTH * 2));
          }
        }
      }
    }

    // PROACTIVE SLOWDOWN: When in lane 0 approaching the entry zone, slow down slightly
    // to give time to react to cars turning. This is realistic defensive driving.
    if (me.currentLane === 0 && me.intent !== 'SEEKING_PARKING') {
      const { entryRoad } = this.topology;
      const distToEntry = me.x - entryRoad.x;

      // Start slowing 50m before entry zone, continue until 20m past
      if (distToEntry > -20 && distToEntry < 50) {
        // Reduce max speed to 70% when passing the entry zone
        yieldSpeed = Math.min(yieldSpeed, SPEEDS.MAIN_ROAD * 0.7);
      }
    }

    return yieldSpeed;
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
      if (other.state === 'EXITED') continue;
      // Note: PARKED cars ARE obstacles - they should block movement

      // Skip vehicles on different roads (they can't block us)
      // Exception: check all vehicles when at junctions (entry/exit points)
      if (vehicle.location !== other.location) {
        // Only consider cross-location conflicts at specific transition zones
        const atJunction = vehicle.location === 'ON_MAIN_ROAD' &&
                          (other.location === 'ON_ENTRY_ROAD' || other.location === 'ON_EXIT_ROAD');
        const otherAtJunction = other.location === 'ON_MAIN_ROAD' &&
                                (vehicle.location === 'ON_ENTRY_ROAD' || vehicle.location === 'ON_EXIT_ROAD');
        if (!atJunction && !otherAtJunction) {
          continue; // Different roads, not at junction - skip
        }
      }

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
        // Use 1.5x width - balanced between false positives and missing real conflicts
        let isBlocking = lateral < CAR_WIDTH * 1.5;

        // DISCIPLINED YIELDING: Yield to vehicles that are turning or merging at junctions.
        // This prevents rear-ending and creates realistic traffic flow.
        if (!isBlocking && vehicle.location === 'ON_MAIN_ROAD') {
          const { entryRoad, exitRoad } = this.topology;

          // Case 1: Yield to vehicles turning into entry road
          if (other.location === 'ON_MAIN_ROAD') {
            const nearEntryZone = other.x >= entryRoad.x - entryRoad.width / 2 - 10 &&
                                  other.x <= entryRoad.x + entryRoad.width / 2 + 10;

            if (nearEntryZone) {
              // Check if the other vehicle is turning (heading significantly different from west)
              const headingDiff = Math.abs(normalizeAngle(other.heading - Math.PI));
              const isTurning = headingDiff > Math.PI / 6; // More than 30° off from west

              // Also check if they're slowing down significantly (preparing to turn)
              const isSlowingDown = other.speed < SPEEDS.MAIN_ROAD * 0.5;

              if (isTurning || isSlowingDown) {
                if (dist < 15 && ahead > 1) {
                  isBlocking = true;
                }
              }
            }
          }

          // Case 2: Yield to vehicles merging from exit road
          if (other.state === 'MERGING' || other.state === 'AT_MERGE_POINT') {
            const nearExitZone = Math.abs(other.x - exitRoad.x) < exitRoad.width + 10;
            if (nearExitZone && dist < 20 && ahead > 0) {
              // A car is merging ahead - yield
              isBlocking = true;
            }
          }
        }

        if (isBlocking) {
          const edgeGap = dist - CAR_LENGTH; // edge-to-edge
          minGap = Math.min(minGap, edgeGap);
        }
      }
    }

    // Note: roadVehicles array is no longer used - all traffic (including pass-through)
    // is now in the main vehicles array and already checked above

    return minGap;
  }

  private computeSpeedFromGap(vehicle: Vehicle, gap: number): number {
    // Handle negative gaps (overlap) - return slow creep to allow separation
    if (gap < 0) {
      return SPEEDS.CREEP * 0.5;
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
    const { mainRoad, entryRoad } = this.topology;

    // RECOVERY BEHAVIOR: If vehicle is outside paved area, try to get back on track
    if (!this.isWithinPavedArea(vehicle.x, vehicle.y)) {
      this.recoverFromOffRoad(vehicle, dt);
      return;
    }

    // Check if vehicle is at the turn point (at entry road x-position, ready to turn south)
    const entryRoadLeft = entryRoad.x - entryRoad.width / 2;
    const entryRoadRight = entryRoad.x + entryRoad.width / 2;
    const isAtTurnZone = vehicle.location === 'ON_MAIN_ROAD' &&
                          vehicle.x >= entryRoadLeft - 5 &&
                          vehicle.x <= entryRoadRight + 5;
    // Can only turn if: in turn zone, in lane 0, AND seeking parking (not pass-through)
    const canTurn = isAtTurnZone && vehicle.currentLane === 0 && vehicle.intent === 'SEEKING_PARKING';

    // When at turn point AND in correct lane, prepare for the turn:
    if (canTurn && vehicle.pathIndex < 2) {
      vehicle.pathIndex = 2; // Jump to the "just below main road" waypoint
      vehicle.heading = -Math.PI / 2; // Face south immediately
    }

    // Special handling for vehicles on main road:
    // They should keep driving west regardless of path state
    if (vehicle.location === 'ON_MAIN_ROAD' && !vehicle.behaviors.isChangingLane && !canTurn) {
      // If in turn zone but wrong lane, slow down and try to change lanes
      if (isAtTurnZone && vehicle.currentLane !== 0 && vehicle.currentLane !== null) {
        vehicle.targetSpeed = SPEEDS.CREEP;
        const targetLane = vehicle.currentLane - 1;
        if (this.canChangeLane(vehicle, targetLane)) {
          vehicle.behaviors.isChangingLane = true;
          vehicle.targetLane = targetLane;
          vehicle.laneChangeStartY = vehicle.y;
          vehicle.behaviors.laneChangeProgress = 0;
          vehicle.behaviors.laneChangeDirection = 'left';
        }
      }

      // Advance path index if we've passed waypoints (but don't stop if path exhausted)
      if (vehicle.pathIndex < vehicle.path.length) {
        const target = vehicle.path[vehicle.pathIndex];
        const xDist = Math.abs(vehicle.x - target.x);
        if (xDist < 5) {
          vehicle.pathIndex++;
        }
      }

      // ALWAYS drive west on main road - don't stop just because path is exhausted
      vehicle.heading = Math.PI;
      vehicle.x += Math.cos(vehicle.heading) * vehicle.speed * dt;

      // Keep vehicle in its current lane if not changing
      if (vehicle.currentLane !== null) {
        const targetLaneY = getLaneY(mainRoad, vehicle.currentLane);
        vehicle.y = targetLaneY;
      }
      return;
    }

    // For non-main-road movement, we need a valid path target
    if (vehicle.path.length === 0 || vehicle.pathIndex >= vehicle.path.length) {
      // Path exhausted - for PARKING state, move toward spot directly
      if (vehicle.state === 'PARKING' && vehicle.targetSpotId !== null) {
        const spot = this.topology.spots[vehicle.targetSpotId];
        const targetHeading = angleTo({ x: vehicle.x, y: vehicle.y }, { x: spot.x, y: spot.y });
        const headingDiff = normalizeAngle(targetHeading - vehicle.heading);
        const turnRate = 2.0;
        const maxTurn = turnRate * dt;
        const turn = Math.max(-maxTurn, Math.min(maxTurn, headingDiff));
        vehicle.heading = normalizeAngle(vehicle.heading + turn);
        vehicle.x += Math.cos(vehicle.heading) * vehicle.speed * dt;
        vehicle.y += Math.sin(vehicle.heading) * vehicle.speed * dt;
      }
      return;
    }

    const target = vehicle.path[vehicle.pathIndex];

    {
      // Normal path following for other locations
      const dist = distance({ x: vehicle.x, y: vehicle.y }, target);

      // Waypoint acceptance radius: 3m general, 2.5m for parking
      // Large enough to progress but small enough to not skip waypoints
      const acceptanceRadius = vehicle.state === 'PARKING' ? 2.5 : 3.0;

      if (dist < acceptanceRadius) {
        // Reached waypoint, move to next
        vehicle.pathIndex++;
        if (vehicle.pathIndex >= vehicle.path.length) {
          return;
        }
      }

      if (vehicle.behaviors.isReversing) {
        // When reversing, move backward (opposite to heading) without turning
        vehicle.x -= Math.cos(vehicle.heading) * vehicle.speed * dt;
        vehicle.y -= Math.sin(vehicle.heading) * vehicle.speed * dt;
      } else {
        // Normal forward driving: turn toward target and move forward
        let targetHeading = angleTo({ x: vehicle.x, y: vehicle.y }, target);

        // Check for parked cars blocking our path and steer around them
        const avoidanceHeading = this.getObstacleAvoidanceHeading(vehicle, targetHeading);
        if (avoidanceHeading !== null) {
          targetHeading = avoidanceHeading;
        }

        // Smoothly turn toward target
        const headingDiff = normalizeAngle(targetHeading - vehicle.heading);
        const turnRate = 2.0; // radians per second max
        const maxTurn = turnRate * dt;
        const turn = Math.max(-maxTurn, Math.min(maxTurn, headingDiff));
        vehicle.heading = normalizeAngle(vehicle.heading + turn);

        // Move forward
        const newX = vehicle.x + Math.cos(vehicle.heading) * vehicle.speed * dt;
        const newY = vehicle.y + Math.sin(vehicle.heading) * vehicle.speed * dt;

        // Only apply movement if it keeps us within paved areas
        if (this.isWithinPavedArea(newX, newY)) {
          vehicle.x = newX;
          vehicle.y = newY;
        } else {
          // Position would be off-road - allow movement along valid axis only
          if (this.isWithinPavedArea(newX, vehicle.y)) {
            vehicle.x = newX;
          }
          if (this.isWithinPavedArea(vehicle.x, newY)) {
            vehicle.y = newY;
          }
        }
      }
    }
  }

  /**
   * Check if a coordinate is within any valid paved area.
   * This includes main road, entry road, exit road, and parking lot.
   * Roads can overlap at junctions, so a position is valid if it's on ANY paved surface.
   */
  private isWithinPavedArea(x: number, y: number): boolean {
    const { mainRoad, entryRoad, exitRoad, lot } = this.topology;

    // Check main road bounds
    // Extend left boundary past the visual road to allow vehicles to reach despawn point (x < -20)
    const mainRoadTop = mainRoad.y + mainRoad.width / 2;
    const mainRoadBottom = mainRoad.y - mainRoad.width / 2;
    const mainRoadLeft = mainRoad.x - 50; // Extended past x=0 to allow despawning at x < -20
    const mainRoadRight = mainRoad.x + mainRoad.length;
    const onMainRoad = x >= mainRoadLeft && x <= mainRoadRight &&
                       y >= mainRoadBottom && y <= mainRoadTop;

    // Check entry road bounds (vertical road going down from main road)
    // Entry road overlaps with main road at the junction to allow smooth transitions
    const entryLeft = entryRoad.x - entryRoad.width / 2;
    const entryRight = entryRoad.x + entryRoad.width / 2;
    const entryTop = mainRoad.y; // Overlap with main road center for junction continuity
    const entryBottom = entryRoad.y;
    const onEntryRoad = x >= entryLeft && x <= entryRight &&
                        y >= entryBottom && y <= entryTop;

    // Check exit road bounds (vertical road going up to main road)
    // Exit road overlaps with main road at the junction to allow smooth transitions
    const exitLeft = exitRoad.x - exitRoad.width / 2;
    const exitRight = exitRoad.x + exitRoad.width / 2;
    const exitTop = mainRoad.y; // Overlap with main road center for junction continuity
    const exitBottom = exitRoad.y;
    const onExitRoad = x >= exitLeft && x <= exitRight &&
                       y >= exitBottom && y <= exitTop;

    // Check parking lot bounds
    const onLot = x >= lot.x && x <= lot.x + lot.width &&
                  y >= lot.y && y <= lot.y + lot.height;

    return onMainRoad || onEntryRoad || onExitRoad || onLot;
  }

  /**
   * Recovery behavior for vehicles that end up outside the paved area.
   * Finds the nearest paved area and moves toward it.
   * This handles edge cases where collision nudging or other factors push a car off-road.
   */
  private recoverFromOffRoad(vehicle: Vehicle, dt: number): void {
    const { mainRoad, entryRoad, exitRoad, lot } = this.topology;

    // Find the nearest point on any paved surface
    let nearestPoint = { x: vehicle.x, y: vehicle.y };
    let minDist = Infinity;

    // Check distance to entry road (most likely for this bug)
    const entryLeft = entryRoad.x - entryRoad.width / 2;
    const entryRight = entryRoad.x + entryRoad.width / 2;
    const entryTop = mainRoad.y; // Overlap with main road center
    const entryBottom = entryRoad.y;

    // Clamp to entry road bounds
    const clampedEntryX = Math.max(entryLeft, Math.min(entryRight, vehicle.x));
    const clampedEntryY = Math.max(entryBottom, Math.min(entryTop, vehicle.y));
    const distToEntry = distance({ x: vehicle.x, y: vehicle.y }, { x: clampedEntryX, y: clampedEntryY });

    if (distToEntry < minDist) {
      minDist = distToEntry;
      nearestPoint = { x: clampedEntryX, y: clampedEntryY };
    }

    // Check distance to lot
    const clampedLotX = Math.max(lot.x, Math.min(lot.x + lot.width, vehicle.x));
    const clampedLotY = Math.max(lot.y, Math.min(lot.y + lot.height, vehicle.y));
    const distToLot = distance({ x: vehicle.x, y: vehicle.y }, { x: clampedLotX, y: clampedLotY });

    if (distToLot < minDist) {
      minDist = distToLot;
      nearestPoint = { x: clampedLotX, y: clampedLotY };
    }

    // Check distance to exit road
    const exitLeft = exitRoad.x - exitRoad.width / 2;
    const exitRight = exitRoad.x + exitRoad.width / 2;
    const exitTop = mainRoad.y; // Overlap with main road center
    const exitBottom = exitRoad.y;

    const clampedExitX = Math.max(exitLeft, Math.min(exitRight, vehicle.x));
    const clampedExitY = Math.max(exitBottom, Math.min(exitTop, vehicle.y));
    const distToExit = distance({ x: vehicle.x, y: vehicle.y }, { x: clampedExitX, y: clampedExitY });

    if (distToExit < minDist) {
      minDist = distToExit;
      nearestPoint = { x: clampedExitX, y: clampedExitY };
    }

    // Move toward the nearest paved point
    if (minDist > 0.1) {
      // Calculate heading toward nearest point
      const targetHeading = angleTo({ x: vehicle.x, y: vehicle.y }, nearestPoint);

      // Turn toward target
      const headingDiff = normalizeAngle(targetHeading - vehicle.heading);
      const turnRate = 2.0;
      const maxTurn = turnRate * dt;
      const turn = Math.max(-maxTurn, Math.min(maxTurn, headingDiff));
      vehicle.heading = normalizeAngle(vehicle.heading + turn);

      // Move slowly toward the paved area (recovery speed)
      const recoverySpeed = SPEEDS.CREEP;
      vehicle.x += Math.cos(vehicle.heading) * recoverySpeed * dt;
      vehicle.y += Math.sin(vehicle.heading) * recoverySpeed * dt;
    }
  }

  /**
   * Check for parked cars ahead and return an adjusted heading to steer around them.
   * Returns null if no avoidance is needed.
   *
   * IMPORTANT: This only applies gentle steering (15 degrees max) and verifies
   * the avoidance won't push the car outside the paved areas (aisles).
   */
  private getObstacleAvoidanceHeading(vehicle: Vehicle, desiredHeading: number): number | null {
    // Don't do avoidance for cars that are parking (they need to go to their spot)
    if (vehicle.state === 'PARKING') return null;

    // Only do avoidance within the parking lot (in aisles)
    if (vehicle.location !== 'IN_LOT') return null;

    const lookAhead = 10; // meters to look ahead for obstacles
    const nearby = this.getNearbyVehicles(vehicle.x, vehicle.y, lookAhead);

    // Direction we want to go
    const facingX = Math.cos(desiredHeading);
    const facingY = Math.sin(desiredHeading);

    let blockingCar: Vehicle | null = null;
    let minBlockDist = Infinity;

    for (const other of nearby) {
      if (other.id === vehicle.id) continue;
      if (other.state !== 'PARKED') continue; // Only avoid parked cars

      const dx = other.x - vehicle.x;
      const dy = other.y - vehicle.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Is this car ahead of us (in our desired direction)?
      const ahead = dx * facingX + dy * facingY;
      if (ahead <= 0) continue; // Behind us

      // Lateral distance from our path
      const lateral = Math.abs(-dx * facingY + dy * facingX);

      // If the car is in our path (within ~1.5 car widths - tighter check)
      if (lateral < CAR_WIDTH * 1.5 && dist < minBlockDist) {
        blockingCar = other;
        minBlockDist = dist;
      }
    }

    if (!blockingCar) return null;

    // Find which aisle we're in (if any) to ensure we don't steer outside it
    const currentAisle = this.topology.aisles.find(aisle => {
      const aisleHalfWidth = AISLE_WIDTH / 2;
      return vehicle.y >= aisle.y - aisleHalfWidth && vehicle.y <= aisle.y + aisleHalfWidth;
    });

    // If not in an aisle, don't do avoidance steering (just slow down via getGapAhead)
    if (!currentAisle) return null;

    // Calculate avoidance direction - steer to whichever side has more space
    const dx = blockingCar.x - vehicle.x;
    const dy = blockingCar.y - vehicle.y;

    // Cross product to determine which side the car is on
    const cross = -dx * facingY + dy * facingX;

    // Use a GENTLE avoidance angle (15 degrees instead of 45)
    // This prevents cars from veering too far off course
    const avoidanceAngle = cross > 0 ? -Math.PI / 12 : Math.PI / 12;

    const newHeading = normalizeAngle(desiredHeading + avoidanceAngle);

    // Verify the new heading won't push us outside the aisle
    // Project where we'd be in 2 seconds at current speed
    const projectedY = vehicle.y + Math.sin(newHeading) * vehicle.speed * 2;
    const aisleHalfWidth = AISLE_WIDTH / 2;

    // If projection would take us outside aisle bounds, don't steer - just slow down
    if (projectedY < currentAisle.y - aisleHalfWidth || projectedY > currentAisle.y + aisleHalfWidth) {
      // Instead of steering outside the aisle, we return null
      // The car will slow down naturally via getGapAhead collision detection
      return null;
    }

    return newHeading;
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

        // If distance is negative, car has passed the entry - mark as missed turn
        // The car will be removed in updateVehicleState
        if (distanceToEntry < -50) {
          // Too far past entry - this car missed its turn
          // Don't trigger lane change, let it exit the simulation
          return null;
        }

        // Start lane change when approaching entry road (up to 600m away)
        // Also keep trying if we're slightly past (-50m to 600m range)
        if (distanceToEntry > -50 && distanceToEntry < 600) {
          // Move one lane at a time toward lane 0
          return vehicle.currentLane - 1;
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

    // Check all vehicles in target lane (including pass-through traffic)
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
      } else {
        // REALISM FIX: URGENCY
        // If we need to change lanes but CANNOT, we must slow down to find a gap.
        // If we just keep driving at full speed, we will miss the exit.
        const distToEntry = vehicle.x - this.topology.entryRoad.x;
        if (distToEntry < 200) {
            // We are getting close and stuck in the wrong lane. 
            // Slow down significantly to let traffic pass and find a gap behind.
            vehicle.targetSpeed *= 0.6; 
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // MERGING LOGIC
  // --------------------------------------------------------------------------

  /**
   * Less restrictive gap check for vehicles waiting too long at merge point.
   * Only checks for immediate collision danger, not comfortable gaps.
   */
  private hasMinimalMergeGap(vehicle: Vehicle): boolean {
    const { mainRoad } = this.topology;
    const mergeX = vehicle.x;
    const minSafeGap = CAR_LENGTH * 1.5; // Just enough to avoid collision

    // Check all vehicles on main road (including pass-through traffic)
    const lane0Y = mainRoad.y - mainRoad.width / 2 + (mainRoad.width / mainRoad.lanes) / 2;
    for (const other of this.state.vehicles) {
      if (other.id === vehicle.id) continue;
      if (other.state === 'EXITED') continue;
      if (other.location !== 'ON_MAIN_ROAD') continue;

      // Only check vehicles near lane 0 (where we merge)
      if (Math.abs(other.y - lane0Y) > 5) continue;

      const dx = other.x - mergeX;

      // Only block if vehicle is very close
      if (Math.abs(dx) < minSafeGap) {
        return false;
      }

      // Or if approaching very fast and close
      if (dx > 0 && dx < minSafeGap * 2) {
        const timeToReach = dx / Math.max(other.speed, 1);
        if (timeToReach < 1.5) {
          return false;
        }
      }

      // Check other merging vehicles
      if (other.state === 'MERGING') {
        if (Math.abs(dx) < CAR_LENGTH * 2) {
          return false;
        }
      }
    }

    return true;
  }

  private canMerge(vehicle: Vehicle): boolean {
    const { mainRoad } = this.topology;

    // Check for safe gap in road traffic
    const mergeX = vehicle.x;

    // Use smaller, realistic gap requirements
    // Gap ahead: need space to accelerate into
    // Gap behind: depends on approaching vehicle speed
    const minGapAhead = CAR_LENGTH * 2; // ~10m ahead
    const minGapBehind = SPEEDS.MAIN_ROAD * 2; // 2 seconds behind (~30m at road speed)

    // Check all vehicles on main road (pass-through and post-merge vehicles)
    const lane0Y = mainRoad.y - mainRoad.width / 2 + (mainRoad.width / mainRoad.lanes) / 2;
    for (const other of this.state.vehicles) {
      if (other.id === vehicle.id) continue;
      if (other.state === 'EXITED') continue;

      // Only care about vehicles on/near the main road bottom lane
      if (Math.abs(other.y - lane0Y) > 5) continue;

      // Check if they're a conflict
      if (other.state === 'MERGING' || other.state === 'ON_ROAD') {
        const dx = other.x - mergeX;

        // Avoid merging too close to another merging vehicle
        if (other.state === 'MERGING' && Math.abs(dx) < CAR_LENGTH * 3) {
          return false;
        }

        // Vehicle ahead (already past our merge point, going west)
        if (dx < 0 && dx > -minGapAhead) {
          return false;
        }

        // Vehicle behind (approaching from east, going west)
        if (dx > 0 && dx < minGapBehind) {
          const timeToReach = dx / Math.max(other.speed, 1);
          if (timeToReach < 2) {
            return false;
          }
        }
      }
    }

    // Also check if there's a queue of vehicles waiting to merge
    // Don't let too many vehicles merge at once
    const mergingCount = this.state.vehicles.filter(v => v.state === 'MERGING').length;
    if (mergingCount >= 2) {
      return false;
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
        if (v2.state === 'EXITED') continue;

        // Skip collision checks between vehicles on different roads
        // (unless at junction where they could actually collide)
        if (v1.location !== v2.location) {
          const atJunction = (v1.location === 'ON_MAIN_ROAD' || v2.location === 'ON_MAIN_ROAD') &&
                            (v1.location === 'ON_ENTRY_ROAD' || v2.location === 'ON_ENTRY_ROAD' ||
                             v1.location === 'ON_EXIT_ROAD' || v2.location === 'ON_EXIT_ROAD');
          if (!atJunction) continue;
        }

        if (this.checkCollision(v1, v2)) {
          // If v2 is parked, v1 must stop (parked cars don't move)
          if (v2.state === 'PARKED') {
            v1.speed = 0;
            continue;
          }

          // Priority: vehicle closer to exit continues, other stops
          const priority1 = this.getExitPriority(v1);
          const priority2 = this.getExitPriority(v2);

          // Nudge overlapping cars apart slightly, but respect road boundaries
          const dist = distance({ x: v1.x, y: v1.y }, { x: v2.x, y: v2.y });
          const minSeparation = CAR_LENGTH * 0.8;

          if (dist > 0 && dist < minSeparation) {
            const dx = v1.x - v2.x;
            const dy = v1.y - v2.y;
            const overlap = minSeparation - dist;
            // Small nudge to separate (5% of overlap per frame)
            const nudgeX = (dx / dist) * overlap * 0.05;
            const nudgeY = (dy / dist) * overlap * 0.05;

            // BOUNDARY CONSTRAINT: Only apply nudge if it keeps vehicles within paved areas
            // This unified check covers all road types (main road, entry/exit roads, lot)
            const v1NewX = v1.x + nudgeX;
            const v1NewY = v1.y + nudgeY;
            const v2NewX = v2.x - nudgeX;
            const v2NewY = v2.y - nudgeY;

            // Only nudge v1 if new position is within paved area
            if (this.isWithinPavedArea(v1NewX, v1NewY)) {
              v1.x = v1NewX;
              v1.y = v1NewY;
            } else {
              // Try nudging along each axis independently
              if (this.isWithinPavedArea(v1NewX, v1.y)) {
                v1.x = v1NewX;
              }
              if (this.isWithinPavedArea(v1.x, v1NewY)) {
                v1.y = v1NewY;
              }
            }

            // Only nudge v2 if new position is within paved area
            if (this.isWithinPavedArea(v2NewX, v2NewY)) {
              v2.x = v2NewX;
              v2.y = v2NewY;
            } else {
              // Try nudging along each axis independently
              if (this.isWithinPavedArea(v2NewX, v2.y)) {
                v2.x = v2NewX;
              }
              if (this.isWithinPavedArea(v2.x, v2NewY)) {
                v2.y = v2NewY;
              }
            }
          }

          // Stop the lower priority vehicle (don't set targetSpeed, just current speed)
          if (priority1 < priority2) {
            v1.speed = 0;
            // v1.targetSpeed = 0; // REMOVED to prevent deadlock
          } else {
            v2.speed = 0;
            // v2.targetSpeed = 0; // REMOVED to prevent deadlock
          }
        }
      }
    }
  }

  private checkCollision(v1: Vehicle, v2: Vehicle): boolean {
    const dist = distance({ x: v1.x, y: v1.y }, { x: v2.x, y: v2.y });
    // Trigger when cars are close enough to conflict
    const minDist = (CAR_LENGTH + CAR_WIDTH) / 2; // ~4m, average of dimensions
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
  // ROAD TRAFFIC (Pass-through vehicles - no more grey background cars)
  // --------------------------------------------------------------------------

  private updateRoadTraffic(dt: number): void {
    // Spawn pass-through vehicles at configured rate
    // These are full simulation vehicles that just drive through without parking
    const spawnRate = this.config.roadTrafficRate / 60; // per second
    if (Math.random() < spawnRate * dt) {
      this.spawnPassThroughVehicle();
    }

    // Note: roadVehicles array is no longer used - all traffic is simulation vehicles
    // Clean up any legacy road vehicles
    this.state.roadVehicles = [];
  }

  /**
   * Spawn a pass-through vehicle that drives straight through without parking.
   * These create realistic traffic that parking vehicles must navigate around.
   */
  private spawnPassThroughVehicle(): void {
    const { mainRoad } = this.topology;

    // Check spawn clearance
    const spawnX = mainRoad.x + mainRoad.length;
    const minSpawnClearance = CAR_LENGTH * 2;

    for (const v of this.state.vehicles) {
      if (v.location === 'ON_MAIN_ROAD') {
        if (Math.abs(v.x - spawnX) < minSpawnClearance) {
          return; // Too close, skip spawn
        }
      }
    }

    // Pass-through vehicles can spawn in any lane (realistic traffic)
    const spawnLane = Math.floor(Math.random() * mainRoad.lanes);
    const laneY = getLaneY(mainRoad, spawnLane);

    const vehicle: Vehicle = {
      id: this.nextVehicleId++,
      x: mainRoad.x + mainRoad.length,
      y: laneY,
      heading: Math.PI, // facing west
      speed: SPEEDS.MAIN_ROAD,
      targetSpeed: SPEEDS.MAIN_ROAD,
      acceleration: 0,

      // Layer 1: Location
      location: 'ON_MAIN_ROAD',

      // Layer 2: Intent - PASSING_THROUGH (not seeking parking)
      intent: 'PASSING_THROUGH',

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
      targetLane: null,
      laneChangeStartY: null,

      // State - ON_ROAD since just passing through
      state: 'ON_ROAD',

      targetSpotId: null, // No parking target
      exitLaneId: null,
      path: [], // No path needed - just drive west
      pathIndex: 0,
      spawnTime: this.state.time,
      parkTime: null,
      exitStartTime: null,
      exitCompleteTime: null,
      waitTime: 0,
      color: COLORS.vehicle.ON_ROAD,
    };

    this.state.vehicles.push(vehicle);
  }

  // --------------------------------------------------------------------------
  // VEHICLE SPAWNING
  // --------------------------------------------------------------------------

  spawnVehicle(): Vehicle | null {
    const spot = findRandomSpot(this.topology);
    if (!spot) return null;

    // Spawn on main road (coming from east, road is westbound)
    const { mainRoad } = this.topology;

    // SPAWN SPACING CHECK: Don't spawn if a vehicle is still near spawn point
    // This prevents pile-ups where cars spawn on top of each other
    const spawnX = mainRoad.x + mainRoad.length;
    const minSpawnClearance = CAR_LENGTH * 2; // Need 2 car lengths clear

    for (const v of this.state.vehicles) {
      if (v.location === 'ON_MAIN_ROAD' && v.state === 'APPROACHING') {
        if (Math.abs(v.x - spawnX) < minSpawnClearance) {
          // Too close to spawn point, skip this spawn attempt
          return null;
        }
      }
    }

    // REALISM FIX: Bias spawn lane.
    // Cars intending to park usually enter the simulation in the right-most lanes (0 or 1)
    // rather than the fast lane (2).
    const r = Math.random();
    let spawnLane;
    if (r < 0.45) spawnLane = 0;      // 45% Lane 0 (Best)
    else if (r < 0.85) spawnLane = 1; // 40% Lane 1 (Okay)
    else spawnLane = 2;               // 15% Lane 2 (Worst)

    // Ensure we don't exceed lane count if config changes
    spawnLane = Math.min(spawnLane, mainRoad.lanes - 1);

    const laneY = getLaneY(mainRoad, spawnLane);

    // Generate path with spawn lane info so first waypoint matches spawn position
    const entryPath = generateEntryPath(this.topology, spot, spawnLane);

    const vehicle: Vehicle = {
      id: this.nextVehicleId++,
      // Start at the right edge of main road (not beyond it)
      // mainRoad.x + mainRoad.length is the visual end of the road
      x: mainRoad.x + mainRoad.length,
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

    // Log spawn event
    this.logEvent(vehicle.id, 'SPAWN', {
      spawnLane,
      targetSpotId: spot.id,
      x: vehicle.x,
      y: vehicle.y,
    });

    return vehicle;
  }

  // --------------------------------------------------------------------------
  // FILL LOT
  // --------------------------------------------------------------------------

  // Queue of vehicles waiting to spawn (staggered spawning)
  private spawnQueue: number = 0;
  private lastSpawnTime: number = 0;
  private readonly SPAWN_INTERVAL = 0.5; // seconds between spawns

  fillLot(count: number): void {
    this.state.phase = 'FILLING';

    // Queue vehicles to spawn over time instead of all at once
    // This prevents 100 cars spawning at the same location
    const toSpawn = Math.min(count, this.topology.spots.length);
    this.spawnQueue = toSpawn;
    this.lastSpawnTime = this.state.time;
  }

  /** Called from step() to gradually spawn queued vehicles */
  private processSpawnQueue(): void {
    if (this.spawnQueue <= 0) return;

    // Spawn vehicles at regular intervals
    const timeSinceLastSpawn = this.state.time - this.lastSpawnTime;
    if (timeSinceLastSpawn >= this.SPAWN_INTERVAL) {
      // Spawn 1-2 vehicles per interval (randomized for natural flow)
      const toSpawnNow = Math.min(this.spawnQueue, Math.random() < 0.7 ? 1 : 2);

      for (let i = 0; i < toSpawnNow; i++) {
        this.spawnVehicle();
        this.spawnQueue--;
      }

      this.lastSpawnTime = this.state.time;
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

    // SEVERE EXODUS: All cars try to leave at once!
    // No staggering - everyone unpacks simultaneously creating maximum congestion
    for (const vehicle of parkedVehicles) {
      this.startVehicleExit(vehicle);
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

    // exitedCount is now tracked incrementally in step() before vehicle removal
    // No need to count here since EXITED vehicles are already removed

    // Calculate average exit time
    if (this.exitTimes.length > 0) {
      this.state.avgExitTime =
        this.exitTimes.reduce((a, b) => a + b, 0) / this.exitTimes.length;
    }

    // Calculate throughput (exits per minute)
    // Simple approximation: total exits / time in minutes
    if (this.state.time > 0) {
      this.state.throughput = Math.round(this.state.exitedCount / (this.state.time / 60));
    }
  }

  private checkPhaseTransitions(): void {
    if (this.state.phase === 'FILLING') {
      // Check if all PARKING-INTENT vehicles are parked (ignore pass-through traffic)
      const parkingVehicles = this.state.vehicles.filter(
        v => v.intent !== 'PASSING_THROUGH'
      );
      const allParked = parkingVehicles.every(
        (v) => v.state === 'PARKED' || v.state === 'EXITED'
      );
      // Also check spawn queue is empty (all requested vehicles have spawned)
      if (allParked && this.state.parkedCount > 0 && this.spawnQueue <= 0) {
        this.state.phase = 'WAITING';
      }
    }

    if (this.state.phase === 'EXODUS') {
      // Check if all vehicles have exited
      // Since we remove EXITED vehicles, check if array is empty (only pass-through remain)
      // and we've had some exits
      const parkingVehicles = this.state.vehicles.filter(
        v => v.intent !== 'PASSING_THROUGH'
      );
      if (parkingVehicles.length === 0 && this.state.exitedCount > 0) {
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
    this.exitTimes = [];

    // Reset log
    this.log = {
      startTime: new Date(),
      snapshots: [],
      events: [],
    };
    this.lastLogTime = 0;
  }

  // --------------------------------------------------------------------------
  // LOGGING
  // --------------------------------------------------------------------------

  /** Capture snapshot of all vehicles at current time */
  private captureLogSnapshot(): void {
    const interval = this.config.logInterval;

    // Only capture at configured interval
    if (interval > 0 && this.state.time - this.lastLogTime < interval) {
      return;
    }
    this.lastLogTime = this.state.time;

    // Capture each vehicle's state
    for (const vehicle of this.state.vehicles) {
      if (vehicle.state === 'EXITED') continue;

      const snapshot: VehicleSnapshot = {
        id: vehicle.id,
        timestamp: this.state.time,

        // Position
        x: Math.round(vehicle.x * 100) / 100,
        y: Math.round(vehicle.y * 100) / 100,
        heading: Math.round(vehicle.heading * 100) / 100,

        // Kinematics
        speed: Math.round(vehicle.speed * 100) / 100,
        targetSpeed: Math.round(vehicle.targetSpeed * 100) / 100,

        // State
        state: vehicle.state,
        location: vehicle.location,
        intent: vehicle.intent,

        // Behaviors
        isChangingLane: vehicle.behaviors.isChangingLane,
        isReversing: vehicle.behaviors.isReversing,
        isMerging: vehicle.behaviors.isMerging,
        isWaitingToMerge: vehicle.behaviors.isWaitingToMerge,

        // Lane info
        currentLane: vehicle.currentLane,
        targetLane: vehicle.targetLane,

        // Navigation
        targetSpotId: vehicle.targetSpotId,
        pathIndex: vehicle.pathIndex,
        pathLength: vehicle.path.length,

        // Timing
        waitTime: Math.round(vehicle.waitTime * 100) / 100,
      };

      this.log.snapshots.push(snapshot);
    }
  }

  /** Log a discrete event */
  logEvent(vehicleId: number, type: SimulationEvent['type'], details?: Record<string, unknown>): void {
    if (!this.config.enableLogging) return;

    this.log.events.push({
      timestamp: this.state.time,
      vehicleId,
      type,
      details,
    });
  }

  /** Get the complete simulation log */
  getLog(): SimulationLog {
    return this.log;
  }

  /** Export log as JSON string (for download) */
  exportLog(): string {
    return JSON.stringify(this.log, null, 2);
  }

  /** Get summary statistics from log */
  getLogSummary(): {
    totalSnapshots: number;
    totalEvents: number;
    vehicleCount: number;
    duration: number;
    stuckVehicles: { id: number; maxWaitTime: number; lastState: VehicleState }[];
  } {
    const vehicleIds = new Set<number>();
    const vehicleMaxWait = new Map<number, { wait: number; state: VehicleState }>();

    for (const snap of this.log.snapshots) {
      vehicleIds.add(snap.id);
      const current = vehicleMaxWait.get(snap.id);
      if (!current || snap.waitTime > current.wait) {
        vehicleMaxWait.set(snap.id, { wait: snap.waitTime, state: snap.state });
      }
    }

    const stuckVehicles = Array.from(vehicleMaxWait.entries())
      .filter(([_, data]) => data.wait > 5)
      .map(([id, data]) => ({ id, maxWaitTime: data.wait, lastState: data.state }))
      .sort((a, b) => b.maxWaitTime - a.maxWaitTime);

    return {
      totalSnapshots: this.log.snapshots.length,
      totalEvents: this.log.events.length,
      vehicleCount: vehicleIds.size,
      duration: this.state.time,
      stuckVehicles,
    };
  }
}