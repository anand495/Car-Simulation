# Parking Simulation Test Report

**Generated:** 2025-12-28T20:25:32.109Z
**Version:** 3.4.0
**Duration:** 14.2 sec

## Summary

| Metric | Value |
|--------|-------|
| Total Passed | 39 |
| Total Failed | 5 |
| Pass Rate | 88.6% |

## Unit Tests - Pure Functions

**Passed:** 26 | **Failed:** 0

### Math Utilities

| Test | Status | Message |
|------|--------|---------|
| normalizeAngle: wraps 2π to 0 | ✅ Pass | normalized angle is within tolerance: 0 ≈ 0 (±0.001) |
| normalizeAngle: wraps -2π to 0 | ✅ Pass | normalized angle is within tolerance: 0 ≈ 0 (±0.001) |
| normalizeAngle: wraps 3π to π | ✅ Pass | normalized angle is within tolerance: 3.141592653589793 ≈ 3. |
| normalizeAngle: keeps π/2 unchanged | ✅ Pass | normalized angle is within tolerance: 1.5707963267948966 ≈ 1 |
| normalizeAngle: keeps -π/2 unchanged | ✅ Pass | normalized angle is within tolerance: -1.5707963267948966 ≈  |
| distance: calculates correctly for horizontal | ✅ Pass | distance is within tolerance: 10 ≈ 10 (±0.001) |
| distance: calculates correctly for vertical | ✅ Pass | distance is within tolerance: 10 ≈ 10 (±0.001) |
| distance: calculates correctly for diagonal (3-4-5) | ✅ Pass | distance is within tolerance: 5 ≈ 5 (±0.001) |
| distance: returns 0 for same point | ✅ Pass | distance is within tolerance: 0 ≈ 0 (±0.001) |

### Constants

| Test | Status | Message |
|------|--------|---------|
| CAR_LENGTH is realistic (4-5m) | ✅ Pass | CAR_LENGTH = 4.5m is realistic |
| CAR_WIDTH is realistic (1.5-2.5m) | ✅ Pass | CAR_WIDTH = 1.8m is realistic |
| SPEEDS.MAIN_ROAD is ~30mph (12-15 m/s) | ✅ Pass | MAIN_ROAD speed = 13.4 m/s is realistic |
| SPEEDS.AISLE is ~10mph (4-5 m/s) | ✅ Pass | AISLE speed = 4.5 m/s is realistic |
| PHYSICS.MAX_ACCELERATION is comfortable (2-3 m/s²) | ✅ Pass | MAX_ACCELERATION = 2.5 m/s² is comfortable |
| PHYSICS.MAX_DECELERATION is comfortable (3-5 m/s²) | ✅ Pass | MAX_DECELERATION = 4 m/s² is comfortable |
| PHYSICS.EMERGENCY_DECEL is emergency-level (7-10 m/s²) | ✅ Pass | EMERGENCY_DECEL = 8 m/s² is appropriate |

### Topology

| Test | Status | Message |
|------|--------|---------|
| createTestSim creates valid simulation | ✅ Pass | Simulation created successfully |
| Topology has correct number of spots | ✅ Pass | Created 150 spots (requested 150) |
| Topology has 3 lanes on main road | ✅ Pass | Main road has 3 lanes |
| Topology has valid entry road | ✅ Pass | Entry road at x=167.5, width=7 |
| Topology has valid exit road | ✅ Pass | Exit road at x=140, width=7 |
| Entry and exit roads are separated | ✅ Pass | Entry and exit roads separated by 27.5m |

### Paved Area

| Test | Status | Message |
|------|--------|---------|
| isWithinPavedArea: center of lot is paved | ✅ Pass | Lot center is within paved area |
| isWithinPavedArea: main road is paved | ✅ Pass | Main road center is within paved area |
| isWithinPavedArea: far off-map is not paved | ✅ Pass | Far off-map position correctly identified as unpaved |
| isWithinPavedArea: despawn extension (x < 0) is valid | ✅ Pass | Despawn extension zone is paved |

## Interaction Tests - Multi-Vehicle Behavior (High Occupancy)

**Passed:** 13 | **Failed:** 5

### Car Following

| Test | Status | Message |
|------|--------|---------|
| High traffic: vehicles maintain safe following distance | ✅ Pass | All following gaps >= 2m |
| Dense traffic: following vehicle slows for leader | ❌ Fail | 1 collisions detected |
| Large convoy (40 vehicles) maintains gaps | ✅ Pass | Large convoy maintains safe gaps with no collisions |

