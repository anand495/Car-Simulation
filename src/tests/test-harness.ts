/**
 * TEST HARNESS FOR SIMULATION
 * ============================
 * Provides deterministic testing utilities for the parking simulation.
 *
 * Features:
 * - Deterministic RNG via seeded PRNG
 * - Fast-forward simulation helper
 * - Common assertion utilities
 * - Collision and boundary checking
 */

import { Simulation } from '../simulation.js';
import { createStandardLot } from '../topology.js';
import { Vehicle, SimConfig, DEFAULT_CONFIG, CAR_LENGTH, SPEEDS } from '../types.js';

// ============================================================================
// SEEDED RANDOM NUMBER GENERATOR
// ============================================================================

/**
 * Simple seeded PRNG (Mulberry32)
 * Provides deterministic random numbers for reproducible tests
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed;
  return function() {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Monkey-patch Math.random for deterministic tests
 */
export function seedRandom(seed: number): () => void {
  const originalRandom = Math.random;
  const seededRandom = createSeededRandom(seed);
  Math.random = seededRandom;

  // Return restore function
  return () => {
    Math.random = originalRandom;
  };
}

// ============================================================================
// TEST SIMULATION WRAPPER
// ============================================================================

export interface TestSim {
  sim: Simulation;
  step: (seconds: number) => void;
  run: (seconds: number, dt?: number) => void;
  getVehicle: (id: number) => Vehicle | undefined;
  getAllVehicles: () => Vehicle[];
  getVehiclesByState: (state: string) => Vehicle[];
  getVehiclesByLocation: (location: string) => Vehicle[];
  spawnVehicleAt: (x: number, y: number, heading: number, lane?: number) => Vehicle;
}

/**
 * Create a test simulation with deterministic behavior
 */
export function createTestSim(
  numSpots: number = 200,
  seed: number = 42,
  config: Partial<SimConfig> = {}
): TestSim {
  // Seed RNG for determinism
  const restoreRandom = seedRandom(seed);

  const fullConfig: SimConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    enableLogging: false, // Disable logging for performance
  };

  const topology = createStandardLot(numSpots);
  const sim = new Simulation(topology, fullConfig);

  return {
    sim,

    step(seconds: number) {
      sim.step(seconds);
    },

    run(seconds: number, dt: number = 0.05) {
      for (let t = 0; t < seconds; t += dt) {
        sim.step(dt);
      }
    },

    getVehicle(id: number): Vehicle | undefined {
      return sim.state.vehicles.find(v => v.id === id);
    },

    getAllVehicles(): Vehicle[] {
      return [...sim.state.vehicles];
    },

    getVehiclesByState(state: string): Vehicle[] {
      return sim.state.vehicles.filter(v => v.state === state);
    },

    getVehiclesByLocation(location: string): Vehicle[] {
      return sim.state.vehicles.filter(v => v.location === location);
    },

    spawnVehicleAt(x: number, y: number, heading: number, lane: number = 0): Vehicle {
      // Create a vehicle manually for testing
      const id = sim.state.vehicles.length > 0
        ? Math.max(...sim.state.vehicles.map(v => v.id)) + 1
        : 0;

      const vehicle: Vehicle = {
        id,
        x,
        y,
        heading,
        speed: 0,
        targetSpeed: 0,
        acceleration: 0,
        location: 'ON_MAIN_ROAD',
        intent: 'SEEKING_PARKING',
        behaviors: {
          isReversing: false,
          isChangingLane: false,
          isYielding: false,
          isMerging: false,
          isWaitingAtLight: false,
          isWaitingToMerge: false,
          isWaitingForSpot: false,
          laneChangeProgress: 0,
          laneChangeDirection: null,
        },
        trafficControl: {
          nearestLightId: null,
          lightColor: null,
          distanceToLight: Infinity,
          mustStop: false,
        },
        currentLane: lane,
        targetLane: null,
        laneChangeStartY: null,
        state: 'APPROACHING',
        targetSpotId: null,
        exitLaneId: null,
        path: [],
        pathIndex: 0,
        waitTime: 0,
        spawnTime: sim.state.time,
      };

      sim.state.vehicles.push(vehicle);
      return vehicle;
    },
  };
}

// ============================================================================
// ASSERTION UTILITIES
// ============================================================================

