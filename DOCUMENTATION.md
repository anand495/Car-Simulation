# Parking Lot Simulation - Technical Documentation

## Project Objective

Simulate realistic vehicle flow in a parking lot environment, including:
- Vehicles entering from a main road
- Navigating through the lot to find parking spots
- Parking and later exiting during an "exodus" event
- Merging back onto the main road

The simulation models realistic physics, speed limits, and traffic flow to study congestion patterns and optimize lot design.

---

## Architecture Overview

### Design Principles

1. **Topology vs Behavior Separation**
   - **Topology** (`topology.ts`): Defines the physical layout - roads, spots, aisles, speed limits
   - **Behavior** (`simulation.ts`): Defines how cars act - state machine, path following, speed control
   - Cars are topology-agnostic: they can be placed in any topology and will adapt

2. **Speed Limit Enforcement**
   - Speed limits are defined as part of topology (property of roads/aisles)
   - Cars respect limits via `getSpeedLimitAtPosition()` function
   - Final speed = `min(state-based max speed, topology speed limit, gap-based speed)`

3. **Topology-Agnostic Gap Calculations**
   - Gap requirements use vehicle speed and IDM time headway, not hardcoded distances
   - Urgency factors use proportional distances (e.g., `distanceToEntry / 200`) not fixed meters
   - Emergency thresholds use `CAR_LENGTH` multiples, not absolute values
   - All movement decisions reference topology properties (`entryRoad.x`, `mainRoad.width`) not magic numbers

### Topology vs Behavior: When to Change What

Understanding where to make changes is critical for maintaining clean separation of concerns.

#### What Belongs in Topology (`topology.ts`)

| Responsibility | Examples |
|---------------|----------|
| **Physical layout** | Road positions, dimensions, lane counts |
| **Valid positions** | Where roads exist, where spots are located |
| **Speed limits** | Speed limit per road/aisle/area |
| **Path generation** | Waypoint sequences from A to B |
| **Geometric queries** | `isOnRoadSegment()`, `getLaneY()`, `getSpeedLimitAtPosition()` |

#### What Belongs in Behavior (`simulation.ts`)

| Responsibility | Examples |
|---------------|----------|
| **Movement rules** | "Stay in your lane", "Don't cut corners" |
| **State transitions** | When to change from APPROACHING to ENTERING |
| **Decision making** | When to change lanes, when to yield |
| **Physics** | Acceleration, braking, smooth motion |
| **Collision avoidance** | Safe following distance, gap checking |

#### Decision Guide: Where Should This Change Go?

| Change Type | Where | Rationale |
|-------------|-------|-----------|
| Add a new road | Topology | Physical layout change |
| Change road dimensions | Topology | Physical layout change |
| Add lane to existing road | Topology + Behavior | Topology defines lanes; behavior may need updated lane logic |
| Change how cars follow lanes | Behavior | Movement rule enforcement |
| Keep cars on paved areas | Behavior | Movement restriction enforcement |
| Add intermediate waypoints for turns | Topology | Path generation responsibility |
| Change state transition triggers | Behavior | Decision logic |
| Add speed limit to area | Topology | Property of the physical space |
| Change how cars accelerate | Behavior | Physics/movement rules |
| Add despawn point | Topology + Behavior | Topology defines location; behavior needs `isWithinPavedArea()` extended |

#### Common Scenarios

**Scenario 1: Adding a new lane to a road**
- Topology: Update `lanes` count, adjust road `width`
- Behavior: Update lane change logic if it references specific lane numbers
- Path generation: May need to assign cars to new lane

**Scenario 2: Cars cutting across unpaved areas**
- Topology: Add intermediate waypoints to create proper turn paths
- Behavior: Update state transitions to check correct positions before changing state

**Scenario 3: Changing traffic flow direction**
- Topology: Update road `direction` property, regenerate paths
- Behavior: Update any hardcoded direction assumptions (e.g., heading angles)

**Scenario 4: Adding a traffic light**
- Topology: Add `TrafficLight` object to `trafficLights[]`
- Behavior: Add logic to detect lights, stop at red, proceed on green

#### Key Insight: Despawn Boundaries

When creating new topologies, the **paved area bounds** must extend beyond the **visual road** to allow vehicles to reach despawn points:

```typescript
// In isWithinPavedArea():
// Despawn happens at mainRoad.x - 20, so paved area must extend to at least mainRoad.x - 50
const mainRoadLeft = mainRoad.x - 50; // NOT mainRoad.x

// Similarly for other roads where vehicles exit the simulation
```

**Why this matters:**
- Movement is validated against `isWithinPavedArea()` before being applied
- If paved area ends at `mainRoad.x`, vehicles cannot move to `x < 0`
- Despawn check is `x < mainRoad.x - 20`, so vehicles get stuck oscillating at x ≈ 0
- Solution: Extend paved bounds 50m beyond the visual road end

**Checklist for new topologies:**
1. Identify all despawn points (where vehicles exit the simulation)
2. Ensure `isWithinPavedArea()` extends at least 30m beyond each despawn point
3. Test that vehicles can actually reach despawn points, not just approach them

#### Key Insight: Path Generation

Path generation is **defined in topology** but creates **vehicle-specific data**:

```typescript
// In topology.ts - generates path at spawn time
const path = generateEntryPath(topology, targetSpot, spawnLane);

// Path is stored on vehicle - behavior follows it
vehicle.path = path;
vehicle.pathIndex = 0;
```

The topology says "here's how to get from A to B", but the behavior says "here's how to follow that path correctly."

---

### Context-Aware Behavior Architecture

Cars behave differently depending on **where they are** and **what they're doing**. The architecture uses a layered state model to enable extensible, context-specific behaviors.

#### The Four-Layer State Model

Each vehicle maintains four independent state layers:

```typescript
interface Vehicle {
  // Layer 1: Location (WHERE am I physically?)
  location: LocationState;  // ON_MAIN_ROAD, ON_ENTRY_ROAD, IN_LOT, IN_SPOT, etc.

  // Layer 2: Intent (WHAT is my goal?)
  intent: IntentState;      // SEEKING_PARKING, PARKED, EXITING_LOT, PASSING_THROUGH

  // Layer 3: Behavior Flags (WHAT micro-behaviors are active?)
  behaviors: BehaviorFlags; // isReversing, isChangingLane, isYielding, etc.

  // Layer 4: Traffic Control (WHAT traffic rules apply?)
  trafficControl: TrafficControlState; // nearestLightId, mustStop, etc.
}
```

#### Why Four Layers?

| Layer | Purpose | Example Query |
|-------|---------|---------------|
| **Location** | Physical context | "Am I in an aisle?" → Enable obstacle avoidance |
| **Intent** | Goal context | "Am I seeking parking?" → Need lane 0 for entry |
| **Behaviors** | Active micro-actions | "Am I reversing?" → Move backward, don't steer |
| **Traffic Control** | Rule compliance | "Is light red?" → Must stop |

#### Context-Based Behavior Dispatch

Behaviors are selected based on context. This pattern makes the system extensible:

```typescript
// Example: Different behaviors based on location
private followPath(vehicle: Vehicle, dt: number): void {
  // Context: On main road
  if (vehicle.location === 'ON_MAIN_ROAD') {
    // Main road behaviors: lane-locked, westbound driving
    this.handleMainRoadMovement(vehicle, dt);
    return;
  }

  // Context: In parking lot
  if (vehicle.location === 'IN_LOT') {
    // Lot behaviors: obstacle avoidance, waypoint following
    this.handleLotMovement(vehicle, dt);
    return;
  }

  // Context: On entry/exit road
  // Different behaviors for vertical road segments
  this.handleVerticalRoadMovement(vehicle, dt);
}
```

#### Adding New Behaviors (Extensibility Guide)

**Step 1: Identify the Context**
- What location(s) should trigger this behavior?
- What intent(s) should trigger this behavior?
- What existing behaviors might conflict?

**Step 2: Add Behavior Flag (if needed)**
```typescript
// In types.ts - BehaviorFlags interface
interface BehaviorFlags {
  // ... existing flags
  isNewBehavior: boolean;  // Add new flag
}
```

**Step 3: Add Context Check in Simulation**
```typescript
// In simulation.ts - where behavior should apply
if (vehicle.location === 'IN_LOT' && vehicle.intent === 'SEEKING_PARKING') {
  const result = this.applyNewBehavior(vehicle);
  if (result !== null) {
    // Behavior was applied
  }
}
```

**Step 4: Implement the Behavior Method**
```typescript
private applyNewBehavior(vehicle: Vehicle): SomeResult | null {
  // Guard: Only apply in correct context
  if (vehicle.state === 'PARKING') return null;

  // Implement behavior logic
  // Return null if behavior doesn't apply
}
```

#### Current Context-Behavior Mapping

| Location | Intent | Active Behaviors |
|----------|--------|------------------|
| `ON_MAIN_ROAD` | `SEEKING_PARKING` | Lane changing, cooperative yielding, lane-locked driving |
| `ON_MAIN_ROAD` | `EXITING_LOT` | Lane-locked driving (post-merge) |
| `ON_ENTRY_ROAD` | `SEEKING_PARKING` | Waypoint following, speed reduction |
| `IN_LOT` | `SEEKING_PARKING` | Obstacle avoidance, waypoint following, parked car detection |
| `IN_LOT` | `EXITING_LOT` | Reversing (from spot), waypoint following |
| `ON_EXIT_ROAD` | `EXITING_LOT` | Merge waiting, gap detection |
| `IN_SPOT` | `PARKED` | No movement (static obstacle) |

#### Future Extensibility Examples

**Example 1: Add "Pedestrian Yielding" behavior**
```typescript
// Context: IN_LOT + pedestrian detected ahead
if (vehicle.location === 'IN_LOT') {
  const pedestrianAhead = this.detectPedestrianAhead(vehicle);
  if (pedestrianAhead) {
    vehicle.behaviors.isYielding = true;
    vehicle.targetSpeed = 0;
  }
}
```

**Example 2: Add "Traffic Light Compliance" behavior**
```typescript
// Context: Approaching traffic light
if (vehicle.trafficControl.mustStop && vehicle.trafficControl.distanceToLight < 10) {
  vehicle.behaviors.isWaitingAtLight = true;
  vehicle.targetSpeed = 0;
}
```

**Example 3: Add "Narrow Aisle Passing" behavior**
```typescript
// Context: IN_LOT + oncoming vehicle in same aisle
if (vehicle.location === 'IN_LOT') {
  const oncoming = this.detectOncomingInAisle(vehicle);
  if (oncoming && this.aisleWidth < MIN_PASSING_WIDTH) {
    // One vehicle must yield
    if (this.shouldYieldTo(vehicle, oncoming)) {
      vehicle.behaviors.isYielding = true;
    }
  }
}
```

#### Design Principles for New Behaviors

1. **Context Guard First**: Always check location/intent before applying behavior
2. **Return Early if Not Applicable**: Use `return null` pattern for optional behaviors
3. **Don't Override Higher-Priority Rules**: Speed limits and collision avoidance take precedence
4. **Use Behavior Flags**: Set flags for debugging and visualization
5. **Respect Boundaries**: Check aisle/road bounds before steering
6. **Composable**: Multiple behaviors can be active simultaneously (e.g., lane changing + yielding)

#### When Changing Topology Requires Behavior Changes

| Topology Change | Behavior Change Needed? |
|-----------------|------------------------|
| Move a road | Usually no - paths are regenerated |
| Change road dimensions | Maybe - if state transitions check specific positions |
| Add/remove lanes | Yes - lane logic needs updating |
| Change entry/exit points | Yes - state transitions reference these positions |
| Add new road segment | Yes - need state transitions for the new segment |
| Change speed limits | No - speed is queried dynamically |

#### Best Practice: Position-Based vs Hardcoded Checks

**Fragile (hardcoded):**
```typescript
// Breaks if entry road moves
if (vehicle.x > 500) {
  vehicle.state = 'ENTERING';
}
```

**Robust (position-based):**
```typescript
// Works regardless of topology changes
const entryRoadLeft = topology.entryRoad.x - topology.entryRoad.width / 2;
const entryRoadRight = topology.entryRoad.x + topology.entryRoad.width / 2;
if (pos.x >= entryRoadLeft && pos.x <= entryRoadRight) {
  vehicle.state = 'ENTERING';
}
```

---

## File Structure

