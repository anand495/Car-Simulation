/**
 * SIMULATION LOG ANALYZER & TEST SUITE
 * =====================================
 * Comprehensive tests for validating realistic vehicle behavior from exported logs.
 *
 * Usage:
 *   npx ts-node src/tests/log-analyzer.ts path/to/simulation-log.json
 *
 * Or import and use programmatically:
 *   import { analyzeLog, runAllTests } from './log-analyzer';
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES
// ============================================================================

interface VehicleSnapshot {
  id: number;
  timestamp: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  targetSpeed: number;
  state: string;
  location: string;
  intent: string;
  isChangingLane: boolean;
  isReversing: boolean;
  isMerging: boolean;
  isWaitingToMerge: boolean;
  currentLane: number | null;
  targetLane: number | null;
  targetSpotId: number | null;
  pathIndex: number;
  pathLength: number;
  waitTime: number;
}

interface SimulationEvent {
  timestamp: number;
  vehicleId: number;
  type: 'SPAWN' | 'PARKED' | 'EXIT_START' | 'EXITED' | 'LANE_CHANGE_START' | 'LANE_CHANGE_END' | 'STUCK';
  details?: Record<string, unknown>;
}

interface SimulationLog {
  startTime: string;
  snapshots: VehicleSnapshot[];
  events: SimulationEvent[];
}

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
  violations?: Violation[];
}

interface Violation {
  vehicleId: number;
  timestamp: number;
  description: string;
  value?: number;
  expected?: string;
}

interface VehicleTimeline {
  id: number;
  snapshots: VehicleSnapshot[];
  spawnEvent?: SimulationEvent;
  parkedEvent?: SimulationEvent;
  exitedEvent?: SimulationEvent;
}

// ============================================================================
// CONSTANTS (matching simulation)
// ============================================================================

const PHYSICS = {
  MAX_ACCELERATION: 2.5,      // m/s²
  MAX_DECELERATION: 4.0,      // m/s²
  EMERGENCY_DECEL: 8.0,       // m/s²
  SAFE_TIME_HEADWAY: 1.5,     // seconds
  MIN_GAP: 2.0,               // meters
};

const SPEEDS = {
  PARKING_LOT: 2.2,           // 5 mph
  AISLE: 4.5,                 // 10 mph
  EXIT_APPROACH: 2.2,         // 5 mph
  MERGE: 3.0,                 // 7 mph
  MAIN_ROAD: 13.4,            // 30 mph
  BACKUP: 1.0,                // 2 mph
  CREEP: 0.5,                 // 1 mph
  LANE_CHANGE: 8.9,           // 20 mph
};

const CAR_LENGTH = 4.5;
const CAR_WIDTH = 1.8;

// Tolerance for floating point comparisons
const EPSILON = 0.01;
// Allow some margin for physics calculations
const PHYSICS_TOLERANCE = 1.2; // 20% margin for numerical integration errors

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function groupByVehicle(log: SimulationLog): Map<number, VehicleTimeline> {
  const timelines = new Map<number, VehicleTimeline>();

  // Group snapshots by vehicle ID
  for (const snapshot of log.snapshots) {
    if (!timelines.has(snapshot.id)) {
      timelines.set(snapshot.id, { id: snapshot.id, snapshots: [] });
    }
    timelines.get(snapshot.id)!.snapshots.push(snapshot);
  }

  // Sort snapshots by timestamp
  for (const timeline of timelines.values()) {
    timeline.snapshots.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Attach events
  for (const event of log.events) {
    const timeline = timelines.get(event.vehicleId);
    if (timeline) {
      if (event.type === 'SPAWN') timeline.spawnEvent = event;
      if (event.type === 'PARKED') timeline.parkedEvent = event;
      if (event.type === 'EXITED') timeline.exitedEvent = event;
    }
  }

  return timelines;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

/**
 * TEST 1: Speed Limits
 * Verifies vehicles don't exceed maximum speeds for their location/state
 */