export interface AssertionResult {
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Check if a value is within tolerance of target
 */
export function expectWithin(
  value: number,
  target: number,
  tolerance: number,
  label: string = 'value'
): AssertionResult {
  const passed = Math.abs(value - target) <= tolerance;
  return {
    passed,
    message: passed
      ? `${label} is within tolerance: ${value} ≈ ${target} (±${tolerance})`
      : `${label} out of tolerance: ${value} should be ${target} (±${tolerance})`,
    details: { value, target, tolerance, diff: Math.abs(value - target) },
  };
}

/**
 * Check if vehicle is in expected state
 */
export function expectVehicleState(
  vehicle: Vehicle | undefined,
  expectedState: string
): AssertionResult {
  if (!vehicle) {
    return {
      passed: false,
      message: 'Vehicle not found',
    };
  }

  const passed = vehicle.state === expectedState;
  return {
    passed,
    message: passed
      ? `Vehicle ${vehicle.id} is in state ${expectedState}`
      : `Vehicle ${vehicle.id} is in state ${vehicle.state}, expected ${expectedState}`,
    details: { vehicleId: vehicle.id, actualState: vehicle.state, expectedState },
  };
}

/**
 * Check if vehicle is in expected location
 */
export function expectVehicleLocation(
  vehicle: Vehicle | undefined,
  expectedLocation: string
): AssertionResult {
  if (!vehicle) {
    return {
      passed: false,
      message: 'Vehicle not found',
    };
  }

  const passed = vehicle.location === expectedLocation;
  return {
    passed,
    message: passed
      ? `Vehicle ${vehicle.id} is at location ${expectedLocation}`
      : `Vehicle ${vehicle.id} is at location ${vehicle.location}, expected ${expectedLocation}`,
    details: { vehicleId: vehicle.id, actualLocation: vehicle.location, expectedLocation },
  };
}

/**
 * Check for collisions between all vehicle pairs
 */
export function expectNoCollisions(vehicles: Vehicle[]): AssertionResult {
  const MIN_DISTANCE = CAR_LENGTH * 0.5;
  const collisions: { v1: number; v2: number; distance: number }[] = [];

  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const v1 = vehicles[i];
      const v2 = vehicles[j];

      // Skip parked vehicles
      if (v1.state === 'PARKED' && v2.state === 'PARKED') continue;

      const distance = Math.sqrt((v1.x - v2.x) ** 2 + (v1.y - v2.y) ** 2);

      if (distance < MIN_DISTANCE) {
        collisions.push({ v1: v1.id, v2: v2.id, distance });
      }
    }
  }

  return {
    passed: collisions.length === 0,
    message: collisions.length === 0
      ? `No collisions detected among ${vehicles.length} vehicles`
      : `${collisions.length} collisions detected`,
    details: { vehicleCount: vehicles.length, collisions: collisions.slice(0, 5) },
  };
}

/**
 * Check if all vehicles are within paved area
 */
export function expectAllWithinPavedArea(
  sim: Simulation,
  vehicles: Vehicle[]
): AssertionResult {
  const violations: { id: number; x: number; y: number }[] = [];

  for (const v of vehicles) {
    // Skip exited vehicles
    if (v.state === 'EXITED') continue;

    if (!sim.isWithinPavedArea(v.x, v.y)) {
      violations.push({ id: v.id, x: v.x, y: v.y });
    }
  }

  return {
    passed: violations.length === 0,
    message: violations.length === 0
      ? `All ${vehicles.length} vehicles are within paved area`
      : `${violations.length} vehicles are off-road`,
    details: { vehicleCount: vehicles.length, offRoadVehicles: violations.slice(0, 5) },
  };
}

/**
 * Check speed limit compliance
 */
export function expectSpeedLimitCompliance(
  vehicles: Vehicle[],
  maxSpeed: number = SPEEDS.MAIN_ROAD
): AssertionResult {
  const violations: { id: number; speed: number; location: string }[] = [];

  for (const v of vehicles) {
    let limit = maxSpeed;

    // Adjust limit based on location
    if (v.location === 'IN_LOT' || v.location === 'ON_ENTRY_ROAD' || v.location === 'ON_EXIT_ROAD') {
      limit = SPEEDS.AISLE;
    }

    // Allow 10% tolerance
    if (v.speed > limit * 1.1) {
      violations.push({ id: v.id, speed: v.speed, location: v.location });
    }
  }

  return {
    passed: violations.length === 0,
    message: violations.length === 0
      ? `All vehicles comply with speed limits`
      : `${violations.length} speed limit violations`,
    details: { violations: violations.slice(0, 5) },
  };
}

/**
 * Check that no vehicle is stuck for too long
 */