```
parking-sim/
├── src/
│   ├── types.ts        # Type definitions, constants, interfaces
│   ├── topology.ts     # Lot layout generation, pathfinding, speed limit lookup
│   ├── simulation.ts   # Core simulation engine, vehicle behavior
│   ├── App.tsx         # React UI, canvas rendering
│   └── main.tsx        # Entry point
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Type Definitions (`types.ts`)

### Physical Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `CAR_LENGTH` | 4.5m | Vehicle length |
| `CAR_WIDTH` | 1.8m | Vehicle width |
| `PARKING_SPOT_LENGTH` | 5.5m | Spot depth |
| `PARKING_SPOT_WIDTH` | 2.7m | Spot width |
| `AISLE_WIDTH` | 6.0m | Driving aisle width |
| `LANE_WIDTH` | 3.5m | Road lane width |

### Speed Constants (`SPEEDS`)

| Speed | Value | MPH | Usage |
|-------|-------|-----|-------|
| `PARKING_LOT` | 2.2 m/s | 5 mph | General lot driving |
| `AISLE` | 4.5 m/s | 10 mph | Driving through aisles |
| `EXIT_APPROACH` | 2.2 m/s | 5 mph | Approaching exit |
| `MERGE` | 3.0 m/s | 7 mph | Merging onto road |
| `MAIN_ROAD` | 13.4 m/s | 30 mph | On main road |
| `BACKUP` | 1.0 m/s | 2 mph | Reversing out of spot |
| `CREEP` | 0.5 m/s | 1 mph | Inching forward |

### Physics Constants (`PHYSICS`)

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_ACCELERATION` | 2.5 m/s² | Comfortable acceleration |
| `MAX_DECELERATION` | 4.0 m/s² | Comfortable braking |
| `EMERGENCY_DECEL` | 8.0 m/s² | Emergency stop |
| `SAFE_TIME_HEADWAY` | 1.5 sec | Following distance time |
| `MIN_GAP` | 2.0m | Minimum gap to car ahead |

### Layered State Architecture (v2.0)

The vehicle state model uses a layered architecture for scalability:

#### Layer 1: Location State (Where am I?)
```typescript
type LocationState =
  | 'ON_MAIN_ROAD'    // On the main road
  | 'ON_ENTRY_ROAD'   // On entry road into lot
  | 'ON_EXIT_ROAD'    // On exit road from lot
  | 'IN_LOT'          // Inside parking lot
  | 'IN_SPOT'         // Parked in a spot
  | 'EXITED';         // Left the simulation
```

#### Layer 2: Intent State (What am I trying to do?)
```typescript
type IntentState =
  | 'SEEKING_PARKING'   // Looking for/driving to a parking spot
  | 'PARKED'            // Stationary, waiting
  | 'EXITING_LOT'       // Leaving the parking lot
  | 'PASSING_THROUGH';  // Just driving through (road traffic)
```

#### Layer 3: Behavior Flags (Active micro-behaviors)
```typescript
interface BehaviorFlags {
  isReversing: boolean;        // Moving backward
  isChangingLane: boolean;     // Actively changing lanes
  isYielding: boolean;         // Yielding to another vehicle
  isMerging: boolean;          // Actively merging into traffic
  isWaitingAtLight: boolean;   // Stopped at traffic light
  isWaitingToMerge: boolean;   // Waiting for gap to merge
  isWaitingForSpot: boolean;   // Waiting for spot to clear
  laneChangeProgress: number;  // 0 to 1, progress through lane change
  laneChangeDirection: 'left' | 'right' | null;
}
```

#### Layer 4: Traffic Control State
```typescript
interface TrafficControlState {
  nearestLightId: string | null;
  lightColor: TrafficLightColor | null;
  distanceToLight: number;
  mustStop: boolean;
}
```

### Legacy Vehicle State Machine (Compatibility)

```
Entry Flow:
APPROACHING → ENTERING → NAVIGATING_TO_SPOT → PARKING → PARKED

Exit Flow:
PARKED → EXITING_SPOT → DRIVING_TO_EXIT → IN_EXIT_LANE → AT_MERGE_POINT → MERGING → ON_ROAD → EXITED
```

| State | Description | Max Speed | Location |
|-------|-------------|-----------|----------|
| `APPROACHING` | On main road, heading toward entry | 13.4 m/s | Main road |
| `ENTERING` | Turning into entry road | 2.2 m/s | Entry road |
| `NAVIGATING_TO_SPOT` | Driving through lot to spot | 4.5 m/s | Lot/Aisles |
| `PARKING` | Pulling into the spot | 0.5 m/s | Near spot |
| `PARKED` | Stationary in spot | 0 m/s | In spot |
| `EXITING_SPOT` | Backing out of spot | 1.0 m/s | Spot/Aisle |
| `DRIVING_TO_EXIT` | Navigating toward exit | 4.5 m/s | Lot/Aisles |
| `IN_EXIT_LANE` | On exit road | 2.2 m/s | Exit road |
| `AT_MERGE_POINT` | Waiting to merge | 0 m/s | Exit road top |
| `MERGING` | Accelerating onto main road | 3.0 m/s | Transition |
| `ON_ROAD` | Driving away on main road | 13.4 m/s | Main road |
| `EXITED` | Left simulation | N/A | Off-screen |

### Key Interfaces

#### Vehicle
```typescript
interface Vehicle {
  id: number;

  // Position and orientation
  x: number;
  y: number;
  heading: number;              // Radians (0 = east, π/2 = north)

  // Kinematics
  speed: number;                // Current speed (m/s)
  targetSpeed: number;          // What we're accelerating toward
  acceleration: number;         // Current acceleration

  // Layered State Model
  location: LocationState;      // Where am I?
  intent: IntentState;          // What am I trying to do?
  behaviors: BehaviorFlags;     // Active micro-behaviors
  trafficControl: TrafficControlState; // Traffic light awareness

  // Lane tracking
  currentLane: number | null;   // Current lane (0 = leftmost)
  targetLane: number | null;    // Target lane for lane change
  laneChangeStartY: number | null;

  // Legacy state (compatibility)
  state: VehicleState;

  // Navigation
  targetSpotId: number | null;  // Assigned parking spot
  path: Point[];                // Waypoints to follow
  pathIndex: number;            // Current waypoint

  // Timing and visual
  spawnTime: number;
  parkTime: number | null;
  waitTime: number;
  color: string;
}
```

#### RoadSegment
```typescript
interface RoadSegment {
  id: string;
  x: number;                    // Start x (horizontal) or center x (vertical)
  y: number;                    // Center y (horizontal) or start y (vertical)
  length: number;
  width: number;                // Total width (lanes × lane width)
  lanes: number;
  orientation: 'horizontal' | 'vertical';
  direction: 'east' | 'west' | 'north' | 'south';
  speedLimit: number;           // m/s
}
```

#### Topology
```typescript
interface Topology {
  mainRoad: RoadSegment;        // 3 lanes, westbound
  entryRoad: RoadSegment;       // 2 lanes, southbound
  exitRoad: RoadSegment;        // 2 lanes, northbound
  lot: {
    x, y, width, height: number;
    speedLimit: number;
  };
  entryPoint: Point;            // Where entry road meets lot
  exitPoint: Point;             // Where exit road leaves lot
  aisles: Aisle[];
  spots: ParkingSpot[];
  trafficLights: TrafficLight[]; // Traffic control infrastructure
}
```

#### TrafficLight
```typescript
interface TrafficLight {
  id: string;
  x: number;
  y: number;
  controlsDirection: 'north' | 'south' | 'east' | 'west';
  color: TrafficLightColor;     // 'red' | 'yellow' | 'green'
  greenDuration: number;        // seconds
  yellowDuration: number;
  redDuration: number;
  currentPhaseTime: number;
  roadSegmentId: string;
  stopLinePosition: number;
}
```

---

## Topology (`topology.ts`)

### Layout Diagram

```
     ←←←←←←←←←←← Main Road (3 lanes, westbound) ←←←←←←←←←←←
                    ↑              │
                    │              ↓
                Exit Road      Entry Road
                (2 lanes)      (2 lanes)
                    ↑              ↓
              ┌─────┴──────────────┴─────┐
              │                          │
              │      Parking Lot         │
              │    ══════════════════    │ ← aisles with spots on both sides
              │    ══════════════════    │
              │                          │
              └──────────────────────────┘
```

### Lot Generation (`createStandardLot`)

- 500 spots by default
- 25 spots per side of aisle (50 per aisle)
- 10 aisles for 500 spots
- Aisles alternate direction (east/west)
- Entry road on right side, exit road on left side

### Speed Limit Lookup (`getSpeedLimitAtPosition`)

Priority order:
1. Main road → 13.4 m/s
2. Entry road → 2.2 m/s
3. Exit road → 2.2 m/s
4. Aisle → 4.5 m/s
5. Lot (default) → 2.2 m/s

### Pathfinding

Waypoints are stored as `path: Point[]` on each vehicle, generated at spawn time.

**Entry Path** (`generateEntryPath(topology, spot, spawnLane)`):
1. Start on main road in spawn lane (y controlled by lane logic, not path)
2. Drive west to entry road x-position (must be in lane 0 by this point)
3. Turn south onto entry road (randomly assigned to left or right lane)
4. Enter lot (top of lot area)
5. Move to approach point: `approachX = min(spot.x + 30, rightCorridorX)`
   - This creates different vertical paths for different spots
   - Spreads traffic instead of funneling through single corridor
6. Drive down to target aisle level
7. Turn into aisle at spot's x position
8. Pull into spot

**Exit Path** (`generateExitPath(topology, spot)`):
1. Start at spot
2. Back out into aisle
3. Drive through aisle to left corridor
4. Navigate up to exit point
5. Drive up exit road (randomly assigned to left or right lane)
6. Merge onto main road (lane 0)
7. Drive west until off-screen

---

## Simulation Engine (`simulation.ts`)

### Main Loop (`step`)

Each frame:
1. Update spatial grid for neighbor lookups
2. Spawn road traffic (grey background vehicles)
3. Update all vehicles (state, speed, position)
4. Resolve collisions
5. Update counters and metrics
6. Check phase transitions

### Speed Computation (`computeTargetSpeed`)

```typescript
targetSpeed = min(
  stateMaxSpeed,           // Based on vehicle state
  topologySpeedLimit,      // Based on position
  densityAdjustedSpeed,    // Reduced in congested areas
  gapBasedSpeed            // Safe following distance
)
```

### Vehicle Movement (`followPath`)

- Normal: Turn toward next waypoint, move forward
- Reversing: Move backward without turning (for exiting spots)
- Waypoint reached when within 2m, advance to next

**Main Road Special Handling:**
- While on main road (not at turn point): y-position locked to current lane
- Only x-distance checked for waypoint completion
- Heading fixed to π (west)

**Turn Point Detection:**
- When vehicle reaches entry road x-position AND is in lane 0:
  - `isAtTurnPoint` becomes true
  - Advances `pathIndex` to 2 (skips stale main road waypoints)
  - Sets heading to south (`-π/2`) immediately
  - Switches to normal path following for entry road

**Why skip waypoints at turn point:**
- Path indices 0-1 are main road waypoints, handled by lane logic (not path following)
- When `isAtTurnPoint` triggers, these waypoints may be behind the car
- Without skipping, `angleTo()` would point backward → car spins 360°
- Advancing to index 2 and setting heading south prevents this

### Lane Distribution

**Main Road (3 lanes, horizontal, westbound):**
- Lane 0 = bottom (south, closest to lot) - required for turning into entry road
- Lane 1 = middle
- Lane 2 = top (north)
- **Grey traffic** (roadVehicles): Randomly distributed across all 3 lanes
- **Green cars** (entering): Spawn in random lane, must change to lane 0 to enter
- **Cyan cars** (exiting): Merge into lane 0

**Entry Road (2 lanes, vertical, southbound):**
- Lane 0 = left (west)
- Lane 1 = right (east)
- Cars randomly assigned to either lane

**Exit Road (2 lanes, vertical, northbound):**
- Lane 0 = left (west)
- Lane 1 = right (east)
- Cars randomly assigned to either lane

### Lane Changing (v3.4.1)

Vehicles on the main road can change lanes to reach the entry road.

**Lane Change Parameters (Base Values):**
| Parameter | Value | Description |
|-----------|-------|-------------|
| `LANE_CHANGE_MIN_GAP` | 8.0m | Base minimum gap (scaled by speed) |
| `LANE_CHANGE_TIME` | 2.0s | Duration of lane change maneuver |
| `LANE_CHANGE_LOOK_AHEAD` | 50m | Distance to check ahead for entry |
| `LANE_CHANGE_LOOK_BEHIND` | 30m | Base check behind distance |

**Speed-Dependent Gap Calculation:**
```
minGapAhead = (BASE_GAP + speed × T × 0.5) × urgencyFactor
minGapBehind = (BASE_GAP + speed × T) × urgencyFactor

where:
  BASE_GAP = 8.0m
  T = IDM time headway (1.5s)
  urgencyFactor = 0.2 to 1.0 based on distance to entry
```

**Lane Change Logic:**
1. Cars spawn in random lane (0, 1, or 2) on main road
2. While on main road, y-position is controlled by lane logic (not pathfinding)
3. Check if vehicle needs to be in lane 0 (bottom) for entry (600m trigger distance)
4. Calculate speed-dependent gaps using IDM time headway
5. Apply urgency factor based on distance to entry point
6. Check gap in target lane with calculated requirements
7. If normal gaps not available but within 50m and minimal gap exists, force lane change
8. If safe, execute smooth lane change with ease-in-out interpolation
9. Once in lane 0, turn right into entry road