function testSpeedLimits(log: SimulationLog): TestResult {
  const violations: Violation[] = [];
  const maxSpeedByLocation: Record<string, number> = {
    'ON_MAIN_ROAD': SPEEDS.MAIN_ROAD * 1.1, // Allow 10% tolerance
    'ON_ENTRY_ROAD': SPEEDS.AISLE * 1.1,
    'ON_EXIT_ROAD': SPEEDS.AISLE * 1.1,
    'IN_LOT': SPEEDS.AISLE * 1.1,
    'IN_SPOT': 0.1, // Should be essentially stopped
  };

  for (const snapshot of log.snapshots) {
    const maxSpeed = maxSpeedByLocation[snapshot.location] ?? SPEEDS.MAIN_ROAD;
    if (snapshot.speed > maxSpeed) {
      violations.push({
        vehicleId: snapshot.id,
        timestamp: snapshot.timestamp,
        description: `Speed ${snapshot.speed.toFixed(2)} exceeds max ${maxSpeed.toFixed(2)} for ${snapshot.location}`,
        value: snapshot.speed,
        expected: `<= ${maxSpeed}`,
      });
    }
  }

  return {
    name: 'Speed Limits',
    category: 'Physics',
    passed: violations.length === 0,
    message: violations.length === 0
      ? 'All vehicles respect speed limits'
      : `${violations.length} speed limit violations found`,
    violations: violations.slice(0, 10), // Limit to first 10
    details: { totalViolations: violations.length },
  };
}

/**
 * TEST 2: Acceleration Limits
 * Verifies vehicles don't accelerate/decelerate beyond physical limits
 */
function testAccelerationLimits(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  const violations: Violation[] = [];

  for (const timeline of timelines.values()) {
    const snaps = timeline.snapshots;
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1];
      const curr = snaps[i];
      const dt = curr.timestamp - prev.timestamp;

      if (dt <= 0) continue;

      const acceleration = (curr.speed - prev.speed) / dt;

      // Check acceleration (positive)
      if (acceleration > PHYSICS.MAX_ACCELERATION * PHYSICS_TOLERANCE) {
        violations.push({
          vehicleId: curr.id,
          timestamp: curr.timestamp,
          description: `Acceleration ${acceleration.toFixed(2)} m/s² exceeds max ${PHYSICS.MAX_ACCELERATION}`,
          value: acceleration,
          expected: `<= ${PHYSICS.MAX_ACCELERATION}`,
        });
      }

      // Check deceleration (negative acceleration)
      // Allow emergency decel in some cases
      if (-acceleration > PHYSICS.EMERGENCY_DECEL * PHYSICS_TOLERANCE) {
        violations.push({
          vehicleId: curr.id,
          timestamp: curr.timestamp,
          description: `Deceleration ${(-acceleration).toFixed(2)} m/s² exceeds emergency limit ${PHYSICS.EMERGENCY_DECEL}`,
          value: -acceleration,
          expected: `<= ${PHYSICS.EMERGENCY_DECEL}`,
        });
      }
    }
  }

  return {
    name: 'Acceleration Limits',
    category: 'Physics',
    passed: violations.length === 0,
    message: violations.length === 0
      ? 'All vehicles respect acceleration limits'
      : `${violations.length} acceleration violations found`,
    violations: violations.slice(0, 10),
    details: { totalViolations: violations.length },
  };
}

/**
 * TEST 3: Position Continuity
 * Verifies vehicles don't teleport (position changes match speed)
 */
function testPositionContinuity(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  const violations: Violation[] = [];
  const TELEPORT_THRESHOLD = 20; // meters - suspicious if moved more than this in one frame

  for (const timeline of timelines.values()) {
    const snaps = timeline.snapshots;
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1];
      const curr = snaps[i];
      const dt = curr.timestamp - prev.timestamp;

      if (dt <= 0) continue;

      const dist = distance(prev.x, prev.y, curr.x, curr.y);
      const avgSpeed = (prev.speed + curr.speed) / 2;
      const expectedMaxDist = avgSpeed * dt * 1.5; // 50% tolerance

      // Check for teleportation
      if (dist > TELEPORT_THRESHOLD || (dist > expectedMaxDist && dist > 5)) {
        violations.push({
          vehicleId: curr.id,
          timestamp: curr.timestamp,
          description: `Moved ${dist.toFixed(2)}m in ${dt.toFixed(3)}s (expected max ${expectedMaxDist.toFixed(2)}m at avg speed ${avgSpeed.toFixed(2)})`,
          value: dist,
          expected: `<= ${expectedMaxDist.toFixed(2)}`,
        });
      }
    }
  }

  return {
    name: 'Position Continuity',
    category: 'Physics',
    passed: violations.length === 0,
    message: violations.length === 0
      ? 'All vehicle movements are continuous'
      : `${violations.length} teleportation events detected`,
    violations: violations.slice(0, 10),
    details: { totalViolations: violations.length },
  };
}