export function expectNoStuckVehicles(
  vehicles: Vehicle[],
  maxWaitTime: number = 30
): AssertionResult {
  const stuck: { id: number; waitTime: number; state: string }[] = [];

  for (const v of vehicles) {
    if (v.waitTime > maxWaitTime && v.state !== 'PARKED') {
      stuck.push({ id: v.id, waitTime: v.waitTime, state: v.state });
    }
  }

  return {
    passed: stuck.length === 0,
    message: stuck.length === 0
      ? `No vehicles stuck longer than ${maxWaitTime}s`
      : `${stuck.length} vehicles stuck longer than ${maxWaitTime}s`,
    details: { maxWaitTimeAllowed: maxWaitTime, stuckVehicles: stuck.slice(0, 5) },
  };
}

/**
 * Check minimum gap between following vehicles
 */
export function expectMinimumGap(
  vehicles: Vehicle[],
  minGap: number = 2.0
): AssertionResult {
  const violations: { follower: number; leader: number; gap: number }[] = [];

  // Group by lane on main road
  const byLane = new Map<number, Vehicle[]>();
  for (const v of vehicles) {
    if (v.location === 'ON_MAIN_ROAD' && v.currentLane !== null) {
      if (!byLane.has(v.currentLane)) {
        byLane.set(v.currentLane, []);
      }
      byLane.get(v.currentLane)!.push(v);
    }
  }

  for (const [lane, laneVehicles] of byLane) {
    // Sort by x position (heading west, so higher x is behind)
    laneVehicles.sort((a, b) => b.x - a.x);

    for (let i = 0; i < laneVehicles.length - 1; i++) {
      const follower = laneVehicles[i];
      const leader = laneVehicles[i + 1];
      const gap = follower.x - leader.x - CAR_LENGTH;

      if (gap < minGap && follower.speed > 0.5) {
        violations.push({ follower: follower.id, leader: leader.id, gap });
      }
    }
  }

  return {
    passed: violations.length === 0,
    message: violations.length === 0
      ? `All following gaps >= ${minGap}m`
      : `${violations.length} gap violations detected`,
    details: { minGapRequired: minGap, violations: violations.slice(0, 5) },
  };
}

// ============================================================================
// SNAPSHOT COLLECTION FOR ANALYSIS
// ============================================================================

export interface VehicleSnapshot {
  time: number;
  id: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  state: string;
  location: string;
  waitTime: number;
}

/**
 * Collect vehicle snapshots during simulation run
 */
export function collectSnapshots(
  testSim: TestSim,
  duration: number,
  interval: number = 0.5
): VehicleSnapshot[] {
  const snapshots: VehicleSnapshot[] = [];
  const dt = 0.05;

  for (let t = 0; t < duration; t += dt) {
    testSim.step(dt);

    // Collect snapshot at interval
    if (Math.abs(t % interval) < dt) {
      for (const v of testSim.getAllVehicles()) {
        snapshots.push({
          time: testSim.sim.state.time,
          id: v.id,
          x: v.x,
          y: v.y,
          heading: v.heading,
          speed: v.speed,
          state: v.state,
          location: v.location,
          waitTime: v.waitTime,
        });
      }
    }
  }

  return snapshots;
}

// ============================================================================
// TEST REPORTER
// ============================================================================

export interface TestCase {
  name: string;
  category: string;
  run: () => AssertionResult | Promise<AssertionResult>;
}

export interface TestSuiteResult {
  name: string;
  passed: number;
  failed: number;
  results: Array<{
    name: string;
    category: string;
    result: AssertionResult;
  }>;
}

/**
 * Run a test suite and collect results
 */
export async function runTestSuite(
  name: string,
  tests: TestCase[]
): Promise<TestSuiteResult> {
  const results: TestSuiteResult = {
    name,
    passed: 0,
    failed: 0,
    results: [],
  };

  for (const test of tests) {
    try {
      const result = await test.run();
      results.results.push({
        name: test.name,
        category: test.category,
        result,
      });

      if (result.passed) {
        results.passed++;
      } else {
        results.failed++;
      }
    } catch (error) {
      results.failed++;
      results.results.push({
        name: test.name,
        category: test.category,
        result: {
          passed: false,
          message: `Test threw error: ${error}`,
        },
      });
    }
  }

  return results;
}

/**
 * Print test suite results to console
 */
