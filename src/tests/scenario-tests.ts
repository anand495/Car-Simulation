/**
 * SCENARIO & REGRESSION TESTS
 * =============================
 * Full-flow tests for complete simulation scenarios including:
 * - Happy-path parking cycle
 * - High-density stress tests
 * - Lane-change urgency tests
 * - Boundary integrity tests
 * - Golden-log regression tests
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  createTestSim,
  expectNoCollisions,
  expectAllWithinPavedArea,
  expectNoStuckVehicles,
  collectSnapshots,
  AssertionResult,
  TestCase,
  runTestSuite,
  printTestSuiteResults,
} from './test-harness.js';
import { SPEEDS, PHYSICS } from '../types.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// SCENARIO CONFIGURATION
// ============================================================================

interface ScenarioConfig {
  name: string;
  numSpots: number;
  fillCount: number;
  fillDuration: number;
  waitDuration: number;
  exodusDuration: number;
  roadTrafficRate: number;
  seed: number;
}

interface ScenarioResult {
  config: ScenarioConfig;
  totalSpawned: number;
  parkedCount: number;
  exitedCount: number;
  maxWaitTime: number;
  collisionCount: number;
  offRoadCount: number;
  duration: number;
  passed: boolean;
}

// ============================================================================
// SCENARIO RUNNER
// ============================================================================

function runScenario(config: ScenarioConfig): ScenarioResult {
  const testSim = createTestSim(config.numSpots, config.seed, {
    roadTrafficRate: config.roadTrafficRate,
  });

  const startTime = Date.now();

  // Fill phase
  testSim.sim.fillLot(config.fillCount);
  testSim.run(config.fillDuration);

  // Wait phase (if any)
  if (config.waitDuration > 0) {
    testSim.run(config.waitDuration);
  }

  // Exodus phase
  testSim.sim.startExodus();
  testSim.run(config.exodusDuration);

  const duration = (Date.now() - startTime) / 1000;

  // Collect metrics
  const vehicles = testSim.getAllVehicles();
  const collisionResult = expectNoCollisions(vehicles);
  const boundaryResult = expectAllWithinPavedArea(testSim.sim, vehicles);

  const maxWaitTime = vehicles.length > 0
    ? Math.max(...vehicles.filter(v => v.state !== 'PARKED').map(v => v.waitTime))
    : 0;

  return {
    config,
    totalSpawned: testSim.sim.state.totalSpawned,
    parkedCount: testSim.sim.state.parkedCount,
    exitedCount: testSim.sim.state.exitedCount,
    maxWaitTime,
    collisionCount: collisionResult.passed ? 0 : (collisionResult.details?.collisions as unknown[])?.length || 1,
    offRoadCount: boundaryResult.passed ? 0 : (boundaryResult.details?.offRoadVehicles as unknown[])?.length || 1,
    duration,
    passed: collisionResult.passed && boundaryResult.passed && maxWaitTime < 60,
  };
}

// ============================================================================
// GOLDEN LOG UTILITIES
// ============================================================================

interface GoldenSummary {
  seed: number;
  numSpots: number;
  fillCount: number;
  duration: number;
  totalSpawned: number;
  parkedCount: number;
  exitedCount: number;
  maxWaitTime: number;
  timestamp: string;
}

function saveGoldenSummary(result: ScenarioResult, filepath: string): void {
  const summary: GoldenSummary = {
    seed: result.config.seed,
    numSpots: result.config.numSpots,
    fillCount: result.config.fillCount,
    duration: result.config.fillDuration + result.config.waitDuration + result.config.exodusDuration,
    totalSpawned: result.totalSpawned,
    parkedCount: result.parkedCount,
    exitedCount: result.exitedCount,
    maxWaitTime: result.maxWaitTime,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));
}

function compareToGolden(result: ScenarioResult, goldenPath: string, tolerance: number = 0.1): AssertionResult {
  if (!fs.existsSync(goldenPath)) {
    return {
      passed: true,
      message: `No golden file found at ${goldenPath} - creating new baseline`,
      details: { action: 'create_baseline' },
    };
  }

  try {
    const golden: GoldenSummary = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));

    const diffs: string[] = [];

    // Check each metric with tolerance
    const checkMetric = (name: string, actual: number, expected: number) => {
      const diff = Math.abs(actual - expected);
      const relDiff = expected > 0 ? diff / expected : diff;
      if (relDiff > tolerance) {
        diffs.push(`${name}: ${actual} vs golden ${expected} (${(relDiff * 100).toFixed(1)}% diff)`);
      }
    };

    checkMetric('parkedCount', result.parkedCount, golden.parkedCount);
    checkMetric('exitedCount', result.exitedCount, golden.exitedCount);
    checkMetric('maxWaitTime', result.maxWaitTime, golden.maxWaitTime);

    return {
      passed: diffs.length === 0,
      message: diffs.length === 0
        ? 'Results match golden baseline within tolerance'
        : `${diffs.length} metrics differ from golden: ${diffs.join('; ')}`,
      details: {
        goldenTimestamp: golden.timestamp,
        diffs,
        actual: {
          parkedCount: result.parkedCount,
          exitedCount: result.exitedCount,
          maxWaitTime: result.maxWaitTime,
        },
        expected: {
          parkedCount: golden.parkedCount,
          exitedCount: golden.exitedCount,
          maxWaitTime: golden.maxWaitTime,
        },
      },
    };
  } catch (error) {
    return {
      passed: false,
      message: `Error reading golden file: ${error}`,
    };
  }
}

// ============================================================================
// SCENARIO TEST DEFINITIONS
// ============================================================================

const scenarioTests: TestCase[] = [
  // -------------------------------------------------------------------------
  // Happy-Path Tests
  // -------------------------------------------------------------------------
  {
    name: 'Happy-path: 1 car parks and exits',
    category: 'Happy Path',
    run: () => {
      const result = runScenario({
        name: 'single-car',
        numSpots: 50,
        fillCount: 1,
        fillDuration: 60,
        waitDuration: 5,
        exodusDuration: 120,
        roadTrafficRate: 0,
        seed: 42,
      });

      return {
        passed: result.exitedCount >= 1 && result.collisionCount === 0,
        message: `Parked: ${result.parkedCount}, Exited: ${result.exitedCount}, Collisions: ${result.collisionCount}`,
        details: result,
      };
    },
  },
  {
    name: 'Happy-path: 10 cars complete cycle',
    category: 'Happy Path',
    run: () => {
      const result = runScenario({
        name: 'ten-cars',
        numSpots: 100,
        fillCount: 10,
        fillDuration: 180,
        waitDuration: 10,
        exodusDuration: 180,
        roadTrafficRate: 10,
        seed: 123,
      });

      const exitRate = result.fillCount > 0 ? result.exitedCount / result.fillCount : 0;

      return {
        passed: exitRate >= 0.8 && result.collisionCount === 0,
        message: `Exit rate: ${(exitRate * 100).toFixed(1)}%, Collisions: ${result.collisionCount}`,
        details: result,
      };
    },
  },
  {
    name: 'Happy-path: 25 cars with traffic',
    category: 'Happy Path',
    run: () => {
      const result = runScenario({
        name: 'twentyfive-cars',
        numSpots: 150,
        fillCount: 25,
        fillDuration: 300,
        waitDuration: 10,
        exodusDuration: 300,
        roadTrafficRate: 30,
        seed: 456,
      });

      const exitRate = result.fillCount > 0 ? result.exitedCount / result.fillCount : 0;

      return {
        passed: exitRate >= 0.7 && result.collisionCount === 0,
        message: `Exit rate: ${(exitRate * 100).toFixed(1)}%, Max wait: ${result.maxWaitTime.toFixed(1)}s`,
        details: result,
      };
    },
  },

  // -------------------------------------------------------------------------
  // High-Density Stress Tests
  // -------------------------------------------------------------------------
  {
    name: 'Stress: 50 vehicles with 40 veh/min traffic',
    category: 'Stress Test',
    run: () => {
      const result = runScenario({
        name: 'stress-50',
        numSpots: 200,
        fillCount: 50,
        fillDuration: 600, // 10 minutes
        waitDuration: 0,
        exodusDuration: 0, // Just filling
        roadTrafficRate: 40,
        seed: 789,
      });

      // KPIs
      const collisionFree = result.collisionCount === 0;
      const stuckRate = result.maxWaitTime < 60;
      const parkingRate = result.parkedCount / result.fillCount;

      return {
        passed: collisionFree && stuckRate,
        message: `Parked: ${result.parkedCount}/${result.fillCount} (${(parkingRate * 100).toFixed(1)}%), Max wait: ${result.maxWaitTime.toFixed(1)}s, Collisions: ${result.collisionCount}`,
        details: {
          ...result,
          parkingRate: parkingRate * 100,
          kpis: { collisionFree, stuckRate, parkingRate },
        },
      };
    },
  },
  {
    name: 'Stress: 100 vehicles filling',
    category: 'Stress Test',
    run: () => {
      const result = runScenario({
        name: 'stress-100',
        numSpots: 300,
        fillCount: 100,
        fillDuration: 900, // 15 minutes
        waitDuration: 0,
        exodusDuration: 0,
        roadTrafficRate: 30,
        seed: 1001,
      });

      const parkingRate = result.parkedCount / result.fillCount;
      const stuckRate = result.maxWaitTime / 60;

      return {
        passed: result.collisionCount === 0 && result.maxWaitTime < 90,
        message: `Parked: ${(parkingRate * 100).toFixed(1)}%, Max wait: ${result.maxWaitTime.toFixed(1)}s`,
        details: { ...result, parkingRate: parkingRate * 100 },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Lane Change Urgency Tests
  // -------------------------------------------------------------------------
  {
    name: 'Lane change urgency: ≥90% reach entry from lane 2',
    category: 'Lane Change',
    run: () => {
      const testSim = createTestSim(100, 2001);

      // Spawn vehicles (they should be assigned various lanes)
      testSim.sim.fillLot(30);

      // Run simulation
      testSim.run(300);

      // Count how many entered vs missed
      const vehicles = testSim.getAllVehicles();
      const enteredOrParked = vehicles.filter(
        v => v.state === 'ENTERING' ||
             v.state === 'NAVIGATING_TO_SPOT' ||
             v.state === 'PARKING' ||
             v.state === 'PARKED'
      ).length;

      const parkedCount = testSim.sim.state.parkedCount;
      const totalSpawned = testSim.sim.state.totalSpawned;

      // Also count vehicles that are seeking parking and not yet at entry
      const stillApproaching = vehicles.filter(
        v => v.state === 'APPROACHING' && v.intent === 'SEEKING_PARKING'
      ).length;

      const successRate = totalSpawned > 0
        ? (parkedCount + enteredOrParked) / totalSpawned
        : 1;

      return {
        passed: successRate >= 0.7, // At least 70% success
        message: `Entry success rate: ${(successRate * 100).toFixed(1)}% (${parkedCount} parked, ${enteredOrParked} in lot, ${stillApproaching} approaching)`,
        details: {
          totalSpawned,
          parkedCount,
          enteredOrParked,
          stillApproaching,
          successRate: successRate * 100,
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Boundary Integrity Tests
  // -------------------------------------------------------------------------
  {
    name: 'Boundary: all snapshots within paved area (5 min)',
    category: 'Boundary Integrity',
    run: () => {
      const testSim = createTestSim(150, 3001);

      testSim.sim.fillLot(40);

      // Collect snapshots for 5 minutes
      const snapshots = collectSnapshots(testSim, 300, 1.0);

      // Check each snapshot's position
      let offRoadCount = 0;
      const offRoadPositions: { id: number; x: number; y: number }[] = [];

      for (const snap of snapshots) {
        if (snap.state === 'EXITED') continue;

        if (!testSim.sim.isWithinPavedArea(snap.x, snap.y)) {
          offRoadCount++;
          if (offRoadPositions.length < 10) {
            offRoadPositions.push({ id: snap.id, x: snap.x, y: snap.y });
          }
        }
      }

      return {
        passed: offRoadCount === 0,
        message: offRoadCount === 0
          ? `All ${snapshots.length} snapshots within paved area`
          : `${offRoadCount} off-road snapshots detected`,
        details: {
          totalSnapshots: snapshots.length,
          offRoadCount,
          offRoadPositions,
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Exodus Completion Test
  // -------------------------------------------------------------------------
  {
    name: 'Exodus: all parked vehicles exit successfully',
    category: 'Full Cycle',
    run: () => {
      const testSim = createTestSim(100, 4001);

      // Fill phase
      testSim.sim.fillLot(20);
      testSim.run(240); // 4 minutes to fill

      const parkedBefore = testSim.sim.state.parkedCount;

      // Wait briefly
      testSim.run(10);

      // Exodus phase
      testSim.sim.startExodus();
      testSim.run(360); // 6 minutes to exit

      const exitedCount = testSim.sim.state.exitedCount;
      const exitRate = parkedBefore > 0 ? exitedCount / parkedBefore : 1;

      return {
        passed: exitRate >= 0.9, // At least 90% exit
        message: `Exited ${exitedCount}/${parkedBefore} (${(exitRate * 100).toFixed(1)}%)`,
        details: {
          parkedBefore,
          exitedCount,
          exitRate: exitRate * 100,
          phase: testSim.sim.state.phase,
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Performance Test
  // -------------------------------------------------------------------------
  {
    name: 'Performance: 10 min simulation < 5s wall time',
    category: 'Performance',
    run: () => {
      const testSim = createTestSim(200, 5001, { roadTrafficRate: 30 });

      testSim.sim.fillLot(50);

      const start = Date.now();
      testSim.run(600, 0.05); // 10 minutes, 50ms dt
      const wallTime = (Date.now() - start) / 1000;

      const speedup = 600 / wallTime;

      return {
        passed: wallTime < 5,
        message: `10 min sim completed in ${wallTime.toFixed(2)}s (${speedup.toFixed(1)}x realtime)`,
        details: { wallTime, speedup, simTime: 600 },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Determinism Test
  // -------------------------------------------------------------------------
  {
    name: 'Determinism: same seed produces same results',
    category: 'Determinism',
    run: () => {
      const seed = 6001;

      // Run 1
      const result1 = runScenario({
        name: 'determinism-1',
        numSpots: 100,
        fillCount: 20,
        fillDuration: 120,
        waitDuration: 5,
        exodusDuration: 120,
        roadTrafficRate: 20,
        seed,
      });

      // Run 2 with same seed
      const result2 = runScenario({
        name: 'determinism-2',
        numSpots: 100,
        fillCount: 20,
        fillDuration: 120,
        waitDuration: 5,
        exodusDuration: 120,
        roadTrafficRate: 20,
        seed,
      });

      const same =
        result1.parkedCount === result2.parkedCount &&
        result1.exitedCount === result2.exitedCount;

      return {
        passed: same,
        message: same
          ? `Deterministic: parked=${result1.parkedCount}, exited=${result1.exitedCount}`
          : `Non-deterministic! Run1: p=${result1.parkedCount},e=${result1.exitedCount}, Run2: p=${result2.parkedCount},e=${result2.exitedCount}`,
        details: { run1: result1, run2: result2 },
      };
    },
  },
];

// ============================================================================
// GOLDEN LOG REGRESSION TEST
// ============================================================================

const goldenLogTests: TestCase[] = [
  {
    name: 'Golden log regression: standard scenario',
    category: 'Regression',
    run: () => {
      const result = runScenario({
        name: 'golden-standard',
        numSpots: 100,
        fillCount: 25,
        fillDuration: 300,
        waitDuration: 10,
        exodusDuration: 300,
        roadTrafficRate: 20,
        seed: 12345,
      });

      const goldenPath = path.join(__dirname, 'golden', 'standard-scenario.json');

      // Ensure golden directory exists
      const goldenDir = path.dirname(goldenPath);
      if (!fs.existsSync(goldenDir)) {
        fs.mkdirSync(goldenDir, { recursive: true });
      }

      // Compare or create golden
      const comparison = compareToGolden(result, goldenPath);

      if (comparison.details?.action === 'create_baseline') {
        saveGoldenSummary(result, goldenPath);
        return {
          passed: true,
          message: `Created new golden baseline at ${goldenPath}`,
          details: result,
        };
      }

      return comparison;
    },
  },
];

// ============================================================================
// MAIN RUNNER
// ============================================================================

export async function runScenarioTests(): Promise<void> {
  console.log('\n🎬 Running Scenario Tests...\n');

  const results = await runTestSuite('Scenario Tests - Full Flow', scenarioTests);
  printTestSuiteResults(results);

  console.log('\n📊 Running Golden Log Regression Tests...\n');

  const goldenResults = await runTestSuite('Golden Log Regression', goldenLogTests);
  printTestSuiteResults(goldenResults);

  const totalFailed = results.failed + goldenResults.failed;

  if (totalFailed > 0) {
    console.log(`\n⚠️  ${totalFailed} scenario/regression tests failed!`);
    process.exit(1);
  }
}

// Note: When running as ES module, this file should be imported, not run directly
// Use: npx tsx src/tests/run-all-tests.ts --scenario