/**
 * TEST 4: Lane Discipline
 * Verifies vehicles stay in their lanes on the main road
 */
function testLaneDiscipline(log: SimulationLog): TestResult {
  const violations: Violation[] = [];
  const LANE_WIDTH = 3.5; // meters (typical lane width)
  const MAIN_ROAD_Y = 360; // approximate y of lane 0

  for (const snapshot of log.snapshots) {
    if (snapshot.location !== 'ON_MAIN_ROAD') continue;
    if (snapshot.isChangingLane) continue; // Skip during lane change

    if (snapshot.currentLane !== null) {
      const expectedY = MAIN_ROAD_Y + snapshot.currentLane * LANE_WIDTH;
      const deviation = Math.abs(snapshot.y - expectedY);

      // Allow deviation during turns (when heading is not purely west)
      const isHeadingWest = Math.abs(normalizeAngle(snapshot.heading - Math.PI)) < 0.3;

      if (deviation > LANE_WIDTH * 0.6 && isHeadingWest) {
        violations.push({
          vehicleId: snapshot.id,
          timestamp: snapshot.timestamp,
          description: `Lane ${snapshot.currentLane}: Y=${snapshot.y.toFixed(2)}, expected ~${expectedY.toFixed(2)}, deviation=${deviation.toFixed(2)}`,
          value: deviation,
          expected: `<= ${(LANE_WIDTH * 0.6).toFixed(2)}`,
        });
      }
    }
  }

  return {
    name: 'Lane Discipline',
    category: 'Lane Behavior',
    passed: violations.length === 0,
    message: violations.length === 0
      ? 'All vehicles maintain lane discipline'
      : `${violations.length} lane discipline violations found`,
    violations: violations.slice(0, 10),
    details: { totalViolations: violations.length },
  };
}

/**
 * TEST 5: Lane Change Safety
 * Verifies lane changes are smooth and don't cause collisions
 */
function testLaneChangeSafety(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  const violations: Violation[] = [];
  let totalLaneChanges = 0;

  for (const timeline of timelines.values()) {
    const snaps = timeline.snapshots;
    let inLaneChange = false;
    let laneChangeStart: VehicleSnapshot | null = null;

    for (let i = 0; i < snaps.length; i++) {
      const curr = snaps[i];

      // Detect lane change start
      if (curr.isChangingLane && !inLaneChange) {
        inLaneChange = true;
        laneChangeStart = curr;
        totalLaneChanges++;
      }

      // Detect lane change end
      if (!curr.isChangingLane && inLaneChange && laneChangeStart) {
        inLaneChange = false;
        const duration = curr.timestamp - laneChangeStart.timestamp;

        // Lane change should take reasonable time (1-4 seconds typically)
        if (duration < 0.5) {
          violations.push({
            vehicleId: curr.id,
            timestamp: curr.timestamp,
            description: `Lane change completed too fast: ${duration.toFixed(2)}s`,
            value: duration,
            expected: '>= 0.5s',
          });
        }
        if (duration > 10) {
          violations.push({
            vehicleId: curr.id,
            timestamp: curr.timestamp,
            description: `Lane change took too long: ${duration.toFixed(2)}s`,
            value: duration,
            expected: '<= 10s',
          });
        }

        laneChangeStart = null;
      }
    }
  }

  return {
    name: 'Lane Change Safety',
    category: 'Lane Behavior',
    passed: violations.length === 0,
    message: violations.length === 0
      ? `All ${totalLaneChanges} lane changes completed safely`
      : `${violations.length} lane change issues found`,
    violations: violations.slice(0, 10),
    details: { totalLaneChanges, totalViolations: violations.length },
  };
}

/**
 * TEST 6: Stuck Vehicle Detection
 * Identifies vehicles that got stuck for too long
 */
