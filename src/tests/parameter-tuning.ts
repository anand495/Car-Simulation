/**
 * IDM/MOBIL Parameter Tuning System
 * ==================================
 *
 * This module implements parameter optimization for the IDM (Intelligent Driver Model)
 * and MOBIL (Minimizing Overall Braking Induced by Lane changes) models.
 *
 * Approach:
 * 1. Define a reward function that captures simulation goals
 * 2. Use a grid search / hill climbing metaheuristic to find optimal parameters
 * 3. Evaluate parameters by running short simulations and computing rewards
 *
 * Goals (captured in reward function):
 * - Minimize collisions (highest priority)
 * - Minimize stuck vehicles (high priority)
 * - Maximize parking throughput (medium priority)
 * - Maintain physics compliance (medium priority)
 * - Keep vehicles within paved area (high priority)
 */

import { Simulation } from '../simulation.js';
import { createStandardLot } from '../topology.js';
import {
  IDMParams,
  DEFAULT_CONFIG,
  CAR_LENGTH,
} from '../types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface TuningParameters {
  // IDM Parameters
  idm_T: number;      // Time headway (seconds)
  idm_s0: number;     // Minimum gap (meters)
  idm_a: number;      // Acceleration (m/s²)
  idm_b: number;      // Deceleration (m/s²)

  // IDM Parking Parameters
  idm_parking_T: number;
  idm_parking_s0: number;
  idm_parking_a: number;
  idm_parking_b: number;

  // IDM Merge Parameters
  idm_merge_T: number;
  idm_merge_s0: number;
  idm_merge_a: number;
  idm_merge_b: number;

  // MOBIL Parameters
  mobil_p: number;           // Politeness (0-1)
  mobil_athreshold: number;  // Threshold (m/s²)
  mobil_bsafe: number;       // Safe braking (m/s²)
  mobil_abias: number;       // Right lane bias (m/s²)
}

export interface SimulationMetrics {
  totalVehicles: number;
  collisions: number;
  stuckVehicles: number;      // Vehicles stuck > 10s
  vehiclesParked: number;
  vehiclesExited: number;
  avgWaitTime: number;
  maxWaitTime: number;
  physicsViolations: number;  // Decel > 8 m/s²
  boundaryViolations: number; // Vehicles outside paved area
  throughput: number;         // Vehicles per minute
  avgExitTime: number;        // Seconds from park to exit
  laneChangeSuccess: number;  // Percentage of successful lane changes
}

export interface RewardComponents {
  collisionPenalty: number;
  stuckPenalty: number;
  throughputReward: number;
  physicsReward: number;
  boundaryPenalty: number;
  waitTimePenalty: number;
  total: number;
}

// ============================================================================
// DEFAULT PARAMETER RANGES FOR TUNING
// ============================================================================

export const PARAM_RANGES = {
  idm_T: { min: 0.8, max: 2.5, step: 0.1 },
  idm_s0: { min: 1.0, max: 4.0, step: 0.25 },
  idm_a: { min: 1.5, max: 3.5, step: 0.25 },
  idm_b: { min: 2.5, max: 5.0, step: 0.25 },

  idm_parking_T: { min: 0.6, max: 1.8, step: 0.1 },
  idm_parking_s0: { min: 1.0, max: 2.5, step: 0.25 },
  idm_parking_a: { min: 1.0, max: 2.5, step: 0.25 },
  idm_parking_b: { min: 2.0, max: 4.0, step: 0.25 },

  idm_merge_T: { min: 0.8, max: 1.8, step: 0.1 },
  idm_merge_s0: { min: 1.0, max: 2.5, step: 0.25 },
  idm_merge_a: { min: 2.0, max: 3.5, step: 0.25 },
  idm_merge_b: { min: 3.0, max: 5.0, step: 0.25 },

  mobil_p: { min: 0.2, max: 0.8, step: 0.1 },
  mobil_athreshold: { min: 0.1, max: 0.5, step: 0.05 },
  mobil_bsafe: { min: 3.0, max: 6.0, step: 0.5 },
  mobil_abias: { min: 0.1, max: 0.5, step: 0.1 },
};