### Lane Changing

| Test | Status | Message |
|------|--------|---------|
| Lane changes complete under heavy traffic (50 vehicles) | ✅ Pass | 25/44 vehicles entered/entering (57%) |
| Lane change safety under congestion (60 vehicles) | ✅ Pass | No collisions detected among 27 vehicles |

### Speed Compliance

| Test | Status | Message |
|------|--------|---------|
| Speed limits respected under high load (70 vehicles) | ✅ Pass | All vehicles comply with speed limits |
| In-lot speed compliance (40 vehicles in lot) | ❌ Fail | Only 0 vehicles in lot (expected >=5 for valid test) |

### Stuck Detection

| Test | Status | Message |
|------|--------|---------|
| No stuck vehicles at 80% occupancy (80/100 spots) | ✅ Pass | No vehicles stuck longer than 45s |
| Stuck resolution at 90% occupancy (90/100 spots) | ✅ Pass | Final max wait time: 0.0s at 90% occupancy |

### Boundary Integrity

| Test | Status | Message |
|------|--------|---------|
| Boundary integrity at 75% occupancy | ✅ Pass | All 50 vehicles are within paved area |

### Merging

| Test | Status | Message |
|------|--------|---------|
| Mass exodus: 50 vehicles merge safely | ✅ Pass | No collisions detected among 51 vehicles |
| Merge yield under heavy traffic (60 veh/min) | ❌ Fail | Exited: 10/40, Merge queue: 0 waiting, 1 merging |

### Stress Test

| Test | Status | Message |
|------|--------|---------|
| Extreme stress: 100 vehicles in 120 spots | ✅ Pass | No collisions detected among 58 vehicles |
| Extreme stress: stuck rate at 90% occupancy | ✅ Pass | Stuck rate: 0.0% (0/52) at 90% occupancy |
| Full capacity: 100/100 spots collision-free | ✅ Pass | No collisions at 100% occupancy (44 parked) |

### Physics Compliance

| Test | Status | Message |
|------|--------|---------|
| Acceleration limits at 60% occupancy | ✅ Pass | Max accel: 2.50, max decel: 6.67 m/s² (60 vehicles) |

### Full Cycle

| Test | Status | Message |
|------|--------|---------|
| Full cycle: 50 vehicles park and exit (50% occupancy) | ❌ Fail | Parked: 21/50, Exited: 21 (100% success) |
| Full cycle: 80 vehicles (80% occupancy) | ❌ Fail | Parked: 32/80, Exited: 32 (100% success) |

## Failed Tests Details

### ❌ Dense traffic: following vehicle slows for leader

**Suite:** Interaction Tests - Multi-Vehicle Behavior (High Occupancy)
**Category:** Car Following
**Message:** 1 collisions detected

**Details:**
```json
{
  "vehicleCount": 28,
  "collisions": [
    {
      "v1": 23,
      "v2": 28,
      "distance": 2.174079334605551
    }
  ]
}
```

### ❌ In-lot speed compliance (40 vehicles in lot)

**Suite:** Interaction Tests - Multi-Vehicle Behavior (High Occupancy)
**Category:** Speed Compliance
**Message:** Only 0 vehicles in lot (expected >=5 for valid test)

**Details:**
```json
{
  "inLotCount": 0
}
```

### ❌ Merge yield under heavy traffic (60 veh/min)

**Suite:** Interaction Tests - Multi-Vehicle Behavior (High Occupancy)
**Category:** Merging
**Message:** Exited: 10/40, Merge queue: 0 waiting, 1 merging

**Details:**
```json
{
  "waitingToMerge": 0,
  "currentlyMerging": 1,
  "exited": 10
}
```

### ❌ Full cycle: 50 vehicles park and exit (50% occupancy)

**Suite:** Interaction Tests - Multi-Vehicle Behavior (High Occupancy)
**Category:** Full Cycle
**Message:** Parked: 21/50, Exited: 21 (100% success)

**Details:**
```json
{
  "parkedCount": 21,
  "exitedCount": 21,
  "successRate": 100
}
```

### ❌ Full cycle: 80 vehicles (80% occupancy)

**Suite:** Interaction Tests - Multi-Vehicle Behavior (High Occupancy)
**Category:** Full Cycle
**Message:** Parked: 32/80, Exited: 32 (100% success)

**Details:**
```json
{
  "parkedCount": 32,
  "exitedCount": 32,
  "successRate": 100,
  "occupancy": "80%"
}
```