function testStuckVehicles(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  const violations: Violation[] = [];
  const STUCK_THRESHOLD = 30; // seconds - vehicle considered problematically stuck
  const MAX_ACCEPTABLE_WAIT = 60; // seconds - maximum acceptable wait time

  let maxWaitTime = 0;
  let vehiclesEverStuck = 0;

  for (const timeline of timelines.values()) {
    const snaps = timeline.snapshots;
    let wasEverStuck = false;

    for (const snap of snaps) {
      if (snap.waitTime > maxWaitTime) {
        maxWaitTime = snap.waitTime;
      }

      if (snap.waitTime > 5 && snap.state !== 'PARKED') {
        wasEverStuck = true;
      }

      if (snap.waitTime > STUCK_THRESHOLD && snap.state !== 'PARKED') {
        violations.push({
          vehicleId: snap.id,
          timestamp: snap.timestamp,
          description: `Stuck for ${snap.waitTime.toFixed(1)}s in state ${snap.state}`,
          value: snap.waitTime,
          expected: `<= ${STUCK_THRESHOLD}s`,
        });
      }
    }

    if (wasEverStuck) vehiclesEverStuck++;
  }

  // Deduplicate violations (keep only first occurrence per vehicle)
  const uniqueViolations: Violation[] = [];
  const seenVehicles = new Set<number>();
  for (const v of violations) {
    if (!seenVehicles.has(v.vehicleId)) {
      seenVehicles.add(v.vehicleId);
      uniqueViolations.push(v);
    }
  }

  return {
    name: 'Stuck Vehicle Detection',
    category: 'Collision & Deadlock',
    passed: uniqueViolations.length === 0 && maxWaitTime < MAX_ACCEPTABLE_WAIT,
    message: uniqueViolations.length === 0
      ? `No critically stuck vehicles. Max wait time: ${maxWaitTime.toFixed(1)}s`
      : `${uniqueViolations.length} vehicles got stuck for >${STUCK_THRESHOLD}s`,
    violations: uniqueViolations.slice(0, 10),
    details: {
      maxWaitTime,
      vehiclesEverStuck,
      criticallyStuckCount: uniqueViolations.length,
    },
  };
}

/**
 * TEST 7: Vehicle Proximity (Collision Detection)
 * Checks if vehicles maintain safe distances
 */
function testVehicleProximity(log: SimulationLog): TestResult {
  const violations: Violation[] = [];
  const MIN_DISTANCE = CAR_LENGTH * 0.5; // Half car length = potential collision

  // Group snapshots by timestamp for proximity checks
  const byTimestamp = new Map<number, VehicleSnapshot[]>();
  for (const snap of log.snapshots) {
    const ts = Math.round(snap.timestamp * 10) / 10; // Round to 0.1s
    if (!byTimestamp.has(ts)) {
      byTimestamp.set(ts, []);
    }
    byTimestamp.get(ts)!.push(snap);
  }

  let totalChecks = 0;
  let closeEncounters = 0;

  for (const [timestamp, snaps] of byTimestamp) {
    for (let i = 0; i < snaps.length; i++) {
      for (let j = i + 1; j < snaps.length; j++) {
        totalChecks++;
        const a = snaps[i];
        const b = snaps[j];

        // Skip parked vehicles
        if (a.state === 'PARKED' && b.state === 'PARKED') continue;

        const dist = distance(a.x, a.y, b.x, b.y);

        if (dist < MIN_DISTANCE) {
          closeEncounters++;
          // Only record as violation if both are moving
          if (a.speed > 0.5 && b.speed > 0.5) {
            violations.push({
              vehicleId: a.id,
              timestamp,
              description: `Vehicles ${a.id} and ${b.id} within ${dist.toFixed(2)}m (both moving)`,
              value: dist,
              expected: `>= ${MIN_DISTANCE.toFixed(2)}m`,
            });
          }
        }
      }
    }
  }

  // Deduplicate by timestamp (one violation per timestamp window)
  const uniqueViolations: Violation[] = [];
  const seenTimestamps = new Set<number>();
  for (const v of violations) {
    const tsWindow = Math.floor(v.timestamp);
    if (!seenTimestamps.has(tsWindow)) {
      seenTimestamps.add(tsWindow);
      uniqueViolations.push(v);
    }
  }

  return {
    name: 'Vehicle Proximity (Collision Detection)',
    category: 'Collision & Deadlock',
    passed: uniqueViolations.length === 0,
    message: uniqueViolations.length === 0
      ? `No collision-like events. ${closeEncounters} close encounters (acceptable)`
      : `${uniqueViolations.length} potential collisions detected`,
    violations: uniqueViolations.slice(0, 10),
    details: {
      totalProximityChecks: totalChecks,
      closeEncounters,
      potentialCollisions: uniqueViolations.length,
    },
  };
}

/**
 * TEST 8: Spawn Rate Analysis
 * Verifies spawn rate is appropriate and not overwhelming
 */