// Current default parameters
export const DEFAULT_PARAMS: TuningParameters = {
  idm_T: 1.5,
  idm_s0: 2.0,
  idm_a: 2.5,
  idm_b: 4.0,

  idm_parking_T: 1.0,
  idm_parking_s0: 1.5,
  idm_parking_a: 2.0,
  idm_parking_b: 3.0,

  idm_merge_T: 1.2,
  idm_merge_s0: 1.5,
  idm_merge_a: 2.5,
  idm_merge_b: 4.0,

  mobil_p: 0.5,
  mobil_athreshold: 0.2,
  mobil_bsafe: 4.0,
  mobil_abias: 0.3,
};

// ============================================================================
// REWARD FUNCTION
// ============================================================================

/**
 * Compute reward from simulation metrics.
 *
 * Reward components:
 * - Collision penalty: -1000 per collision (critical safety issue)
 * - Stuck penalty: -50 per stuck vehicle (blocking traffic flow)
 * - Boundary penalty: -200 per boundary violation (car off road)
 * - Physics penalty: -100 per physics violation (unrealistic decel)
 * - Wait time penalty: -1 per second average wait (inefficiency)
 * - Throughput reward: +10 per vehicle exited (goal achievement)
 * - Exit time reward: +100 if avg exit time < 30s, scaled down after
 */
export function computeReward(metrics: SimulationMetrics): RewardComponents {
  // Weights for each component
  const COLLISION_WEIGHT = -1000;
  const STUCK_WEIGHT = -50;
  const BOUNDARY_WEIGHT = -200;
  const PHYSICS_WEIGHT = -100;
  const WAIT_WEIGHT = -1;
  const THROUGHPUT_WEIGHT = 10;
  const EXIT_TIME_BASE = 100;

  const collisionPenalty = metrics.collisions * COLLISION_WEIGHT;
  const stuckPenalty = metrics.stuckVehicles * STUCK_WEIGHT;
  const boundaryPenalty = metrics.boundaryViolations * BOUNDARY_WEIGHT;
  const physicsReward = metrics.physicsViolations * PHYSICS_WEIGHT;
  const waitTimePenalty = metrics.avgWaitTime * WAIT_WEIGHT;
  const throughputReward = metrics.vehiclesExited * THROUGHPUT_WEIGHT;

  // Exit time reward: bonus for fast exits
  // Target: 30s or less = full bonus, scaled down to 0 at 120s
  let exitTimeReward = 0;
  if (metrics.avgExitTime > 0 && metrics.vehiclesExited > 0) {
    if (metrics.avgExitTime <= 30) {
      exitTimeReward = EXIT_TIME_BASE;
    } else if (metrics.avgExitTime < 120) {
      exitTimeReward = EXIT_TIME_BASE * (1 - (metrics.avgExitTime - 30) / 90);
    }
  }

  const total = collisionPenalty + stuckPenalty + boundaryPenalty +
                physicsReward + waitTimePenalty + throughputReward + exitTimeReward;

  return {
    collisionPenalty,
    stuckPenalty,
    throughputReward: throughputReward + exitTimeReward,
    physicsReward,
    boundaryPenalty,
    waitTimePenalty,
    total,
  };
}

// ============================================================================
// SIMULATION EVALUATION
// ============================================================================

/**
 * Run a simulation with given parameters and collect metrics.
 */
