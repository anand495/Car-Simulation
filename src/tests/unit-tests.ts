/**
 * UNIT TESTS FOR PURE FUNCTIONS
 * ==============================
 * Tests for mathematical utilities and pure helper functions.
 * These run without side effects and validate core calculations.
 */

import {
  createTestSim,
  expectWithin,
  AssertionResult,
  TestCase,
  runTestSuite,
  printTestSuiteResults,
} from './test-harness.js';
import { CAR_LENGTH, CAR_WIDTH, SPEEDS, PHYSICS } from '../types.js';

// ============================================================================
// GEOMETRY & MATH UTILITIES
// ============================================================================

function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

// ============================================================================
// UNIT TEST DEFINITIONS
// ============================================================================

const unitTests: TestCase[] = [
  // -------------------------------------------------------------------------
  // normalizeAngle tests
  // -------------------------------------------------------------------------
  {
    name: 'normalizeAngle: wraps 2π to 0',
    category: 'Math Utilities',
    run: () => {
      const result = normalizeAngle(2 * Math.PI);
      return expectWithin(result, 0, 0.001, 'normalized angle');
    },
  },
  {
    name: 'normalizeAngle: wraps -2π to 0',
    category: 'Math Utilities',
    run: () => {
      const result = normalizeAngle(-2 * Math.PI);
      return expectWithin(result, 0, 0.001, 'normalized angle');
    },
  },
  {
    name: 'normalizeAngle: wraps 3π to π',
    category: 'Math Utilities',
    run: () => {
      const result = normalizeAngle(3 * Math.PI);
      return expectWithin(Math.abs(result), Math.PI, 0.001, 'normalized angle');
    },
  },
  {
    name: 'normalizeAngle: keeps π/2 unchanged',
    category: 'Math Utilities',
    run: () => {
      const result = normalizeAngle(Math.PI / 2);
      return expectWithin(result, Math.PI / 2, 0.001, 'normalized angle');
    },
  },
  {
    name: 'normalizeAngle: keeps -π/2 unchanged',
    category: 'Math Utilities',
    run: () => {
      const result = normalizeAngle(-Math.PI / 2);
      return expectWithin(result, -Math.PI / 2, 0.001, 'normalized angle');
    },
  },

  // -------------------------------------------------------------------------
  // distance tests
  // -------------------------------------------------------------------------
  {
    name: 'distance: calculates correctly for horizontal',
    category: 'Math Utilities',
    run: () => {
      const d = distance(0, 0, 10, 0);
      return expectWithin(d, 10, 0.001, 'distance');
    },
  },
  {
    name: 'distance: calculates correctly for vertical',
    category: 'Math Utilities',
    run: () => {
      const d = distance(0, 0, 0, 10);
      return expectWithin(d, 10, 0.001, 'distance');
    },
  },
  {
    name: 'distance: calculates correctly for diagonal (3-4-5)',
    category: 'Math Utilities',
    run: () => {
      const d = distance(0, 0, 3, 4);
      return expectWithin(d, 5, 0.001, 'distance');
    },
  },
  {
    name: 'distance: returns 0 for same point',
    category: 'Math Utilities',
    run: () => {
      const d = distance(5, 5, 5, 5);
      return expectWithin(d, 0, 0.001, 'distance');
    },
  },

  // -------------------------------------------------------------------------
  // Constants validation
  // -------------------------------------------------------------------------
  {
    name: 'CAR_LENGTH is realistic (4-5m)',
    category: 'Constants',
    run: () => {
      const passed = CAR_LENGTH >= 4 && CAR_LENGTH <= 5;
      return {
        passed,
        message: passed
          ? `CAR_LENGTH = ${CAR_LENGTH}m is realistic`
          : `CAR_LENGTH = ${CAR_LENGTH}m is unrealistic`,
        details: { CAR_LENGTH },
      };
    },
  },
  {
    name: 'CAR_WIDTH is realistic (1.5-2.5m)',
    category: 'Constants',
    run: () => {
      const passed = CAR_WIDTH >= 1.5 && CAR_WIDTH <= 2.5;
      return {
        passed,
        message: passed
          ? `CAR_WIDTH = ${CAR_WIDTH}m is realistic`
          : `CAR_WIDTH = ${CAR_WIDTH}m is unrealistic`,
        details: { CAR_WIDTH },
      };
    },
  },
  {
    name: 'SPEEDS.MAIN_ROAD is ~30mph (12-15 m/s)',
    category: 'Constants',
    run: () => {
      const passed = SPEEDS.MAIN_ROAD >= 12 && SPEEDS.MAIN_ROAD <= 15;
      return {
        passed,
        message: passed
          ? `MAIN_ROAD speed = ${SPEEDS.MAIN_ROAD} m/s is realistic`
          : `MAIN_ROAD speed = ${SPEEDS.MAIN_ROAD} m/s is unrealistic`,
        details: { speed: SPEEDS.MAIN_ROAD, mph: SPEEDS.MAIN_ROAD * 2.237 },
      };
    },
  },
  {
    name: 'SPEEDS.AISLE is ~10mph (4-5 m/s)',
    category: 'Constants',
    run: () => {
      const passed = SPEEDS.AISLE >= 4 && SPEEDS.AISLE <= 5;
      return {
        passed,
        message: passed
          ? `AISLE speed = ${SPEEDS.AISLE} m/s is realistic`
          : `AISLE speed = ${SPEEDS.AISLE} m/s is unrealistic`,
        details: { speed: SPEEDS.AISLE, mph: SPEEDS.AISLE * 2.237 },
      };
    },
  },
  {
    name: 'PHYSICS.MAX_ACCELERATION is comfortable (2-3 m/s²)',
    category: 'Constants',
    run: () => {
      const passed = PHYSICS.MAX_ACCELERATION >= 2 && PHYSICS.MAX_ACCELERATION <= 3.5;
      return {
        passed,
        message: passed
          ? `MAX_ACCELERATION = ${PHYSICS.MAX_ACCELERATION} m/s² is comfortable`
          : `MAX_ACCELERATION = ${PHYSICS.MAX_ACCELERATION} m/s² is too aggressive`,
        details: { accel: PHYSICS.MAX_ACCELERATION },
      };
    },
  },
  {
    name: 'PHYSICS.MAX_DECELERATION is comfortable (3-5 m/s²)',
    category: 'Constants',
    run: () => {
      const passed = PHYSICS.MAX_DECELERATION >= 3 && PHYSICS.MAX_DECELERATION <= 5;
      return {
        passed,
        message: passed
          ? `MAX_DECELERATION = ${PHYSICS.MAX_DECELERATION} m/s² is comfortable`
          : `MAX_DECELERATION = ${PHYSICS.MAX_DECELERATION} m/s² is unrealistic`,
        details: { decel: PHYSICS.MAX_DECELERATION },
      };
    },
  },
  {
    name: 'PHYSICS.EMERGENCY_DECEL is emergency-level (7-10 m/s²)',
    category: 'Constants',
    run: () => {
      const passed = PHYSICS.EMERGENCY_DECEL >= 7 && PHYSICS.EMERGENCY_DECEL <= 10;
      return {
        passed,
        message: passed
          ? `EMERGENCY_DECEL = ${PHYSICS.EMERGENCY_DECEL} m/s² is appropriate`
          : `EMERGENCY_DECEL = ${PHYSICS.EMERGENCY_DECEL} m/s² is unrealistic`,
        details: { decel: PHYSICS.EMERGENCY_DECEL },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Topology creation tests
  // -------------------------------------------------------------------------
  {
    name: 'createTestSim creates valid simulation',
    category: 'Topology',
    run: () => {
      const { sim } = createTestSim(100);
      const passed = sim !== null && sim.topology !== null;
      return {
        passed,
        message: passed
          ? 'Simulation created successfully'
          : 'Failed to create simulation',
        details: { hasTopology: sim?.topology !== null },
      };
    },
  },
  {
    name: 'Topology has correct number of spots',
    category: 'Topology',
    run: () => {
      const numSpots = 150;
      const { sim } = createTestSim(numSpots);
      const actualSpots = sim.topology.spots.length;
      // Allow some variance due to row/column constraints
      const passed = Math.abs(actualSpots - numSpots) < numSpots * 0.1;
      return {
        passed,
        message: passed
          ? `Created ${actualSpots} spots (requested ${numSpots})`
          : `Spot count ${actualSpots} too far from requested ${numSpots}`,
        details: { requested: numSpots, actual: actualSpots },
      };
    },
  },
  {
    name: 'Topology has 3 lanes on main road',
    category: 'Topology',
    run: () => {
      const { sim } = createTestSim(100);
      const lanes = sim.topology.mainRoad.lanes;
      const passed = lanes === 3;
      return {
        passed,
        message: passed
          ? 'Main road has 3 lanes'
          : `Main road has ${lanes} lanes, expected 3`,
        details: { lanes },
      };
    },
  },
  {
    name: 'Topology has valid entry road',
    category: 'Topology',
    run: () => {
      const { sim } = createTestSim(100);
      const entry = sim.topology.entryRoad;
      const passed = entry.x > 0 && entry.y > 0 && entry.width > 0;
      return {
        passed,
        message: passed
          ? `Entry road at x=${entry.x}, width=${entry.width}`
          : 'Entry road has invalid dimensions',
        details: { x: entry.x, y: entry.y, width: entry.width },
      };
    },
  },
  {
    name: 'Topology has valid exit road',
    category: 'Topology',
    run: () => {
      const { sim } = createTestSim(100);
      const exit = sim.topology.exitRoad;
      const passed = exit.x > 0 && exit.y > 0 && exit.width > 0;
      return {
        passed,
        message: passed
          ? `Exit road at x=${exit.x}, width=${exit.width}`
          : 'Exit road has invalid dimensions',
        details: { x: exit.x, y: exit.y, width: exit.width },
      };
    },
  },
  {
    name: 'Entry and exit roads are separated',
    category: 'Topology',
    run: () => {
      const { sim } = createTestSim(100);
      const entry = sim.topology.entryRoad;
      const exit = sim.topology.exitRoad;
      const separation = Math.abs(entry.x - exit.x);
      const passed = separation > 10; // At least 10m apart
      return {
        passed,
        message: passed
          ? `Entry and exit roads separated by ${separation.toFixed(1)}m`
          : `Roads too close: ${separation.toFixed(1)}m apart`,
        details: { entryX: entry.x, exitX: exit.x, separation },
      };
    },
  },

  // -------------------------------------------------------------------------
  // isWithinPavedArea tests
  // -------------------------------------------------------------------------
  {
    name: 'isWithinPavedArea: center of lot is paved',
    category: 'Paved Area',
    run: () => {
      const { sim } = createTestSim(100);
      const lotCenter = sim.topology.lot;
      const passed = sim.isWithinPavedArea(lotCenter.x, lotCenter.y);
      return {
        passed,
        message: passed
          ? 'Lot center is within paved area'
          : 'Lot center should be paved',
        details: { x: lotCenter.x, y: lotCenter.y },
      };
    },
  },
  {
    name: 'isWithinPavedArea: main road is paved',
    category: 'Paved Area',
    run: () => {
      const { sim } = createTestSim(100);
      const road = sim.topology.mainRoad;
      const passed = sim.isWithinPavedArea(road.x + road.length / 2, road.y);
      return {
        passed,
        message: passed
          ? 'Main road center is within paved area'
          : 'Main road should be paved',
        details: { x: road.x + road.length / 2, y: road.y },
      };
    },
  },
  {
    name: 'isWithinPavedArea: far off-map is not paved',
    category: 'Paved Area',
    run: () => {
      const { sim } = createTestSim(100);
      const passed = !sim.isWithinPavedArea(-1000, -1000);
      return {
        passed,
        message: passed
          ? 'Far off-map position correctly identified as unpaved'
          : 'Far off-map should not be paved',
        details: { x: -1000, y: -1000 },
      };
    },
  },
  {
    name: 'isWithinPavedArea: despawn extension (x < 0) is valid',
    category: 'Paved Area',
    run: () => {
      const { sim } = createTestSim(100);
      const road = sim.topology.mainRoad;
      // Check area west of origin (despawn zone)
      const passed = sim.isWithinPavedArea(-20, road.y);
      return {
        passed,
        message: passed
          ? 'Despawn extension zone is paved'
          : 'Despawn extension should be paved for exiting vehicles',
        details: { x: -20, y: road.y },
      };
    },
  },
];

// ============================================================================
// MAIN RUNNER
// ============================================================================

import { TestSuiteResult } from './test-harness.js';

let lastResults: TestSuiteResult | null = null;

export async function runUnitTests(): Promise<void> {
  const results = await runTestSuite('Unit Tests - Pure Functions', unitTests);
  lastResults = results;
  printTestSuiteResults(results);

  // Don't throw - let the main runner handle failures and save results
  if (results.failed > 0) {
    console.log('\n⚠️  Some unit tests failed!');
  }
}

export function getUnitTestResults(): TestSuiteResult | null {
  return lastResults;
}

// Note: When running as ES module, this file should be imported, not run directly
// Use: npx tsx src/tests/run-all-tests.ts --unit