function testSpawnRate(log: SimulationLog): TestResult {
  const spawnEvents = log.events.filter(e => e.type === 'SPAWN');

  if (spawnEvents.length < 2) {
    return {
      name: 'Spawn Rate Analysis',
      category: 'Traffic Flow',
      passed: true,
      message: 'Insufficient spawn events for analysis',
      details: { totalSpawns: spawnEvents.length },
    };
  }

  // Sort by timestamp
  spawnEvents.sort((a, b) => a.timestamp - b.timestamp);

  const intervals: number[] = [];
  for (let i = 1; i < spawnEvents.length; i++) {
    intervals.push(spawnEvents[i].timestamp - spawnEvents[i - 1].timestamp);
  }

  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const minInterval = Math.min(...intervals);
  const maxInterval = Math.max(...intervals);

  // Check for burst spawning (too many too fast)
  const burstThreshold = 0.1; // 100ms minimum between spawns
  const bursts = intervals.filter(i => i < burstThreshold).length;

  const violations: Violation[] = [];
  if (bursts > intervals.length * 0.1) {
    violations.push({
      vehicleId: -1,
      timestamp: 0,
      description: `${bursts} burst spawns (interval < ${burstThreshold}s)`,
      value: bursts,
      expected: `< ${Math.floor(intervals.length * 0.1)}`,
    });
  }

  return {
    name: 'Spawn Rate Analysis',
    category: 'Traffic Flow',
    passed: violations.length === 0,
    message: violations.length === 0
      ? `Spawn rate healthy: avg ${avgInterval.toFixed(2)}s, range [${minInterval.toFixed(2)}s - ${maxInterval.toFixed(2)}s]`
      : `Spawn rate issues detected`,
    violations,
    details: {
      totalSpawns: spawnEvents.length,
      avgInterval,
      minInterval,
      maxInterval,
      burstSpawns: bursts,
    },
  };
}

/**
 * TEST 9: State Transitions
 * Verifies vehicles follow valid state transition paths
 */
function testStateTransitions(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  const violations: Violation[] = [];

  // Valid state transitions
  const validTransitions: Record<string, string[]> = {
    'APPROACHING': ['ENTERING', 'ON_ROAD', 'EXITED'], // Can pass through or enter
    'ENTERING': ['NAVIGATING_TO_SPOT', 'APPROACHING'], // Rare: back to approaching
    'NAVIGATING_TO_SPOT': ['PARKING', 'NAVIGATING_TO_SPOT'],
    'PARKING': ['PARKED', 'NAVIGATING_TO_SPOT'], // Might need to retry
    'PARKED': ['EXITING_SPOT', 'PARKED'],
    'EXITING_SPOT': ['DRIVING_TO_EXIT', 'EXITING_SPOT'],
    'DRIVING_TO_EXIT': ['IN_EXIT_LANE', 'DRIVING_TO_EXIT'],
    'IN_EXIT_LANE': ['AT_MERGE_POINT', 'IN_EXIT_LANE'],
    'AT_MERGE_POINT': ['MERGING', 'AT_MERGE_POINT'],
    'MERGING': ['ON_ROAD', 'MERGING'],
    'ON_ROAD': ['EXITED', 'ON_ROAD'],
    'EXITED': [], // Terminal state
  };

  for (const timeline of timelines.values()) {
    const snaps = timeline.snapshots;
    for (let i = 1; i < snaps.length; i++) {
      const prevState = snaps[i - 1].state;
      const currState = snaps[i].state;

      if (prevState !== currState) {
        const allowed = validTransitions[prevState] || [];
        if (!allowed.includes(currState) && currState !== prevState) {
          violations.push({
            vehicleId: snaps[i].id,
            timestamp: snaps[i].timestamp,
            description: `Invalid transition: ${prevState} → ${currState}`,
            expected: `One of: ${allowed.join(', ')}`,
          });
        }
      }
    }
  }

  return {
    name: 'State Transitions',
    category: 'State Machine',
    passed: violations.length === 0,
    message: violations.length === 0
      ? 'All state transitions are valid'
      : `${violations.length} invalid state transitions`,
    violations: violations.slice(0, 10),
    details: { totalViolations: violations.length },
  };
}

/**
 * TEST 10: Parking Success Rate
 * Analyzes how many vehicles successfully parked
 */