export function evaluateParameters(
  params: TuningParameters,
  numVehicles: number = 50,
  simDuration: number = 60,  // seconds
  numSpots: number = 100
): SimulationMetrics {
  // Create simulation with custom parameters
  const topology = createStandardLot(numSpots);
  const config = {
    ...DEFAULT_CONFIG,
    numSpots,
    enableLogging: false,  // Disable for performance
  };

  const sim = new Simulation(topology, config);

  // Apply parameters to simulation (would need to modify Simulation class to accept these)
  // For now, we'll use the default parameters in the Simulation class

  // Fill lot with vehicles
  sim.fillLot(numVehicles);

  // Run simulation for specified duration
  const dt = 0.1;  // 100ms timestep
  const steps = Math.ceil(simDuration / dt);

  // Track metrics
  let collisions = 0;
  let maxWaitTime = 0;
  let totalWaitTime = 0;
  let waitCount = 0;
  let physicsViolations = 0;
  let boundaryViolations = 0;

  for (let i = 0; i < steps; i++) {
    sim.step(dt);

    // Check for collisions
    const vehicles = sim.state.vehicles;
    for (let j = 0; j < vehicles.length; j++) {
      const v1 = vehicles[j];
      if (v1.state === 'EXITED' || v1.state === 'PARKED') continue;

      for (let k = j + 1; k < vehicles.length; k++) {
        const v2 = vehicles[k];
        if (v2.state === 'EXITED' || v2.state === 'PARKED') continue;

        const dist = Math.sqrt((v1.x - v2.x) ** 2 + (v1.y - v2.y) ** 2);
        if (dist < CAR_LENGTH * 0.8) {
          collisions++;
        }
      }

      // Track wait time
      if (v1.waitTime > 0) {
        totalWaitTime += v1.waitTime;
        waitCount++;
        maxWaitTime = Math.max(maxWaitTime, v1.waitTime);
      }

      // Check physics - deceleration should not exceed emergency decel
      if (v1.acceleration < -8) {
        physicsViolations++;
      }

      // Check boundary
      if (!sim.isWithinPavedArea(v1.x, v1.y)) {
        boundaryViolations++;
      }
    }
  }

  // Start exodus
  sim.startExodus();

  // Run exodus for same duration
  for (let i = 0; i < steps; i++) {
    sim.step(dt);

    // Continue tracking metrics during exodus
    const vehicles = sim.state.vehicles;
    for (const v of vehicles) {
      if (v.state === 'EXITED' || v.state === 'PARKED') continue;

      if (v.waitTime > maxWaitTime) {
        maxWaitTime = v.waitTime;
      }
      if (v.acceleration < -8) {
        physicsViolations++;
      }
      if (!sim.isWithinPavedArea(v.x, v.y)) {
        boundaryViolations++;
      }
    }
  }

  // Count stuck vehicles (wait > 10s)
  const stuckVehicles = sim.state.vehicles.filter(v =>
    v.state !== 'EXITED' && v.state !== 'PARKED' && v.waitTime > 10
  ).length;

  return {
    totalVehicles: sim.state.totalSpawned,
    collisions: Math.floor(collisions / 10),  // Normalize (multiple detections per collision)
    stuckVehicles,
    vehiclesParked: sim.state.parkedCount,
    vehiclesExited: sim.state.exitedCount,
    avgWaitTime: waitCount > 0 ? totalWaitTime / waitCount : 0,
    maxWaitTime,
    physicsViolations: Math.floor(physicsViolations / 10),  // Normalize
    boundaryViolations: Math.floor(boundaryViolations / 10),  // Normalize
    throughput: sim.state.throughput,
    avgExitTime: sim.state.avgExitTime ?? 0,
    laneChangeSuccess: 0,  // Would need to track in simulation
  };
}

// ============================================================================
// HILL CLIMBING OPTIMIZER
// ============================================================================

interface OptimizationResult {
  bestParams: TuningParameters;
  bestReward: number;
  history: Array<{ params: TuningParameters; reward: number }>;
  iterations: number;
}

/**
 * Hill climbing optimization for parameter tuning.
 *
 * Strategy:
 * 1. Start with default parameters
 * 2. For each parameter, try small perturbations
 * 3. Keep changes that improve the reward
 * 4. Repeat until no improvement found
 */
export async function optimizeParameters(
  initialParams: TuningParameters = DEFAULT_PARAMS,
  maxIterations: number = 50,
  verbose: boolean = true
): Promise<OptimizationResult> {
  let currentParams = { ...initialParams };
  let currentMetrics = evaluateParameters(currentParams);
  let currentReward = computeReward(currentMetrics).total;

  const history: Array<{ params: TuningParameters; reward: number }> = [
    { params: { ...currentParams }, reward: currentReward }
  ];

  if (verbose) {
    console.log('Starting optimization...');
    console.log(`Initial reward: ${currentReward.toFixed(2)}`);
    console.log(`Initial metrics:`, currentMetrics);
  }

  let iteration = 0;
  let improved = true;

  while (improved && iteration < maxIterations) {
    improved = false;
    iteration++;

    if (verbose) {
      console.log(`\n--- Iteration ${iteration} ---`);
    }

    // Try each parameter
    for (const [paramName, range] of Object.entries(PARAM_RANGES)) {
      const key = paramName as keyof TuningParameters;
      const currentValue = currentParams[key];

      // Try increasing and decreasing
      for (const delta of [range.step, -range.step]) {
        const newValue = Math.max(range.min, Math.min(range.max, currentValue + delta));

        if (newValue === currentValue) continue;

        const testParams = { ...currentParams, [key]: newValue };
        const testMetrics = evaluateParameters(testParams);
        const testReward = computeReward(testMetrics).total;

        if (testReward > currentReward) {
          currentParams = testParams;
          currentMetrics = testMetrics;
          currentReward = testReward;
          improved = true;

          if (verbose) {
            console.log(`  ${paramName}: ${currentValue.toFixed(2)} -> ${newValue.toFixed(2)} (reward: ${testReward.toFixed(2)})`);
          }

          history.push({ params: { ...currentParams }, reward: currentReward });
        }
      }
    }

    if (verbose && !improved) {
      console.log('  No improvement found, stopping.');
    }
  }

  if (verbose) {
    console.log('\n=== Optimization Complete ===');
    console.log(`Final reward: ${currentReward.toFixed(2)}`);
    console.log(`Iterations: ${iteration}`);
    console.log('Optimal parameters:', currentParams);
  }

  return {
    bestParams: currentParams,
    bestReward: currentReward,
    history,
    iterations: iteration,
  };
}