**Visual Indicators:**
- Vehicles changing lanes pulse yellow
- Turn signal indicator shows on the side of intended direction

### Car Behavior Rules (Complete Reference)

This section documents all currently implemented car behaviors in the simulation.

> **Architecture Note:** Behaviors are context-aware and location-dependent. See
> [Context-Aware Behavior Architecture](#context-aware-behavior-architecture) for the
> extensibility pattern used to add new behaviors.

---

#### Behaviors by Location (Quick Reference)

| Location | Enabled Behaviors |
|----------|-------------------|
| `ON_MAIN_ROAD` | Lane-locked driving, lane changing, cooperative yielding, turn point detection |
| `ON_ENTRY_ROAD` | Waypoint following, speed reduction |
| `IN_LOT` | Obstacle avoidance (15° max), parked car detection, waypoint following |
| `IN_SPOT` | Static (no movement), acts as obstacle to others |
| `ON_EXIT_ROAD` | Waypoint following, merge gap detection, merge waiting |
| **All Locations** | **Movement validation, off-road recovery** |

---

#### 1. State Machine & Lifecycle

Cars progress through a defined state machine based on their intent and location:

**Entry Flow (SEEKING_PARKING intent):**
```
APPROACHING → ENTERING → NAVIGATING_TO_SPOT → PARKING → PARKED
```

**Exit Flow (EXITING_LOT intent):**
```
PARKED → EXITING_SPOT → DRIVING_TO_EXIT → IN_EXIT_LANE → AT_MERGE_POINT → MERGING → ON_ROAD → EXITED
```

**Pass-Through Flow (PASSING_THROUGH intent):**
```
ON_ROAD → EXITED
```
Pass-through vehicles simply drive west on the main road without entering the lot. They create realistic traffic that parking vehicles must navigate around when changing lanes or merging.

| State | Description | Speed | Location |
|-------|-------------|-------|----------|
| `APPROACHING` | On main road, driving west toward entry | 13.4 m/s (30 mph) | `ON_MAIN_ROAD` |
| `ENTERING` | Turned onto entry road, driving south | 2.2 m/s (5 mph) | `ON_ENTRY_ROAD` |
| `NAVIGATING_TO_SPOT` | In lot, following path to spot | 4.5 m/s (10 mph) | `IN_LOT` |
| `PARKING` | Final approach to parking spot | 0.5 m/s (1 mph) | `IN_LOT` |
| `PARKED` | Stationary in spot, waiting | 0 | `IN_SPOT` |
| `EXITING_SPOT` | Reversing out of spot | 1.0 m/s (2 mph) | `IN_LOT` |
| `DRIVING_TO_EXIT` | Navigating through lot to exit | 4.5 m/s (10 mph) | `IN_LOT` |
| `IN_EXIT_LANE` | On exit road, driving north | 2.2 m/s (5 mph) | `ON_EXIT_ROAD` |
| `AT_MERGE_POINT` | Stopped, waiting for gap to merge | 0 | `ON_EXIT_ROAD` |
| `MERGING` | Actively merging onto main road | 3.0 m/s (7 mph) | `ON_EXIT_ROAD` |
| `ON_ROAD` | On main road after merge, accelerating | 13.4 m/s (30 mph) | `ON_MAIN_ROAD` |
| `EXITED` | Left simulation boundary | 0 | `EXITED` |

---

#### 2. Speed Control

Speed is computed as the **minimum** of multiple constraints:

```typescript
targetSpeed = min(
  stateMaxSpeed,       // Based on vehicle state (see table above)
  topologySpeedLimit,  // Based on current position (road/aisle limits)
  densityAdjustedSpeed,// Reduced in congested areas
  gapBasedSpeed,       // Safe following distance (IDM-style)
  yieldSpeed           // Cooperative yielding for lane changers
)
```

**Speed Limits by Area:**
| Area | Speed Limit | Notes |
|------|-------------|-------|
| Main Road | 13.4 m/s (30 mph) | Full highway speed |
| Entry Road | 2.2 m/s (5 mph) | Slow for turning |
| Exit Road | 2.2 m/s (5 mph) | Slow for safety |
| Aisles | 4.5 m/s (10 mph) | Moderate lot speed |
| Lot (general) | 2.2 m/s (5 mph) | Default lot speed |

**Gap-Based Speed (IDM Model):**
- Minimum gap: 2.0 m
- Safe time headway: 1.5 seconds
- At gap < 2m: creep at 0.25 m/s
- At gap < 4m: creep at 0.5 m/s
- At gap < desired: proportionally reduce speed

---

#### 3. Path Following

Cars follow pre-computed waypoint paths generated at spawn time.

**Waypoint Acceptance Radius:**
- General: 3.0 m
- Parking state: 2.5 m (tighter for precision)

**Turn Rate:** 2.0 radians/second maximum

**Main Road Special Handling:**
- Y-position is locked to current lane (not path-following)
- Only X-distance checked for waypoint completion
- Heading fixed to π (west)
- Cars continue driving west even if path is exhausted

**Turn Point Behavior:**
- When vehicle reaches entry road x-position AND is in lane 0:
  - Advances `pathIndex` to skip stale main road waypoints
  - Sets heading to `-π/2` (south) immediately
  - Prevents 360° spin from outdated waypoints

---

#### 4. Lane Changing (Main Road)

Cars must be in lane 0 (bottom/south) to turn into the entry road.

**Lane Change Parameters:**
| Parameter | Value | Description |
|-----------|-------|-------------|
| `LANE_CHANGE_MIN_GAP` | 8.0 m | Min gap ahead in target lane |
| `LANE_CHANGE_LOOK_BEHIND` | 30 m | Distance to check behind |
| `LANE_CHANGE_TIME` | 2.0 s | Duration of maneuver |
| Time-to-close threshold | 3 s | Min time before vehicle behind catches up |

**Lane Change Logic:**
1. Detect need: If not in lane 0 and within 600m of entry
2. Safety check: Verify gaps ahead (8m) and behind (30m + time-to-close)
3. Execute: Smooth ease-in-out interpolation over 2 seconds
4. Complete: Snap to target lane y-position

**Urgency Slowdown:**
- If lane change needed but blocked, and within 20% of main road length of entry:
- Speed reduced by 40% to find a gap

**Missed Turn Handling:**
- If car passes entry by >50m in wrong lane:
- Car marked as EXITED (can't turn back on one-way road)
- Assigned parking spot freed
- Replacement vehicle spawned (during FILLING phase)

---

#### 5. Parked Cars as Obstacles

**Rule:** Moving vehicles treat parked cars as solid, immovable obstacles.

**Gap Detection (`getGapAhead`):**
- Parked cars ARE included in collision detection
- Only `EXITED` vehicles are skipped
- Dot product used to determine if obstacle is ahead
- Cross product used for lateral distance check

**Collision Response:**
- When moving car collides with parked car: `v1.speed = 0`
- Parked car never moves
- Moving car must wait or find alternate path

**Congestion Exclusion:**
- Parked cars do NOT contribute to density calculations
- Only actively moving vehicles affect traffic flow metrics
- When state changes (e.g., to `EXITING_SPOT`), car rejoins congestion model

---

#### 6. Obstacle Avoidance (In Aisles)

When driving in aisles, cars can steer around parked vehicles blocking their path.

**Conditions:**
- Only in parking lot (`location === 'IN_LOT'`)
- NOT in `PARKING` state (those need direct path to spot)
- Only avoids `PARKED` state vehicles

**Detection:**
- Look ahead: 10 meters
- Path width: 1.5 × car width (2.7 m)
- Uses dot product (ahead check) and cross product (lateral distance)

**Steering:**
- Maximum avoidance angle: 15° (π/12 radians)
- Direction: Away from blocking car (cross product determines side)

**Boundary Check (Critical):**
- Before applying steering, projects future position (2 seconds ahead)
- If projection would exit aisle bounds: steering rejected
- Car instead slows down via normal gap detection
- Prevents cars from driving outside paved areas

```typescript
const projectedY = vehicle.y + Math.sin(newHeading) * vehicle.speed * 2;
if (projectedY < aisle.y - aisleHalfWidth || projectedY > aisle.y + aisleHalfWidth) {
  return null; // Don't steer outside aisle
}
```

---

#### 7. Cooperative Yielding

Cars on main road yield to vehicles changing lanes in front of them.

**Detection:**
- Looks ahead 40m for lane-changing vehicles
- Checks if other car's `targetLane` matches our `currentLane`
- Only yields to cars ahead (smaller x-position for westbound traffic)

**Response:**
- Computes safe following speed based on distance
- Maintains gap of 1.5× car length to merging vehicle
- Allows smooth lane changes without collision

---

#### 8. Merging onto Main Road

Cars at merge point (top of exit road) wait for safe gaps before merging.

**Gap Requirements:**
- Gap ahead: 10m (2 car lengths)
- Gap behind: 30m (2 seconds at road speed)
- Time-to-reach check: approaching vehicles must be >2s away
- Checks all vehicles on main road (pass-through and post-merge traffic)

**Merge Execution:**
- When gap found: state changes to `MERGING`
- Speed: 3.0 m/s (accelerating)
- Upon reaching lane 0 y-position: state becomes `ON_ROAD`
- Lane assigned: 0 (bottom lane where exit road joins)
- Heading snapped to west (π) for clean traffic flow

**Timeout Protection:**
- After 10 seconds waiting, uses relaxed `hasMinimalMergeGap()` check
- Prevents indefinite waiting during heavy traffic

---

#### 9. Reversing (Exiting Spots)

Cars back out of parking spots without turning.

**Behavior:**
- `isReversing` flag set to true
- Movement: backward relative to heading
- No steering applied during reverse
- Speed: 1.0 m/s (backup speed)

**State Transition:**
- After reaching aisle (pathIndex >= 2): switch to forward driving
- `isReversing` set to false
- Continue to `DRIVING_TO_EXIT` state

---

#### 10. Collision Resolution

**Spatial Grid:**
- O(1) neighbor lookups using grid cells (10m × 10m)
- Only checks nearby vehicles for collisions

**Priority System:**
- Cars closer to exit have higher priority
- When collision detected: lower priority car stops
- Parked cars always have priority (never move)

**Overlap Resolution:**
- When cars overlap (dist < 0.8 × car length)
- Nudge apart slightly in direction away from each other
- Prevents permanent stuck states

---

#### 11. Wait Time Tracking

**Purpose:** Visual feedback for stuck vehicles

**Accumulation:**
- Increments when speed < 0.1 m/s
- NOT accumulated when PARKED or AT_MERGE_POINT
- Resets to 0 when vehicle starts moving again

**Visual Effect:**
- Vehicles with `waitTime > 3s` rendered in red
- Helps identify congestion points

---

#### 12. Spawning

**Staggered Spawning:**
- `spawnQueue` maintains count of vehicles to spawn
- One vehicle spawned every 0.5 seconds
- Prevents gridlock from simultaneous spawning

**Lane Distribution:**
- Vehicles biased toward lanes 0-1 (45%/40%/15% distribution)
- Must change to lane 0 before reaching entry

**Position:**
- Spawn x: right edge of main road (not beyond)
- Spawn y: lane y-position based on assigned lane

**Spawn Spacing Check:**
- Before spawning, checks if any vehicle is within 2 car lengths of spawn point
- If spawn point is blocked, spawn attempt is skipped (will retry next interval)
- Prevents pile-ups where cars spawn on top of each other

---

#### 13. Stay Within Paved Path (Boundary Constraints)

Cars must remain within the paved areas at all times. This is enforced through coordinate validation rather than position clamping.

**Coordinate Validation (`isWithinPavedArea`):**
Before any movement is applied, the new position is validated against all paved surfaces:

| Paved Area | X Bounds | Y Bounds |
|------------|----------|----------|
| Main Road | `roadLeft` to `roadRight` | `roadBottom` to `roadTop` |
| Entry Road | `entryLeft` to `entryRight` | `entryBottom` to `entryTop` |
| Exit Road | `exitLeft` to `exitRight` | `exitBottom` to `exitTop` |
| Parking Lot | `lotLeft` to `lotRight` | `lotBottom` to `lotTop` |

A position is valid if it falls within ANY of these areas. This correctly handles junctions where roads overlap (e.g., where entry road meets main road).

**Movement Validation:**
```typescript
const newX = vehicle.x + Math.cos(heading) * speed * dt;
const newY = vehicle.y + Math.sin(heading) * speed * dt;

if (this.isWithinPavedArea(newX, newY)) {
  vehicle.x = newX;
  vehicle.y = newY;
} else {
  // Try moving along each axis independently
  if (this.isWithinPavedArea(newX, vehicle.y)) vehicle.x = newX;
  if (this.isWithinPavedArea(vehicle.x, newY)) vehicle.y = newY;
}
```

**Collision Nudge Constraints:**
When collision resolution nudges cars apart, the nudge is validated:
- Before applying nudge, check if new position is within paved area
- If full nudge would push outside, try nudging along each axis independently
- Prevents collision resolution from pushing cars off roads

```typescript
if (this.isWithinPavedArea(v1NewX, v1NewY)) {
  v1.x = v1NewX;
  v1.y = v1NewY;
} else {
  // Try each axis independently
  if (this.isWithinPavedArea(v1NewX, v1.y)) v1.x = v1NewX;
  if (this.isWithinPavedArea(v1.x, v1NewY)) v1.y = v1NewY;
}
```

**Recovery Behavior (`recoverFromOffRoad`):**
If a vehicle somehow ends up outside the paved area, a recovery behavior activates:
1. Find the nearest point on any paved surface (entry road, lot, or exit road)
2. Turn toward that point
3. Move slowly (creep speed) back onto the paved area
4. Once back on paved area, normal path following resumes

This handles edge cases where numerical precision or unexpected conditions push a vehicle slightly off-road.

**Why Coordinate Validation Instead of Clamping:**
The previous clamping approach had a critical flaw: it prevented legitimate movements at road junctions. For example, a car at (171, 354) trying to turn south from the main road onto the entry road would have its y-position clamped to the main road bottom, preventing the turn.

Coordinate validation allows movement as long as the destination is on ANY valid paved surface, correctly handling transitions between roads.

---

#### 14. Summary: Behaviors Grouped by Location Context

This section organizes all behaviors by where they apply, demonstrating the context-aware architecture.

**`ON_MAIN_ROAD` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Lane-locked driving | Always | Y-position snapped to lane center |
| Lane changing | Need lane 0, within 600m of entry | Smooth ease-in-out interpolation |
| Lane change slowdown | Changing lanes near entry (within 3× road width) | Cap speed to AISLE (4.5 m/s) |
| Cooperative yielding | Another car changing into our lane | Slow down to maintain gap |
| Urgency slowdown | Can't change lanes, within 20% of road length | Reduce speed by 40% |
| Turn point detection | At entry x-position AND in lane 0 | Face south, advance pathIndex |
| Extended turn zone | Up to 1 road width past entry center | Still allow turn if slightly late |
| Missed turn handling | Passed entry by 50m in wrong lane | Mark EXITED, respawn replacement |

**`ON_ENTRY_ROAD` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Waypoint following | Always | Turn toward next waypoint, move forward |
| Speed reduction | Always | Limited to 2.2 m/s (5 mph) |

**`IN_LOT` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Obstacle avoidance | Parked car ahead, in aisle | Steer up to 15° around obstacle |
| Boundary checking | Before any steering | Project position, reject if leaves aisle |
| Parked car collision | Moving car hits parked car | Moving car stops (speed = 0) |
| Aisle yielding | Higher priority vehicle nearby | Yield based on exit priority |
| Yield to backing vehicles | Vehicle in EXITING_SPOT state within 10m | Treat as blocking |
| Waypoint following | Not reversing | Turn toward waypoint, move forward |
| Reversing | EXITING_SPOT state | Move backward without turning |
| Direct spot approach | PARKING state, path exhausted | Turn toward spot, move forward |

**`IN_SPOT` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Static obstacle | Always | Speed = 0, position fixed |
| Collision blocker | Moving car approaches | Moving car must stop or avoid |

**`ON_EXIT_ROAD` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Waypoint following | IN_EXIT_LANE state | Turn toward waypoint, move forward |
| Merge waiting | AT_MERGE_POINT state | Check for gap in main road traffic |
| Merge execution | MERGING state, gap found | Accelerate onto main road |

**Universal Behaviors (All Locations):**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Speed limiting | Always | min(state, topology, density, gap) |
| Collision resolution | Any two cars overlap | Priority-based stopping + lane-constrained nudge |
| Head-on conflict | Vehicles facing each other | Wait time used as priority tiebreaker |
| Wait time tracking | Speed < 0.1 m/s | Increment counter, visual feedback |
| Stuck resolution | waitTime > 5s | Tiered escalation: creep (10s) → aggressive (15s) → skip waypoint (20s) |
| Priority-based creep | Multiple stuck vehicles | Only highest priority vehicle allowed to creep |
| Gap-based speed | Car ahead | IDM-style following distance |
| Movement validation | Before any position update | Check `isWithinPavedArea()`, reject if off-road |
| Off-road recovery | Position outside paved area | Find nearest paved point, navigate back slowly |

---

#### Adding a New Location-Specific Behavior

To add a behavior that only applies in a specific location:

```typescript
// 1. Check location context FIRST
if (vehicle.location !== 'IN_LOT') return null;

// 2. Check additional conditions
if (vehicle.state === 'PARKING') return null;  // Doesn't apply when parking

// 3. Detect the situation
const obstacle = this.detectObstacle(vehicle);
if (!obstacle) return null;

// 4. Apply the behavior
const newHeading = this.computeAvoidanceHeading(vehicle, obstacle);

// 5. Validate the result (respect boundaries)
if (!this.isValidHeading(vehicle, newHeading)) return null;

return newHeading;
```

This pattern ensures:
- Behaviors are isolated to their context
- Multiple behaviors can compose without conflicts
- New topologies work without behavior changes
- Debugging is easier (check location → check behavior)

---

## Traffic Models: IDM and MOBIL (`idm-mobil.ts`)

The simulation uses two peer-reviewed traffic models for realistic vehicle behavior:

### IDM (Intelligent Driver Model)

The Intelligent Driver Model (Treiber, Hennecke & Helbing, 2000) is a car-following model that computes acceleration based on:
- Current speed vs desired speed
- Gap to vehicle ahead
- Approach rate (closing speed)

**Key Equation:**
```
a = a_max * [1 - (v/v0)^δ - (s*(v,Δv)/s)^2]

where:
  s* = s0 + v*T + v*Δv/(2*sqrt(a*b))  (desired gap)
  s0 = minimum gap (jam distance)
  T  = time headway (following distance in seconds)
  a  = comfortable acceleration
  b  = comfortable deceleration
  δ  = acceleration exponent (typically 4)
```

**Context-Aware Parameters:**

The simulation uses different IDM parameters for different contexts:

| Context | T (s) | s0 (m) | a (m/s²) | b (m/s²) | Use Case |
|---------|-------|--------|----------|----------|----------|
| **Highway (IDM)** | 1.5 | 2.0 | 2.5 | 4.0 | Main road driving |
| **Parking (IDM_PARKING)** | 1.0 | 1.5 | 2.0 | 3.0 | In-lot navigation |
| **Merge (IDM_MERGE)** | 1.2 | 1.5 | 2.5 | 4.0 | Merging onto road |

### MOBIL (Lane Change Model)

The MOBIL model (Kesting, Treiber & Helbing, 2007) decides when lane changes are safe and beneficial:

**Safety Criterion:**
The new follower in the target lane must not need to brake harder than `b_safe`.

**Incentive Criterion:**
```
a_new - a_old > p * (Δa_follower) + a_threshold

where:
  p = politeness factor (0 = selfish, 1 = altruistic)
  a_threshold = minimum improvement required
```

**Parameters (Optimized):**
```typescript
MOBIL = {
  p: 0.4,           // Politeness factor (optimized from 0.5 - slightly less polite reduces collisions)
  athreshold: 0.2,  // Threshold acceleration gain (m/s²)
  bsafe: 4.0,       // Max safe braking for new follower (m/s²)
  abias: 0.3,       // Bias toward right lane (m/s²)
}
```

### Implementation Best Practices

1. **Small timesteps (dt ≤ 0.1s)** - Larger steps cause instability
2. **Clamp velocity ≥ 0** - Vehicles cannot move backward accidentally
3. **Handle no leader** - Use large gap (100m) when no vehicle ahead
4. **Handle small gaps** - Return creep speed for gaps < s0
5. **Consistent IDM for MOBIL** - Use same parameters for all acceleration calculations

### Parameter Tuning System

The simulation includes a parameter tuning system (`src/tests/parameter-tuning.ts`) for optimizing IDM/MOBIL parameters:

**Reward Function Components:**
| Component | Weight | Purpose |
|-----------|--------|---------|
| Collision penalty | -1000 | Critical safety |
| Stuck vehicle penalty | -50 | Traffic flow |
| Boundary violation penalty | -200 | Stay on road |
| Physics violation penalty | -100 | Realistic motion |
| Wait time penalty | -1/sec | Efficiency |
| Throughput reward | +10/vehicle | Goal achievement |

**Running Parameter Optimization:**
```bash
# Analyze a simulation log
npx tsx src/tests/parameter-tuning.ts --analyze ~/Downloads/simulation-log.json

# Run hill climbing optimization
npx tsx src/tests/parameter-tuning.ts --optimize --iterations 50

# Evaluate current default parameters
npx tsx src/tests/parameter-tuning.ts --evaluate
```

### Spawn Clearance and Lane Discipline

Vehicles spawn on the main road with per-lane clearance checks:

```typescript
// Spawn clearance is checked PER LANE, not globally
const minSpawnClearance = CAR_LENGTH * 3; // 13.5m

for (const v of this.state.vehicles) {
  if (v.location === 'ON_MAIN_ROAD') {
    // Only check vehicles in the SAME lane
    if (Math.abs(v.y - laneY) < laneWidth * 0.7) {
      if (Math.abs(v.x - spawnX) < minSpawnClearance) {
        return; // Too close, skip spawn
      }
    }
  }
}
```

This prevents the "cluster spawn" issue where vehicles in different lanes blocked spawning globally, leading to bursts of spawns followed by collisions.

### Topology-Agnostic Lane Change Gaps

Lane change gap requirements are calculated dynamically based on:
1. **Vehicle speed** - Higher speeds require larger gaps (using IDM time headway)
2. **Urgency** - Vehicles near the entry point accept smaller gaps
3. **Topology dimensions** - Uses `entryRoad.x` for distance calculations

```typescript
// Speed-dependent gaps: gap = base + speed * time_headway
const speedBasedGapAhead = PHYSICS.LANE_CHANGE_MIN_GAP + vehicle.speed * IDM.T * 0.5;
const speedBasedGapBehind = PHYSICS.LANE_CHANGE_MIN_GAP + vehicle.speed * IDM.T;

// Urgency factor based on distance to entry (topology-agnostic)
const distanceToEntry = vehicle.x - entryRoad.x;
const urgencyFactor = distanceToEntry > 0
  ? Math.max(0.3, Math.min(1.0, distanceToEntry / 200)) // 0.3 at <60m, 1.0 at >200m
  : 0.2; // Very urgent if past entry point

// Final gaps combine speed and urgency
const minGapAhead = speedBasedGapAhead * urgencyFactor;
const minGapBehind = speedBasedGapBehind * urgencyFactor;
```

**Emergency Lane Change (Last Resort):**
When a vehicle is within 50m of the entry point and cannot find a normal gap, it may force a lane change with minimal safety requirements:
- Checks for minimal gap (1.2 × CAR_LENGTH)
- Slows down during the forced lane change
- Prevents vehicles from missing their turn in heavy traffic

### Emergency Braking Logic

When vehicles get too close, emergency braking activates based on gap distance:

```typescript
// Emergency gap threshold (topology-agnostic - based on CAR_LENGTH)
const EMERGENCY_GAP = CAR_LENGTH * 0.2; // 0.9m edge gap

if (gap < 0) {
  // Overlap - allow tiny creep to separate
  return SPEEDS.CREEP * 0.1;
}

if (gap < EMERGENCY_GAP) {
  // Emergency zone - very slow creep to prevent collision
  const ratio = gap / EMERGENCY_GAP;
  return SPEEDS.CREEP * (0.1 + 0.1 * ratio);
}

if (gap < idmParams.s0) {
  // Below jam distance - creep slowly
  const ratio = (gap - EMERGENCY_GAP) / (idmParams.s0 - EMERGENCY_GAP);
  return SPEEDS.CREEP * (0.2 + 0.3 * ratio);
}
```

This graduated response:
- Prevents complete deadlocks (always allows minimal creep)
- Smoothly transitions from emergency to normal IDM behavior
- Uses topology-agnostic values (CAR_LENGTH, SPEEDS constants)

---

## Rendering (`App.tsx`)

### Coordinate System

- World coordinates: origin at bottom-left, y increases upward
- Screen coordinates: origin at top-left, y increases downward
- `worldToScreen()` converts between systems with camera offset and zoom

### Vehicle Colors by State

| State | Color | Hex |
|-------|-------|-----|
| APPROACHING, ENTERING, NAVIGATING, PARKING | Green | #4ade80 |
| PARKED | Blue | #3b82f6 |
| EXITING_SPOT, DRIVING_TO_EXIT, IN_EXIT_LANE | Orange | #f97316 |
| AT_MERGE_POINT | Yellow | #eab308 |
| MERGING, ON_ROAD | Cyan | #22d3ee |
| Road traffic | Grey | #666666 |

### Camera Controls

- Mouse drag: Pan
- Mouse wheel: Zoom
- Touch: Pan and pinch-to-zoom

---

## Simulation Phases

| Phase | Description |
|-------|-------------|
| `IDLE` | Initial state, no activity |
| `FILLING` | Vehicles spawning and parking |
| `WAITING` | All vehicles parked, waiting for exodus |
| `EXODUS` | All parked vehicles exiting |
| `COMPLETE` | All vehicles have exited |

---

## Configuration (`SimConfig`)

| Option | Default | Description |
|--------|---------|-------------|
| `numSpots` | 500 | Number of parking spots |
| `roadTrafficRate` | 30 | Vehicles per minute on main road |
| `staggerExitSeconds` | 60 | Spread exodus over this many seconds |
| `showDebug` | false | Show debug overlays |

---

## Implementation History

### Version 1.0 - Initial Setup
- React + Vite + TypeScript project
- Basic canvas rendering
- Vehicle spawning and movement

### Version 1.1 - Parking Snap Fix
- Fixed cars not snapping to parking spots
- Increased PARKING threshold from 0.5m to 2m
- Adjusted NAVIGATING_TO_SPOT transition logic

### Version 1.2 - Removed Fixed Facing Direction
- Removed `facing` property from ParkingSpot
- Cars park from whichever direction they approach (realistic behavior)

### Version 1.3 - Reversing Capability
- Added `isReversing` boolean to Vehicle
- Cars now back out of spots (move opposite to heading)
- Set during EXITING_SPOT state

### Version 1.4 - Topology Redesign
- Replaced access road with proper road network:
  - 3-lane one-way main road (westbound)
  - 2-lane entry road (southbound into lot)
  - 2-lane exit road (northbound to main road)
- Speed limits defined in topology
- `getSpeedLimitAtPosition()` for position-based lookup

### Version 1.5 - Speed Limit Enforcement
- Fixed APPROACHING state to use MAIN_ROAD speed (was using PARKING_LOT)
- Cars now properly travel at 30 mph on main road
- State-based speeds align with topology speed limits

### Version 1.6 - Lane Distribution
- Grey traffic distributed across all 3 lanes (was single lane)
- Green entering cars spawn in bottom lane
- Road vehicles face west (added rotation to rendering)
- Path generation uses correct lane y-positions

### Version 2.0 - Layered State Architecture
- **Breaking Change**: Complete refactor of vehicle state model
- Introduced 4-layer architecture:
  - Layer 1: LocationState (physical location)
  - Layer 2: IntentState (goal/purpose)
  - Layer 3: BehaviorFlags (active micro-behaviors)
  - Layer 4: TrafficControlState (traffic light awareness)
- Added lane tracking (`currentLane`, `targetLane`)
- Legacy `VehicleState` maintained for compatibility

### Version 2.1 - Traffic Lights Infrastructure
- Added `TrafficLight` interface to topology
- Supports red/yellow/green phases with configurable timing
- Framework ready for complex intersection topologies

### Version 2.2 - Realistic Lane Changing
- Vehicles can change lanes on main road
- Gap-based safety checks (ahead and behind)
- Time-to-close calculation for vehicles behind
- Smooth ease-in-out lane change animation
- Visual indicators (pulsing yellow, turn signals)
- Lane change triggers when approaching entry road

### Version 2.3 - Multi-Lane Entry/Exit Roads
- Entry road now uses both lanes (was single lane)
- Exit road now uses both lanes (was single lane)
- Cars randomly assigned to left or right lane on entry/exit roads
- Entering cars spawn in random main road lane (was always bottom)
- Main road y-position controlled by lane logic, not pathfinding
- Lane 0 = bottom/south (closest to lot), Lane 2 = top/north
- Fixed lane numbering confusion (was inverted)

### Version 2.4 - Topology vs Behavior Design Documentation
- Added comprehensive "Topology vs Behavior: When to Change What" section
- Documented responsibilities of topology.ts vs simulation.ts
- Added decision guide table for common change types
- Included common scenarios with where-to-change guidance
- Documented path generation as topology-defined but vehicle-specific
- Added best practice examples (position-based vs hardcoded checks)
- Intermediate waypoints added to prevent cars cutting corners during turns

### Version 2.5 - Turn Point Detection Fix
- Fixed bug where cars could not enter the parking lot
- **Root cause**: On main road, y-position was locked to current lane, preventing turns
- **Solution**: Added `isAtTurnPoint` detection in `followPath()`
- When vehicle is on main road AND at entry road x-position AND in lane 0:
  - Switches from lane-locked movement to normal path following
  - Allows vehicle to turn south onto entry road
- This is an example of behavior needing to handle topology transitions correctly

### Version 2.6 - Turn Circle Bug Fix
- Fixed bug where cars spun in a full circle when turning into entry road
- **Root cause**: When `isAtTurnPoint` triggered, `pathIndex` was still 0 or 1, pointing to
  waypoints behind or at the car's position. The `angleTo()` calculation pointed backward,
  causing the car to rotate 360° trying to reach a waypoint it had already passed.
- **Solution**: When at turn point with `pathIndex < 2`:
  - Advance `pathIndex` to 2 (the "just below main road" waypoint)
  - Set `heading` to `-π/2` (south) immediately
- **Path structure**: `[spawn, entry road x on main road, below main road, ...]`
  - Index 0-1: Main road waypoints (handled by lane logic, not path following)
  - Index 2+: Entry road and lot waypoints (handled by normal path following)

### Version 2.7 - Direct Path Routing (Traffic Distribution)
- Fixed traffic bottleneck where all cars used the same vertical corridor path

- **Problem observed**: When cars entered the lot to park:
  1. All cars traveled to the same corridor point (`corridorX = lot.x + lot.width - 15`)
  2. All cars then traveled down the same vertical corridor
  3. When one car stopped (to pull into a spot), all cars behind got blocked
  4. This created a cascading traffic jam

- **Root cause**: The `generateEntryPath()` function used a single hardcoded corridor x-position
  for all vehicles, regardless of where their destination spot was located

- **Reason for fix**: In the real world, drivers minimize travel distance by choosing the most
  direct drivable path to their parking spot. They don't all follow the same lane when there's
  open pavement available. A driver going to a spot on the left side of the lot would naturally
  drive more toward the left, while a driver going to a spot on the right would stay right.

- **Solution**: Direct path routing that minimizes travel distance while staying on drivable paths
  - `approachX = min(spot.x + 30, rightCorridorX)` - creates unique approach point per spot
  - Cars heading to spots on the left travel further left before going down
  - Cars heading to spots on the right stay near the right corridor
  - This spreads traffic across the lot width instead of single corridor
  - When one car stops, cars with different destinations can pass on different paths

### Version 3.0 - Unified Traffic Model & Severe Exodus

- Replaced separate grey background traffic with unified vehicle model
- All traffic now uses full simulation vehicles with proper physics and collision detection

- **Traffic Model Changes**:
  1. Removed `RoadVehicle` type and grey car rendering
  2. Added `PASSING_THROUGH` intent for vehicles that drive straight through
  3. Pass-through vehicles spawn continuously based on `roadTrafficRate` config
  4. Pass-through vehicles stay in their spawn lane (no lane changing needed)
  5. All vehicles now participate in full collision detection and gap checking

- **Benefits of unified model**:
  - Pass-through traffic properly interacts with parking vehicles
  - Lane change gap checking now includes pass-through vehicles
  - Merge gap detection considers all traffic, not just roadVehicles array
  - More realistic traffic dynamics - everyone follows same physics rules

- **Severe Exodus Mode**:
  - Removed staggered exit timing (`staggerExitSeconds` config ignored)
  - All parked cars attempt to exit simultaneously when exodus starts
  - Creates maximum congestion for stress testing and realistic worst-case scenario
  - Useful for studying traffic jams and bottleneck behavior

- **Implementation Details**:
  - `spawnPassThroughVehicle()` creates full Vehicle objects with `intent: 'PASSING_THROUGH'`
  - Pass-through vehicles use `state: 'ON_ROAD'` and exit when `x < mainRoad.x - 20`
  - `canMerge()` and `hasMinimalMergeGap()` now check `state.vehicles` instead of `roadVehicles`
  - `canChangeLane()` considers all vehicles on main road

- **Vehicle Cleanup (Memory Management)**:
  - Vehicles with `state: 'EXITED'` are removed from array each frame
  - Prevents memory buildup from continuous pass-through traffic
  - `exitedCount` tracked incrementally before removal
  - EXODUS completion checks for no remaining parking vehicles (ignoring pass-through)

---

### Version 2.9 - Merge Point Improvements

- Improved merge logic to prevent cars from getting stuck when exiting the lot

- **Problems addressed**:
  1. Imprecise merge point detection could cause vehicles to overshoot
  2. Merge gap requirements were too restrictive (45m gaps)
  3. No timeout protection for vehicles waiting indefinitely at merge point
  4. MERGING state completion check was relative to road center instead of lane 0

- **Solution 1 - Precise Merge Point Detection**:
  - Calculate exact lane 0 y-position for merge point detection
  - Vehicle stops precisely at `mergePointY - 5` instead of vague `mainRoad.y - 10`
  - Explicitly stop vehicle at merge point (`vehicle.speed = 0`)

- **Solution 2 - Improved `canMerge()` Logic**:
  - Reduced gap requirements to realistic values (10m ahead, 30m behind)
  - Use time-to-reach calculation instead of fixed distance for approaching vehicles
  - Check only lane 0 conflicts, not entire road width
  - Limit concurrent merging vehicles to 2 to prevent pile-ups

- **Solution 3 - Merge Timeout Protection**:
  - After 10 seconds waiting at merge point, use relaxed `hasMinimalMergeGap()` check
  - Minimal gap check only prevents immediate collisions (1.5 car lengths)
  - Prevents indefinite waiting during high traffic periods

- **Solution 4 - Precise Merge Completion**:
  - Check against lane 0 y-position, not road center
  - Snap vehicle to lane center on merge completion
  - Set heading to west (π) for clean traffic flow

---

### Version 2.8 - Coordinate Validation & Off-Road Recovery

- Replaced position clamping with coordinate validation approach

- **Problem observed**: Cars were getting stuck at road junctions, specifically at the entry road turn:
  1. The `clampToRoadBounds()` function clamped cars to their current road's bounds
  2. When a car at the main road tried to turn south onto the entry road, its y-position was clamped to `mainRoadBottom`
  3. The car could never decrease y enough to trigger the `ON_ENTRY_ROAD` state transition
  4. Additionally, collision resolution could nudge cars outside road bounds, leaving them permanently stuck

- **Root cause**: Clamping treats the symptom (cars off-road) but prevents legitimate transitions between roads at junctions

- **Solution 1 - Coordinate Validation (`isWithinPavedArea`)**:
  - Before applying any movement, check if the new position is valid on ANY paved surface
  - A position at (167, 354) is valid because it's on the entry road, even though it's below the main road
  - Movement is allowed as long as the destination is on valid paved area
  - If full movement would go off-road, try moving along each axis independently

- **Solution 2 - Collision Nudge Validation**:
  - Before applying collision resolution nudges, validate with `isWithinPavedArea()`
  - If nudge would push vehicle off-road, reject or reduce the nudge
  - Prevents collision resolution from pushing cars outside paved areas

- **Solution 3 - Off-Road Recovery (`recoverFromOffRoad`)**:
  - If a vehicle somehow ends up outside paved area, activate recovery mode
  - Find the nearest point on any paved surface (entry road, lot, exit road)
  - Turn toward that point and move slowly (creep speed) back onto pavement
  - Once back on paved area, normal path following resumes
  - This handles edge cases from numerical precision or unexpected conditions

---

### Version 3.1 - Disciplined Yielding

- Implemented realistic yielding behavior where vehicles slow down for turning and merging cars

- **Problem observed**: After implementing the unified traffic model (v3.0), pass-through vehicles would rear-end parking-seeking vehicles that were turning into the entry road:
  1. When a vehicle in lane 0 turned south, its y-position started changing
  2. Following vehicles used lateral distance to determine "blocking" status
  3. Because the turning car's y was now different, it wasn't detected as blocking
  4. Following cars maintained speed and collided with the turning car

- **Root cause**: The gap detection (`getGapAhead`) only considered vehicles directly ahead in the same lane, not vehicles actively turning or changing lanes

- **Solution 1 - Heading-Aware Gap Detection**:
  - Enhanced `getGapAhead()` to detect vehicles that are turning (heading differs from westbound by more than 30°)
  - Also detects vehicles that are slowing significantly (preparing to turn)
  - Near the entry zone, if a car ahead is turning or slowing, treat it as blocking

  ```typescript
  // Check if the other vehicle is turning (heading significantly different from west)
  const headingDiff = Math.abs(normalizeAngle(other.heading - Math.PI));
  const isTurning = headingDiff > Math.PI / 6; // More than 30° off from west
  const isSlowingDown = other.speed < SPEEDS.MAIN_ROAD * 0.5;

  if (isTurning || isSlowingDown) {
    if (dist < 15 && ahead > 1) {
      isBlocking = true;
    }
  }
  ```

- **Solution 2 - Cooperative Yielding for Turning Cars**:
  - Enhanced `getCooperativeYieldSpeed()` to yield to vehicles turning at entry zone
  - Looks ahead 40m for vehicles that are turning (heading differs by more than ~22°)
  - Computes safe following speed with 2× car length gap

- **Solution 3 - Proactive Slowdown in Lane 0**:
  - Pass-through vehicles in lane 0 now slow to 70% of road speed when near entry zone
  - Applied when within -20m to +50m of entry road x-position
  - Gives turning vehicles more time and reduces collision risk

- **Solution 4 - Yield to Merging Vehicles**:
  - `getGapAhead()` now detects vehicles in MERGING or AT_MERGE_POINT state
  - When near exit zone, treats merging vehicles as blocking
  - Prevents collisions at the exit road merge point

- **Junction Bounds Fix**:
  - Fixed `isWithinPavedArea()` bounds for entry/exit roads
  - Entry and exit road tops now overlap with main road center (`mainRoad.y`)
  - Provides junction continuity for smooth transitions between roads
  - Previously, there could be a gap at junctions preventing valid movements

- **Despawn Boundary Fix**:
  - Extended main road left boundary in `isWithinPavedArea()` from `mainRoad.x` to `mainRoad.x - 50`
  - Allows vehicles to continue driving west past x=0 to reach the despawn point at x < -20
  - Previously, vehicles were getting stuck oscillating around x=0 because movement was blocked

---

### Version 3.2 - Stuck/Yield Resolution & Metrics Dashboard

- Added comprehensive stuck vehicle resolution and priority-based collision handling

- **Stuck Vehicle Resolution (Timeout-Based Escalation)**:
  - Level 1 (5-10s): Minor steering adjustments to find alternate path
  - Level 2 (10-15s): Allow slow creep movement (0.3× creep speed) even when blocked
  - Level 3 (15-20s): More aggressive creep (0.5× creep speed)
  - Level 4 (20s+): Skip current waypoint as last resort

- **Priority-Based Creep Resolution**:
  - Only the highest-priority stuck vehicle is allowed to creep
  - Prevents convoy deadlock where multiple stuck vehicles try to move simultaneously
  - Uses `getExitPriority()` to determine which vehicle has precedence

- **Expanded Priority System**:
  - Extended `getExitPriority()` to include all vehicle states, not just exiting:
    - ON_ROAD: 100 + x-position
    - MERGING: 90
    - AT_MERGE_POINT: 80
    - IN_EXIT_LANE: 70 + y-position
    - DRIVING_TO_EXIT: 60 + y-position
    - EXITING_SPOT: 50
    - PARKING: 40 - y * 0.1 (deeper in lot = more progress)
    - NAVIGATING_TO_SPOT: 30 - y * 0.1
    - ENTERING: 20 - y * 0.1
    - APPROACHING: 10 + time since spawn * 0.5

- **Head-On Conflict Detection**:
  - Detects vehicles facing each other (heading difference ≈ π)
  - Uses dot products to verify both vehicles are actually facing toward each other
  - In head-on conflicts, wait time serves as priority tiebreaker (longer wait = higher priority)

- **Entry Road/Lot Junction Collision Detection**:
  - Added `entryToLot` check to detect conflicts between vehicles on entry road and in lot
  - Ensures vehicles transitioning from entry road to lot are properly detected for collision

- **Metrics Dashboard**:
  - Added comprehensive vehicle state breakdown in top-right corner
  - Shows counts for: Spawned, Parked, Exited, In Transit, In Lot, Exiting, On Road, Stuck
  - "Stuck" defined as waitTime > 5s and not parked

---

### Version 3.3 - Topology-Agnostic Refactoring

- Refactored all magic number thresholds to use proportional values based on topology dimensions

- **Design Principle**: Vehicle behavior should depend only on:
  1. Vehicle state (position, heading, speed, waitTime)
  2. Relative distances to other vehicles
  3. Topology-provided properties (road width, dimensions)
  - NOT on hardcoded coordinate values that assume a specific layout

- **Refactored Distance Thresholds**:
  | Original | Refactored | Rationale |
  |----------|------------|-----------|
  | `entryRoad.x ± 10` | `entryRoad.x ± entryRoad.width` | Entry zone proportional to road width |
  | `distToEntry > -20 && < 50` | `distToEntry > -passDistance && < approachDistance` | Approach/pass zones = 3×/2× entry road width |
  | `dist < 15` for blocking | `dist < CAR_LENGTH * 3` | Distance relative to vehicle size |
  | `exitRoad.width + 10` | `exitRoad.width * 2` | Exit zone proportional to road width |
  | `dist < 20` for merge yield | `dist < CAR_LENGTH * 4` | Distance relative to vehicle size |
  | `distToEntry < 200` for urgency | `distToEntry < mainRoad.length * 0.2` | Urgency zone = 20% of road length |

- **Why Topology-Agnostic Matters**:
  - Same simulation code works with any lot layout
  - Behavior scales appropriately with different road dimensions
  - Easier to create new topologies without modifying behavior code
  - Reduces coupling between topology definition and vehicle logic

- **What Remains Topology-Dependent (Legitimately)**:
  - Reading topology structure (`this.topology.entryRoad.x`)
  - Computing positions from topology (`getLaneY(mainRoad, lane)`)
  - Checking paved area bounds (`isWithinPavedArea()`)
  - These are necessary queries, not hardcoded assumptions

---

### Version 3.4 - Lane-Constrained Collision Resolution

- Fixed collision nudging to prevent vehicles from being pushed off their lanes

- **Problem**: When vehicles collided, the nudge-apart logic could push them perpendicular to the road, causing them to leave their lane or even go off-road.

- **Solution**: Constrain nudge direction based on vehicle location (topology-agnostic):
  | Location | Allowed Nudge | Rationale |
  |----------|---------------|-----------|
  | `ON_MAIN_ROAD` (both vehicles) | X-axis only | Main road runs east-west |
  | `ON_ENTRY_ROAD` / `ON_EXIT_ROAD` (both) | Y-axis only | These roads run north-south |
  | Junction (mixed locations) | 30% magnitude | Conservative nudging at intersections |
  | `IN_LOT` | Both axes | Vehicles can be at any angle in lot |

- **Why This Is Topology-Agnostic**:
  - Uses `vehicle.location` state, not hardcoded coordinates
  - Road orientation is implicit in location type (main = horizontal, entry/exit = vertical)
  - Same logic works for any topology that follows the standard road naming convention

- **Disciplined Driving Behavior**:
  - Real vehicles don't phase through each other or get pushed sideways
  - Priority-based stopping handles who yields
  - Nudging only corrects minor overlaps along the natural travel direction

- **Dynamic Spawn Rate**:
  - Spawn interval adjusts based on traffic congestion
  - Base interval: 0.5 seconds
  - Formula: `dynamicInterval = 0.5s × (1 + floor(vehiclesInTransit / 10) × 0.5)`
  - At 10+ vehicles in transit: interval doubles to 1.0s
  - At 20+ vehicles in transit: interval triples to 1.5s
  - Prevents overwhelming the system during high traffic

- **Exit Count Accuracy**:
  - `exitedCount` only counts vehicles that actually parked and then exited
  - Filters by `intent === 'EXITING_LOT'`
  - Excludes pass-through traffic (never entered lot)
  - Excludes missed-turn vehicles (never parked)

- **Extended Turn Zone**:
  - Vehicles can turn into entry road even if slightly past the entry point
  - Zone extends from `entryRoadLeft - entryRoad.width` to `entryRoadRight + 5`
  - Accommodates vehicles that completed lane change slightly late

- **Lane Change Slowdown Near Entry**:
  - Vehicles slow down during lane change when near the entry point
  - Condition: `distToEntry < entryRoad.width * 3 && distToEntry > -entryRoad.width`
  - Speed capped to `SPEEDS.AISLE` (4.5 m/s) to complete lane change in time

---

### Version 3.4.1 - Topology-Agnostic Gap Calculations

- Implemented speed-dependent and urgency-based lane change gap requirements

- **Speed-Dependent Gap Calculation**:
  - Gap requirements now scale with vehicle speed using IDM time headway
  - Formula: `gap = base_gap + speed × time_headway`
  - Higher speeds require larger gaps for safe lane changes
  - Ensures realistic following behavior at all speeds

- **Urgency-Based Gap Relaxation**:
  - Vehicles near entry point accept smaller gaps (urgency factor)
  - Factor scales from 1.0 (200m+ from entry) to 0.2 (past entry point)
  - Prevents vehicles from missing turns in heavy traffic

- **Emergency Lane Change (Last Resort)**:
  - Vehicles within 50m of entry can force lane change with minimal gap (1.2 × CAR_LENGTH)
  - Slows down during forced lane change for safety
  - `hasMinimalLaneChangeGap()` function checks basic collision clearance

- **Graduated Emergency Braking**:
  - Replaced hard stop at emergency gap with graduated response
  - At gap < 0 (overlap): Allow 10% creep speed to separate
  - At gap < EMERGENCY_GAP: Scale from 10-20% creep speed
  - At gap < s0: Scale from 20-50% creep speed
  - Prevents complete deadlocks while maintaining safety

- **MOBIL Parameter Optimization**:
  - Optimized politeness factor from 0.5 to 0.4
  - Slightly less polite behavior reduces collisions in dense traffic
  - All IDM parameters verified optimal (no changes needed)

- **Test Improvements**:
  - Increased full-cycle test durations (600s/800s) for lane change delays
  - Dense traffic collision test now passes consistently

- **Files Changed**:
  - `simulation.ts`: `computeSpeedFromGap()`, `canChangeLane()`, `updateLaneChange()`, `hasMinimalLaneChangeGap()`
  - `types.ts`: MOBIL.p = 0.4
  - `interaction-tests.ts`: Extended test durations

---

## Known Limitations

1. Single-file movement in aisles (no passing)
2. Simplified merging logic (gap-based only)
3. No pedestrians
4. All vehicles same size
5. Traffic lights defined but not yet active in simulation loop

---

## Future Enhancements (Potential)

- [x] Lane changing on main road (implemented v2.2)
- [x] Traffic light infrastructure (implemented v2.1)
- [x] Unified traffic model - all vehicles follow same rules (implemented v3.0)
- [x] Disciplined yielding at intersections (implemented v3.1)
- [x] Stuck vehicle resolution with tiered escalation (implemented v3.2)
- [x] Priority-based collision resolution (implemented v3.2)
- [x] Metrics dashboard (implemented v3.2)
- [x] Topology-agnostic refactoring (implemented v3.3)
- [x] Lane-constrained collision resolution (implemented v3.4)
- [ ] Activate traffic light simulation loop
- [ ] Different vehicle types/sizes
- [ ] Pedestrian simulation
- [ ] Time-based demand patterns
- [ ] Multiple entry/exit points
- [ ] Handicap spot prioritization
- [ ] Real-time analytics dashboard
- [ ] Complex intersection topologies

---

## Evolution Roadmap: From Prototype to Traffic Laboratory

### Current State Assessment

The current code base is an **excellent rule-based micro-simulation prototype** containing:
- Clear physical topology / behavioural separation
- Reasonable kinematics (point-mass + max accel/decel)
- Robust lane-change, merge and stuck-recovery logic
- Instrumentation (snapshots, events, logging)

For a first-generation "parking-lot bottleneck analyser" this is more than enough. The following roadmap outlines how to evolve it into a **general-purpose traffic laboratory** where "cars learn how to move in any situation".

---

### Phase 1: Immediate, Low-Risk Improvements (Keep Rule-Based)

| Area | What to Change | Benefit |
|------|----------------|---------|
| **Physics fidelity** | Replace point-mass with bicycle model (steering angle, turning radius). Use continuous time-integration (semi-implicit Euler). | Correct cornering, realistic turning radii, fewer corner-cutting artefacts. |
| **Behavioural models** | Replace bespoke gap/yield logic with published models: IDM/Gipps for car-following, MOBIL for lane changing. | Less code, easier calibration, peer-reviewed realism. |
| **Path planning** | Compute paths lazily with A*/Dijkstra on a graph instead of hard-coded waypoint recipes. | Any topology becomes plug-and-play; no manual path tweaks. |
| **Collision** | Use bounding rectangles + swept collision (continuous) instead of centre-point + nudge. | Removes "tunnelling" and late detections at high speed. |
| **Performance** | Move simulation loop to a Web Worker. Replace grid with dynamic hashed grid or kd-tree when vehicle count grows. | 60 FPS rendering even with thousands of vehicles. |
| **Code health** | Enable `strictNullChecks`, `noImplicitAny`, `exactOptionalPropertyTypes`. Add unit tests for each behaviour transition. Adopt ESLint + Prettier config. | Fewer regressions, better onboarding for contributors. |

---

### Phase 2: Medium-Term Architectural Upgrades

1. **Entity-Component-System (ECS)**
   - Decouple "vehicle data" (components) from "systems" (behaviours)
   - Makes it trivial to add trucks, buses, pedestrians without duplicating code

2. **Event-Driven Traffic Control**
   - Implement the `TrafficLight` state machine
   - Turn the "mustStop" flag into a subscription to events (`LIGHT_RED`, `LIGHT_GREEN`)

3. **Scenario Scripting Layer**
   - A small DSL or JSON schema: "every 15s spawn 20 cars at gate A, close exit B for 30s, switch light C to red"
   - Essential for bottleneck experiments

4. **Headless Mode**
   - A Node.js build that runs N× faster than real-time and dumps CSV
   - Perfect for Monte-Carlo studies and CI tests

---

### Phase 3: Machine Learning Integration Strategy

**Where ML adds value:**

| ML Use-Case | Fit | Notes |
|-------------|-----|-------|
| **Parameter calibration** (IDM `a`, `b`, `T`, etc.) against real trajectory data | ★★★ | Simple optimisation / Bayesian calibration; low risk. |
| **Behavioural diversity** (aggressive, cautious, distracted drivers) | ★★☆ | Sample driver parameters from learned distributions. |
| **Adaptive route choice** (RL to minimise travel time under congestion) | ★★☆ | Useful when multiple alternative paths exist. |
| **Local decision policy** (deep RL for acceleration/steering each frame) | ★☆☆ | Overkill for most research; needs massive training data; hard to guarantee safety. |
| **Computer-vision perception** inside sim | ☆☆☆ | Not relevant – we have perfect ground truth. |

**Recommendation:** Stay rule-based for core safety-critical manoeuvres (collision avoidance, lane keeping). Use ML only for *high-level* decisions or for *calibrating* the many tunable constants already in the code.

---

### Suggested Version Roadmap

| Version | Focus | Key Changes |
|---------|-------|-------------|
| **v3.5** | Physics upgrade | Integrate bicycle model, refactor `applyAcceleration` & `followPath` |
| **v3.6** | ECS refactor + Web Worker | Split components (Position, Kinematics, DriverProfile, Intent, Path), run systems in worker |
| **v4.0** | Generic topology loader | Import OpenDRIVE/GeoJSON → auto-generate road graph, switch to graph-based A* routing |
| **v4.1** | Behaviour calibration | Collect GPS traces or NGSIM data, optimise IDM/MOBIL parameters with CMA-ES, export "driver archetypes" JSON |
| **v5.0** | Scenario engine & dashboard | YAML/JSON scenario scripts, real-time charts (queue length, delay, throughput), batch runner for sensitivity analysis |
| **v5.x** | Optional ML branch | Try PPO/TD3 agents for tactical lane selection or dynamic gap acceptance – sandboxed, not in core library |

---

### Quick-Win: Driver Profile Implementation

Add behavioural heterogeneity with minimal code changes (~200 LOC):

```typescript
// types.ts
export interface DriverProfile {
  maxAcceleration: number;      // m/s²
  comfortableBraking: number;   // m/s²
  desiredTimeHeadway: number;   // seconds
  politeness: number;           // MOBIL parameter
  aggressiveness: number;       // lane change threshold
}

// simulation.ts, during vehicle spawn
const profile = randomDriverProfile();
vehicle.profile = profile;

// Then use vehicle.profile instead of global PHYSICS constants
// in computeTargetSpeed() and canChangeLane()
```

This provides instant behavioural diversity with minimal refactoring.

---

### Bottom Line

- The current deterministic, rule-based simulator is **appropriate for bottleneck studies** in small to medium layouts
- Focus first on **physics fidelity, modularity, performance, and calibration** before introducing heavyweight ML
- Use machine learning selectively – mainly for parameter tuning or strategic decision layers – not as a wholesale replacement for proven traffic-flow models

---

## Test Suite for Disciplined Driving

The simulation includes a comprehensive test suite to validate realistic vehicle behavior. Tests can be run on exported simulation logs or via headless simulation.

### Test Architecture

```
src/tests/
├── test-harness.ts       # Core utilities: seeded RNG, TestSim wrapper, assertions
├── log-analyzer.ts       # Analyze exported JSON logs from UI
├── unit-tests.ts         # Pure function tests (math, constants, topology)
├── interaction-tests.ts  # Multi-vehicle behavior tests
├── scenario-tests.ts     # Full-flow scenario and regression tests
├── run-all-tests.ts      # Main test runner CLI
└── golden/               # Golden baseline files for regression
    └── standard-scenario.json
```

### Running Tests

```bash
# Run all tests
npx ts-node src/tests/run-all-tests.ts

# Run specific test suites
npx ts-node src/tests/run-all-tests.ts --unit
npx ts-node src/tests/run-all-tests.ts --interaction
npx ts-node src/tests/run-all-tests.ts --scenario

# Analyze exported log file
npx ts-node src/tests/run-all-tests.ts --log ~/Downloads/simulation-log.json --report

# Quick smoke test (skips long scenarios)
npx ts-node src/tests/run-all-tests.ts --quick
```

### Test Harness Essentials

**Deterministic RNG:**
```typescript
import { createTestSim, seedRandom } from './test-harness';

// Create simulation with seeded random
const { sim, step, run } = createTestSim(200, 42); // 200 spots, seed=42

// Run simulation for 60 seconds at 50ms steps
run(60, 0.05);

// Access vehicles
const vehicles = sim.state.vehicles;
```

**Assertion Utilities:**
```typescript
import {
  expectWithin,
  expectVehicleState,
  expectNoCollisions,
  expectAllWithinPavedArea,
  expectSpeedLimitCompliance,
  expectNoStuckVehicles,
  expectMinimumGap,
} from './test-harness';

// Check value tolerance
expectWithin(speed, 13.4, 0.5, 'speed');

// Check vehicle state
expectVehicleState(vehicle, 'PARKED');

// Check no collisions in vehicle list
expectNoCollisions(vehicles);

// Check all within paved area
expectAllWithinPavedArea(sim, vehicles);
```

---

### Test Categories

#### 1. Unit Tests (Pure Functions)

| Function | Cases Covered |
|----------|---------------|
| `normalizeAngle` | Wrap ±2π, preserve ±π/2 |
| `distance` | Horizontal, vertical, diagonal (3-4-5), same point |
| Constants | CAR_LENGTH, CAR_WIDTH, SPEEDS, PHYSICS realistic ranges |
| `isWithinPavedArea` | Lot center, main road, off-map, despawn extension |
| Topology creation | Spot count, lane count, entry/exit separation |

#### 2. Interaction Tests (≥2 Vehicles)

| Test | Setup | Success Criteria |
|------|-------|------------------|
| Safe following | Multiple vehicles in lanes | Gap never < `MIN_GAP`, no collisions |
| Lane change safety | Vehicles changing lanes | No collisions, reasonable duration (0.5-10s) |
| Speed compliance | All locations | Never exceeds location-specific limit |
| Stuck detection | 30+ vehicles, 3 min | No vehicle stuck > 45s |
| Boundary integrity | Fill + drive | All positions within `isWithinPavedArea()` |
| Merge behavior | Exodus phase | Vehicles wait for safe gaps |
| Acceleration limits | Track Δv/Δt | Never exceeds MAX_ACCELERATION/EMERGENCY_DECEL |

#### 3. Scenario Tests (Full Flow)

| Scenario | Configuration | KPIs |
|----------|---------------|------|
| Happy-path: 1 car | 50 spots, 1 vehicle | Parks + exits, 0 collisions |
| Happy-path: 10 cars | 100 spots, 10 vehicles | ≥80% exit rate, 0 collisions |
| Happy-path: 25 cars + traffic | 150 spots, 25 vehicles, 30 veh/min | ≥70% exit rate |
| Stress: 50 vehicles | 200 spots, 40 veh/min traffic | 0 collisions, <60s max wait |
| Stress: 100 vehicles | 300 spots, 15 min fill | 0 collisions, <90s max wait |
| Lane change urgency | 30 vehicles | ≥70% reach entry successfully |
| Boundary: 5 min | 40 vehicles | 0 off-road snapshots |
| Exodus completion | Fill + exit | ≥90% vehicles exit |
| Performance | 50 vehicles, 10 min | <5s wall time |
| Determinism | Same seed twice | Identical results |

#### 4. Log Analysis Tests

Run on exported simulation logs (JSON):

| Test | What It Checks |
|------|----------------|
| Speed Limits | No vehicle exceeds location-based limits |
| Acceleration Limits | Δv/Δt within comfortable/emergency bounds |
| Position Continuity | No teleportation (movement matches speed) |
| Lane Discipline | Y-position matches lane center when not changing |
| Lane Change Safety | Duration 0.5-10s, smooth execution |
| Stuck Vehicles | No vehicle stuck > 30s (except parked) |
| Vehicle Proximity | No moving vehicles closer than 0.5×CAR_LENGTH |
| Spawn Rate | No burst spawning (interval > 0.1s) |
| State Transitions | Only valid state transitions occur |
| Parking Success | ≥70% of seeking vehicles park |
| Reversing Safety | Speed ≤ 1.5×BACKUP during reverse |
| Heading Consistency | Turn rate ≤ 180°/s at speed |
| Path Progress | No stalls > 30s without waypoint advance |
| Exit Completion | ≥90% of exiting vehicles complete |

---

### Golden Log Regression

For each version, save a golden summary:

```json
{
  "seed": 12345,
  "numSpots": 100,
  "fillCount": 25,
  "duration": 610,
  "totalSpawned": 25,
  "parkedCount": 23,
  "exitedCount": 21,
  "maxWaitTime": 12.5,
  "timestamp": "2025-12-27T00:00:00.000Z"
}
```

CI compares new runs against golden with ±10% tolerance. Large drift flags behavior changes.

---

### Adding New Tests

**Unit Test Example:**
```typescript
// unit-tests.ts
{
  name: 'myFunction handles edge case',
  category: 'Math Utilities',
  run: () => {
    const result = myFunction(edgeInput);
    return expectWithin(result, expectedValue, tolerance, 'myFunction');
  },
}
```

**Interaction Test Example:**
```typescript
// interaction-tests.ts
{
  name: 'Vehicles yield at intersection',
  category: 'Yielding',
  run: () => {
    const testSim = createTestSim(100, 1234);
    testSim.sim.fillLot(20);
    testSim.run(120);

    const vehicles = testSim.getAllVehicles();
    return expectNoCollisions(vehicles);
  },
}
```

**Scenario Test Example:**
```typescript
// scenario-tests.ts
{
  name: 'Custom scenario: rush hour',
  category: 'Stress Test',
  run: () => {
    const result = runScenario({
      name: 'rush-hour',
      numSpots: 300,
      fillCount: 100,
      fillDuration: 600,
      waitDuration: 0,
      exodusDuration: 600,
      roadTrafficRate: 60,
      seed: 9999,
    });

    return {
      passed: result.collisionCount === 0 && result.maxWaitTime < 120,
      message: `Collisions: ${result.collisionCount}, Max wait: ${result.maxWaitTime}s`,
      details: result,
    };
  },
}
```

---

### Test-Driven Development Workflow

1. **Before implementing new behavior:**
   - Add failing test that validates expected behavior
   - Run `--quick` to verify test fails appropriately

2. **After implementation:**
   - Run full test suite
   - Check no regressions in existing tests
   - Update golden baselines if behavior intentionally changed

3. **For bug fixes:**
   - Add test that reproduces the bug
   - Fix the bug
   - Verify test now passes

4. **Before release:**
   ```bash
   npx ts-node src/tests/run-all-tests.ts
   ```
   All tests must pass.


### Behavioral Validation Tests (12 Core Requirements)

These tests are implemented in `src/tests/behavioral-tests.ts` and can be run with:
```bash
npm run test:behavioral
```

| # | Test | Category | Description |
|---|------|----------|-------------|
| 1 | Cars able to park | Parking Ability | ≥80% of spawned vehicles should park within 5 minutes |
| 2 | No duplicate spots | Spot Assignment | No two vehicles assigned to same parking spot |
| 3 | No stuck vehicles | Stuck Detection | ≤5% of active vehicles stuck (waiting >60s) |
| 4 | Lane discipline | Driving Discipline | <5% lane violations, yielding behavior observed |
| 5 | No collisions | Collision Avoidance | Zero collisions during entire simulation |
| 6 | Spawn clearance | Spawn Behavior | Vehicles spawn with adequate clearance (>1.5 car lengths) |
| 7 | Parking completion | Task Completion | ≥90% of parking-bound vehicles eventually park |
| 8 | Parked car avoidance | Obstacle Avoidance | Active vehicles properly navigate around parked vehicles |
| 9 | Paved path constraint | Boundary Integrity | 100% of vehicle positions within paved areas |
| 10 | Conflict resolution | Conflict Resolution | Priority-based conflict handling with minimal deadlocks |
| 11 | Context-aware behavior | Context Awareness | Speed varies appropriately by location (main road > lot) |
| 12 | Task completion metrics | Metrics | Fill rate ≥80%, Exit rate ≥80%, throughput tracking |

Additionally, there are **degree-based metric tests** that report scores rather than pass/fail:
- **Efficiency Score**: Combined parking rate and wait time metric (0-100)
- **Flow Quality**: Throughput vs theoretical maximum (0-100)
- **Safety Score**: Based on near-miss frequency (0-100)

---

## Topology Editor (Planned Feature)

This section documents the planned topology editor feature that will allow users to create, modify, and save custom parking lot and road layouts.

### Overview

The topology editor will provide a visual interface for creating custom simulation environments without modifying code. Users will be able to:
- Create new topologies from scratch or from templates
- Modify existing topologies
- Save and load topologies as JSON files
- Validate topologies before running simulations

### Topology Element Catalog

The following elements are available for constructing infrastructure:

#### 1. Road Infrastructure

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Road Segment** | `road` | Straight road section | x, y, length, width, lanes, direction, speedLimit |
| **Curved Road** | `curved_road` | Arc-shaped road for turns | centerX, centerY, radius, startAngle, endAngle, lanes |
| **Intersection** | `intersection` | Junction of roads | type (3-way, 4-way, roundabout), controlType |
| **Lane** | `lane` | Individual lane within road | index, direction, type (normal, turn, merge) |
| **Ramp** | `ramp` | Entry/exit ramp | slope, curvature, mergeType |
| **Bridge** | `bridge` | Elevated road crossing | elevation, supportedLoad |
| **Tunnel** | `tunnel` | Underground passage | depth, ventilation |
| **Median** | `median` | Traffic divider | width, crossable (boolean) |
| **Shoulder** | `shoulder` | Emergency stopping area | width, surfaceType |

#### 2. Parking Infrastructure

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Parking Spot** | `spot` | Standard parking space | x, y, width, length, aisleId, angle |
| **Handicap Spot** | `handicap_spot` | Accessible parking | accessAisleWidth, signage |
| **Compact Spot** | `compact_spot` | Smaller vehicle spot | maxVehicleLength |
| **EV Charging Spot** | `ev_spot` | Electric vehicle spot | chargerType, powerOutput |
| **Reserved Spot** | `reserved_spot` | Designated parking | reservationType, permitRequired |
| **Motorcycle Spot** | `motorcycle_spot` | Two-wheeler parking | count (spots per area) |
| **Aisle** | `aisle` | Driving lane in lot | y, xStart, xEnd, direction, speedLimit |
| **Parking Structure** | `structure` | Multi-level garage | levels, rampType, spotsPerLevel |
| **Drop-off Zone** | `dropoff` | Temporary stopping | maxWaitTime, capacity |

#### 3. Traffic Control

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Traffic Light** | `traffic_light` | Signal system | phases[], cycleDuration, controlsDirection |
| **Stop Sign** | `stop_sign` | Mandatory stop | facingDirection, allWayStop |
| **Yield Sign** | `yield_sign` | Yield right-of-way | facingDirection, yieldTo |
| **Speed Limit Sign** | `speed_sign` | Posted limit | speedLimit, unit |
| **One-Way Sign** | `oneway_sign` | Direction restriction | allowedDirection |
| **No Entry Sign** | `no_entry` | Entry prohibition | exceptions[] |
| **Crosswalk** | `crosswalk` | Pedestrian crossing | width, signalized, pedestrianPhase |
| **Pedestrian Signal** | `ped_signal` | Walk signal | linkedToLight, countdown |
| **Toll Booth** | `toll_booth` | Payment checkpoint | paymentTypes[], laneCount |
| **Checkpoint** | `checkpoint` | Security/verification | verificationType, processingTime |

#### 4. Obstacles & Barriers

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Broken Down Vehicle** | `disabled_vehicle` | Blocking obstacle | vehicleType, hazardLights, duration |
| **Barricade** | `barricade` | Temporary barrier | width, height, reflective |
| **Traffic Cone** | `cone` | Lane guidance | position, color |
| **Jersey Barrier** | `jersey_barrier` | Concrete barrier | length, height, anchored |
| **Bollard** | `bollard` | Fixed post | retractable, height, diameter |
| **Gate/Boom Barrier** | `gate` | Movable barrier | armLength, openSpeed, trigger |
| **Curb** | `curb` | Road boundary | height, mountable |
| **Guardrail** | `guardrail` | Safety barrier | length, terminalType |
| **Debris** | `debris` | Temporary obstacle | size, clearanceRequired |
| **Pothole** | `pothole` | Road damage | diameter, depth, severity |
| **Construction Zone** | `construction` | Work area | bounds, speedReduction, laneClosure |
| **Crash Site** | `crash_site` | Accident scene | severity, lanesBlocked, duration |

#### 5. Buildings & Structures

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Building** | `building` | Adjacent structure | footprint, entrances[], height |
| **Booth** | `booth` | Attendant station | staffed, paymentCapable |
| **Canopy** | `canopy` | Covered area | bounds, clearanceHeight |
| **Loading Dock** | `loading_dock` | Commercial zone | dockCount, truckCapacity |
| **Gas Station** | `gas_station` | Fuel facility | pumpCount, fuelTypes[] |
| **Car Wash** | `car_wash` | Wash facility | type (auto/manual), queueCapacity |
| **Entrance Building** | `entrance` | Venue entry | pedestrianFlow, vehicleAccess |

#### 6. Pedestrian Infrastructure

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Sidewalk** | `sidewalk` | Walking path | width, surface, ada_compliant |
| **Pedestrian Path** | `ped_path` | Lot walkway | waypoints[], protected |
| **Crosswalk** | `crosswalk` | Road crossing | marked, signalized, raiseType |
| **Pedestrian Bridge** | `ped_bridge` | Elevated walkway | span, width, covered |
| **Pedestrian Tunnel** | `ped_tunnel` | Underground crossing | lighting, accessibility |
| **Waiting Area** | `waiting_area` | Pickup zone | capacity, sheltered |
| **Staircase** | `stairs` | Vertical access | width, steps, handrails |
| **Elevator** | `elevator` | Vertical transport | capacity, floors[], accessible |

#### 7. Environmental & Decorative

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Tree** | `tree` | Landscaping | trunkDiameter, canopyRadius |
| **Planter/Island** | `island` | Landscaped divider | bounds, drivable (boolean) |
| **Light Pole** | `light_pole` | Illumination | height, lightRadius, position |
| **Drainage Grate** | `drain` | Storm drainage | size, coveredBy |
| **Fire Hydrant** | `hydrant` | No-park marker | clearanceRadius |
| **Dumpster** | `dumpster` | Waste container | size, accessRequired |
| **Cart Corral** | `cart_corral` | Shopping cart area | capacity, bounds |

#### 8. Entry/Exit Points

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Spawn Point** | `spawn` | Vehicle generation | rate, vehicleTypes[], lane |
| **Despawn Point** | `despawn` | Vehicle removal | position, conditions |
| **Entry Gate** | `entry_gate` | Controlled entry | ticketType, accessMethods[] |
| **Exit Gate** | `exit_gate` | Controlled exit | paymentMethods[], validationRequired |
| **Emergency Exit** | `emergency_exit` | Emergency egress | alarmTriggered, autoOpen |

#### 9. Zones & Regions

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Speed Zone** | `speed_zone` | Speed-limited area | bounds, speedLimit, enforcementType |
| **No-Parking Zone** | `no_parking` | Prohibited parking | bounds, towEnabled |
| **Fire Lane** | `fire_lane` | Emergency access | width, alwaysClear |
| **Loading Zone** | `loading_zone` | Commercial loading | timeLimit, vehicleTypes[] |
| **Taxi Stand** | `taxi_stand` | Taxi waiting | capacity, queueDirection |
| **Bus Lane** | `bus_lane` | Reserved lane | operatingHours, sharedWith[] |
| **HOV Lane** | `hov_lane` | Carpool lane | minOccupancy, operatingHours |

#### 10. Dynamic Elements

| Element | Type | Description | Key Properties |
|---------|------|-------------|----------------|
| **Movable Barrier** | `movable_barrier` | Scheduled barrier | schedule[], defaultState |
| **Variable Message Sign** | `vms` | Digital signage | messageQueue[], displayDuration |
| **Parking Counter** | `counter` | Availability display | linkedSpots[], position |
| **Sensor** | `sensor` | Vehicle detection | type (inductive, camera, ultrasonic), range |
| **Camera** | `camera` | Surveillance | fieldOfView, coverage, type |

### Data Structures

#### TopologyElement Base Interface

```typescript
interface TopologyElement {
  id: string;
  type: string;
  x: number;
  y: number;
  rotation?: number;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}
```

#### Obstacle Interface

```typescript
interface Obstacle extends TopologyElement {
  type: 'disabled_vehicle' | 'barricade' | 'cone' | 'debris' | 'pothole' | 'construction' | 'crash_site';
  width: number;
  height: number;
  blocking: boolean;          // Completely blocks path
  speedReduction?: number;    // Speed multiplier (0.5 = half speed)
  avoidanceRadius?: number;   // How far vehicles should stay away
  duration?: number;          // Temporary obstacles: removal time (seconds)
  dynamic?: boolean;          // Can change state during simulation
}
```

#### Zone Interface

```typescript
interface Zone extends TopologyElement {
  type: 'speed_zone' | 'no_parking' | 'fire_lane' | 'loading_zone';
  bounds: { x: number; y: number; width: number; height: number };
  rules: {
    speedLimit?: number;
    parkingAllowed?: boolean;
    stoppingAllowed?: boolean;
    timeLimit?: number;
    vehicleTypes?: string[];
  };
}
```

### Editor UI Components

#### Mode Toggle
- **Simulation Mode**: Run simulations with current topology
- **Editor Mode**: Create and modify topology elements

#### Tool Palette
- Selection tool (click to select, drag to move)
- Road tool (click start/end points)
- Parking row tool (drag to create row of spots)
- Obstacle tool (click to place)
- Zone tool (drag to define area)
- Delete tool (click to remove)

#### Properties Panel
- Shows properties of selected element
- Real-time editing with validation
- Undo/redo support

#### Element Library
- Categorized list of available elements
- Drag-and-drop onto canvas
- Search and filter

#### Toolbar Actions
- New topology
- Open/Save topology
- Export as JSON
- Import from JSON
- Validate topology
- Preview in simulation

### Validation Rules

Before a topology can be used in simulation, it must pass validation:

1. **Connectivity**: Entry points must connect to road network
2. **Accessibility**: All parking spots must be reachable from entry
3. **Exit Routes**: All spots must have path to exit
4. **No Overlaps**: Elements cannot physically overlap (unless designed to)
5. **Speed Limits**: All drivable areas must have defined speed limits
6. **Lane Consistency**: Lane counts must match at road connections
7. **Spawn Clearance**: Spawn points must have adequate space

### File Format

Topologies are saved as JSON:

```json
{
  "version": "1.0",
  "metadata": {
    "name": "Custom Mall Parking",
    "description": "Large mall parking lot with multiple entrances",
    "author": "User",
    "created": "2025-12-28T00:00:00Z",
    "modified": "2025-12-28T00:00:00Z"
  },
  "dimensions": {
    "width": 500,
    "height": 300
  },
  "elements": {
    "roads": [...],
    "aisles": [...],
    "spots": [...],
    "obstacles": [...],
    "zones": [...],
    "trafficControl": [...],
    "entryExits": [...]
  },
  "defaults": {
    "speedLimit": 4.5,
    "spotWidth": 2.7,
    "spotLength": 5.5,
    "aisleWidth": 6.0
  }
}
```

### Implementation Phases

#### Phase 1: Core Editor (MVP)
- Mode toggle (Simulation ↔ Editor)
- Basic element placement (roads, aisles, spots)
- Property editing panel
- Save/Load to localStorage
- Basic validation

#### Phase 2: Visual Editing
- Drag-and-drop positioning
- Resize handles for elements
- Grid snapping
- Multi-select and group operations
- Undo/redo history

#### Phase 3: Advanced Elements
- Obstacles and barriers
- Traffic control devices
- Zones and regions
- Dynamic elements

#### Phase 4: Templates & Presets
- Built-in topology templates
- User template library
- Import/export to file
- Sharing capabilities

### Integration with Simulation

When switching from Editor to Simulation mode:

1. **Validation**: Topology is validated for completeness
2. **Compilation**: Elements are compiled into simulation-ready structures
3. **Path Generation**: Entry/exit paths are computed using A* on road graph
4. **Speed Zones**: Speed limit lookup table is built
5. **Collision Mesh**: Obstacle collision boundaries are computed

The simulation engine receives the compiled topology and operates identically to programmatic topologies.

### Keyboard Shortcuts (Planned)

| Key | Action |
|-----|--------|
| `Ctrl+N` | New topology |
| `Ctrl+O` | Open topology |
| `Ctrl+S` | Save topology |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Delete` | Delete selected |
| `Escape` | Deselect / Cancel |
| `G` | Toggle grid snap |
| `R` | Rotate selected |
| `Space` | Toggle simulation/editor mode |