function testParkingSuccessRate(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  let seekingParking = 0;
  let parked = 0;
  let missedTurns = 0;
  let passThrough = 0;

  for (const timeline of timelines.values()) {
    const firstSnap = timeline.snapshots[0];
    const lastSnap = timeline.snapshots[timeline.snapshots.length - 1];

    if (firstSnap?.intent === 'SEEKING_PARKING') {
      seekingParking++;
      if (timeline.parkedEvent) {
        parked++;
      } else if (lastSnap?.state === 'EXITED' || lastSnap?.state === 'ON_ROAD') {
        missedTurns++;
      }
    } else if (firstSnap?.intent === 'PASSING_THROUGH') {
      passThrough++;
    }
  }

  const successRate = seekingParking > 0 ? (parked / seekingParking) * 100 : 100;
  const MINIMUM_SUCCESS_RATE = 70; // At least 70% should park

  return {
    name: 'Parking Success Rate',
    category: 'Traffic Flow',
    passed: successRate >= MINIMUM_SUCCESS_RATE,
    message: `${successRate.toFixed(1)}% parking success (${parked}/${seekingParking})`,
    details: {
      seekingParking,
      parked,
      missedTurns,
      passThrough,
      successRate,
    },
  };
}

/**
 * TEST 11: Yielding Behavior
 * Verifies vehicles yield appropriately
 */
function testYieldingBehavior(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  let yieldingInstances = 0;
  let mergingInstances = 0;
  let waitingToMergeInstances = 0;

  for (const snap of log.snapshots) {
    if (snap.state === 'AT_MERGE_POINT' || snap.isWaitingToMerge) {
      waitingToMergeInstances++;
    }
    if (snap.isMerging) {
      mergingInstances++;
    }
  }

  // Count vehicles that successfully merged
  let successfulMerges = 0;
  for (const timeline of timelines.values()) {
    const states = timeline.snapshots.map(s => s.state);
    if (states.includes('AT_MERGE_POINT') && states.includes('ON_ROAD')) {
      successfulMerges++;
    }
  }

  return {
    name: 'Yielding Behavior',
    category: 'Traffic Flow',
    passed: true, // Informational test
    message: `${successfulMerges} successful merges, ${waitingToMergeInstances} yield instances`,
    details: {
      waitingToMergeInstances,
      mergingInstances,
      successfulMerges,
    },
  };
}

/**
 * TEST 12: Reversing Safety
 * Verifies backing vehicles move slowly
 */
function testReversingSafety(log: SimulationLog): TestResult {
  const violations: Violation[] = [];
  const MAX_REVERSE_SPEED = SPEEDS.BACKUP * 1.5; // Allow 50% tolerance

  for (const snap of log.snapshots) {
    if (snap.isReversing && snap.speed > MAX_REVERSE_SPEED) {
      violations.push({
        vehicleId: snap.id,
        timestamp: snap.timestamp,
        description: `Reversing at ${snap.speed.toFixed(2)} m/s (max ${MAX_REVERSE_SPEED})`,
        value: snap.speed,
        expected: `<= ${MAX_REVERSE_SPEED}`,
      });
    }
  }

  return {
    name: 'Reversing Safety',
    category: 'Physics',
    passed: violations.length === 0,
    message: violations.length === 0
      ? 'All reversing done at safe speeds'
      : `${violations.length} unsafe reversing events`,
    violations: violations.slice(0, 10),
    details: { totalViolations: violations.length },
  };
}

/**
 * TEST 13: Heading Consistency
 * Verifies heading changes are smooth (no instant 180° turns)
 */
function testHeadingConsistency(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  const violations: Violation[] = [];
  const MAX_TURN_RATE = Math.PI; // radians per second (about 180°/s max)

  for (const timeline of timelines.values()) {
    const snaps = timeline.snapshots;
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1];
      const curr = snaps[i];
      const dt = curr.timestamp - prev.timestamp;

      if (dt <= 0) continue;

      const headingChange = Math.abs(normalizeAngle(curr.heading - prev.heading));
      const turnRate = headingChange / dt;

      // Allow instant turns at very low speeds (parking maneuvers)
      if (turnRate > MAX_TURN_RATE && prev.speed > 1 && curr.speed > 1) {
        violations.push({
          vehicleId: curr.id,
          timestamp: curr.timestamp,
          description: `Turn rate ${(turnRate * 180 / Math.PI).toFixed(1)}°/s at speed ${curr.speed.toFixed(2)}`,
          value: turnRate,
          expected: `<= ${MAX_TURN_RATE} rad/s`,
        });
      }
    }
  }

  return {
    name: 'Heading Consistency',
    category: 'Physics',
    passed: violations.length === 0,
    message: violations.length === 0
      ? 'All heading changes are smooth'
      : `${violations.length} abrupt heading changes detected`,
    violations: violations.slice(0, 10),
    details: { totalViolations: violations.length },
  };
}

