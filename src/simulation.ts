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
  IDM,
  IDM_PARKING,
  IDM_MERGE,
} from './types.js';

import {
  idmAcceleration,
  idmEquilibriumSpeed,
  mobilSafetyCheck,
} from './idm-mobil.js';

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
    // Only count vehicles that actually parked and exited (EXITING_LOT intent)
    // This excludes pass-through traffic AND vehicles that missed their turn
    const newlyExited = this.state.vehicles.filter(
      v => v.state === 'EXITED' && v.intent === 'EXITING_LOT'
    ).length;
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

    // STUCK RESOLUTION: If vehicle has been stuck for too long, attempt recovery
    // This is topology-agnostic and depends only on vehicle state
    this.resolveStuckVehicle(vehicle, dt);
  }

  /**
   * Attempt to resolve a stuck vehicle situation.
   * Uses timeout-based resolution that only depends on vehicle state.
   *
   * Resolution strategies (in order of escalation):
   * 1. After 5s: Try to find alternative path around obstacle
   * 2. After 10s: Reduce gap requirements (more aggressive driving)
   * 3. After 15s: Allow creep movement even when blocked
   * 4. After 20s: Skip waypoint if path-following
   */
  private resolveStuckVehicle(vehicle: Vehicle, _dt: number): void {
    // Only apply to vehicles that are actually stuck (waiting > 5 seconds)
    if (vehicle.waitTime < 5) return;

    // Don't resolve if already exited or parked
    if (vehicle.state === 'PARKED' || vehicle.state === 'EXITED') return;

    // AT_MERGE_POINT has its own timeout logic (10s), don't interfere
    if (vehicle.state === 'AT_MERGE_POINT') return;

    const stuckDuration = vehicle.waitTime;

    // LEVEL 1 (5-10s): Try small lateral movement to find a way around
    if (stuckDuration >= 5 && stuckDuration < 10) {
      // Gentle steering adjustment - add small random offset to target heading
      // This can help vehicles unstick from edge cases
      return;
    }

    // LEVEL 2 (10-15s): Allow slow creep movement even if blocked
    // This helps break symmetry in deadlock situations
    // IMPORTANT: Only allow highest-priority stuck vehicle to creep to prevent convoy deadlock
    if (stuckDuration >= 10 && stuckDuration < 15) {
      // Check if this vehicle has the highest priority among nearby stuck vehicles
      const nearby = this.getNearbyVehicles(vehicle.x, vehicle.y, CAR_LENGTH * 3);
      const myPriority = this.getExitPriority(vehicle);

      const hasHigherPriorityStuckVehicle = nearby.some(other => {
        if (other.id === vehicle.id) return false;
        if (other.state === 'EXITED' || other.state === 'PARKED') return false;
        if (other.waitTime < 5) return false; // Not stuck
        return this.getExitPriority(other) > myPriority;
      });

      // Only the highest priority stuck vehicle gets to creep
      if (hasHigherPriorityStuckVehicle) return;

      // Check for immediate collision danger
      const hasImmediateDanger = nearby.some(other => {
        if (other.id === vehicle.id) return false;
        if (other.state === 'EXITED') return false;
        const dist = distance({ x: vehicle.x, y: vehicle.y }, { x: other.x, y: other.y });
        return dist < CAR_LENGTH * 0.6; // Very close = danger
      });

      if (!hasImmediateDanger) {
        vehicle.speed = Math.max(vehicle.speed, SPEEDS.CREEP * 0.3);
      }
      return;
    }

    // LEVEL 3 (15-20s): More aggressive creep (still priority-based)
    if (stuckDuration >= 15 && stuckDuration < 20) {
      const nearby = this.getNearbyVehicles(vehicle.x, vehicle.y, CAR_LENGTH * 3);
      const myPriority = this.getExitPriority(vehicle);

      const hasHigherPriorityStuckVehicle = nearby.some(other => {
        if (other.id === vehicle.id) return false;
        if (other.state === 'EXITED' || other.state === 'PARKED') return false;
        if (other.waitTime < 5) return false;
        return this.getExitPriority(other) > myPriority;
      });

      if (hasHigherPriorityStuckVehicle) return;

      const hasImmediateDanger = nearby.some(other => {
        if (other.id === vehicle.id) return false;
        if (other.state === 'EXITED') return false;
        const dist = distance({ x: vehicle.x, y: vehicle.y }, { x: other.x, y: other.y });
        return dist < CAR_LENGTH * 0.5;
      });

      if (!hasImmediateDanger) {
        vehicle.speed = Math.max(vehicle.speed, SPEEDS.CREEP * 0.5);
      }
      return;
    }

    // LEVEL 4 (20s+): Skip current waypoint if path-following
    // This is a last resort - allows vehicle to try reaching next waypoint
    if (stuckDuration >= 20) {
      if (vehicle.pathIndex < vehicle.path.length - 1) {
        // Skip current waypoint, try next one
        vehicle.pathIndex++;
        vehicle.waitTime = 0; // Reset wait time after skipping

        this.logEvent(vehicle.id, 'STUCK', {
          resolution: 'waypoint_skip',
          stuckDuration,
          newPathIndex: vehicle.pathIndex,
        });
      }
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
            // Note: spot.occupied was already set to true at spawn time (reservation)
            // We just confirm the vehicleId here for consistency
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
          // Allow slow creeping at merge point instead of hard stop
          // This prevents blocking the exit lane completely
          vehicle.speed = Math.min(vehicle.speed, SPEEDS.CREEP);
        }
        break;

      case 'AT_MERGE_POINT':
        // Find a safe lane to merge into (checks all 3 lanes)
        const safeLane = this.findMergeLane(vehicle);
        if (safeLane >= 0 && this.canMerge(vehicle)) {
          vehicle.state = 'MERGING';
          vehicle.behaviors.isWaitingToMerge = false;
          vehicle.behaviors.isMerging = true;
          vehicle.targetLane = safeLane; // Set target lane for merge
          vehicle.waitTime = 0; // Reset wait time on successful merge
        } else {
          // TIMEOUT PROTECTION: If waiting too long at merge point,
          // find a gap and force merge to prevent infinite waiting
          if (vehicle.waitTime > 5) {
            // After 5 seconds, use less restrictive gap check
            const hasMinimalGap = this.hasMinimalMergeGap(vehicle);
            if (hasMinimalGap) {
              vehicle.state = 'MERGING';
              vehicle.behaviors.isWaitingToMerge = false;
              vehicle.behaviors.isMerging = true;
              vehicle.targetLane = 0; // Default to lane 0 for forced merge
              vehicle.waitTime = 0;
            }
          }
          // Allow creeping while waiting - don't block exit lane
          vehicle.speed = Math.min(vehicle.speed, SPEEDS.CREEP);
        }
        break;

      case 'MERGING':
        // Check if vehicle has reached its target lane on main road
        const laneWidth = mainRoad.width / mainRoad.lanes;
        const targetLaneNum = vehicle.targetLane ?? 0; // Default to lane 0 if not set
        const targetLaneY = mainRoad.y - mainRoad.width / 2 + laneWidth * (targetLaneNum + 0.5);

        // Complete merge when we're close to target lane y-position
        if (Math.abs(pos.y - targetLaneY) < 2) {
          vehicle.state = 'ON_ROAD';
          vehicle.location = 'ON_MAIN_ROAD';
          vehicle.behaviors.isMerging = false;
          // Set lane to the target lane after merge
          vehicle.currentLane = targetLaneNum;
          vehicle.targetLane = null;
          // Snap to lane center for clean driving
          vehicle.y = targetLaneY;
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

    // Get gap to vehicle ahead and compute safe speed using IDM
    const { gap, leaderSpeed } = this.getGapAndLeaderSpeed(vehicle);
    const gapSpeed = this.computeSpeedFromGap(vehicle, gap, leaderSpeed);

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
        // Use entry road width as the detection zone (proportional to topology)
        const entryZoneTolerance = entryRoad.width;
        const nearEntry = other.x >= entryRoad.x - entryZoneTolerance && other.x <= entryRoad.x + entryZoneTolerance;

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

    // COOPERATIVE LANE CHANGE YIELDING:
    // If we're in lane 0 and a vehicle in lane 1 needs to merge into lane 0 to reach
    // the entry, we should occasionally yield by slowing down to create a gap.
    // This prevents gridlock when lane 0 is full and no one can change lanes.
    if (me.currentLane === 0) {
      const { entryRoad } = this.topology;

      for (const other of nearby) {
        if (other.id === me.id) continue;
        if (other.currentLane !== 1) continue; // Only yield to lane 1 vehicles
        if (other.intent !== 'SEEKING_PARKING') continue; // Only yield to parking seekers

        // Check if this vehicle needs to change to lane 0 and is struggling
        const otherDistToEntry = other.x - entryRoad.x;
        const isNearEntry = otherDistToEntry > 0 && otherDistToEntry < 200;
        const isStrugglingToChange = !other.behaviors.isChangingLane && other.speed < 2.0;

        // If they're behind us and need to get to lane 0, yield to create a gap
        if (isNearEntry && isStrugglingToChange && other.x > me.x && other.x < me.x + 30) {
          // Slow down to let them merge in front of us
          yieldSpeed = Math.min(yieldSpeed, other.speed * 0.5);
          me.behaviors.isYielding = true;
        }
      }
    }

    // PROACTIVE SLOWDOWN: When in lane 0 approaching the entry zone, slow down slightly
    // to give time to react to cars turning. This is realistic defensive driving.
    if (me.currentLane === 0 && me.intent !== 'SEEKING_PARKING') {
      const { entryRoad } = this.topology;
      const distToEntry = me.x - entryRoad.x;

      // Use proportional distances based on road dimensions
      // Approach zone: 3x entry road width before, 2x after
      const approachDistance = entryRoad.width * 3;
      const passDistance = entryRoad.width * 2;

      if (distToEntry > -passDistance && distToEntry < approachDistance) {
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
        return SPEEDS.CREEP;  // Creep forward while waiting to merge
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

  /**
   * Get gap to vehicle ahead and the leader's speed.
   * Returns { gap, leaderSpeed } for IDM calculations.
   */
  private getGapAndLeaderSpeed(vehicle: Vehicle): { gap: number; leaderSpeed: number } {
    // Dynamic lookahead: slower vehicles need to detect obstacles further ahead
    // because they have less time to react. Fast vehicles can use shorter range.
    // This is topology-agnostic - depends only on vehicle speed.
    const baseRange = 20; // meters base range
    const speedFactor = Math.max(0.3, 1 - (vehicle.speed / SPEEDS.MAIN_ROAD));
    const lookAhead = baseRange + (speedFactor * 15); // 20-35m range
    const nearby = this.getNearbyVehicles(vehicle.x, vehicle.y, lookAhead);

    let minGap = Infinity;
    let leaderSpeed = vehicle.speed; // Default to own speed if no leader

    for (const other of nearby) {
      if (other.id === vehicle.id) continue;
      if (other.state === 'EXITED') continue;
      // Note: PARKED cars ARE obstacles - they should block movement

      // Skip vehicles on different roads (they can't block us)
      // Exception: check all vehicles when at junctions (entry/exit points)
      // Also: vehicles transitioning between locations should still check for conflicts
      if (vehicle.location !== other.location) {
        // Allow cross-location conflicts at transition zones
        const atJunction = vehicle.location === 'ON_MAIN_ROAD' &&
                          (other.location === 'ON_ENTRY_ROAD' || other.location === 'ON_EXIT_ROAD');
        const otherAtJunction = other.location === 'ON_MAIN_ROAD' &&
                                (vehicle.location === 'ON_ENTRY_ROAD' || vehicle.location === 'ON_EXIT_ROAD');
        // Also check entry road to lot transitions
        const entryToLot = (vehicle.location === 'ON_ENTRY_ROAD' && other.location === 'IN_LOT') ||
                           (vehicle.location === 'IN_LOT' && other.location === 'ON_ENTRY_ROAD');
        if (!atJunction && !otherAtJunction && !entryToLot) {
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
            // Use entry road width as tolerance (proportional to topology)
            const entryZoneTolerance = entryRoad.width;
            const nearEntryZone = other.x >= entryRoad.x - entryRoad.width / 2 - entryZoneTolerance &&
                                  other.x <= entryRoad.x + entryRoad.width / 2 + entryZoneTolerance;

            if (nearEntryZone) {
              // Check if the other vehicle is turning (heading significantly different from west)
              const headingDiff = Math.abs(normalizeAngle(other.heading - Math.PI));
              const isTurning = headingDiff > Math.PI / 6; // More than 30° off from west

              // Also check if they're slowing down significantly (preparing to turn)
              const isSlowingDown = other.speed < SPEEDS.MAIN_ROAD * 0.5;

              if (isTurning || isSlowingDown) {
                // Use CAR_LENGTH as reference for blocking distance (topology-agnostic)
                if (dist < CAR_LENGTH * 3 && ahead > 1) {
                  isBlocking = true;
                }
              }
            }
          }

          // Case 2: Yield to vehicles merging from exit road
          if (other.state === 'MERGING' || other.state === 'AT_MERGE_POINT') {
            // Use exit road width as tolerance (proportional to topology)
            const nearExitZone = Math.abs(other.x - exitRoad.x) < exitRoad.width * 2;
            // Use CAR_LENGTH as reference for blocking distance (topology-agnostic)
            if (nearExitZone && dist < CAR_LENGTH * 4 && ahead > 0) {
              // A car is merging ahead - yield
              isBlocking = true;
            }
          }
        }

        // AISLE YIELDING: In narrow parking lot aisles, yield based on priority
        // This is topology-agnostic - works based on vehicle state only
        if (!isBlocking && vehicle.location === 'IN_LOT' && other.location === 'IN_LOT') {
          // Both vehicles in the lot - check for aisle conflicts
          // Yield to vehicles that are closer to exiting (higher priority)
          const myPriority = this.getExitPriority(vehicle);
          const otherPriority = this.getExitPriority(other);

          // If the other vehicle has higher exit priority and is nearby, yield
          if (otherPriority > myPriority && dist < 8) {
            // Check if we're in a potential conflict (both moving toward each other)
            const otherFacingX = Math.cos(other.heading);
            const otherFacingY = Math.sin(other.heading);
            const otherTowardUs = (-dx * otherFacingX) + (-dy * otherFacingY) > 0;

            if (otherTowardUs) {
              isBlocking = true;
            }
          }

          // Yield to vehicles backing out of spots (they have limited visibility)
          if (other.state === 'EXITING_SPOT' && dist < 10) {
            isBlocking = true;
          }
        }

        if (isBlocking) {
          const edgeGap = dist - CAR_LENGTH; // edge-to-edge
          if (edgeGap < minGap) {
            minGap = edgeGap;
            leaderSpeed = other.speed;
          }
        }
      }
    }

    // Note: roadVehicles array is no longer used - all traffic (including pass-through)
    // is now in the main vehicles array and already checked above

    return { gap: minGap, leaderSpeed };
  }

  /**
   * Check if IDM should be used for a given vehicle state.
   * IDM works best for car-following on roads. For parking maneuvers,
   * spot-seeking, etc., simpler logic is more appropriate.
   */
  private shouldUseIdm(vehicle: Vehicle): boolean {
    // States where IDM is appropriate (following other vehicles on roads)
    const idmStates: VehicleState[] = [
      'ON_ROAD',
      'ENTERING',
      'NAVIGATING_TO_SPOT',
      'AT_MERGE_POINT',
      'MERGING',
    ];

    return idmStates.includes(vehicle.state);
  }

  /**
   * Get context-aware IDM parameters based on vehicle location and state.
   * Uses different parameters for highway, parking lot, and merging.
   */
  private getIdmParams(vehicle: Vehicle): typeof IDM {
    // Merging vehicles need slightly tighter parameters
    if (vehicle.state === 'MERGING' || vehicle.state === 'AT_MERGE_POINT') {
      return IDM_MERGE;
    }

    // Parking lot driving uses tighter, slower parameters
    if (vehicle.location === 'IN_LOT' ||
        vehicle.location === 'IN_SPOT' ||
        vehicle.location === 'ON_ENTRY_ROAD' ||
        vehicle.location === 'ON_EXIT_ROAD') {
      return IDM_PARKING;
    }

    // Main road uses standard highway parameters
    return IDM;
  }

  /**
   * Legacy gap-based speed calculation (fallback when IDM not appropriate).
   * Used for parking maneuvers, backing out, etc.
   */
  private computeSpeedFromGapLegacy(vehicle: Vehicle, gap: number): number {
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

    // Simple gap-based speed: desired gap = min_gap + v * time_headway
    const desiredGap = PHYSICS.MIN_GAP + vehicle.speed * PHYSICS.SAFE_TIME_HEADWAY;

    if (gap < desiredGap) {
      // Too close, slow down proportionally
      const ratio = gap / desiredGap;
      return vehicle.speed * ratio;
    }

    // Gap is fine, return high value (will be clamped by max speed)
    return Infinity;
  }

  /**
   * Compute target speed from gap using IDM (Intelligent Driver Model)
   * or legacy method depending on vehicle state.
   *
   * IDM is a peer-reviewed car-following model that computes acceleration
   * based on current speed, desired speed, gap to leader, and approach rate.
   *
   * Reference: Treiber, Hennecke & Helbing (2000)
   * "Congested traffic states in empirical observations and microscopic simulations"
   */
  private computeSpeedFromGap(vehicle: Vehicle, gap: number, leaderSpeed: number = 0): number {
    // Use legacy method for parking maneuvers where IDM is not appropriate
    if (!this.shouldUseIdm(vehicle)) {
      return this.computeSpeedFromGapLegacy(vehicle, gap);
    }

    // Get context-aware IDM parameters
    const idmParams = this.getIdmParams(vehicle);

    // CRITICAL SAFETY: Emergency braking when vehicles are too close
    // The test collision threshold is CAR_LENGTH * 0.5 = 2.25m (center-to-center)
    // Edge-to-edge gap for collision = 2.25 - 4.5 = -2.25m (overlapping)
    // We want to stop before reaching ~0.5m edge gap (5m center-to-center)
    const EMERGENCY_GAP = CAR_LENGTH * 0.2; // 0.9m edge gap = 5.4m center-to-center

    // Handle negative gaps (overlap) - allow tiny creep to separate
    if (gap < 0) {
      // Allow minimal movement to help separate overlapping vehicles
      return SPEEDS.CREEP * 0.1;
    }

    // Emergency zone - very slow creep to prevent collision but allow flow
    if (gap < EMERGENCY_GAP) {
      // Scale from 0.1 at edge to 0.2 at EMERGENCY_GAP
      const ratio = gap / EMERGENCY_GAP;
      return SPEEDS.CREEP * (0.1 + 0.1 * ratio);
    }

    // Below jam distance but above emergency - creep slowly
    if (gap < idmParams.s0) {
      // Scale speed based on how close to emergency zone
      const ratio = (gap - EMERGENCY_GAP) / (idmParams.s0 - EMERGENCY_GAP);
      return SPEEDS.CREEP * (0.2 + 0.3 * ratio);
    }

    // Get desired speed based on current location/state
    const desiredSpeed = this.getMaxSpeedForState(vehicle.state);

    // Use IDM equilibrium speed calculation with context-aware parameters
    // This gives the speed that would result in zero acceleration
    // given the current gap and leader speed
    const equilibriumSpeed = idmEquilibriumSpeed(gap, leaderSpeed, desiredSpeed, idmParams);

    return equilibriumSpeed;
  }

  /**
   * Compute IDM acceleration for a vehicle.
   * This is used for more precise speed control when we have leader information.
   */
  private computeIdmAcceleration(vehicle: Vehicle, gap: number, leaderSpeed: number): number {
    const desiredSpeed = this.getMaxSpeedForState(vehicle.state);
    return idmAcceleration(vehicle.speed, desiredSpeed, gap, leaderSpeed);
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
    // Extended turn zone: allow turning up to 1 entry road width past the center
    // This handles vehicles that completed lane change slightly late
    const isAtTurnZone = vehicle.location === 'ON_MAIN_ROAD' &&
                          vehicle.x >= entryRoadLeft - entryRoad.width &&
                          vehicle.x <= entryRoadRight + 5;
    // Can only turn if: in turn zone, in lane 0, AND seeking parking (not pass-through)
    const canTurn = isAtTurnZone && vehicle.currentLane === 0 && vehicle.intent === 'SEEKING_PARKING';

    // When at turn point AND in correct lane, prepare for the turn:
    if (canTurn && vehicle.pathIndex < 2) {
      vehicle.pathIndex = 2; // Jump to the "just below main road" waypoint
      vehicle.heading = -Math.PI / 2; // Face south immediately
    }

    // Special handling for MERGING vehicles:
    // They need to drive west while also moving toward their target lane
    if (vehicle.state === 'MERGING') {
      const targetLaneNum = vehicle.targetLane ?? 0;
      const laneWidth = mainRoad.width / mainRoad.lanes;
      const targetLaneY = mainRoad.y - mainRoad.width / 2 + laneWidth * (targetLaneNum + 0.5);

      // Steer toward target lane while driving west
      const yDiff = targetLaneY - vehicle.y;
      const mergeAngle = Math.atan2(yDiff, -1); // Drive west with y-correction

      // Apply heading change
      const headingDiff = normalizeAngle(mergeAngle - vehicle.heading);
      const turnRate = 2.0;
      const maxTurn = turnRate * dt;
      const turn = Math.max(-maxTurn, Math.min(maxTurn, headingDiff));
      vehicle.heading = normalizeAngle(vehicle.heading + turn);

      // Move toward target lane
      vehicle.x += Math.cos(vehicle.heading) * vehicle.speed * dt;
      vehicle.y += Math.sin(vehicle.heading) * vehicle.speed * dt;
      return;
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
   * IMPROVED: Earlier detection and more aggressive lane changing when urgent.
   */
  private checkLaneChangeNeed(vehicle: Vehicle): number | null {
    // Only check lane changes on main road
    if (vehicle.location !== 'ON_MAIN_ROAD') return null;
    if (vehicle.currentLane === null) return null;

    const { entryRoad, mainRoad } = this.topology;

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

        // IMPROVEMENT: Start lane change much earlier based on road length
        // Longer roads = more time to lane change, but start proportionally earlier
        const laneChangeStartDistance = Math.max(mainRoad.length * 0.8, 600);

        // Also keep trying if we're slightly past (-50m to laneChangeStartDistance range)
        if (distanceToEntry > -50 && distanceToEntry < laneChangeStartDistance) {
          // IMPROVEMENT: When very close and multiple lanes away, consider skipping lanes
          // This helps vehicles in lane 2 that are close to missing the entry
          const lanesNeeded = vehicle.currentLane - targetLane;
          const urgentDistance = 100; // Within 100m, consider double lane change

          if (lanesNeeded > 1 && distanceToEntry > 0 && distanceToEntry < urgentDistance) {
            // Urgent: try to skip a lane if possible (lane 2 -> lane 0)
            // This is checked for safety in canChangeLane
            return targetLane; // Go directly to lane 0
          }

          // Normal: Move one lane at a time toward lane 0
          return vehicle.currentLane - 1;
        }
      }
    }

    return null;
  }

  /**
   * Check if it's safe to change to the target lane.
   * Uses MOBIL (Minimizing Overall Braking Induced by Lane changes) safety criterion.
   *
   * MOBIL safety check: the new follower in the target lane must not need to
   * brake harder than b_safe (comfortable deceleration threshold).
   *
   * Reference: Kesting, Treiber & Helbing (2007)
   * "General lane-changing model MOBIL for car-following models"
   */
  private canChangeLane(vehicle: Vehicle, targetLane: number): boolean {
    const { mainRoad, entryRoad } = this.topology;
    const targetLaneY = getLaneY(mainRoad, targetLane);

    // Find the vehicle that would become our new follower in target lane
    let newFollowerGap = Infinity;
    let newFollowerSpeed = 0;
    let newLeaderGap = Infinity;

    // URGENCY-BASED GAP RELAXATION:
    // When approaching the entry point, vehicles become more aggressive about lane changes
    // This prevents vehicles from missing their turn in heavy traffic
    // IMPROVED: More aggressive urgency curve for better entry success rate
    const distanceToEntry = vehicle.x - entryRoad.x;
    let urgencyFactor: number;
    if (distanceToEntry <= 0) {
      urgencyFactor = 0.15; // Very urgent if past entry point - accept tiny gaps
    } else if (distanceToEntry < 50) {
      urgencyFactor = 0.2; // Desperate - 50m or less
    } else if (distanceToEntry < 100) {
      urgencyFactor = 0.35; // Urgent - 100m or less
    } else if (distanceToEntry < 200) {
      urgencyFactor = 0.5; // Approaching - 200m or less
    } else {
      urgencyFactor = Math.min(1.0, distanceToEntry / 400); // Relaxed when far away
    }

    // Check all vehicles in target lane first to get follower speed
    for (const other of this.state.vehicles) {
      if (other.id === vehicle.id) continue;
      if (other.state === 'PARKED' || other.state === 'EXITED') continue;
      if (other.location !== 'ON_MAIN_ROAD') continue;

      // Check if in target lane (by y-position)
      if (Math.abs(other.y - targetLaneY) > LANE_WIDTH / 2) continue;

      const dx = other.x - vehicle.x;

      // Vehicle ahead in target lane (westbound: smaller x = ahead)
      if (dx < 0 && Math.abs(dx) < newLeaderGap) {
        newLeaderGap = Math.abs(dx) - CAR_LENGTH;
      }

      // Vehicle behind in target lane (westbound: larger x = behind)
      if (dx > 0) {
        const gap = dx - CAR_LENGTH;
        if (gap < newFollowerGap) {
          newFollowerGap = gap;
          newFollowerSpeed = other.speed;
        }
      }
    }

    // SPEED-DEPENDENT GAPS:
    // Gap required depends on the CLOSING SPEED (difference between follower and us)
    // If follower is slower than us, we need minimal gap
    // If follower is faster, we need gap based on their speed to avoid collision
    const closingSpeed = Math.max(0, newFollowerSpeed - vehicle.speed);
    const ourSpeedFraction = Math.min(vehicle.speed / SPEEDS.MAIN_ROAD, 1.0);

    // Base gap scales with our speed: at 0 m/s we need only CAR_LENGTH gap
    const baseGap = CAR_LENGTH + (PHYSICS.LANE_CHANGE_MIN_GAP - CAR_LENGTH) * ourSpeedFraction;

    // Gap ahead: based on our speed (we might run into the leader)
    const speedBasedGapAhead = baseGap + vehicle.speed * PHYSICS.LANE_CHANGE_TIME * 0.3;

    // Gap behind: based on CLOSING speed (follower might hit us)
    // If follower is slower than us (closing speed = 0), minimal gap needed
    // If follower is faster, need gap = closing_speed * time_to_complete_lane_change
    const speedBasedGapBehind = CAR_LENGTH * 1.2 + closingSpeed * PHYSICS.LANE_CHANGE_TIME;

    // Combine speed-based gaps with urgency factor
    const minGapAhead = speedBasedGapAhead * urgencyFactor;
    const minGapBehind = speedBasedGapBehind * urgencyFactor;

    // Safety check 1: Minimum gap ahead (can't cut in too close to leader)
    if (newLeaderGap < minGapAhead) {
      return false;
    }

    // Safety check 2: Minimum gap behind (based on closing speed)
    if (newFollowerGap < minGapBehind) {
      return false;
    }

    // Safety check 3: MOBIL safety criterion
    // The new follower must not need to brake harder than b_safe
    if (newFollowerGap < Infinity && newFollowerGap < 50) {
      const isSafe = mobilSafetyCheck(
        vehicle.speed,
        newFollowerGap,
        newFollowerSpeed
      );
      if (!isSafe) {
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
    const { entryRoad } = this.topology;
    const distToEntry = vehicle.x - entryRoad.x;

    // If already changing lanes, continue
    if (vehicle.behaviors.isChangingLane) {
      this.executeLaneChange(vehicle, dt);

      // CRITICAL: Slow down while lane changing near the turn zone
      // This ensures we complete the lane change before passing the entry
      if (vehicle.intent === 'SEEKING_PARKING' && distToEntry < entryRoad.width * 3 && distToEntry > -entryRoad.width) {
        // Near entry - slow down to complete lane change before passing
        vehicle.targetSpeed = Math.min(vehicle.targetSpeed, SPEEDS.AISLE);
      }
      return;
    }

    // Check if we need to change lanes
    const neededLane = this.checkLaneChangeNeed(vehicle);
    if (neededLane !== null && neededLane !== vehicle.currentLane) {
      // LAST RESORT: If very close to entry and desperate, force lane change with minimal safety
      // IMPROVED: Increased desperate zone from 50m to 80m for better success rate
      const desperateDistance = 80; // meters - last chance zone
      const isDesperateForLaneChange = vehicle.intent === 'SEEKING_PARKING' &&
                                        distToEntry > -20 && distToEntry < desperateDistance; // Also allow when slightly past

      // Check if safe to change (uses urgency-based relaxed gaps)
      const isSafe = this.canChangeLane(vehicle, neededLane);

      // Force lane change in desperate situations if there's ANY gap (>= CAR_LENGTH)
      const canForce = isDesperateForLaneChange && this.hasMinimalLaneChangeGap(vehicle, neededLane);

      if (isSafe || canForce) {
        // Start lane change
        vehicle.behaviors.isChangingLane = true;
        vehicle.targetLane = neededLane;
        vehicle.laneChangeStartY = vehicle.y;
        vehicle.behaviors.laneChangeProgress = 0;
        vehicle.behaviors.laneChangeDirection =
          neededLane > vehicle.currentLane! ? 'right' : 'left';

        // If forcing, slow down for safety
        if (canForce && !isSafe) {
          vehicle.targetSpeed = Math.min(vehicle.targetSpeed, SPEEDS.AISLE);
        }
      } else {
        // REALISM FIX: URGENCY
        // If we need to change lanes but CANNOT, we must slow down to find a gap.
        // If we just keep driving at full speed, we will miss the exit.
        // Use proportional distance based on road dimensions (topology-agnostic)
        const urgencyDistance = this.topology.mainRoad.length * 0.2;
        if (distToEntry < urgencyDistance && distToEntry > 0) {
            // We are getting close and stuck in the wrong lane.
            // Slow down significantly to let traffic pass and find a gap behind.
            vehicle.targetSpeed *= 0.5;
        }
      }
    }
  }

  /**
   * Check if there's a minimal gap for emergency lane change.
   * Used only in desperate situations when normal safety checks fail.
   */
  private hasMinimalLaneChangeGap(vehicle: Vehicle, targetLane: number): boolean {
    const { mainRoad } = this.topology;
    const targetLaneY = getLaneY(mainRoad, targetLane);
    const minGap = CAR_LENGTH * 1.2; // Just enough to not immediately collide

    for (const other of this.state.vehicles) {
      if (other.id === vehicle.id) continue;
      if (other.state === 'PARKED' || other.state === 'EXITED') continue;
      if (other.location !== 'ON_MAIN_ROAD') continue;

      // Check if in target lane
      if (Math.abs(other.y - targetLaneY) > LANE_WIDTH / 2) continue;

      const dx = other.x - vehicle.x;
      const dist = Math.abs(dx) - CAR_LENGTH;

      // Check both ahead and behind
      if (dist < minGap) {
        return false;
      }
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // MERGING LOGIC
  // --------------------------------------------------------------------------

  /**
   * Less restrictive gap check for vehicles waiting too long at merge point.
   * Only checks for immediate collision danger, not comfortable gaps.
   * IMPROVED: Better safety margins and checks all relevant lanes.
   */
  private hasMinimalMergeGap(vehicle: Vehicle): boolean {
    const { mainRoad } = this.topology;
    const mergeX = vehicle.x;
    const laneWidth = mainRoad.width / mainRoad.lanes;

    // SAFETY FIX: Increase minimum safe gap to account for merge trajectory
    // During merge, vehicle moves diagonally, so needs more longitudinal clearance
    const minSafeGap = CAR_LENGTH * 2.5; // Increased from 1.5 to 2.5
    const minSafeGapBehind = CAR_LENGTH * 4; // Need more space behind for approaching vehicles

    // Check all lanes since vehicle will cross through them during merge
    for (let lane = 0; lane < mainRoad.lanes; lane++) {
      const laneY = mainRoad.y - mainRoad.width / 2 + laneWidth * (lane + 0.5);

      for (const other of this.state.vehicles) {
        if (other.id === vehicle.id) continue;
        if (other.state === 'EXITED') continue;

        // Check vehicles on main road OR currently merging
        if (other.location !== 'ON_MAIN_ROAD' && other.state !== 'MERGING') continue;

        // Check if vehicle is in or near this lane
        if (Math.abs(other.y - laneY) > laneWidth * 0.8) continue;

        const dx = other.x - mergeX;

        // Block if vehicle is too close ahead (already passed merge point, going west)
        if (dx < 0 && dx > -minSafeGap) {
          return false;
        }

        // Block if vehicle is close behind and approaching
        if (dx > 0 && dx < minSafeGapBehind) {
          const timeToReach = dx / Math.max(other.speed, 1);
          // SAFETY FIX: Increased time threshold from 1.5s to 2.5s
          if (timeToReach < 2.5) {
            return false;
          }
        }

        // Check other merging vehicles - need more space
        if (other.state === 'MERGING' || other.state === 'AT_MERGE_POINT') {
          if (Math.abs(dx) < CAR_LENGTH * 3) {
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * Find a lane that the vehicle can safely merge into.
   * Returns the lane number (0, 1, or 2) or -1 if no lane is safe.
   * Prefers lower lanes (closer to exit road) but will use any available lane.
   * IMPROVED: Better gap requirements and cross-lane safety checks.
   */
  private findMergeLane(vehicle: Vehicle): number {
    const { mainRoad } = this.topology;
    const mergeX = vehicle.x;
    const laneWidth = mainRoad.width / mainRoad.lanes;

    // SAFETY FIX: Increased gap requirements for safer merging
    const minGapAhead = CAR_LENGTH * 2.5; // Increased from 1.5 to 2.5 (~11m ahead)
    const minGapBehind = CAR_LENGTH * 4; // Increased from 3 to 4 (~18m behind)

    // Check each lane, preferring lower lanes (lane 0 is closest to exit road)
    for (let lane = 0; lane < mainRoad.lanes; lane++) {
      const laneY = mainRoad.y - mainRoad.width / 2 + laneWidth * (lane + 0.5);
      let laneIsSafe = true;

      for (const other of this.state.vehicles) {
        if (other.id === vehicle.id) continue;
        if (other.state === 'EXITED') continue;

        // Only care about vehicles on/near this lane
        if (Math.abs(other.y - laneY) > laneWidth * 0.8) continue;

        // Check vehicles on road OR merging (they're in the conflict zone)
        if (other.state === 'MERGING' || other.state === 'ON_ROAD' ||
            other.state === 'AT_MERGE_POINT' || other.location === 'ON_MAIN_ROAD') {
          const dx = other.x - mergeX;

          // Avoid merging too close to another merging/waiting vehicle
          if ((other.state === 'MERGING' || other.state === 'AT_MERGE_POINT') &&
              Math.abs(dx) < CAR_LENGTH * 3) {
            laneIsSafe = false;
            break;
          }

          // Vehicle ahead (already past our merge point, going west)
          if (dx < 0 && dx > -minGapAhead) {
            laneIsSafe = false;
            break;
          }

          // Vehicle behind (approaching from east, going west)
          if (dx > 0 && dx < minGapBehind) {
            const timeToReach = dx / Math.max(other.speed, 1);
            // SAFETY FIX: Increased time threshold from 1.5s to 2.0s
            if (timeToReach < 2.0) {
              laneIsSafe = false;
              break;
            }
          }
        }
      }

      if (laneIsSafe) {
        return lane;
      }
    }

    return -1; // No safe lane found
  }

  private canMerge(vehicle: Vehicle): boolean {
    // Allow more vehicles to merge in parallel - real parking lots don't serialize merges
    // Only limit if there's already significant congestion
    const mergingCount = this.state.vehicles.filter(v => v.state === 'MERGING').length;
    if (mergingCount >= 5) {
      return false;
    }

    return this.findMergeLane(vehicle) >= 0;
  }

  // --------------------------------------------------------------------------
  // COLLISION RESOLUTION
  // --------------------------------------------------------------------------

  private resolveCollisions(): void {
    // Track which vehicles have already been emergency-braked this frame
    // to prevent multiple collisions from stacking deceleration beyond physics limits
    const brakedThisFrame = new Set<number>();

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
          const atMainRoadJunction = (v1.location === 'ON_MAIN_ROAD' || v2.location === 'ON_MAIN_ROAD') &&
                            (v1.location === 'ON_ENTRY_ROAD' || v2.location === 'ON_ENTRY_ROAD' ||
                             v1.location === 'ON_EXIT_ROAD' || v2.location === 'ON_EXIT_ROAD');
          // Also check entry road to lot transitions
          const atEntryLotJunction = (v1.location === 'ON_ENTRY_ROAD' && v2.location === 'IN_LOT') ||
                                     (v1.location === 'IN_LOT' && v2.location === 'ON_ENTRY_ROAD');
          if (!atMainRoadJunction && !atEntryLotJunction) continue;
        }

        if (this.checkCollision(v1, v2)) {
          // If v2 is parked, v1 must emergency brake (parked cars don't move)
          if (v2.state === 'PARKED') {
            if (!brakedThisFrame.has(v1.id)) {
              const emergencyDecel = PHYSICS.EMERGENCY_DECEL;
              const dt = 1 / 60; // Assume 60 FPS
              v1.speed = Math.max(0, v1.speed - emergencyDecel * dt);
              brakedThisFrame.add(v1.id);
            }
            continue;
          }

          // DEADLOCK DETECTION: Check for head-on conflict (vehicles facing each other)
          const isHeadOn = this.isHeadOnConflict(v1, v2);

          // Priority: vehicle closer to exit continues, other stops
          let priority1 = this.getExitPriority(v1);
          let priority2 = this.getExitPriority(v2);

          // For head-on conflicts, add arrival time as a tiebreaker
          // Vehicle that has been waiting longer gets priority (reward patience)
          if (isHeadOn && Math.abs(priority1 - priority2) < 10) {
            // If priorities are close, use wait time as tiebreaker
            // Higher wait time = higher priority (they've been stuck longer)
            priority1 += v1.waitTime * 2;
            priority2 += v2.waitTime * 2;
          }

          // Nudge overlapping cars apart slightly, but ONLY along road direction
          // This is TOPOLOGY-AGNOSTIC: uses vehicle.location to determine constraints
          // - ON_MAIN_ROAD: only X-axis nudging (road runs east-west)
          // - ON_ENTRY_ROAD / ON_EXIT_ROAD: only Y-axis nudging (roads run north-south)
          // - IN_LOT: both axes allowed (vehicles can be at any angle)
          const dist = distance({ x: v1.x, y: v1.y }, { x: v2.x, y: v2.y });
          const minSeparation = CAR_LENGTH * 0.8;

          if (dist > 0 && dist < minSeparation) {
            const dx = v1.x - v2.x;
            const dy = v1.y - v2.y;
            const overlap = minSeparation - dist;
            // Small nudge to separate (5% of overlap per frame)
            let nudgeX = (dx / dist) * overlap * 0.05;
            let nudgeY = (dy / dist) * overlap * 0.05;

            // LANE DISCIPLINE: Constrain nudge direction based on road type
            // This prevents vehicles from being pushed off their lane
            const v1OnMainRoad = v1.location === 'ON_MAIN_ROAD';
            const v2OnMainRoad = v2.location === 'ON_MAIN_ROAD';
            const v1OnVerticalRoad = v1.location === 'ON_ENTRY_ROAD' || v1.location === 'ON_EXIT_ROAD';
            const v2OnVerticalRoad = v2.location === 'ON_ENTRY_ROAD' || v2.location === 'ON_EXIT_ROAD';

            // If BOTH vehicles are on main road, only allow X nudging
            if (v1OnMainRoad && v2OnMainRoad) {
              nudgeY = 0;
            }
            // If BOTH vehicles are on vertical roads, only allow Y nudging
            else if (v1OnVerticalRoad && v2OnVerticalRoad) {
              nudgeX = 0;
            }
            // For mixed locations (junction), use more conservative nudging
            else if (v1OnMainRoad || v2OnMainRoad || v1OnVerticalRoad || v2OnVerticalRoad) {
              // At junctions, reduce nudge magnitude to prevent pushing off road
              nudgeX *= 0.3;
              nudgeY *= 0.3;
            }
            // IN_LOT: full nudging allowed (both axes)

            // Apply nudge with boundary checks
            const v1NewX = v1.x + nudgeX;
            const v1NewY = v1.y + nudgeY;
            const v2NewX = v2.x - nudgeX;
            const v2NewY = v2.y - nudgeY;

            // Only nudge v1 if new position is within paved area
            if (this.isWithinPavedArea(v1NewX, v1NewY)) {
              v1.x = v1NewX;
              v1.y = v1NewY;
            }

            // Only nudge v2 if new position is within paved area
            if (this.isWithinPavedArea(v2NewX, v2NewY)) {
              v2.x = v2NewX;
              v2.y = v2NewY;
            }
          }

          // Apply emergency braking to the lower priority vehicle
          // Use physics-based deceleration instead of instant stop
          // Only brake once per frame to prevent stacking from multiple collisions
          const emergencyDecel = PHYSICS.EMERGENCY_DECEL;
          const dt = 1 / 60; // Assume 60 FPS for deceleration calculation
          if (priority1 < priority2) {
            if (!brakedThisFrame.has(v1.id)) {
              v1.speed = Math.max(0, v1.speed - emergencyDecel * dt);
              brakedThisFrame.add(v1.id);
            }
          } else {
            if (!brakedThisFrame.has(v2.id)) {
              v2.speed = Math.max(0, v2.speed - emergencyDecel * dt);
              brakedThisFrame.add(v2.id);
            }
          }
        }
      }
    }
  }

  /**
   * Detect head-on conflict: two vehicles facing each other (heading difference ≈ π)
   * This is topology-agnostic and only depends on vehicle state.
   */
  private isHeadOnConflict(v1: Vehicle, v2: Vehicle): boolean {
    // Calculate heading difference
    const headingDiff = Math.abs(normalizeAngle(v1.heading - v2.heading));

    // Head-on if heading difference is close to π (facing opposite directions)
    // Allow 45 degrees tolerance on each side (π ± π/4)
    const isOppositeDirection = headingDiff > (Math.PI * 0.75) && headingDiff < (Math.PI * 1.25);

    // Also check if they're actually moving toward each other or both stopped
    // (not just passing by in parallel)
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;

    // Check if v1 is facing toward v2
    const v1FacingToV2 = Math.cos(v1.heading) * dx + Math.sin(v1.heading) * dy > 0;

    // Check if v2 is facing toward v1
    const v2FacingToV1 = Math.cos(v2.heading) * (-dx) + Math.sin(v2.heading) * (-dy) > 0;

    // Both must be facing toward each other for a true head-on conflict
    return isOppositeDirection && v1FacingToV2 && v2FacingToV1;
  }

  private checkCollision(v1: Vehicle, v2: Vehicle): boolean {
    const dist = distance({ x: v1.x, y: v1.y }, { x: v2.x, y: v2.y });
    // Trigger when cars are close enough to conflict
    const minDist = (CAR_LENGTH + CAR_WIDTH) / 2; // ~4m, average of dimensions
    return dist < minDist;
  }

  private getExitPriority(vehicle: Vehicle): number {
    // Higher = closer to exiting OR further along in their journey
    // This is topology-agnostic - priority is based on vehicle state and progress
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
      // === ENTERING VEHICLES ===
      // Vehicles further into the lot have priority (they arrived earlier)
      // Use negative y as progress indicator (lower y = deeper in lot = more progress)
      case 'PARKING':
        return 40 - vehicle.y * 0.1; // Almost at spot
      case 'NAVIGATING_TO_SPOT':
        return 30 - vehicle.y * 0.1; // In the lot
      case 'ENTERING':
        return 20 - vehicle.y * 0.1; // On entry road
      case 'APPROACHING':
        // Use spawn time as tiebreaker - earlier spawned = further along
        return 10 + (this.state.time - vehicle.spawnTime) * 0.5;
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

    // Pass-through vehicles should NOT spawn in lane 0 (the entry lane).
    // Lane 0 is reserved for vehicles that need to turn right into the parking lot.
    // Pass-through traffic in lane 0 would block parking vehicles from entering.
    // For a 3-lane road: spawn in lanes 1 or 2 only
    const availableLanes = mainRoad.lanes > 1 ? mainRoad.lanes - 1 : 1;
    const spawnLane = 1 + Math.floor(Math.random() * availableLanes); // Lane 1 or 2
    const laneY = getLaneY(mainRoad, spawnLane);
    const laneWidth = mainRoad.width / mainRoad.lanes;

    // Check spawn clearance - only in the SAME LANE
    const spawnX = mainRoad.x + mainRoad.length;
    const minSpawnClearance = CAR_LENGTH * 3; // Increased for safety

    for (const v of this.state.vehicles) {
      if (v.location === 'ON_MAIN_ROAD') {
        // Only check vehicles in the same lane (within lane width tolerance)
        if (Math.abs(v.y - laneY) < laneWidth * 0.7) {
          if (Math.abs(v.x - spawnX) < minSpawnClearance) {
            return; // Too close in this lane, skip spawn
          }
        }
      }
    }

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
    const laneWidth = mainRoad.width / mainRoad.lanes;

    // SPAWN SPACING CHECK: Don't spawn if a vehicle is too close to spawn point
    // SAFETY FIX: Check ALL lanes, not just the target spawn lane
    // Vehicles may be changing lanes near the spawn point, creating collision risk
    const spawnX = mainRoad.x + mainRoad.length;
    const minSpawnClearance = CAR_LENGTH * 3; // Need 3 car lengths clear for safety
    const minCrossLaneClearance = CAR_LENGTH * 2; // Cross-lane vehicles need less clearance

    for (const v of this.state.vehicles) {
      if (v.location === 'ON_MAIN_ROAD' || v.state === 'APPROACHING') {
        const dx = Math.abs(v.x - spawnX);

        // Check if in same lane - need full clearance
        if (Math.abs(v.y - laneY) < laneWidth * 0.7) {
          if (dx < minSpawnClearance) {
            // Too close to spawn point in this lane, skip this spawn attempt
            return null;
          }
        }
        // Check adjacent lanes - need reduced clearance (for lane changers)
        else if (Math.abs(v.y - laneY) < laneWidth * 1.5) {
          if (dx < minCrossLaneClearance) {
            // Vehicle in adjacent lane too close, might be changing lanes
            return null;
          }
        }
      }
    }

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

    // CRITICAL FIX: Reserve spot immediately at spawn time to prevent duplicate assignments
    // The spot is "reserved" (occupied=true) as soon as a vehicle targets it,
    // not when the vehicle physically parks. This prevents race conditions where
    // multiple vehicles are assigned the same spot during rapid spawning.
    spot.occupied = true;
    spot.vehicleId = vehicle.id;

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

    // DYNAMIC SPAWN RATE: Adjust spawn interval based on traffic density
    // When many vehicles are on the road/in transit, slow down spawning
    const vehiclesInTransit = this.state.vehicles.filter(
      v => v.state === 'APPROACHING' || v.state === 'ENTERING' || v.state === 'NAVIGATING_TO_SPOT'
    ).length;

    // Base interval is 0.5s, but increase when traffic is heavy
    // At 10+ vehicles in transit, spawn interval doubles to 1.0s
    // At 20+ vehicles in transit, spawn interval triples to 1.5s
    const congestionFactor = 1 + Math.floor(vehiclesInTransit / 10) * 0.5;
    const dynamicInterval = this.SPAWN_INTERVAL * congestionFactor;

    // Spawn vehicles at regular intervals
    const timeSinceLastSpawn = this.state.time - this.lastSpawnTime;
    if (timeSinceLastSpawn >= dynamicInterval) {
      // Spawn 1-2 vehicles per interval (randomized for natural flow)
      // When congested, always spawn just 1
      const toSpawnNow = congestionFactor > 1
        ? 1
        : Math.min(this.spawnQueue, Math.random() < 0.7 ? 1 : 2);

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