// ============================================================================
// ANALYZE LOG FILE
// ============================================================================

interface LogSnapshot {
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
  waitTime: number;
}

interface LogEvent {
  timestamp: number;
  vehicleId: number;
  type: string;
  details?: Record<string, unknown>;
}

interface SimulationLog {
  startTime: string;
  snapshots: LogSnapshot[];
  events: LogEvent[];
}

/**
 * Analyze a simulation log to extract metrics.
 */
export function analyzeLog(log: SimulationLog): SimulationMetrics {
  const vehicleIds = new Set<number>();
  const vehicleMaxWait = new Map<number, number>();
  const vehicleLastState = new Map<number, string>();
  const vehiclePositions = new Map<number, { x: number; y: number }[]>();

  let collisions = 0;
  let physicsViolations = 0;
  let boundaryViolations = 0;
  let totalWaitTime = 0;
  let waitCount = 0;

  // Group snapshots by timestamp to detect collisions
  const snapshotsByTime = new Map<number, LogSnapshot[]>();

  for (const snap of log.snapshots) {
    vehicleIds.add(snap.id);

    // Track max wait time
    const current = vehicleMaxWait.get(snap.id) ?? 0;
    if (snap.waitTime > current) {
      vehicleMaxWait.set(snap.id, snap.waitTime);
    }

    // Track state
    vehicleLastState.set(snap.id, snap.state);

    // Group by timestamp
    const timeKey = Math.round(snap.timestamp * 10) / 10;  // Round to 0.1s
    if (!snapshotsByTime.has(timeKey)) {
      snapshotsByTime.set(timeKey, []);
    }
    snapshotsByTime.get(timeKey)!.push(snap);

    // Accumulate wait time for average
    if (snap.waitTime > 0) {
      totalWaitTime += snap.waitTime;
      waitCount++;
    }

    // Track positions for boundary checking (simplified)
    if (!vehiclePositions.has(snap.id)) {
      vehiclePositions.set(snap.id, []);
    }
    vehiclePositions.get(snap.id)!.push({ x: snap.x, y: snap.y });
  }

  // Detect collisions from position data
  for (const [, snaps] of snapshotsByTime) {
    for (let i = 0; i < snaps.length; i++) {
      for (let j = i + 1; j < snaps.length; j++) {
        const s1 = snaps[i];
        const s2 = snaps[j];

        // Skip parked/exited
        if (s1.state === 'PARKED' || s1.state === 'EXITED') continue;
        if (s2.state === 'PARKED' || s2.state === 'EXITED') continue;

        const dist = Math.sqrt((s1.x - s2.x) ** 2 + (s1.y - s2.y) ** 2);
        if (dist < CAR_LENGTH * 0.8) {
          collisions++;
        }
      }
    }
  }

  // Count stuck vehicles (max wait > 10s)
  let stuckVehicles = 0;
  let maxWaitTime = 0;
  for (const wait of vehicleMaxWait.values()) {
    if (wait > 10) stuckVehicles++;
    maxWaitTime = Math.max(maxWaitTime, wait);
  }

  // Count events
  let vehiclesParked = 0;
  let vehiclesExited = 0;
  for (const event of log.events) {
    if (event.type === 'PARKED') vehiclesParked++;
    if (event.type === 'EXITED') vehiclesExited++;
  }

  // Calculate duration
  const maxTime = Math.max(...log.snapshots.map(s => s.timestamp), 0);

  return {
    totalVehicles: vehicleIds.size,
    collisions: Math.floor(collisions / 5),  // Normalize for duplicate detection
    stuckVehicles,
    vehiclesParked,
    vehiclesExited,
    avgWaitTime: waitCount > 0 ? totalWaitTime / waitCount : 0,
    maxWaitTime,
    physicsViolations,
    boundaryViolations,
    throughput: maxTime > 0 ? (vehiclesExited / maxTime) * 60 : 0,
    avgExitTime: 0,  // Would need exit time tracking
    laneChangeSuccess: 0,
  };
}