/**
 * TEST 14: Path Progress
 * Verifies vehicles make progress along their paths
 */
function testPathProgress(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  const violations: Violation[] = [];
  const STALL_THRESHOLD = 30; // seconds without path progress

  for (const timeline of timelines.values()) {
    const snaps = timeline.snapshots;
    if (snaps.length < 2) continue;

    let lastProgressTime = snaps[0].timestamp;
    let lastPathIndex = snaps[0].pathIndex;

    for (const snap of snaps) {
      if (snap.pathIndex !== lastPathIndex) {
        lastPathIndex = snap.pathIndex;
        lastProgressTime = snap.timestamp;
      } else {
        const stalled = snap.timestamp - lastProgressTime;
        if (stalled > STALL_THRESHOLD && snap.state !== 'PARKED' && snap.pathLength > 0) {
          violations.push({
            vehicleId: snap.id,
            timestamp: snap.timestamp,
            description: `No path progress for ${stalled.toFixed(1)}s in state ${snap.state}`,
            value: stalled,
            expected: `< ${STALL_THRESHOLD}s`,
          });
          lastProgressTime = snap.timestamp; // Reset to avoid repeated violations
        }
      }
    }
  }

  // Deduplicate
  const uniqueViolations: Violation[] = [];
  const seen = new Set<string>();
  for (const v of violations) {
    const key = `${v.vehicleId}-${Math.floor(v.timestamp / 30)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueViolations.push(v);
    }
  }

  return {
    name: 'Path Progress',
    category: 'State Machine',
    passed: uniqueViolations.length === 0,
    message: uniqueViolations.length === 0
      ? 'All vehicles make consistent path progress'
      : `${uniqueViolations.length} path stall events`,
    violations: uniqueViolations.slice(0, 10),
    details: { totalViolations: uniqueViolations.length },
  };
}

/**
 * TEST 15: Exit Completion
 * Verifies exiting vehicles complete their exit
 */
function testExitCompletion(log: SimulationLog, timelines: Map<number, VehicleTimeline>): TestResult {
  let startedExiting = 0;
  let completedExit = 0;
  let stuckExiting = 0;

  for (const timeline of timelines.values()) {
    const states = timeline.snapshots.map(s => s.state);

    if (states.includes('EXITING_SPOT')) {
      startedExiting++;
      if (states.includes('ON_ROAD') || timeline.exitedEvent) {
        completedExit++;
      } else {
        stuckExiting++;
      }
    }
  }

  const completionRate = startedExiting > 0 ? (completedExit / startedExiting) * 100 : 100;

  return {
    name: 'Exit Completion',
    category: 'Traffic Flow',
    passed: completionRate >= 90,
    message: `${completionRate.toFixed(1)}% exit completion (${completedExit}/${startedExiting})`,
    details: {
      startedExiting,
      completedExit,
      stuckExiting,
      completionRate,
    },
  };
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

export function runAllTests(log: SimulationLog): TestResult[] {
  const timelines = groupByVehicle(log);

  const results: TestResult[] = [
    // Physics tests
    testSpeedLimits(log),
    testAccelerationLimits(log, timelines),
    testPositionContinuity(log, timelines),
    testReversingSafety(log),
    testHeadingConsistency(log, timelines),

    // Lane behavior tests
    testLaneDiscipline(log),
    testLaneChangeSafety(log, timelines),

    // Collision & deadlock tests
    testStuckVehicles(log, timelines),
    testVehicleProximity(log),

    // Traffic flow tests
    testSpawnRate(log),
    testParkingSuccessRate(log, timelines),
    testYieldingBehavior(log, timelines),
    testExitCompletion(log, timelines),

    // State machine tests
    testStateTransitions(log, timelines),
    testPathProgress(log, timelines),
  ];

  return results;
}

export function printResults(results: TestResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('SIMULATION LOG ANALYSIS RESULTS');
  console.log('='.repeat(80) + '\n');

  // Group by category
  const byCategory = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byCategory.has(r.category)) {
      byCategory.set(r.category, []);
    }
    byCategory.get(r.category)!.push(r);
  }

  let totalPassed = 0;
  let totalFailed = 0;

  for (const [category, tests] of byCategory) {
    console.log(`\n📦 ${category}`);
    console.log('-'.repeat(40));

    for (const test of tests) {
      const status = test.passed ? '✅' : '❌';
      console.log(`  ${status} ${test.name}`);
      console.log(`     ${test.message}`);

      if (test.passed) totalPassed++;
      else totalFailed++;

      // Print details
      if (test.details) {
        for (const [key, value] of Object.entries(test.details)) {
          if (typeof value === 'number') {
            console.log(`     • ${key}: ${value.toFixed ? value.toFixed(2) : value}`);
          }
        }
      }

      // Print violations
      if (test.violations && test.violations.length > 0) {
        console.log('     Violations:');
        for (const v of test.violations.slice(0, 5)) {
          console.log(`       - [t=${v.timestamp.toFixed(1)}s, v${v.vehicleId}] ${v.description}`);
        }
        if (test.violations.length > 5) {
          console.log(`       ... and ${test.violations.length - 5} more`);
        }
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`  Total tests: ${results.length}`);
  console.log(`  ✅ Passed: ${totalPassed}`);
  console.log(`  ❌ Failed: ${totalFailed}`);
  console.log(`  Success rate: ${((totalPassed / results.length) * 100).toFixed(1)}%`);
  console.log('='.repeat(80) + '\n');
}

export function generateReport(log: SimulationLog, results: TestResult[]): string {
  const timelines = groupByVehicle(log);

  let report = '# Simulation Log Analysis Report\n\n';
  report += `**Generated:** ${new Date().toISOString()}\n`;
  report += `**Log Start Time:** ${log.startTime}\n`;
  report += `**Total Snapshots:** ${log.snapshots.length}\n`;
  report += `**Total Events:** ${log.events.length}\n`;
  report += `**Unique Vehicles:** ${timelines.size}\n\n`;

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  report += '## Summary\n\n';
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Total Tests | ${results.length} |\n`;
  report += `| Passed | ${passed} |\n`;
  report += `| Failed | ${failed} |\n`;
  report += `| Success Rate | ${((passed / results.length) * 100).toFixed(1)}% |\n\n`;

  // Detailed results
  report += '## Test Results\n\n';

  const byCategory = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byCategory.has(r.category)) {
      byCategory.set(r.category, []);
    }
    byCategory.get(r.category)!.push(r);
  }

  for (const [category, tests] of byCategory) {
    report += `### ${category}\n\n`;

    for (const test of tests) {
      const status = test.passed ? '✅' : '❌';
      report += `#### ${status} ${test.name}\n\n`;
      report += `${test.message}\n\n`;

      if (test.details && Object.keys(test.details).length > 0) {
        report += '| Detail | Value |\n';
        report += '|--------|-------|\n';
        for (const [key, value] of Object.entries(test.details)) {
          const displayValue = typeof value === 'number' && value % 1 !== 0
            ? value.toFixed(2)
            : value;
          report += `| ${key} | ${displayValue} |\n`;
        }
        report += '\n';
      }

      if (test.violations && test.violations.length > 0) {
        report += '**Violations:**\n\n';
        for (const v of test.violations.slice(0, 10)) {
          report += `- \`[t=${v.timestamp.toFixed(1)}s, v${v.vehicleId}]\` ${v.description}\n`;
        }
        if (test.violations.length > 10) {
          report += `- ... and ${test.violations.length - 10} more\n`;
        }
        report += '\n';
      }
    }
  }

  return report;
}

// ============================================================================
// CLI ENTRY POINT (for direct execution)
// ============================================================================

export function runLogAnalyzerCLI(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npx tsx src/tests/log-analyzer.ts <path-to-log.json> [--report]');
    console.log('Options:');
    console.log('  --report    Generate a markdown report file');
    process.exit(1);
  }

  const logPath = args[0];
  const generateMarkdownReport = args.includes('--report');

  try {
    console.log(`Loading log from: ${logPath}`);
    const logData = fs.readFileSync(logPath, 'utf-8');
    const log: SimulationLog = JSON.parse(logData);

    console.log(`Loaded ${log.snapshots.length} snapshots, ${log.events.length} events`);

    const results = runAllTests(log);
    printResults(results);

    if (generateMarkdownReport) {
      const report = generateReport(log, results);
      const reportPath = logPath.replace('.json', '-report.md');
      fs.writeFileSync(reportPath, report);
      console.log(`Report written to: ${reportPath}`);
    }

    // Exit with appropriate code
    const allPassed = results.every(r => r.passed);
    process.exit(allPassed ? 0 : 1);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Check if running directly (ES module way)
const isDirectRun = process.argv[1]?.includes('log-analyzer');
if (isDirectRun) {
  runLogAnalyzerCLI();
}