export function printTestSuiteResults(suite: TestSuiteResult): void {
  console.log('\n' + '='.repeat(60));
  console.log(`TEST SUITE: ${suite.name}`);
  console.log('='.repeat(60));

  // Group by category
  const byCategory = new Map<string, typeof suite.results>();
  for (const r of suite.results) {
    if (!byCategory.has(r.category)) {
      byCategory.set(r.category, []);
    }
    byCategory.get(r.category)!.push(r);
  }

  for (const [category, tests] of byCategory) {
    console.log(`\n📦 ${category}`);
    console.log('-'.repeat(40));

    for (const test of tests) {
      const icon = test.result.passed ? '✅' : '❌';
      console.log(`  ${icon} ${test.name}`);
      console.log(`     ${test.result.message}`);
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`TOTAL: ${suite.passed} passed, ${suite.failed} failed`);
  console.log('='.repeat(60) + '\n');
}

// ============================================================================
// TEST RESULT SAVING
// ============================================================================

export interface SavedTestReport {
  timestamp: string;
  version: string;
  summary: {
    totalPassed: number;
    totalFailed: number;
    duration: string;
  };
  suites: Array<{
    name: string;
    passed: number;
    failed: number;
    tests: Array<{
      name: string;
      category: string;
      passed: boolean;
      message: string;
      details?: Record<string, unknown>;
    }>;
  }>;
}

/**
 * Convert test suite results to a saveable format
 */
export function formatTestReportForSave(
  suites: TestSuiteResult[],
  startTime: number
): SavedTestReport {
  const endTime = Date.now();
  const durationMs = endTime - startTime;
  const durationStr = durationMs > 60000
    ? `${(durationMs / 60000).toFixed(1)} min`
    : `${(durationMs / 1000).toFixed(1)} sec`;

  let totalPassed = 0;
  let totalFailed = 0;

  const formattedSuites = suites.map(suite => {
    totalPassed += suite.passed;
    totalFailed += suite.failed;

    return {
      name: suite.name,
      passed: suite.passed,
      failed: suite.failed,
      tests: suite.results.map(r => ({
        name: r.name,
        category: r.category,
        passed: r.result.passed,
        message: r.result.message,
        details: r.result.details,
      })),
    };
  });

  return {
    timestamp: new Date().toISOString(),
    version: '3.4.0',
    summary: {
      totalPassed,
      totalFailed,
      duration: durationStr,
    },
    suites: formattedSuites,
  };
}

/**
 * Generate markdown report from test results
 */
export function generateMarkdownReport(report: SavedTestReport): string {
  const lines: string[] = [];

  lines.push('# Parking Simulation Test Report');
  lines.push('');
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push(`**Version:** ${report.version}`);
  lines.push(`**Duration:** ${report.summary.duration}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  const passRate = report.summary.totalPassed + report.summary.totalFailed > 0
    ? ((report.summary.totalPassed / (report.summary.totalPassed + report.summary.totalFailed)) * 100).toFixed(1)
    : '0';
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Passed | ${report.summary.totalPassed} |`);
  lines.push(`| Total Failed | ${report.summary.totalFailed} |`);
  lines.push(`| Pass Rate | ${passRate}% |`);
  lines.push('');

  // Results by suite
  for (const suite of report.suites) {
    lines.push(`## ${suite.name}`);
    lines.push('');
    lines.push(`**Passed:** ${suite.passed} | **Failed:** ${suite.failed}`);
    lines.push('');

    // Group by category
    const byCategory = new Map<string, typeof suite.tests>();
    for (const test of suite.tests) {
      if (!byCategory.has(test.category)) {
        byCategory.set(test.category, []);
      }
      byCategory.get(test.category)!.push(test);
    }

    for (const [category, tests] of byCategory) {
      lines.push(`### ${category}`);
      lines.push('');
      lines.push('| Test | Status | Message |');
      lines.push('|------|--------|---------|');

      for (const test of tests) {
        const status = test.passed ? '✅ Pass' : '❌ Fail';
        const message = test.message.replace(/\|/g, '\\|').substring(0, 60);
        lines.push(`| ${test.name} | ${status} | ${message} |`);
      }
      lines.push('');
    }
  }

  // Failed tests summary
  const failedTests = report.suites.flatMap(s =>
    s.tests.filter(t => !t.passed).map(t => ({ suite: s.name, ...t }))
  );

  if (failedTests.length > 0) {
    lines.push('## Failed Tests Details');
    lines.push('');

    for (const test of failedTests) {
      lines.push(`### ❌ ${test.name}`);
      lines.push('');
      lines.push(`**Suite:** ${test.suite}`);
      lines.push(`**Category:** ${test.category}`);
      lines.push(`**Message:** ${test.message}`);
      if (test.details) {
        lines.push('');
        lines.push('**Details:**');
        lines.push('```json');
        lines.push(JSON.stringify(test.details, null, 2));
        lines.push('```');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