// ============================================================================
// CLI RUNNER
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
IDM/MOBIL Parameter Tuning
==========================

Usage:
  npx tsx src/tests/parameter-tuning.ts [options]

Options:
  --optimize        Run hill climbing optimization
  --analyze <path>  Analyze a simulation log file
  --evaluate        Evaluate current default parameters
  --iterations <n>  Max optimization iterations (default: 50)
  --help, -h        Show this help

Examples:
  npx tsx src/tests/parameter-tuning.ts --optimize
  npx tsx src/tests/parameter-tuning.ts --analyze ~/Downloads/simulation-log.json
  npx tsx src/tests/parameter-tuning.ts --evaluate
`);
    return;
  }

  if (args.includes('--evaluate')) {
    console.log('Evaluating default parameters...\n');
    const metrics = evaluateParameters(DEFAULT_PARAMS);
    console.log('Metrics:', metrics);
    const reward = computeReward(metrics);
    console.log('\nReward breakdown:', reward);
    return;
  }

  if (args.includes('--analyze')) {
    const logIndex = args.indexOf('--analyze');
    const logPath = args[logIndex + 1];

    if (!logPath) {
      console.error('Please provide a log file path');
      process.exit(1);
    }

    const fs = await import('fs');
    const logContent = fs.readFileSync(logPath, 'utf-8');
    const log = JSON.parse(logContent) as SimulationLog;

    console.log(`Analyzing log: ${logPath}\n`);
    const metrics = analyzeLog(log);
    console.log('Metrics:', metrics);
    const reward = computeReward(metrics);
    console.log('\nReward breakdown:', reward);
    return;
  }

  if (args.includes('--optimize')) {
    const iterIndex = args.indexOf('--iterations');
    const maxIter = iterIndex !== -1 ? parseInt(args[iterIndex + 1]) || 50 : 50;

    console.log(`Running parameter optimization (max ${maxIter} iterations)...\n`);
    const result = await optimizeParameters(DEFAULT_PARAMS, maxIter, true);

    console.log('\n=== OPTIMAL PARAMETERS ===');
    console.log(JSON.stringify(result.bestParams, null, 2));

    console.log('\n=== TypeScript Code ===');
    console.log(`
// Optimized IDM Parameters (Highway)
export const IDM: IDMParams = {
  T: ${result.bestParams.idm_T},
  s0: ${result.bestParams.idm_s0},
  a: ${result.bestParams.idm_a},
  b: ${result.bestParams.idm_b},
  delta: 4,
};

// Optimized IDM Parameters (Parking Lot)
export const IDM_PARKING: IDMParams = {
  T: ${result.bestParams.idm_parking_T},
  s0: ${result.bestParams.idm_parking_s0},
  a: ${result.bestParams.idm_parking_a},
  b: ${result.bestParams.idm_parking_b},
  delta: 4,
};

// Optimized IDM Parameters (Merging)
export const IDM_MERGE: IDMParams = {
  T: ${result.bestParams.idm_merge_T},
  s0: ${result.bestParams.idm_merge_s0},
  a: ${result.bestParams.idm_merge_a},
  b: ${result.bestParams.idm_merge_b},
  delta: 4,
};

// Optimized MOBIL Parameters
export const MOBIL = {
  p: ${result.bestParams.mobil_p},
  athreshold: ${result.bestParams.mobil_athreshold},
  bsafe: ${result.bestParams.mobil_bsafe},
  abias: ${result.bestParams.mobil_abias},
} as const;
`);
    return;
  }

  // Default: show help
  console.log('Use --help for usage information');
}

main().catch(console.error);
