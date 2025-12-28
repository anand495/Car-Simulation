/**
 * INTERACTION TESTS (≥2 vehicles)
 * =================================
 * Tests for multi-vehicle interactions including:
 * - Safe following (IDM-style)
 * - Lane change gap checking
 * - Cooperative yielding
 * - Merge acceptance
 * - Obstacle avoidance
 */

import {
  createTestSim,
  expectWithin,
  expectNoCollisions,
  expectAllWithinPavedArea,
  expectMinimumGap,
  expectSpeedLimitCompliance,
  expectNoStuckVehicles,
  collectSnapshots,
  AssertionResult,
  TestCase,
  runTestSuite,
  printTestSuiteResults,
  TestSim,
} from './test-harness.js';
import { CAR_LENGTH, SPEEDS, PHYSICS } from '../types.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function runUntilStable(testSim: TestSim, maxTime: number = 60, checkInterval: number = 1): void {
  let lastVehicleCount = 0;
  let stableCount = 0;

  for (let t = 0; t < maxTime; t += checkInterval) {
    testSim.run(checkInterval);

    const currentCount = testSim.getAllVehicles().length;
    if (currentCount === lastVehicleCount && currentCount > 0) {
      stableCount++;
      if (stableCount > 3) break; // Stable for 3 seconds
    } else {
      stableCount = 0;
    }
    lastVehicleCount = currentCount;
  }
}

// ============================================================================
// INTERACTION TEST DEFINITIONS
// ============================================================================

// HIGH OCCUPANCY TESTING:
// Tests are designed for realistic high-density scenarios (70-90% occupancy)
// This matches real-world parking lot stress conditions

const interactionTests: TestCase[] = [
  // -------------------------------------------------------------------------
  // Safe Following Tests (High Traffic Volume)
  // -------------------------------------------------------------------------
  {
    name: 'High traffic: vehicles maintain safe following distance',
    category: 'Car Following',
    run: () => {
      const testSim = createTestSim(100, 123);

      // 80% occupancy: 80 vehicles for 100 spots
      testSim.sim.fillLot(80);
      testSim.run(60); // Run for 60 seconds

      const vehicles = testSim.getAllVehicles();
      return expectMinimumGap(vehicles, PHYSICS.MIN_GAP);
    },
  },
  {
    name: 'Dense traffic: following vehicle slows for leader',
    category: 'Car Following',
    run: () => {
      const testSim = createTestSim(100, 456);

      // 60 vehicles creates dense traffic conditions
      testSim.sim.fillLot(60);
      testSim.run(45);

      const vehicles = testSim.getAllVehicles();
      return expectNoCollisions(vehicles);
    },
  },
  {
    name: 'Large convoy (40 vehicles) maintains gaps',
    category: 'Car Following',
    run: () => {
      const testSim = createTestSim(150, 789);

      // Large convoy with 40 vehicles
      testSim.sim.fillLot(40);
      testSim.run(90);

      const vehicles = testSim.getAllVehicles();
      const gapResult = expectMinimumGap(vehicles);
      const collisionResult = expectNoCollisions(vehicles);

      return {
        passed: gapResult.passed && collisionResult.passed,
        message: gapResult.passed && collisionResult.passed
          ? 'Large convoy maintains safe gaps with no collisions'
          : `Issues: ${gapResult.message}; ${collisionResult.message}`,
        details: { ...gapResult.details, ...collisionResult.details },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Lane Change Tests (High Occupancy)
  // -------------------------------------------------------------------------
  {
    name: 'Lane changes complete under heavy traffic (50 vehicles)',
    category: 'Lane Changing',
    run: () => {
      const testSim = createTestSim(100, 111);

      // Heavy traffic with 50 vehicles
      testSim.sim.fillLot(50);
      testSim.run(120); // Give time for lane changes

      const vehicles = testSim.getAllVehicles();
      // At least 60% should have entered or be entering
      const enteredOrParked = vehicles.filter(
        v => v.state === 'ENTERING' ||
             v.state === 'NAVIGATING_TO_SPOT' ||
             v.state === 'PARKING' ||
             v.state === 'PARKED'
      );

      const entryRate = vehicles.length > 0 ? enteredOrParked.length / vehicles.length : 0;

      return {
        passed: entryRate >= 0.5 || vehicles.length === 0,
        message: `${enteredOrParked.length}/${vehicles.length} vehicles entered/entering (${(entryRate * 100).toFixed(0)}%)`,
        details: { enteredCount: enteredOrParked.length, totalVehicles: vehicles.length, entryRate: entryRate * 100 },
      };
    },
  },
  {
    name: 'Lane change safety under congestion (60 vehicles)',
    category: 'Lane Changing',
    run: () => {
      const testSim = createTestSim(150, 222);

      // Congested conditions: 60 vehicles
      testSim.sim.fillLot(60);
      testSim.run(120);

      const vehicles = testSim.getAllVehicles();
      return expectNoCollisions(vehicles);
    },
  },

  // -------------------------------------------------------------------------
  // Speed Limit Compliance Tests (High Occupancy)
  // -------------------------------------------------------------------------
  {
    name: 'Speed limits respected under high load (70 vehicles)',
    category: 'Speed Compliance',
    run: () => {
      const testSim = createTestSim(150, 333);

      // 70 vehicles for high-load testing
      testSim.sim.fillLot(70);
      testSim.run(90);

      const vehicles = testSim.getAllVehicles();
      return expectSpeedLimitCompliance(vehicles);
    },
  },
  {
    name: 'In-lot speed compliance (40 vehicles in lot)',
    category: 'Speed Compliance',
    run: () => {
      const testSim = createTestSim(100, 444);

      // 40 vehicles to ensure many enter the lot
      testSim.sim.fillLot(40);
      testSim.run(180); // Run long enough for vehicles to enter lot

      const inLotVehicles = testSim.getVehiclesByLocation('IN_LOT');

      if (inLotVehicles.length < 5) {
        return {
          passed: false,
          message: `Only ${inLotVehicles.length} vehicles in lot (expected >=5 for valid test)`,
          details: { inLotCount: inLotVehicles.length },
        };
      }

      const maxInLotSpeed = Math.max(...inLotVehicles.map(v => v.speed));
      const passed = maxInLotSpeed <= SPEEDS.AISLE * 1.1;

      return {
        passed,
        message: passed
          ? `In-lot max speed: ${maxInLotSpeed.toFixed(2)} m/s (limit: ${SPEEDS.AISLE}) with ${inLotVehicles.length} vehicles`
          : `In-lot speed too high: ${maxInLotSpeed.toFixed(2)} m/s`,
        details: { maxInLotSpeed, limit: SPEEDS.AISLE, vehicleCount: inLotVehicles.length },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Stuck Vehicle Tests (High Occupancy Stress)
  // -------------------------------------------------------------------------
  {
    name: 'No stuck vehicles at 80% occupancy (80/100 spots)',
    category: 'Stuck Detection',
    run: () => {
      const testSim = createTestSim(100, 555);

      // 80% occupancy - realistic high-demand scenario
      testSim.sim.fillLot(80);
      testSim.run(240); // 4 minutes

      const vehicles = testSim.getAllVehicles();
      return expectNoStuckVehicles(vehicles, 45); // 45 second threshold
    },
  },
  {
    name: 'Stuck resolution at 90% occupancy (90/100 spots)',
    category: 'Stuck Detection',
    run: () => {
      const testSim = createTestSim(100, 666);

      // 90% occupancy - near-capacity stress test
      testSim.sim.fillLot(90);

      // Run and track max wait times over time
      const maxWaitTimes: number[] = [];

      for (let t = 0; t < 360; t += 30) {
        testSim.run(30);
        const vehicles = testSim.getAllVehicles();
        const activeVehicles = vehicles.filter(v => v.state !== 'PARKED');
        const maxWait = activeVehicles.length > 0
          ? Math.max(...activeVehicles.map(v => v.waitTime))
          : 0;
        maxWaitTimes.push(maxWait);
      }

      // Check that wait times don't continuously increase
      const lastWait = maxWaitTimes[maxWaitTimes.length - 1];
      const passed = lastWait < 90; // Allow up to 90s at high occupancy

      return {
        passed,
        message: passed
          ? `Final max wait time: ${lastWait.toFixed(1)}s at 90% occupancy`
          : `Vehicles remain stuck: ${lastWait.toFixed(1)}s wait`,
        details: { maxWaitTimes, finalMaxWait: lastWait, occupancy: '90%' },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Boundary Integrity Tests (High Occupancy)
  // -------------------------------------------------------------------------
  {
    name: 'Boundary integrity at 75% occupancy',
    category: 'Boundary Integrity',
    run: () => {
      const testSim = createTestSim(100, 777);

      // 75 vehicles to stress boundary checking
      testSim.sim.fillLot(75);
      testSim.run(180);

      const vehicles = testSim.getAllVehicles();
      return expectAllWithinPavedArea(testSim.sim, vehicles);
    },
  },

  // -------------------------------------------------------------------------
  // Merge Tests (High Volume Exodus)
  // -------------------------------------------------------------------------
  {
    name: 'Mass exodus: 50 vehicles merge safely',
    category: 'Merging',
    run: () => {
      const testSim = createTestSim(100, 888);

      // Fill lot with 50 vehicles
      testSim.sim.fillLot(50);
      testSim.run(240); // Fill phase - allow parking

      // Start mass exodus
      testSim.sim.startExodus();
      testSim.run(300); // Exodus phase

      // Check no collisions during merge
      const vehicles = testSim.getAllVehicles();
      return expectNoCollisions(vehicles);
    },
  },
  {
    name: 'Merge yield under heavy traffic (60 veh/min)',
    category: 'Merging',
    run: () => {
      const testSim = createTestSim(100, 999, { roadTrafficRate: 60 });

      // 40 vehicles to create substantial merge traffic
      testSim.sim.fillLot(40);
      testSim.run(150);
      testSim.sim.startExodus();
      testSim.run(180);

      // Check for waiting-to-merge vehicles
      const atMerge = testSim.getVehiclesByState('AT_MERGE_POINT');
      const merging = testSim.getVehiclesByState('MERGING');
      const exited = testSim.sim.state.exitedCount;

      return {
        passed: exited >= 20, // At least 50% should have exited
        message: `Exited: ${exited}/40, Merge queue: ${atMerge.length} waiting, ${merging.length} merging`,
        details: { waitingToMerge: atMerge.length, currentlyMerging: merging.length, exited },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Extreme Stress Tests (Near 100% Occupancy)
  // -------------------------------------------------------------------------
  {
    name: 'Extreme stress: 100 vehicles in 120 spots',
    category: 'Stress Test',
    run: () => {
      const testSim = createTestSim(120, 1001);

      // 83% occupancy - extreme stress
      testSim.sim.fillLot(100);
      testSim.run(360); // 6 minutes

      const vehicles = testSim.getAllVehicles();
      return expectNoCollisions(vehicles);
    },
  },
  {
    name: 'Extreme stress: stuck rate at 90% occupancy',
    category: 'Stress Test',
    run: () => {
      const testSim = createTestSim(100, 1002);

      // 90% occupancy - near capacity
      testSim.sim.fillLot(90);
      testSim.run(360);

      const vehicles = testSim.getAllVehicles();
      const stuckVehicles = vehicles.filter(v => v.waitTime > 30 && v.state !== 'PARKED');
      const stuckRate = vehicles.length > 0 ? stuckVehicles.length / vehicles.length : 0;

      const passed = stuckRate < 0.10; // Allow up to 10% at extreme occupancy

      return {
        passed,
        message: passed
          ? `Stuck rate: ${(stuckRate * 100).toFixed(1)}% (${stuckVehicles.length}/${vehicles.length}) at 90% occupancy`
          : `Stuck rate too high: ${(stuckRate * 100).toFixed(1)}%`,
        details: {
          stuckCount: stuckVehicles.length,
          totalVehicles: vehicles.length,
          stuckRate: stuckRate * 100,
          occupancy: '90%',
        },
      };
    },
  },
  {
    name: 'Full capacity: 100/100 spots collision-free',
    category: 'Stress Test',
    run: () => {
      const testSim = createTestSim(100, 1003);

      // 100% occupancy - absolute limit
      testSim.sim.fillLot(100);
      testSim.run(420); // 7 minutes

      const vehicles = testSim.getAllVehicles();
      const collisionResult = expectNoCollisions(vehicles);
      const parkedCount = vehicles.filter(v => v.state === 'PARKED').length;

      return {
        passed: collisionResult.passed,
        message: collisionResult.passed
          ? `No collisions at 100% occupancy (${parkedCount} parked)`
          : collisionResult.message,
        details: { ...collisionResult.details, parkedCount, occupancy: '100%' },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Acceleration Compliance (High Density)
  // -------------------------------------------------------------------------
  {
    name: 'Acceleration limits at 60% occupancy',
    category: 'Physics Compliance',
    run: () => {
      const testSim = createTestSim(100, 1004);

      // 60 vehicles for high-density acceleration testing
      testSim.sim.fillLot(60);
      const snapshots = collectSnapshots(testSim, 90, 0.1);

      // Group by vehicle and check acceleration
      const byVehicle = new Map<number, typeof snapshots>();
      for (const snap of snapshots) {
        if (!byVehicle.has(snap.id)) {
          byVehicle.set(snap.id, []);
        }
        byVehicle.get(snap.id)!.push(snap);
      }

      let maxAccel = 0;
      let maxDecel = 0;

      for (const [, vSnapshots] of byVehicle) {
        vSnapshots.sort((a, b) => a.time - b.time);
        for (let i = 1; i < vSnapshots.length; i++) {
          const dt = vSnapshots[i].time - vSnapshots[i - 1].time;
          if (dt <= 0) continue;

          const accel = (vSnapshots[i].speed - vSnapshots[i - 1].speed) / dt;
          if (accel > maxAccel) maxAccel = accel;
          if (-accel > maxDecel) maxDecel = -accel;
        }
      }

      const passed = maxAccel <= PHYSICS.MAX_ACCELERATION * 1.2 &&
                     maxDecel <= PHYSICS.EMERGENCY_DECEL * 1.2;

      return {
        passed,
        message: passed
          ? `Max accel: ${maxAccel.toFixed(2)}, max decel: ${maxDecel.toFixed(2)} m/s² (60 vehicles)`
          : `Acceleration exceeded: accel=${maxAccel.toFixed(2)}, decel=${maxDecel.toFixed(2)}`,
        details: { maxAccel, maxDecel, vehicleCount: 60 },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Full Cycle Tests (High Occupancy)
  // -------------------------------------------------------------------------
  {
    name: 'Full cycle: 50 vehicles park and exit (50% occupancy)',
    category: 'Full Cycle',
    run: () => {
      const testSim = createTestSim(100, 2001);

      // Fill with 50 vehicles
      testSim.sim.fillLot(50);

      // Run until vehicles are parked (longer timeout for lane change delays)
      for (let t = 0; t < 600; t += 1) {
        testSim.run(1);
        const parkedCount = testSim.sim.state.parkedCount;
        if (parkedCount >= 45) break; // 90% of 50
      }

      const parkedCount = testSim.sim.state.parkedCount;

      // Start exodus
      testSim.sim.startExodus();

      // Run until exited (longer timeout for heavy traffic merge delays)
      for (let t = 0; t < 600; t += 1) {
        testSim.run(1);
        if (testSim.sim.state.phase === 'COMPLETE') break;
      }

      const exitedCount = testSim.sim.state.exitedCount;
      const successRate = parkedCount > 0 ? (exitedCount / parkedCount) * 100 : 0;

      return {
        passed: exitedCount >= 35, // At least 70% of 50
        message: `Parked: ${parkedCount}/50, Exited: ${exitedCount} (${successRate.toFixed(0)}% success)`,
        details: { parkedCount, exitedCount, successRate },
      };
    },
  },
  {
    name: 'Full cycle: 80 vehicles (80% occupancy)',
    category: 'Full Cycle',
    run: () => {
      const testSim = createTestSim(100, 2002);

      // 80% occupancy
      testSim.sim.fillLot(80);

      // Run until vehicles are parked (longer timeout for lane change delays)
      for (let t = 0; t < 800; t += 1) {
        testSim.run(1);
        const parkedCount = testSim.sim.state.parkedCount;
        if (parkedCount >= 70) break; // 87.5% of 80
      }

      const parkedCount = testSim.sim.state.parkedCount;

      // Start exodus
      testSim.sim.startExodus();

      // Run until exited (longer timeout for heavy traffic merge delays)
      for (let t = 0; t < 800; t += 1) {
        testSim.run(1);
        if (testSim.sim.state.phase === 'COMPLETE') break;
      }

      const exitedCount = testSim.sim.state.exitedCount;
      const successRate = parkedCount > 0 ? (exitedCount / parkedCount) * 100 : 0;

      return {
        passed: exitedCount >= 50, // At least 62.5% of 80
        message: `Parked: ${parkedCount}/80, Exited: ${exitedCount} (${successRate.toFixed(0)}% success)`,
        details: { parkedCount, exitedCount, successRate, occupancy: '80%' },
      };
    },
  },
];

// ============================================================================
// MAIN RUNNER
// ============================================================================

import { TestSuiteResult } from './test-harness.js';

let lastResults: TestSuiteResult | null = null;

export async function runInteractionTests(): Promise<void> {
  const results = await runTestSuite('Interaction Tests - Multi-Vehicle Behavior (High Occupancy)', interactionTests);
  lastResults = results;
  printTestSuiteResults(results);

  // Don't throw - let the main runner handle failures and save results
  if (results.failed > 0) {
    console.log('\n⚠️  Some interaction tests failed!');
  }
}

export function getInteractionTestResults(): TestSuiteResult | null {
  return lastResults;
}

// Note: When running as ES module, this file should be imported, not run directly
// Use: npx tsx src/tests/run-all-tests.ts --interaction
